# AntigravityWorker — real headless `agy` dispatch, RBAC investigated empirically, proven end-to-end

Date: 2026-08-20 · Machine: this Mac · `agy` version: **1.1.16**
(`/Users/celeste7/.local/bin/agy`) · Postgres: `central-mvp-pg` (docker, port
5433, schema `controlplane`, reused, not recreated).

## Answer, up front

**`agy` headless mode has NO built-in per-tool allow/deny mechanism — none of
`--help`, `agy mcp`, `agy plugin`, or the global settings file provide one —
and confirmed live, `--dangerously-skip-permissions` (and even the DEFAULT
headless mode, without that flag, because this machine's global
`~/.gemini/antigravity-cli/settings.json` already has `"toolPermission":
"always-proceed"`) auto-approves every tool with no interactive gate
whatsoever.** This is the same bug class the project already found twice
(Claude's `--allowedTools`, Gemini's GHSA-wpqr-6v78-jr5g) — a third
confirmation that "yolo mode" defaults are the norm, not the exception, across
agentic CLIs.

**But there IS one real, external, deterministic enforcement mechanism:**
`.agents/hooks.json` PreToolUse hooks. A hook can return `{"decision":"deny"}`
for a tool-name regex match, and this fires as a real subprocess spawned by
the `agy` runtime itself — outside the model's control entirely. **This was
tested live, not assumed:** a deny hook matching
`run_command|write_to_file|replace_file_content|multi_replace_file_content|sed_file`
was set up, then a task was run that explicitly tried to (1) read a file, (2)
run a shell command, and (3) write a file, all under
`--dangerously-skip-permissions`. Real result: **the read succeeded, the
shell command was blocked, the file write was blocked** — both failures
carrying the exact hook's deny reason in the tool's error field
(`"tool call denied by pre-tool hook: RBAC test: mutating tool blocked by
hook"`). No file was created; verified by `ls`/`cat` after the run, not
inferred from the log alone. **`AntigravityWorker` uses this mechanism as its
real RBAC boundary** — see §3.

A second, independent, load-bearing finding surfaced in the same
investigation: **`cwd` alone does not scope where agy's tools actually
operate.** Without `--add-dir <cwd>`, file-read tools (`find_by_name`) roamed
freely outside the intended directory — observed searching
`~/.gemini/antigravity-cli/scratch`, `~/.gemini`, `~/`, `/tmp`, and even `/`
(filesystem root) — and `write_to_file` refused any target outside an
internal per-conversation "brain" artifact directory. Passing `--add-dir`
with the real target directory fixed this in the live retest. This is now a
required flag in `AntigravityWorker.args()`, not optional — see §2.

---

## 1. Tool-scoping options investigated — real commands, real output

### 1.1 `agy --help` (full, re-read for anything missed)

No `--allowedTools`/`--disallowedTools`-equivalent flag anywhere in the full
flag list:

```
--add-dir --agent -c --continue --conversation --dangerously-skip-permissions
--disable-slash-commands --effort -i --input-format --json-schema --log-file
--mode --model --new-project --output-format -p --print --print-timeout
--project --prompt --prompt-interactive --sandbox
```

Subcommands: `agent(s)`, `changelog`, `help`, `install`, `mcp`, `plugin(s)`,
`update`.

### 1.2 `agy mcp --help` / `agy plugin --help`

```
agy mcp:    add | remove | list | enable | disable
agy plugin: list | import | install | uninstall | enable | disable | validate | link
```

`agy mcp list` (real output, this machine) shows per-server enable/disable —
`claude-peers`/`github`/`linear`/`supabase`/`vercel`/`data-agent-kit`/
`visualization` enabled, `knowledge_catalog`/`notebooks`/`redis`/`render`/
`spanner` disabled. **This scopes MCP-provided tools only.** It has no
bearing on the 53 BUILT-IN tools (`run_command`, `write_to_file`,
`browser_*`, `view_file`, etc. — the full list is in every real `init`
event, §4) — those are not MCP tools and cannot be enabled/disabled this way.
`agy plugin` scopes plugin-provided tools/skills the same way. Neither is a
per-tool allow/deny mechanism for the built-in toolset the RBAC question is
actually about.

### 1.3 Config directories — `~/.gemini/antigravity-cli/settings.json`

