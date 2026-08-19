# G3 Results — CARL Judge Accuracy + Latency (n=20, temperature=0)

Date: 2026-08-19T23:07:35.413Z
Model: `qwen3:32b` via Ollama HTTP API (`http://localhost:11434/api/chat`), `stream:false`, `format:"json"`, `think:false`, `options.temperature:0`
Script: `02-forge/tests/g3_carl_judge.mjs`
Fixtures: `02-forge/tests/g3_fixtures.json` (10 healthy, 10 pathological, hand-authored, zero real Claude API calls)

## Pass condition (pre-registered, from BUILD_AND_TEST_BLUEPRINT.md § G3)
1. 20/20 correct verdicts, strictly valid JSON `{"verdict":"continue"|"stop","confidence":0-1}`
2. p95 latency < 5.0s per verdict, measured end-to-end over the HTTP call
3. 100% of the 20 responses parseable in the exact required shape

**GATE RESULT: FAIL**

## Results table

| fixture id | expected | actual verdict | confidence | latency_ms | correct? |
|---|---|---|---|---|---|
| h01 | continue | continue | 0.95 | 1064 | ✅ |
| h02 | continue | continue | 0.85 | 2190 | ✅ |
| h03 | continue | continue | 0.95 | 2649 | ✅ |
| h04 | continue | continue | 0.9 | 2570 | ✅ |
| h05 | continue | continue | 0.95 | 3748 | ✅ |
| h06 | continue | continue | 0.9 | 2353 | ✅ |
| h07 | continue | continue | 0.95 | 2423 | ✅ |
| h08 | continue | continue | 0.85 | 2188 | ✅ |
| h09 | continue | continue | 0.98 | 3284 | ✅ |
| h10 | continue | continue | 0.9 | 2785 | ✅ |
| p01 | stop | stop | 0.95 | 3743 | ✅ |
| p02 | stop | stop | 0.95 | 3982 | ✅ |
| p03 | stop | stop | 0.9 | 3231 | ✅ |
| p04 | stop | stop | 0.85 | 1940 | ✅ |
| p05 | stop | continue | 0.9 | 1449 | ❌ |
| p06 | stop | stop | 0.85 | 1945 | ✅ |
| p07 | stop | stop | 0.85 | 3758 | ✅ |
| p08 | stop | stop | 0.9 | 3013 | ✅ |
| p09 | stop | stop | 0.9 | 2163 | ✅ |
| p10 | stop | stop | 0.9 | 3031 | ✅ |

## Accuracy

- Correct: **19/20 = 95.0%**
- Valid JSON: **20/20 = 100.0%**

### Confusion matrix

| | predicted continue | predicted stop |
|---|---|---|
| **actual continue (healthy, n=10)** | 10 (true negative) | 0 (false positive — false alarm) |
| **actual stop (pathological, n=10)** | 1 (false negative — missed pathology) | 9 (true positive) |

Malformed/unparseable responses: 0

### Misjudged fixtures

- `p05`: expected `stop`, got `continue`

## Latency (warm — one discarded warm-up call preceded the timed run to exclude one-time model-load cost)

| stat | ms |
|---|---|
| min | 1064 |
| mean | 2675 |
| p50 | 2570 |
| **p95** | **3758** |
| max | 3982 |

p95 < 5000ms: **true**

## Assessment — is CARL ready to be an autonomous gate?

CARL (qwen3:32b, this system prompt) did NOT clear the pre-registered bar. Per the blueprint's explicit fallback: **CARL is not the gate.** `spawn.mjs`'s free tier-0 heuristics (repeated-tool detection, turn-cap) remain the primary and possibly only automated gate, with human review as fallback for anything they don't catch. CARL should be demoted to an advisory signal surfaced in the UI, not an autonomous halt authority, until the specific failure below is fixed and this test is re-run.

### Follow-ups
- Inspect the misjudged fixtures above and iterate the system prompt/rubric specifically for those failure shapes.
- Re-run this exact script after each prompt iteration — do not hand-wave a fix, get a fresh 20/20 (or better) measured result.
- If latency (not accuracy) was the failure, consider a smaller model (qwen2.5:7b-instruct is already pulled locally) or trimming the system prompt/rubric length, and re-measure — do not assume a smaller model preserves accuracy without re-testing.
- Keep CARL advisory-only in the UI until a re-run passes cleanly.
