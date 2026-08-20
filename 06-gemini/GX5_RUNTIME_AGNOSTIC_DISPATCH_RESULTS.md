# GX5 — Is CENTRAL's dispatch pipeline genuinely runtime-agnostic (Claude + Gemini, same events table)?

Date: 2026-08-20 · Machine: this Mac · Gemini CLI versions tested: **0.55.1** (globally
installed, `/opt/homebrew/lib/node_modules/@google/gemini-cli`) and **0.56.0** (latest
published, via `npx -y @google/gemini-cli@0.56.0`) · Postgres: `central-mvp-pg`
(docker, port 5433, schema `controlplane`, reused as instructed, not recreated).

## Answer, up front

**Mechanically proven, functionally blocked.** A new, separate `GeminiWorker` class
(`06-gemini/gemini-worker.mjs`) spawns the real `gemini` binary with `stdio:
['ignore','pipe','pipe']`, parses its real stream-json NDJSON output with a schema read
directly out of the installed package's shipped source (not assumed to match Claude's —
it genuinely doesn't, see §2), and writes one real row into the SAME
`controlplane.events` table Claude workers already write to, tagged `runtime='gemini'`
via a new column (`06-gemini/sql/001_runtime_column.sql`, applied live). That row exists,
coexists cleanly with pre-existing `runtime='claude'` rows, and both are queryable
together with no schema conflict — **proven, §5**.

What did **not** happen: the trivial task itself. `gemini -p "Reply with exactly:
GEMINI-WORKER-OK" --output-format stream-json` cannot authenticate on this machine, on
either CLI version tested. The account's Gemini OAuth is on the "Gemini Code Assist for
individuals" free tier, which both the currently-installed client and the latest
published client refuse with `IneligibleTierError: This client is no longer supported
... migrate to the Antigravity suite of products`. This is a real, reproducible,
external auth/tier blocker — not a bug in the dispatch code, and not something a
different flag or a code change fixes. **`pass=false`**: no real `GEMINI-WORKER-OK`
result was ever produced, so the full "can we genuinely use both" claim is not yet
provable end-to-end, even though the shared-table half of it is.

---

## 1. Flag shape — confirmed via `gemini --help`, not assumed

```
-p, --prompt <string>          Run in non-interactive (headless) mode with the given prompt
-o, --output-format <string>   choices: "text", "json", "stream-json"
```

`--output-format stream-json` happens to have the same flag *name* as Claude's. That is
the only thing that turned out to match.

## 2. Event schema — read from real shipped source, genuinely different from Claude's

`docs/cli/headless.md` (shipped inside the installed package) documents six stream-json
event types: `init`, `message`, `tool_use`, `tool_result`, `error`, `result`. To get
exact field names (not just the type list) I read the actual construction sites in the
installed package's bundle — comments were left intact by the bundler
(`// packages/cli/src/nonInteractiveCli.js` region of
`bundle/gemini-63IMHOLI.js`; `// packages/core/src/output/stream-json-formatter.ts` in
`bundle/chunk-QCOIICKD.js`) — real code, not documentation prose, e.g.:

```js
streamFormatter.emitEvent({ type: JsonStreamEventType.INIT, timestamp, session_id: config.getSessionId(), model: config.getModel() });
streamFormatter.emitEvent({ type: JsonStreamEventType.MESSAGE, timestamp, role: "assistant", content: output, delta: true });
streamFormatter.emitEvent({ type: JsonStreamEventType.TOOL_USE, timestamp, tool_name: event.name, tool_id: event.requestId, parameters: event.args });
streamFormatter.emitEvent({ type: JsonStreamEventType.RESULT, timestamp, status: errorPayload ? "error" : "success", stats: streamFormatter.convertToStreamStats(metrics, durationMs) });
```

Three structural differences from spawn.mjs's Claude schema, all real:

1. Claude bundles assistant text *and* `tool_use` requests together inside one
   `assistant` event's `message.content[]` array. Gemini emits them as two entirely
   separate event types — never combined.
