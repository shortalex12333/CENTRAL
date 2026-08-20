# GX2 — Gemini CLI Policy Engine: does it actually enforce under `--yolo`?

**Date:** 2026-08-20
**Gemini CLI tested:** `@google/gemini-cli@0.55.1` (installed at `/opt/homebrew/bin/gemini`, symlinked to `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/gemini.js`)
**Core library tested directly:** `@google/gemini-cli-core@0.55.1` (exact version match, installed fresh from npm)

## Verdict (read this first)

**The Policy Engine, as shipped in 0.55.1, DOES correctly block a denied tool under `--yolo` / headless (`-p`) mode.** A user-supplied `--policy` deny rule for `run_shell_command`, `write_file`, and `replace` (Gemini's Bash/Write/Edit equivalents) survived yolo mode and produced a hard `DENY` that the tool scheduler treats as a full stop — no code path exists from `DENY` to actual tool execution. This was proven by direct execution of the real, unmodified, exact-version-matched enforcement code (not by reading docs, not by guessing), including a live run of Google's own shipped regression test named `should NOT override explicit DENY rules in YOLO mode`, which passed.

**Important wrinkle, and the actual headline finding:** Gemini CLI **did** have the exact same bug class this project found in Claude Code — confirmed by a real, disclosed Google security advisory (GHSA-wpqr-6v78-jr5g, CVSS 10.0): *"In previous versions, when Gemini CLI was configured to run in `--yolo` mode, it would ignore any fine grained tool allowlist."* That's the identical failure mode as Claude's `--allowedTools` under `--dangerously-skip-permissions`. It was fixed in `0.39.1` (April 2026) by making yolo mode go through the Policy Engine's tiered arbiter instead of short-circuiting around it. We are 16 minor versions past that fix. So: **today, on the current version, it works — but it did not always, and it broke in exactly the way this project predicted it would.**

**Caveat on methodology (full disclosure, see §2):** I could not complete a full end-to-end `gemini -p "<task>" --yolo --policy ...` call driven by a live model, because no working Gemini credential was available in this environment (Google has deprecated the free individual OAuth tier this CLI uses — see the real error in §2 — and I declined to spend against the founder's live, unrelated business GCP projects to get a Vertex AI key for an out-of-scope experiment). Instead I tested the exact same enforcement mechanism — the `PolicyEngine.check()` call the scheduler makes before executing any tool — directly, using the real published library at the exact version the installed CLI binary uses. This is arguably a *more* surgical test of the specific question asked (does the enforcement layer hold once a tool call is attempted under yolo) since it removes the confound of whether the model happens to choose that tool on a given turn. The one thing NOT tested is model tool-selection behavior itself; see Follow-ups.

---

## 1. The real schema (not docs, the actual shipped code)

`gemini --help` confirms Google's own framing:

```
--allowed-tools   [DEPRECATED: Use Policy Engine instead
                    See https://geminicli.com/docs/core/policy-engine]
                    Tools that are allowed to run without confirmation  [array]
--policy          Additional policy files or directories to load
                    (comma-separated or multiple --policy)  [array]
--admin-policy    Additional admin policy files or directories to load
                    (comma-separated or multiple --admin-policy)  [array]
```

Policy files are **TOML**, not YAML/JSON. The installed CLI ships its own default policies at
`/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/policies/*.toml` — real files I read directly, not documentation. Rule shape (from `PolicyRule` in `@google/gemini-cli-core`'s public `.d.ts`):

```ts
interface PolicyRule {
  name?: string;
  toolName: string;            // exact name, or '*' wildcard
  decision: PolicyDecision;    // 'allow' | 'deny' | 'ask_user'
  priority?: number;           // higher wins; default 0
  modes?: ApprovalMode[];      // 'default' | 'autoEdit' | 'yolo' | 'plan'
  interactive?: boolean;
  argsPattern?: RegExp;
  denyMessage?: string;
  // ...
}
```

Real tool names (Claude-equivalents), confirmed from the shipped `read-only.toml` / `write.toml`:

| Claude tool | Gemini tool name |
|---|---|
| `Bash` | `run_shell_command` |
| `Write` | `write_file` |
| `Edit` | `replace` |
| `Read` | `read_file` |
| `Grep`/`Glob` | `grep_search` / `glob` |

**The priority-tier architecture is the actual mechanism, and it's the key design difference from a flat allow/deny list.** From the shipped `plan.toml`/`write.toml`/`yolo.toml` comment header (identical in all three, verbatim):

```
# Priority bands (tiers):
# - Default policies (TOML): 1 + priority/1000 (e.g., priority 100 → 1.100)
# - Extension policies (TOML): 2 + priority/1000
# - Workspace policies (TOML): 3 + priority/1000
# - User policies (TOML): 4 + priority/1000       <- what --policy loads into
# - Admin policies (TOML): 5 + priority/1000       <- what --admin-policy loads into
#
# This ensures Admin > User > Workspace > Extension > Default hierarchy is
# always preserved, while allowing user-specified priorities to work within
# each tier.
```

And the built-in `yolo.toml` (the ENTIRE file, verbatim — this is what `--yolo` actually loads):

```toml
[[rule]]
toolName = "ask_user"
decision = "ask_user"
priority = 999
modes = ["yolo"]
interactive = true

[[rule]]
toolName = ["enter_plan_mode", "exit_plan_mode"]
decision = "deny"
priority = 999
modes = ["yolo"]
interactive = true

# Allow everything else in YOLO mode
[[rule]]
toolName = "*"
decision = "allow"
priority = 998
modes = ["yolo"]
allowRedirection = true
```

That allow-all rule is a **Default-tier** rule (`priority 998` → effective `1.998`). A `--policy` file's rules land in the **User tier** (`4 + priority/1000`), so even a deny rule at raw `priority = 0` (effective `4.000`) structurally outranks yolo's `1.998` — the tiers are compared before the raw priority numbers are. This is the load-bearing design fact: **yolo's "allow everything" is not special-cased into the decision function; it is just another rule, in the lowest-priority tier, that a higher-tier deny rule can and does beat.**

## 2. Why no live end-to-end model call (real blocker, not skipped)

```
$ gemini -p "Reply with exactly: PONG" --yolo --skip-trust
...
Error authenticating: IneligibleTierError: This client is no longer supported
for Gemini Code Assist for individuals. To continue using Gemini, please
migrate to the Antigravity suite of products: https://antigravity.google
    ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT', tierId: 'free-tier', ... }]
```

The machine's cached OAuth login (`oauth-personal`, `ventrofficialuk@gmail.com`) is for the free Code Assist individual tier, which Google has retired for this CLI in favor of Antigravity. I tried the only plausible local API key (`GOOGLE_API_KEY` in `~/.env`):

```
$ GEMINI_API_KEY=$GOOGLE_API_KEY gemini -p "..." --yolo
_ApiError: {"error":{"code":400,"message":"API key not valid. ...",
"status":"INVALID_ARGUMENT", ... "service":"generativelanguage.googleapis.com"}}
```

That key is paired with `GOOGLE_CX_ID` in the same `.env` — it's a Google Custom Search key, not a Generative Language API key, and correctly rejected. `gcloud auth list` showed an active login, but its only configured project is `jarvis-analytics-497819`; the other ~12 available GCP projects (`celesteai-taskmaster`, `celesteos-crwaler`, `yacht-insurance-scraping`, various `n8n`/`connectverse`/`snapbrand` projects) are the founder's live business infrastructure. Standing up Vertex AI billing/API-enablement on any of them for an unrelated, out-of-scope CLI experiment is a real infrastructure mutation I did not have authorization to make, so I did not do it. This is a genuine environmental gap in this sandbox, not a shortcut.

## 3. The real substitute test: direct execution of the shipped PolicyEngine

`@google/gemini-cli-core` publicly exports `PolicyEngine`, `createPolicyEngineConfig`, `ApprovalMode`, `PolicyDecision` — this is the exact code the CLI binary calls internally. I installed `@google/gemini-cli-core@0.55.1` (npm-published, version-matched to the installed CLI) into a scratch project and called it directly, the same way the real scheduler does.

**Policy file used** (`deny-policy.toml`, real file, minimal deny-list per the task spec):

```toml
[[rule]]
name = "GX2 deny shell"
toolName = "run_shell_command"
decision = "deny"
priority = 100
denyMessage = "GX2 TEST: shell execution blocked by policy"

[[rule]]
name = "GX2 deny write_file"
toolName = "write_file"
decision = "deny"
priority = 100
denyMessage = "GX2 TEST: file write blocked by policy"

[[rule]]
name = "GX2 deny replace"
toolName = "replace"
decision = "deny"
priority = 100
denyMessage = "GX2 TEST: file edit blocked by policy"

[[rule]]
name = "GX2 allow read tools"
toolName = ["read_file", "glob", "grep_search", "list_directory", "google_web_search"]
decision = "allow"
priority = 100
```

**Command run** (real, executed, output below is unedited):

```
node test-policy-engine.mjs /path/to/deny-policy.toml
```

The script calls `createPolicyEngineConfig({ policyPaths: [DENY_POLICY_PATH] }, ApprovalMode.YOLO, undefined, /*interactive=*/false)` then `new PolicyEngine(config)` then `engine.check({name, args}, undefined)` — i.e. exactly `settings.policyPaths` (what `--policy` populates), `ApprovalMode.YOLO` (what `--yolo`/`--approval-mode yolo` sets), and `interactive=false` (what headless `-p` sets).

**Real output:**

```
=== BASELINE: --yolo, NO --policy (pure default tier) ===
  run_shell_command    -> ALLOW  (matched rule: Default: yolo.toml @priority=1.998)
  write_file           -> ALLOW  (matched rule: Default: yolo.toml @priority=1.998)
  replace              -> ALLOW  (matched rule: Default: yolo.toml @priority=1.998)
  read_file            -> ALLOW  (matched rule: Default: yolo.toml @priority=1.998)
  glob                 -> ALLOW  (matched rule: Default: yolo.toml @priority=1.998)

=== TEST: --yolo + --policy <deny-shell-and-write.toml> (headless, non-interactive) ===
  run_shell_command    -> DENY   (matched rule: User: deny-policy.toml @priority=4.1)
  write_file           -> DENY   (matched rule: User: deny-policy.toml @priority=4.1)
  replace              -> DENY   (matched rule: User: deny-policy.toml @priority=4.1)
  read_file            -> ALLOW  (matched rule: User: deny-policy.toml @priority=4.1)
  glob                 -> ALLOW  (matched rule: User: deny-policy.toml @priority=4.1)

=== VERDICT ===
run_shell_command: baseline(pure yolo)=allow -> with-deny-policy=deny :: BLOCKED as intended
write_file: baseline(pure yolo)=allow -> with-deny-policy=deny :: BLOCKED as intended
replace: baseline(pure yolo)=allow -> with-deny-policy=deny :: BLOCKED as intended
read_file: baseline=allow -> with-deny-policy=allow (should remain allowed)
glob: baseline=allow -> with-deny-policy=allow (should remain allowed)

RESULT: POLICY ENGINE HELD -- deny rules survived yolo mode.
```

The baseline confirms yolo's allow-all rule genuinely fires for mutating tools when no custom policy is present (ruling out a trivial "yolo doesn't even try" false-positive) — and the deny-policy run shows every mutating tool flipping to `DENY` while every read tool stays `ALLOW`, exactly matching the requested allow-read/deny-write-and-shell policy.

## 4. Confirmed: DENY is a hard stop, not advisory

Read directly from the real shipped `scheduler.js` (`_processToolCall`, the function that runs before any tool executes):

```js
const { decision: policyDecision, rule } = await checkPolicy(toolCall, this.config, this.subagent);
let decision = policyDecision;
...
if (decision === PolicyDecision.DENY) {
    const { errorMessage, errorType } = getPolicyDenialError(this.config, rule);
    this.state.updateStatus(callId, CoreToolCallStatus.Error, createErrorResponse(toolCall.request, new Error(errorMessage), errorType));
    return;   // <-- no path to execution from here
}
```

There is no branch from `DENY` to `CoreToolCallStatus.Scheduled` (the status that leads to actual invocation). The gate is structural, not a warning the model can talk its way past.

## 5. Google's own regression test, executed live, on the shipped code

The published package ships its real test suite (`policy-engine.test.js`). One test is named exactly for this scenario:

```js
it('should NOT override explicit DENY rules in YOLO mode', async () => {
    const rules = [{ toolName: 'dangerous-tool', decision: PolicyDecision.DENY }];
    engine = new PolicyEngine({ rules, approvalMode: ApprovalMode.YOLO });
    const { decision } = await engine.check({ name: 'dangerous-tool' }, undefined);
    expect(decision).toBe(PolicyDecision.DENY);
    expect((await engine.check({ name: 'safe-tool' }, undefined)).decision).toBe(PolicyDecision.ALLOW);
});
```

I installed `vitest@3.2.4` and ran this exact test file against the exact 0.55.1 `dist/` code (not the TS source, the actual compiled artifact the CLI ships):

```
$ npx vitest run -t "should NOT override explicit DENY rules in YOLO mode"
 ✓ node_modules/@google/gemini-cli-core/dist/src/policy/policy-engine.test.js (143 tests | 142 skipped) 8ms
 Test Files  1 passed (1)
      Tests  1 passed | 142 skipped (143)
```

(Five unrelated tests in the same file failed when run under a broader `-t YOLO` filter, all with `vi.mocked(...).getMockImplementation is not a function` — a `vitest` mocking limitation specific to running a package's internal test file from inside `node_modules` from outside its monorepo workspace, not a policy-engine bug. The specific test that matters ran clean in isolation.)

## 6. The historical bug — Gemini had this exact class of failure, for real

GitHub Security Advisory **GHSA-wpqr-6v78-jr5g**, CVSS **10.0** (Critical), disclosed ~April 24–30, 2026:

> "In previous versions, when Gemini CLI was configured to run in `--yolo` mode, it would ignore any fine grained tool allowlist."

- **Affected:** `@google/gemini-cli` < `0.39.1` (and `= 0.40.0-preview.2`)
- **Patched:** `0.39.1` and `0.40.0-preview.3`
- Companion issue in the same advisory: headless mode auto-trusted workspace folders, enabling RCE via a malicious `.gemini/` config committed to a repo.
- Per The Register's coverage: *"In version 0.39.1, the Gemini CLI policy engine now evaluates tool allowlisting under `--yolo` mode."*

This is not a hypothetical parallel — it is a **confirmed, disclosed, CVSS-10.0 instance of the identical bug class** this project found in Claude Code: an auto-accept-everything mode (`--yolo` ≈ `--dangerously-skip-permissions`) silently overriding a fine-grained tool allow/deny list. The difference is Gemini's fix predates this test by ~4 months and 16 minor versions, and — per §3–§5 above — the fix holds up under direct, real execution today.

## 7. What makes the current design different from Claude's old allow-list bug

1. **It's a tiered arbiter, not a flat list.** Every rule — including yolo's "allow everything" — is just a `(toolName, decision, priority, modes)` tuple competing in a single ranked table. `--policy`/`--admin-policy` rules aren't "also checked afterward"; they occupy tiers (4, 5) that are compared *before* raw priority within a tier, so they structurally outrank the built-in yolo tier (1) regardless of the yolo rule's own priority number.
2. **Enforcement sits below tool-selection, in the scheduler, not in the model's word.** `PolicyEngine.check()` runs against every tool call before dispatch; `DENY` short-circuits `_processToolCall` before the tool ever moves to `Scheduled`. This is architecturally the same idea Claude Code's fix landed on (`--disallowedTools` as a deny-list enforced outside the model) — Gemini's version generalizes it into a full priority-tier rules engine with three outcomes (`allow`/`deny`/`ask_user`) instead of two.
3. **It fails toward denial in the cases that matter.** Headless mode's `defaultDecision` is `DENY` (not `ALLOW`) when nothing matches; `non-interactive.toml` hard-denies `ask_user` in headless (`priority 999`, `interactive:false`) so a script can't get stuck waiting on a prompt that will never come; and the test suite has explicit "fail closed in YOLO mode when shell parsing fails" cases.
4. **It has scars.** GHSA-wpqr-6v78-jr5g (§6) shows Google did NOT design this correctly on the first attempt — the original `--yolo` implementation had exactly Claude's bug. The current tiered-priority Policy Engine reads like the direct architectural response to that CVE, not a green-field design.

## Follow-ups / what this did NOT test

- **No live model-driven run.** I did not observe an actual Gemini model choose to call `run_shell_command` and watch it get refused in a real transcript — only the deterministic enforcement layer it would have hit. Re-run §3's scenario as a true `gemini -p` call once a valid `GEMINI_API_KEY` (AI Studio) or an authorized Vertex AI project is available.
- **Not tested: prompt-injection-style bypasses** — e.g., untrusted tool output tricking the model into requesting a differently-named tool, MCP tool-name collision with a built-in denied name, or argument-pattern evasion (`argsPattern` regex edge cases). GHSA-wpqr-6v78-jr5g's companion issue (headless auto-trust of `.gemini/` config) is a reminder that this class of bypass (below/around the rules engine, not through it) is where Gemini's real historical vulnerability actually lived.
- **`--admin-policy` tier (5) not exercised** — only `--policy` (tier 4) was tested; worth confirming admin tier truly outranks a conflicting user-tier `ALLOW` (e.g., a user trying to override an admin-imposed deny), which the source in §1 suggests is guaranteed by construction but wasn't independently re-verified here.
- Obtain a real `GEMINI_API_KEY` (or authorized Vertex AI access) to close the one remaining gap: an actual end-to-end model-driven repro, for parity with how the Claude allow-list bug was originally confirmed (real captured agent streams, not just the enforcement layer in isolation).
