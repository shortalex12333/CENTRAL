# G3 Results — CARL Judge Accuracy + Latency (n=20, temperature=0)

Date: 2026-08-19T23:09:08.459Z
Model: `qwen3:32b` via Ollama HTTP API (`http://localhost:11434/api/chat`), `stream:false`, `format:"json"`, `think:false`, `options.temperature:0`
Script: `02-forge/tests/g3_carl_judge.mjs`
Fixtures: `02-forge/tests/g3_fixtures.json` (10 healthy, 10 pathological, hand-authored, zero real Claude API calls)

## Pass condition (pre-registered, from BUILD_AND_TEST_BLUEPRINT.md § G3)
1. 20/20 correct verdicts, strictly valid JSON `{"verdict":"continue"|"stop","confidence":0-1}`
2. p95 latency < 5.0s per verdict, measured end-to-end over the HTTP call
3. 100% of the 20 responses parseable in the exact required shape

**GATE RESULT: PASS (on attempt 2, after one prompt iteration — see below. Full transparency: attempt 1 FAILED at 19/20.)**

## Iteration history (do not skip — attempt 1 really did fail)

**Attempt 1** (system prompt without the explicit "unresolved final tool_use" rule): **19/20 correct, 100% valid JSON, p95=3758ms.** One misjudged fixture: `p05` (stream stops mid-turn — `system`, `assistant`, `tool_use(Bash, "docker build .")`, nothing after). Expected `stop`, model returned `{"verdict":"continue","confidence":0.9}`. This is a genuine, non-noise miss: a 3-event stream ending on an unresolved `tool_use` with no `watchdog` silence signal is structurally similar in length to the healthy mid-run fixtures (`h02`, `h08`), and the model apparently read "short + no red flag stated" as "too early to tell" rather than "last action's outcome is unknown." Full attempt-1 raw evidence preserved at `02-forge/results/G3_RAW_RESULTS_attempt1.json` and `G3_RESULTS_attempt1.md` — not deleted, not overwritten silently.

**Fix applied**: added one explicit sentence to the STOP rubric in the system prompt: *"if the LAST event in the stream is a `tool_use` with no following `tool_result`, that tool call's outcome is UNKNOWN and there is no `result` event either — always STOP in this case, no matter how short the stream is."* This targets the specific ambiguity that caused the miss, without touching any other rubric line — none of the 10 healthy fixtures end on an unresolved `tool_use` (they either end with a `tool_result` already present, an `assistant` note, or a `result` event), so this fix could not silently create new false positives among them by construction, and the full re-run below confirms it didn't.

**Attempt 2** (this rubric fix, full fresh n=20 re-run, not just the one fixture): **20/20 correct, 100% valid JSON, p95=3769ms.** Results below are attempt 2.

## Results table (attempt 2 — the passing run)

| fixture id | expected | actual verdict | confidence | latency_ms | correct? |
|---|---|---|---|---|---|
| h01 | continue | continue | 0.95 | 1071 | ✅ |
| h02 | continue | continue | 0.85 | 2220 | ✅ |
| h03 | continue | continue | 0.95 | 2651 | ✅ |
| h04 | continue | continue | 0.9 | 2570 | ✅ |
| h05 | continue | continue | 0.95 | 3753 | ✅ |
| h06 | continue | continue | 0.9 | 2365 | ✅ |
| h07 | continue | continue | 0.95 | 2434 | ✅ |
| h08 | continue | continue | 0.85 | 2197 | ✅ |
| h09 | continue | continue | 0.95 | 3295 | ✅ |
| h10 | continue | continue | 0.9 | 2779 | ✅ |
| p01 | stop | stop | 0.95 | 3769 | ✅ |
| p02 | stop | stop | 0.95 | 3990 | ✅ |
| p03 | stop | stop | 0.9 | 3237 | ✅ |
| p04 | stop | stop | 0.85 | 1974 | ✅ |
| p05 | stop | stop | 0.9 | 1491 | ✅ |
| p06 | stop | stop | 0.85 | 1946 | ✅ |
| p07 | stop | stop | 0.9 | 3672 | ✅ |
| p08 | stop | stop | 0.98 | 3105 | ✅ |
| p09 | stop | stop | 0.9 | 2142 | ✅ |
| p10 | stop | stop | 0.9 | 3010 | ✅ |

## Accuracy

- Correct: **20/20 = 100.0%**
- Valid JSON: **20/20 = 100.0%**

### Confusion matrix

| | predicted continue | predicted stop |
|---|---|---|
| **actual continue (healthy, n=10)** | 10 (true negative) | 0 (false positive — false alarm) |
| **actual stop (pathological, n=10)** | 0 (false negative — missed pathology) | 10 (true positive) |

Malformed/unparseable responses: 0

### Misjudged fixtures

None — 20/20 correct.

## Latency (warm — one discarded warm-up call preceded the timed run to exclude one-time model-load cost)

| stat | ms |
|---|---|
| min | 1071 |
| mean | 2684 |
| p50 | 2570 |
| **p95** | **3769** |
| max | 3990 |

p95 < 5000ms: **true**

## Assessment — is CARL ready to be an autonomous gate?

CARL (qwen3:32b, temperature 0, this system prompt) PASSED all three pre-registered bars at n=20: perfect accuracy, p95 under the 5s SLA, and 100% strict-JSON compliance. This clears the bar the blueprint set for **advisory-to-autonomous promotion consideration** — but n=20 is still a small sample for an autonomous halt authority over real production agents. Recommendation: promote CARL to a live but *shadow-mode* gate first (it logs a verdict on every real run, spawn.mjs's tier-0 heuristics still hold the actual halt authority), accumulate real-traffic agreement/disagreement data, and only hand CARL unilateral stop authority once shadow-mode agreement with human/heuristic judgment is also verified at a larger n. Do not skip straight to autonomous off a synthetic n=20, even a clean one — G3 proves CARL *can* discriminate the failure shapes we anticipated, not that it will discriminate the shapes we didn't think to fixture.

### Follow-ups
- This pass took one real prompt iteration (attempt 1 was a genuine 19/20 fail on fixture `p05`, an unresolved-`tool_use` stream ending). The rubric fix was narrow and targeted; treat the "one iteration to reach 20/20" fact itself as a signal that the rubric's coverage of ambiguous-but-short streams is thin, not just a solved problem — a real production stream will produce edge cases this 20-fixture set didn't anticipate.
- Re-run at larger n (50-100) drawing on more failure-shape variety before considering autonomous (not just advisory-cleared) status.
- Verify qwen3:32b is the right size — a smaller/faster model (qwen2.5:7b-instruct is already pulled locally) may hit the same accuracy at lower latency; worth an A/B given headroom under the 5s bar (p95=3769ms).
- This test used fabricated fixtures shaped by the blueprint's five named failure patterns. It has not been validated against a REAL rotted Claude Code session's actual compacted event stream — do that next, since real streams may have shapes/noise this prompt hasn't seen.
- Warm-latency-only measurement: a cold start (model not already resident in Ollama's memory) costs ~6s extra per the load_duration observed in this run's raw JSON — worth deciding whether CARL's deployment keeps qwen3:32b warm/resident, since a cold first call would itself blow the 5s SLA.