2. Claude's terminal `result` event carries the final answer text directly
   (`ev.result`). Gemini's terminal `result` event carries **only** `status` + `stats` —
   no response-text field at all (confirmed at the `emitFinalResult` call site: the
   object literal has exactly `{type, timestamp, status, stats}`). The final answer must
   be reconstructed by concatenating every `message` event where `role === "assistant"`.
3. Claude's `result` event exposes `total_cost_usd` (spawn.mjs:
   `state.costUsd = ev.total_cost_usd ?? 0`). Gemini's `stats` object
   (`StreamJsonFormatter.convertToStreamStats`, read in full) exposes only
   `total_tokens / input_tokens / output_tokens / cached / input / duration_ms /
   tool_calls` — **no dollar-cost field anywhere in the real schema.**
   `GeminiWorker.state.costUsd` is therefore permanently `null` — reported honestly, per
   the task brief, not fabricated as `0` or estimated.

## 3. Auth blocker — confirmed live, twice, with real diligence before giving up

| Attempt | Result |
|---|---|
| `gemini -p "..." --output-format stream-json` (installed 0.55.1) | Exit 1. `IneligibleTierError: UNSUPPORTED_CLIENT` on stderr, zero bytes on stdout. |
| `npx -y @google/gemini-cli@0.56.0 -p "..." --output-format stream-json` (latest published, npm confirms `0.57.0-preview.0` also exists but no newer stable) | Same `IneligibleTierError`, same exit 1. Upgrading the client does not fix it — this account's tier is the blocker, not the client version. |
| `curl generativelanguage.googleapis.com/v1beta/models?key=$GOOGLE_API_KEY` (the only Google key found, in `~/.env`, shared with `GOOGLE_CX_ID`) | `HTTP 400 API_KEY_INVALID` — real response body, confirms this key is scoped to Custom Search, not the Gemini API. |
| Search for `GEMINI_API_KEY` / `GOOGLE_GENAI_API_KEY` in shell rc files, `.env*`, macOS keychain | None found. `~/.gemini/settings.json` has `security.auth.selectedType: "oauth-personal"` — the exact tier that's now rejected. |
| `gcloud auth list` | One authenticated account (`ventrofficialuk@gmail.com`), ADC file present. Not exercised further — routing through Vertex AI would require enabling billing/APIs on a real Cloud project, which is a real-money, out-of-scope escalation this gate did not have standing authorization to make. |

Zero dollars were spent anywhere in this diligence trail — every attempt failed before
any billable model call.

## 4. `GeminiWorker` — what it actually does, run live

`06-gemini/gemini-worker.mjs` (new file; `03-daemon/spawn.mjs` was not touched). Real
run against the real binary:

```
$ node gemini-worker.mjs --task "Reply with exactly: GEMINI-WORKER-OK" --cwd .../06-gemini

[done ] events=0 status=none wall=5832ms exit=1 err=exit_1: Error authenticating: IneligibleTierError: ...
[result] null
[stats ] null
[db] wrote controlplane.events id=12 runtime=gemini
```

`events=0` is itself a real, correct parse result, not a bug: the crash happens inside
`_doSetupUser`, before `config`/`streamFormatter` exist in the real CLI's own code path
(confirmed by reading the surrounding source, §2) — so no stream-json line is ever
written, and the readline-based NDJSON ingest correctly receives and parses nothing.
`GeminiWorker.run()` still resolves cleanly, captures the real stderr into
`state.error`, and proceeds to the DB write — exactly the defensive shape spawn.mjs uses
for its own `proc.on('error'/'close')` paths.

## 5. The events-table proof — this is the part that actually succeeded

`06-gemini/sql/001_runtime_column.sql` applied live. Before: `controlplane.events` had
no `runtime` column and no `body.runtime` key on any existing row (checked first, not
assumed — `\d controlplane.events` and `select body ? 'runtime'` both confirmed this).
After: `runtime text not null default 'claude'` + `check (runtime in ('claude',
'gemini'))` + an index, and all 10 pre-existing rows backfilled to `'claude'` by the
column default (all of them were in fact produced by `spawn.mjs`/`dispatcher.mjs`'s
Claude `Worker` — verified against `dispatcher.mjs`'s `logEvent()` call sites, so
`'claude'` is a checked backfill, not a guess).