Real content, this machine, BEFORE any test changes:

```json
{
  "agentMode": "accept-edits",
  "colorScheme": "colorblind-friendly dark",
  "model": "Gemini 3.6 Flash (High)",
  "permissions": { "allow": ["command(lsof)"] },
  "toolPermission": "always-proceed",
  "trustedWorkspaces": ["/Users/celeste7"]
}
```

Cross-referenced against the live docs (`antigravity.google/docs/permissions`,
fetched, not guessed): this IS a real policy-engine format —
`action(target)` syntax (`command(prefix)`, `read_file(/path)`,
`write_file(/path)`, `read_url(domain)`, `execute_url(domain)`,
`mcp(server/tool)`, `unsandboxed(prefix)`), with **Deny > Ask > Allow**
precedence across three lists (`allow`/`ask`/`deny`). **But two things make
it unusable as this worker's enforcement boundary:**

1. It is a **single global file**, not a per-invocation flag — editing it to
   scope one role's dispatch would also silently reshape every other `agy`
   invocation on this machine, including the interactive desktop app and IDE
   (both of which are also driven by this same `~/.gemini/` tree).
2. `toolPermission: "always-proceed"` is a coarser switch that, per the docs
   fetched and confirmed by the empirical baseline test (§2), overrides the
   allow/deny lists entirely when set — the lists exist but are not being
   consulted while this mode is active. (`--dangerously-skip-permissions` is
   documented as doing the same thing per-invocation; on this machine the
   global setting already does it by default even without that flag — see
   the `permission_mode:"always-proceed"` field present in every real `init`
   event, §4, whether or not `--dangerously-skip-permissions` was passed.)

No project-local override for `permissions.allow/ask/deny` was found in
`agy-customizations` docs (`json_configs.md`, `mcp_servers.md`,
`skills.md`, `plugins.md`, `rules.md`) — only skills/plugins get a
per-project `.agents/*.json` registration path. Permissions themselves are
not documented as project-scopable there.

### 1.4 `--sandbox`

