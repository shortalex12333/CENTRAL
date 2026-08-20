# F3 — CARL + tier-0.5 validated against REAL stream-json, not fixtures

Date: 2026-08-19
Closes the gap flagged in `G3_RESULTS.md`'s own follow-up: *"This test used fabricated fixtures... It has not been validated against a REAL rotted Claude Code session's actual compacted event stream — do that next."* Same gap independently flagged for tier-0.5: `spawn.unit-test.mjs` (7/7) feeds only hand-fabricated `toolUse()`/`toolResult()` objects into `Worker.ingest()`, never a real subprocess-produced event.

## Step 0 — checked existing real logs first (cost-consciousness gate)

Per project standing discipline ("do not re-run a real/costly action just to produce a file"), every real stream-json log already on disk from this session was inspected **before** spending anything new:

`logs/{t1_streamjson,conc_1..5,resume_test1,resume_test2,t2_lean}.ndjson`, `02-forge/results/g2_raw_report.json`, `02-forge/results/g5_dispatcher.log` / `g5_ingest.log`.

Result: **all 9 ndjson logs are single-turn, zero-tool-call successes** (`"result".num_turns == 1`, no `tool_use` blocks at all — `PONG`, `AGENT-1..5`, `OK`, `42`). The `g5_*` logs likewise show `tool_calls: []` on every dispatched worker (one-shot text answers). None contain any repetition, error, or multi-turn exploration to test tier-0.5 or CARL against — confirmed by `jq` type/tool-name/`is_error` tallies over every file, not by inspection alone. This satisfies the task's explicit "ONLY IF none of the existing real logs contain any interesting pattern" condition for spending fresh cost.

## Step 1 — 2 real haiku probe calls via spawn.mjs's own `Worker` class

Both used `role: 'probe'` exactly as `spawn.mjs` defines it, spawned via `new Worker({...}).run()` (real subprocess, real `claude -p --output-format stream-json`), **not** instructed to loop — each given one genuinely underspecified, plausible, read-only task over this repo where the target file does not exist:

| # | Task | Turns | Tool calls | Cost |
|---|---|---|---|---|
| 1 | "Find the CHANGELOG file... tell me the latest version." (no CHANGELOG exists in CENTRAL) | 8 | `Bash×6, Read×1` — 7 **distinct** fingerprints | $0.0476 |
| 2 | "Read `03-daemon/rot_thresholds.json`... tell me `hard_stop_at`." (file does not exist) | 5 | `Read×1 (errored), Bash×3` — 4 **distinct** fingerprints | $0.0364 |

Raw stream-json captured to `logs/f3_real_probe.ndjson` (67 lines) and `logs/f3_real_probe2.ndjson` (46 lines). Total fresh spend: **$0.0840** (2 haiku calls, well under the 2-call cap).

**Real, unfabricated ground truth in both:** the agent explored a handful of plausible paths/searches, never repeated an identical tool call, and terminated cleanly with a `result` event stating it couldn't find the file and asking how to proceed. Probe 2 additionally produced one genuinely real `tool_result.is_error: true` (Read on a nonexistent path — `"File does not exist..."`), the exact code path tier-0.5 added this session and which the unit test could only fabricate. Both are **healthy, non-pathological** sessions by any reasonable read — not loops, not runaways, not silent failures.

Unplanned but noteworthy: role `probe` in `spawn.mjs` scopes `tools: ['Read']` only, yet both real runs used `Bash` (6× and 3× respectively). `spawn.mjs` always passes `--dangerously-skip-permissions` alongside `--allowedTools`; this real run is direct evidence that flag causes the CLI to skip enforcement of the `--allowedTools` allowlist entirely, not just the confirmation prompt. `spawn.mjs`'s own comment calls `ROLES` "the RBAC matrix AND the cost control — one mechanism" (line 17) — this observation contradicts that on real data. Flagged as a follow-up below; out of scope to chase further here since it isn't what this task asked to validate.

## Step 2 — tier-0.5 heuristics run against the real streams via `Worker.ingest()`

Two independent checks, both against the real captured data, zero additional cost:
(a) the heuristics *live*, firing during the actual `.run()` above (`nudge`/`suspect-rot` listeners attached before spawn), and
(b) a **decoupled replay** — `new Worker(...)` then `.ingest(JSON.parse(line))` for every line of the saved `.ndjson`, exactly as the task specified, confirming the live result wasn't an artifact of listener timing.

Both methods agree exactly:

| stream | fingerprints (all distinct?) | error streaks | `nudge` fired | `suspect-rot` fired |
|---|---|---|---|---|
| probe 1 (CHANGELOG hunt) | 7/7 distinct | none (0 errors) | no | no |
| probe 2 (rot_thresholds.json) | 4/4 distinct | Read fingerprint → streak=1 (below `ERROR_HARD_STOP_AT=3`, below `NUDGE_AT` trigger of streak=2) | no | no |