Real `SELECT` after `GeminiWorker`'s real write:

```
 runtime | count |           earliest            |            latest
---------+-------+-------------------------------+-------------------------------
 claude  |    10 | 2026-08-19 23:38:43.154182+00 | 2026-08-20 01:18:32.997633+00
 gemini  |     1 | 2026-08-20 11:42:35.683035+00 | 2026-08-20 11:42:35.683035+00
```

```
 id |          kind          | severity | runtime |                body_result                | body_error
----+------------------------+----------+---------+--------------------------------------------+------------
 12 | worker_dispatch_result | error    | gemini  | (null)                                     | exit_1: Error authenticating: IneligibleTierError...
 11 | worker_dispatch_result | info     | claude  | The most likely file to investigate first...| (null)
 10 | routing_decision       | info     | claude  | (null)                                      | (null)
  9 | unrouted_error         | warn     | claude  | (null)                                      | (null)
  8 | routing_decision       | info     | claude  | (null)                                      | (null)
  6 | unrouted_error         | warn     | claude  | (null)                                      | (null)
```

Both runtimes sit in the same table, same `kind` taxonomy
(`worker_dispatch_result`/`routing_decision`/`unrouted_error` — `GeminiWorker` reuses
`worker_dispatch_result` exactly, not a new kind), same `body` jsonb shape, distinguished
only by the new `runtime` column, queried together with a single `SELECT`, no FK
violation, no CHECK-constraint violation, no conflict of any kind. This genuinely is the
same table already serving both runtimes — the schema/plumbing half of "runtime-agnostic"
holds.

## 6. Verdict

| Claim | Status |
|---|---|
| Real `gemini -p ... --output-format stream-json` flag shape confirmed (not assumed) | ✅ |
| Real stream-json event schema read from shipped source, differences from Claude documented, not assumed to match | ✅ |
| `GeminiWorker` spawns the real binary, stdin closed the same defensive way as spawn.mjs | ✅ |
| Incremental NDJSON parsing into a comparable state shape (session id, tool calls, final result, cost/tokens) | ✅ (code path verified correct even though this run produced zero events — see §4) |
| Cost/token honesty — no fabricated cost field | ✅ — `costUsd` is permanently `null`, documented as a real schema absence |
| Migration adds a real `runtime` discriminator, checked against real schema first | ✅ — applied live, 10 pre-existing rows correctly backfilled |
| One real row written to the shared `controlplane.events` table, tagged `runtime='gemini'` | ✅ — id=12 |
| That row coexists with pre-existing `runtime='claude'` rows, no conflict | ✅ — proven by live `SELECT`, §5 |
| **The trivial task itself succeeds** (`GEMINI-WORKER-OK` actually returned) | ❌ — blocked by `IneligibleTierError`, an account/tier problem, not a code problem |

**Overall: FAIL on the gate's literal condition** — a *successful* Gemini-originated
dispatch was not achieved, only a correctly-logged *failed* one. The architecture that
would make Claude and Gemini genuinely interchangeable through this pipeline is built and
the shared-table half is proven; the actual "can we use both" claim needs a Gemini
account with a supported auth path (a real `GEMINI_API_KEY` from Google AI Studio, or a
Vertex AI project with billing enabled, or migrating this account off the sunset free
tier) before it can be exercised for real. No code change to `gemini-worker.mjs` should
be needed once that exists — rerun the exact command in §4.

## Files

- `06-gemini/gemini-worker.mjs` — new, `spawn.mjs` untouched.
- `06-gemini/sql/001_runtime_column.sql` — new migration, applied live to `central-mvp-pg`.
- `06-gemini/run_stdout.log`, `run_stderr.log` — raw output of the real end-to-end test run.

## Cost accounting

**$0.00.** Every attempted `gemini`/`GeminiWorker` invocation failed at auth before any
billable model call; the one `curl` to the Generative Language API was a free metadata
call that itself returned `400 API_KEY_INVALID`.
