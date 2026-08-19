# G2 Results — Resume vs. Compaction, Fork Isolation

Run: 2026-08-19T23:04:08Z. Model: `claude-haiku-4-5-20251001` only (rate-limit constraint).
Script: `02-forge/tests/g2_compaction.mjs`. Raw event dump: `02-forge/results/g2_raw_report.json`.
16 real API invocations total, all real (no simulated/fabricated output).
**Total spend across all 16 turns: $0.202396.**

## Summary table

| sub-test | expected (pre-registered) | actual | cost (usd) | latency (duration_api_ms) | pass/fail |
|---|---|---|---|---|---|
| 1. Inflate session — 12 sequential `--resume` turns on one session_id, 5 facts planted at turns 1,4,6,9,12 | session_id persists across all 12 turns; final turn returns a valid result event | session_id `52f08075-a7dc-4784-b9bd-194aeb94cd15` held identical across all 12 turns. Final turn: cost $0.009202, duration_api_ms 4286, num_turns 2 | $0.009202 (final turn) / $0.172547 (sum of all 12) | 4286 ms (final turn) | baseline (not a gate) |
| 2. Control — naive resume (13th `--resume` on same session_id), recall FACT1 (port) + FACT2 (role name) | correct recall; cost/latency scale with the accumulated 12-turn window, i.e. NOT cheap — this is the control, not a failure | `"PORT=8791 ROLE=ORACLE"` — both facts recalled exactly | $0.004686 | 2282 ms | PASS (recall correct) |
| 3. Compaction — deterministic 235-char / ~59-token JSON artifact (5 facts + `pending: none`, no model call used to build it) opened as the FIRST prompt in a **brand-new** session_id, same recall question | correct recall AND materially **lower** cost and/or latency than sub-test 2 | `"PORT=8791 ROLE=ORACLE"` — correct. But cost $0.021697 (**4.63× sub-test 2**) and duration 2629 ms (**15% slower** than sub-test 2) | $0.021697 | 2629 ms | **FAIL** — correct, but neither cheaper nor faster; contradicts the pre-registered hypothesis at this test's scale |
| 4a. Fork isolation — `--resume <original> --fork-session`, teach "the codename is BANANA" | fork produces a **new, distinct** session_id | forked session_id `5e0b095e-8b47-4ef9-bd79-c5d907483afd` ≠ original `52f08075-...` | $0.004481 | 1394 ms | PASS |
| 4b. Fork isolation — `--resume` the **original** (unforked) session_id, ask "what is the codename?" | original session must NOT know BANANA (no leakage) | Replied exactly `"NO CODENAME KNOWN"` — BANANA never mentioned | $0.005651 | 3282 ms | PASS |

**Gate-defining sub-tests:**
- **3-vs-2 (compaction beats naive resume): FAIL.** Correctness held (both answers exactly right), but the pre-registered bar was correctness AND a materially lower cost/latency, and step 3 was both more expensive and slower.
- **Fork isolation (4a+4b): PASS.** Distinct session_id produced by the fork, zero leakage back to the original.

**Gate overall: FAIL** (pass requires both sub-tests to pass; 3-vs-2 did not).

## Raw per-turn detail — session inflation (sub-test 1)

| turn | kind | fact planted | cost_usd | duration_api_ms | num_turns | result |
|---|---|---|---|---|---|---|
| 1 | fact | FACT1: deploy port is 8791 | 0.035375 | 5153 | 2 | LOGGED FACT1 |
| 2 | pad | — | 0.034860 | 3261 | 2 | LOGGED PAD2 |
| 3 | pad | — | 0.008421 | 3166 | 2 | LOGGED PAD3 |
| 4 | fact | FACT2: role X is named ORACLE | 0.015191 | 8029 | 3 | LOGGED FACT2 |
| 5 | pad | — | 0.008900 | 3507 | 2 | LOGGED PAD5 |
| 6 | fact | FACT3: g2_manifest.txt has 42 lines | 0.008762 | 2977 | 2 | LOGGED FACT3 |
| 7 | pad | — | 0.008839 | 2943 | 2 | LOGGED PAD7 |
| 8 | pad | — | 0.008916 | 3138 | 2 | LOGGED PAD8 |
| 9 | fact | FACT4: fallback region is eu-west-2 | 0.008980 | 2967 | 2 | LOGGED FACT4 |
| 10 | pad | — | 0.009272 | 2962 | 2 | LOGGED PAD10 |
| 11 | pad | — | 0.009163 | 3359 | 2 | LOGGED PAD11 |
| 12 | fact | FACT5: retry budget is 3 attempts | 0.009202 | 4286 | 2 | LOGGED FACT5 |