**tier-0.5 verdict: silent (no rot signal) on both — CORRECT.** Neither stream has an identical-fingerprint run of 4 (`HARD_STOP_AT`), a 3-in-a-row nudge run, an alternating A-B-A-B period-2 cycle, an error streak reaching 3, or `turns > 40`. Ground truth agrees: both are ordinary explorative sessions that converged and terminated cleanly. This is the first time the `is_error`-tracking code (added this session, previously flowing through completely unread per `SYNTHESIS.md`) has been exercised by a **real** `tool_result.is_error: true` rather than a fabricated one — it correctly recorded a streak of 1 and correctly did not escalate.

## Step 3 — CARL (qwen3:32b via Ollama) judged the same real streams

Each real ndjson was compacted into the identical shape `g3_fixtures.json` uses (`{t, s, tool, args, ok, err, num_turns, cost_usd}` — dropped `system`(non-init)/`rate_limit_event`, kept `Read`→`{file}` and `Bash`→`{cmd}` arg trimming) and sent to CARL using the **exact** validated system prompt, model, and call shape from `02-forge/tests/g3_carl_judge.mjs` (`POST http://localhost:11434/api/chat`, `format:"json"`, `think:false`, `options.temperature:0`) — not the `/api/generate` endpoint named in this task's background text, since the tested/working pattern uses `/api/chat` with a `messages` array and that's what "per the pattern in g3_carl_judge.mjs" means literally.

| stream | CARL verdict | confidence | latency | valid JSON | correct? |
|---|---|---|---|---|---|
| probe 1 (CHANGELOG hunt, 8 turns, 7 distinct tools, 0 errors) | `continue` | 0.95 | 16,478 ms | yes | **yes** |
| probe 2 (rot_thresholds.json, 5 turns, 1 real error non-repeating) | `continue` | 0.95 | 3,529 ms | yes | **yes** |

Both verdicts match ground truth: clean termination via a `result` event, no red flag from CARL's own STOP rubric actually present. Note probe 1's latency (16.5s) is well over G3's 5s p95 SLA bar — a real compacted stream is larger (28 compacted events vs. the fixtures' handful) and this is the first time CARL has been timed against a real-sized payload rather than a hand-trimmed fixture; flagged as a follow-up, not a re-litigation of G3 (which passed its own smaller/synthetic bar).

Full compacted streams + raw CARL responses: `logs/f3_carl_real_results.json`.

## Step 4 — did tier-0.5 and CARL agree, and was either WRONG?

**AGREED, both times.** tier-0.5 stayed silent (no rot signal) on both real streams; CARL independently returned `continue` (confidence 0.95) on both. Cross-checked against the actual ground truth of what the real sessions did (read the `result` text, the tool-call list, and the raw ndjson directly, not just the verdicts) — **both tools were CORRECT on both real streams.** Neither produced a false positive (flagging healthy exploration as rot) nor a false negative (missing a real repeat/error escalation, since none was present to miss).

This is an honest true-negative result, not a flattering one manufactured to pass: the two real probe tasks — chosen to be genuinely underspecified and read-only, not instructed to loop — turned out to produce healthy, non-pathological, if imperfect (the file genuinely wasn't found) sessions. That is itself informative: it shows a competent haiku model performing ordinary tool-scoped exploration does NOT trip tier-0.5's fingerprint/error-streak heuristics, and CARL does not falsely escalate it either. It does **not** yet show either detector correctly catching a REAL pathological (looping/erroring) session, because no real captured log — old or newly spent — contained one. That specific validation (a real true positive) remains open; see follow-ups.

## Follow-ups

1. **Real true-positive still unvalidated.** Every real log available (old + the 2 new probes) turned out healthy. Tier-0.5 and CARL have now both been proven correct on real *negatives*; neither has yet been proven correct on a real *positive* (an actual repeated-identical-call loop or 3-in-a-row error streak occurring naturally, not fabricated). Worth capturing opportunistically the next time a real worker genuinely gets stuck, rather than manufacturing one (which the task correctly avoided as gaming the test).
2. **`--dangerously-skip-permissions` appears to bypass `--allowedTools` enforcement.** Both real probe runs used `Bash` despite `role: 'probe'` scoping `tools: ['Read']` only. `spawn.mjs`'s own header comment calls the `ROLES` matrix "the RBAC matrix AND the cost control — one mechanism" (line 17); this real observation contradicts that on live data. Not chased further here (out of scope for this task) but worth its own investigation — it would mean role-based tool scoping is currently unenforced for every role, not just `probe`.
3. **CARL's real-payload latency (16.5s) exceeded G3's 5s p95 SLA** on the larger of the two real compacted streams (28 events vs. G3 fixtures' handful). G3 itself passed its own bar on small synthetic payloads; this suggests the SLA needs re-verifying against realistically-sized compacted streams, not just re-asserted.
4. Consider capturing one real `fixer`-role (Edit/Bash) session opportunistically — probe-role's Read-only scope naturally limits how pathological a real session can get; a mutating role has more surface for genuine loop/error patterns to occur unforced.