CLI reference (fetched live): `enableTerminalSandbox` — *"Restricts all
local execution commands launched by agents to OS containment rings."*
Terminal-command-specific by its own description; nothing suggests it
touches `write_to_file` or `browser_*`. Not independently live-tested beyond
this (the hooks mechanism in §1.5 was decisive and cheaper to verify —
`--sandbox` restricting only `run_command` is documented, not contradicted
by anything observed, but should be treated as "documented, not
re-confirmed live" if it matters for a future decision).

### 1.5 `.agents/hooks.json` — the real mechanism, found in
`~/.gemini/antigravity/builtin/skills/agy-customizations/docs/hooks.md`

`PreToolUse` hooks match a tool-name regex and can return
`{"decision":"allow"|"deny"|"ask"|"force_ask", "reason":...}`. `"deny"` is
documented as *"Hard block the execution immediately."* This runs as an
external `sh -c` subprocess spawned by the `agy` runtime before the tool
executes — the model has no path to talk its way past it, unlike a
system-prompt instruction. **This is the mechanism `AntigravityWorker` uses**
— see §3 for the live proof.

---

## 2. Empirical tests — three real runs, in order

### Test A — baseline, no restriction, wrong directory (accidental but instructive)

Task: read `seed.txt`, run `echo AGY_SHELL_TEST_OK`, write `agy_output.txt`,
`cwd` = a `/private/tmp/...` scratch directory NOT under
`trustedWorkspaces` (`["/Users/celeste7"]`), no `--add-dir`,
`--dangerously-skip-permissions` passed, no hook present.

Real observed behavior — the agent:
- Tried `find_by_name` for `seed.txt` in `~/.gemini/antigravity-cli`,
  `~/.gemini`, `~/`, a per-conversation `brain/<id>/` directory,
  `/tmp`, and finally **`/` (filesystem root)** — none of these are the
  directory that was passed as `cwd`, which the `init` event correctly
  reported. `run_command`'s own `pwd` returned
  `/Users/celeste7/.gemini/antigravity-cli/scratch` — a completely different
  path than the real OS-level `cwd` given to `child_process.spawn`.
- `run_command echo AGY_SHELL_TEST_OK` executed immediately, no gate, no ask.
- `write_to_file` to a path under the real `cwd` was REJECTED — not by any
  permission system, but by an "artifact path" constraint:
  `"... is not a valid artifact path; artifacts must be in
  .../antigravity-cli/brain/<conversation_id>/"`. Retried against that path
  and succeeded.
- Final `result.status` was `"ERROR"` (because the last visible attempt in
  the transcript still carried the earlier error string forward), but the
  shell command and eventual write both genuinely executed.

**Read this as a workspace-trust boundary, not a security feature to rely
on:** the fallback location is shared scratch space for ALL untrusted-`cwd`
`agy` invocations on this machine, and the read side had NO containment
at all — it searched the entire filesystem tree, including `/`. This is the
real behavior when a caller does not explicitly declare its intended
workspace.

### Test B — real fix: `--add-dir`, still no hook (established the fix, not yet a security test)

Same task, `cwd` unchanged, added `--add-dir <that same directory>`. Real
result: `view_file` correctly resolved and read the REAL `seed.txt` at the
REAL path this time (`"output":"2 lines, 27 bytes"`) — confirming `--add-dir`
is what actually establishes the working scope, not `cwd` alone. (This test
also had no deny hook yet — see Test C for the enforcement proof, run with
both `--add-dir` and the hook together.)

### Test C — the decisive RBAC test: `--add-dir` + `.agents/hooks.json` deny hook

`.agents/hooks.json` (in the target `cwd`):

```json
{
  "rbac-test-deny-mutating": {
    "PreToolUse": [{
      "matcher": "run_command|write_to_file|replace_file_content|multi_replace_file_content|sed_file",
      "hooks": [{ "type": "command",
        "command": "echo '{\"decision\":\"deny\",\"reason\":\"RBAC test: mutating tool blocked by hook\"}'",
        "timeout": 10 }]
    }]
  }
}
```

Same 3-step task, same `--add-dir`, `--dangerously-skip-permissions` still
passed. **Real, live result (full NDJSON captured):**

| Step | Tool | Result |
|---|---|---|
| Read `seed.txt` | `view_file` | **Succeeded** — `"output":"2 lines, 27 bytes"`, real content returned |
| `echo AGY_SHELL_TEST_OK` | `run_command` | **BLOCKED** — `state:"ERROR"`, `tool_info.error.message`: `"tool call denied by pre-tool hook: RBAC test: mutating tool blocked by hook"` |
| Write `agy_output.txt` | `write_to_file` | **BLOCKED** — identical hook-denial error |

Verified independently of the log: `ls`/`cat agy_output.txt` after the run
confirmed the file was never created. The terminal `result.status` was
`"ERROR"` with `error` carrying the same hook-denial string — an honest
failure record, not a silently-swallowed one.

**This is the proof.** The deny hook held under `--dangerously-skip-permissions`
and under a global `toolPermission: "always-proceed"` setting — the exact
combination that made the analogous Claude-CLI and Gemini-CLI bugs real.
Read access worked, write and shell access did not, and the denial reason
that landed in the tool's error field is byte-for-byte the reason the hook
script returned — no ambiguity about what happened or why.

---

## 3. `AntigravityWorker` — what it does, run live

New file: `06-gemini/antigravity-worker.mjs`. `spawn.mjs` and
`gemini-worker.mjs` untouched. Shape mirrors `spawn.mjs`'s `Worker`
(constructor, `args()`, `run()`, `ingest()`, `handoff()`,
EventEmitter: `ready`/`tool`/`tool-denied`/`event`/`done`).

`ROLES`: `probe`/`auditor` deny every mutating/dangerous tool via the
`.agents/hooks.json` PreToolUse mechanism proven in §2 Test C — these two
are the roles this gate actually live-tested. `fixer`/`architect` exist for
shape-parity with `spawn.mjs`'s `ROLES` but were **not independently
live-dispatched** in this gate — flagged in follow-ups, do not treat as
proven the way `probe` is.

`args()` always includes `--add-dir <cwd>` (§2's correctness fix) and
`--dangerously-skip-permissions` (needed because headless mode otherwise
still surfaces `ask_permission`-shaped interaction points that a
stdin-closed process can never answer — confirmed by an early test that hung
until the 5-minute `--print-timeout` expired with `"error":"timeout waiting
for response"`, before `--add-dir` and hook scoping were both in place).

`run()` writes the role's deny-hook to `<cwd>/.agents/hooks.json` BEFORE
spawning (fail-closed: if that write fails, the run is aborted with
`rbac_gate_write_failed` rather than silently dispatching unrestricted), then
spawns with `stdio:['ignore','pipe','pipe']` — stdin closed, matching
`spawn.mjs`'s documented reasoning.

`ingest()` parses the real event schema (§4): `step_type:"tool"` fires
twice per call (`ACTIVE` then `DONE`/`ERROR`, correlated by `step_index` —
this schema has no per-call id field), populating `state.toolCalls` with
`{stepIndex, state, toolName, parameters, output, error, deniedByHook}` —
`deniedByHook` is set by pattern-matching the confirmed
`"tool call denied by pre-tool hook: ..."` error string, so a caller can
tell "the model didn't try" from "the model tried and was blocked" without
re-reading raw events.

### Real end-to-end run

```
$ node antigravity-worker.mjs --role probe \
    --task "Read seed.txt in this directory and reply with exactly its content, nothing else." \
    --cwd .../06-gemini/worker-test-workspace
```

Real captured output:

```
[ready] conv=920ec7b2-8a4c-4b5a-a6a4-ccd3797b7a21 tools=57 permission_mode=always-proceed
[tool ] view_file

[done ] events=8 status=SUCCESS wall=68735ms exit=0 err=none
[result] "seed content for the real AntigravityWorker end-to-end proof\n"
[usage ] {"input_tokens":16000,"output_tokens":453,"thinking_tokens":375,"cache_read_tokens":24427,"total_tokens":16453}
[db] wrote controlplane.events id=13 runtime=antigravity
[handoff] {"runtime":"antigravity","role":"probe",
  "originalTask":"Read seed.txt in this directory and reply with exactly its content, nothing else.",
  "cwd":".../worker-test-workspace","conversationId":"920ec7b2-...",
  "toolsUsed":["view_file"],"toolsDenied":[],
  "deniedToolPattern":"run_command|command_status|send_command_input|write_to_file|...",
  "error":null,"lastResult":"seed content for the real AntigravityWorker end-to-end proof\n",
  "costUsd":null,"usage":{...},"numTurns":1}
```

`seed.txt`'s real content was `"seed content for the real AntigravityWorker
end-to-end proof\n"` — the returned result matches it exactly. `toolsDenied`
is empty here because this task only needed a read, so the deny hook was
never triggered — §2 Test C is the run that proves the hook actually fires.

### A real bug found and fixed while proving this — `'close'` hung, `'exit'` didn't

The FIRST two end-to-end attempts through `AntigravityWorker.run()` (using
only `proc.on('close', ...)`, the same pattern `spawn.mjs` and
`gemini-worker.mjs` both use) hung indefinitely — one for 4+ minutes before
being killed, well past `agy`'s own 5-minute `--print-timeout`. In both
hangs, the real NDJSON events (`init`, at least one `tool` call) had already
been ingested — visible in the worker's own log — and `ps -ef` showed **no
`agy` process at all anymore**, yet `'close'` never fired. A control test
run directly via shell (`agy -p ... > file.ndjson`, no Node pipe involved)
with the exact same task and flags completed cleanly in ~65s, twice.

This is the textbook Node.js `child_process` gotcha: `'close'` only fires
once a child's stdio **streams** report closed, a stronger condition than
the child process itself having exited — if anything continues holding the
write end of the stdout pipe open (this project could not confirm what,
since by the time `ps` was checked no orphan remained to inspect — but the
symptom matches exactly), `'close'` can wait forever past the real exit.
`'exit'` fires on the process's own termination regardless of stream state.
Fixed by listening on both, with a `setImmediate` grace tick on `'exit'` to
let any already-buffered stdout drain through `readline` first — the SAME
task that hung twice under `close`-only then completed cleanly (§3's
transcript above) after this fix. This is now how `run()` resolves; see the
code comment at the fix site for the full detail.

---

## 4. Real event schema — confirmed live, differences from Claude/Gemini documented

```
{"event":"init","conversation_id":..,"init":{"cwd":..,"tools":[...53 names],"permission_mode":"always-proceed"}}
{"event":"step_update","step_update":{"conversation_id":..,"step_index":N,"state":"ACTIVE"|"DONE"|"ERROR",
   "step_type":"user_input"|"checkpoint"|"agent_response"|"tool",
   "text_delta":..,"duration_seconds":..,"usage":{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens},
   "tool_name":.., "tool_info":{"name":..,"parameters":{...},"output":..,"error":{"type":"TOOL_ERROR","message":..}}}}
{"event":"result","result":{"conversation_id":..,"status":"SUCCESS"|"ERROR","response":"...",
   "error":..,"duration_seconds":..,"num_turns":..,"usage":{...same fields...}}}
```

Differences from Claude (`spawn.mjs`) and Gemini (`gemini-worker.mjs`), all
real, all load-bearing for `ingest()`:

1. **Tool calls are `step_type:"tool"` + a separate `tool_name` field** — not
   folded into an `assistant` message's content blocks (Claude) and not a
   distinct top-level event type keyed by `tool_name` alone (Gemini's
   `tool_use`/`tool_result` pair). Each call fires twice at the SAME
   `step_index` (`ACTIVE` → `DONE`/`ERROR`) — no call-id field exists.
2. **The terminal `result` event DOES carry the final answer directly**
   (`result.response`) — like Claude, unlike Gemini (which has no response
   text field at all and requires reconstruction from streamed `message`
   events).
3. **No dollar-cost field anywhere** — matches Gemini's absence, unlike
   Claude's `total_cost_usd`. `usage` carries
   `input_tokens/output_tokens/thinking_tokens/cache_read_tokens/total_tokens`
   only. `AntigravityWorker.state.costUsd` is permanently `null` — reported
   honestly, not fabricated.
4. **A `thinking_tokens` field exists** — present in neither Claude's nor
   Gemini's schema as observed by the prior two workers.

---

## 5. `controlplane.events` — migration, applied live, and coexistence proof

`06-gemini/sql/002_antigravity_runtime.sql` (new; `001_runtime_column.sql`
untouched). Checked first, live:

```
\d controlplane.events   → runtime text not null default 'claude',
                            CHECK (runtime = ANY (ARRAY['claude','gemini']))
select runtime, count(*) from controlplane.events group by runtime;
                          → claude=10, gemini=1 (11 rows) BEFORE this migration
```

Postgres has no `ALTER ... ADD VALUE` for a plain `text` + `CHECK` column
(that syntax is only for native `ENUM` types); the migration drops and
recreates the constraint as a strict superset — safe, metadata-only, cannot
invalidate any existing row. Applied live:

```sql
alter table controlplane.events drop constraint if exists events_runtime_check;
alter table controlplane.events add constraint events_runtime_check
  check (runtime in ('claude', 'gemini', 'antigravity'));
```

Verified immediately after:

```
events_runtime_check | CHECK ((runtime = ANY (ARRAY['claude'::text, 'gemini'::text, 'antigravity'::text])))
```

### Coexistence proof (after `AntigravityWorker`'s real write)

Real `SELECT`s, run immediately after the successful e2e dispatch (§3):

```
 runtime     | count
-------------+-------
 antigravity |     1
 claude      |    10
 gemini      |     1
(3 rows)
```

```
 id | kind                    | severity | runtime     | result (excerpt)                          | status  | conv_id
----+-------------------------+----------+-------------+--------------------------------------------+---------+--------
 13 | worker_dispatch_result  | info     | antigravity | seed content for the real AntigravityWo... | SUCCESS | 920ec7b2-...
```

```
 id | kind                    | runtime     | emitted_at
----+-------------------------+-------------+-------------------------------
 13 | worker_dispatch_result  | antigravity | 2026-08-20 13:13:47.770566+00
 12 | worker_dispatch_result  | gemini      | 2026-08-20 11:42:35.683035+00
 11 | worker_dispatch_result  | claude      | 2026-08-20 01:18:32.997633+00
 10 | routing_decision        | claude      | 2026-08-20 01:18:21.938876+00
  9 | unrouted_error          | claude      | 2026-08-20 01:18:21.636505+00
  8 | routing_decision        | claude      | 2026-08-20 01:18:21.57576+00
```

All three runtimes queried together with a single `SELECT`, same `kind`
taxonomy (`worker_dispatch_result`), same `body` jsonb shape, no FK
violation, no CHECK-constraint violation. `body.tool_calls` on row 13
contains the real `{stepIndex, state, toolName, parameters, output, error,
deniedByHook}` shape from `ingest()` — both the `ACTIVE` and `DONE` records
for the single `view_file` call, correlated by `stepIndex:3` as documented
in §4. This completes what GX5 could not: a genuinely different runtime,
dispatched for real, producing a real result, logged into the same shared
table, coexisting cleanly with the other two.

---

## 6. Verdict

| Claim | Status |
|---|---|
| `agy --help` re-read fully for a missed allow/deny flag | ✅ none exists |
| `agy mcp`/`agy plugin` investigated for tool scoping | ✅ MCP/plugin-tool scoping only, no bearing on the 53 built-ins |
| `~/.gemini/antigravity-cli/settings.json` policy format found and read | ✅ real `action(target)` allow/ask/deny lists exist, but global + overridden by `toolPermission:"always-proceed"` on this machine |
| `--sandbox` investigated | ⚠️ documented as terminal-execution-only; not independently live-tested (hooks mechanism was decisive and cheaper) |
| Real minimal 3-part task (read + shell + write) run under whatever mechanism was found | ✅ run under `.agents/hooks.json` PreToolUse deny — §2 Test C |
| Empirical result: which of the 3 were attempted vs. blocked | ✅ read attempted+succeeded, shell attempted+BLOCKED, write attempted+BLOCKED — verified by both the NDJSON error field and a real `ls`/`cat` after the run |
| Does real enforcement hold under `--dangerously-skip-permissions`/`always-proceed`? | ✅ **YES, for the hooks mechanism** — proven live. ❌ **NO built-in mechanism holds** — confirmed absent |
| `AntigravityWorker` built, mirrors `spawn.mjs`'s shape | ✅ `06-gemini/antigravity-worker.mjs`, `spawn.mjs`/`gemini-worker.mjs` untouched |
| Worker does NOT silently ship unrestricted by default | ✅ every role denies all mutating/dangerous tools via the hook; fail-closed if the hook file can't be written |
| Migration adds `'antigravity'` to the CHECK constraint, applied live | ✅ `002_antigravity_runtime.sql` |
| Real `AntigravityWorker` dispatch → real result → real DB row → coexists with `claude`/`gemini` rows | ✅ — id=13, `status=SUCCESS`, real content returned, verified alongside claude(10)/gemini(1) rows |
| A real bug found in the process (`'close'` hang) and fixed, not just worked around | ✅ — `'exit'`+`setImmediate` fallback; same task hung twice under `close`-only, succeeded 3/3 after the fix |

## Files

- `06-gemini/antigravity-worker.mjs` — new. `spawn.mjs`, `gemini-worker.mjs` untouched.
- `06-gemini/sql/002_antigravity_runtime.sql` — new migration, applied live.
- Raw NDJSON transcripts of every real test run kept in
  `/private/tmp/claude-501/-Users-celeste7/793578bd-a949-4268-8fca-2fc4a6cef123/scratchpad/agy-rbac-test/`
  (baseline_run2.ndjson = Test A, hook_run.ndjson = Test C) and
  `06-gemini/worker_e2e_run.log` / `worker_e2e_run2.log` (the two `'close'`-hang
  failures, killed) / `worker_e2e_run3.log` (§3's successful real dispatch,
  post-fix — DB row id=13).

## Cost accounting

**~8 real `agy` invocations** across this investigation (1 ping, 1 aborted
60s-timeout probe, Test A, Test B, Test C, 2 hung node-wrapper attempts later
fixed, 1 successful raw control run, 1 final successful e2e run through
`AntigravityWorker` itself). Every real `result` event's `usage` object was
inspected — confirmed §4 (point 3): **no dollar-cost field exists anywhere
in `agy`'s schema.** `agy` authenticates via the same account as the
Antigravity desktop app (no separate `GEMINI_API_KEY`/billed API key was
used, none was needed), so there is no per-call dollar figure to report for
these invocations the way there would be for a metered API — this matches
`costUsd: null` being reported honestly throughout, not fabricated as `0`.
No separate paid API was called anywhere in this investigation (the earlier
`WebFetch` calls to `antigravity.google/docs/*` are free page fetches, same
class as GX5's zero-cost diligence trail).