Sum of all 12 inflation turns: **$0.172547**.

## Why sub-test 3 lost to sub-test 2 — inference, not directly instrumented

The per-turn cost of sub-test 1 is revealing: after an initial elevated cost on turns 1–2 (first-time
system-prompt + tool-schema setup for this session_id), cost flattens to ~$0.0088–0.0092 per turn from
turn 3 onward *despite the conversation growing every turn*. That flat curve is the signature of Anthropic
prompt caching: a resumed session re-reads its accumulated prefix (system prompt, tool schema, prior
turns) at the cheap cache-read rate, and only pays full/write price for the marginal new content each turn.
Sub-test 2 (the 13th resume) inherits that same warm cache and does no tool call, so it lands even
cheaper ($0.0047).

Sub-test 3 opens a genuinely fresh session_id. It has never cached anything, so the ENTIRE
prefix — system prompt, tool schema, and our 235-char artifact — is paid at full/cache-write price on
that single call. That fixed "cold start" cost is why it lands at 4.6× sub-test 2's cost even though
its total content is far smaller than the 12-turn accumulated session.

**Caveat: this is inferred from the observed cost pattern, not proven from raw usage fields** —
this run did not capture `cache_read_input_tokens` / `cache_creation_input_tokens` from the result
events (only `total_cost_usd`, `duration_api_ms`, `num_turns` were persisted). Confirming the caching
explanation directly is a follow-up (see below).

**Implication for CARL's design:** at only 12 short turns / a few KB of accumulated context, the
resumed session's per-turn cost never grew enough to cross the fresh session's fixed cold-start cost.
The crossover point — the session depth at which naive resume actually becomes MORE expensive than a
compacted fresh session — was not reached by this test and is still unknown. This is the single most
important open question this gate leaves unanswered; see follow-ups.

## Explicitly out of scope for this MVP run

**SKIPPED for MVP scope: G2 test 3 (resume across daemon process restart) and test 6 (10-way concurrent
local-state corruption under kill -9) — both need a persistent daemon process that doesn't exist yet;
flagged as follow-ups before real production concurrency.**

## Follow-ups

1. **Find the actual crossover point.** Re-run sub-tests 2 vs 3 at materially greater depth (e.g. 50–100
   turns and/or larger per-turn payloads, not one-liners) to find the session size at which naive resume's
   accumulating cost/latency actually exceeds a compacted fresh session's fixed cold-start cost. Until this
   is measured, "compaction beats resume" is unproven — this run's honest result is the opposite, at small
   scale.
2. **Instrument cache token accounting.** Capture `cache_read_input_tokens` / `cache_creation_input_tokens`
   from each result/usage event (not just `total_cost_usd`) to confirm the prompt-caching explanation
   above directly rather than inferring it from the cost curve shape.
3. **Pre-warm the compacted session's cache**, if feasible, and re-measure — if the cold-start cost is the
   dominant factor, a compaction strategy that reuses a cached system-prompt prefix (rather than opening
   fully cold) may change the result.
4. G2 test 3 (daemon-restart resume survival) — deferred, needs a persistent daemon.
5. G2 test 6 (10-way concurrent kill -9 local-state corruption) — deferred, needs a persistent daemon and
   is explicitly flagged in the blueprint as a precondition for any real production concurrency.
6. Account was at 85% of the 7-day rate-limit window before this run; total spend here was $0.2024 across
   16 turns — re-running follow-up 1 at 50-100 turns should be budgeted and scheduled after headroom
   returns, not squeezed into the remaining 15%.
