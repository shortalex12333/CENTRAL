# G2 Cache-Reuse Experiment — does prefix-sharing across independent session_ids get a cache discount?

Run: 2026-08-19. Model: `claude-haiku-4-5-20251001` only. Script: `cache_reuse_spawn.mjs` (spawn pattern
copied from `03-daemon/spawn.mjs`: `--strict-mcp-config`, `--mcp-config '{"mcpServers":{}}'`,
`--setting-sources ""`, stdin closed, `--dangerously-skip-permissions`). Raw NDJSON dumps for all 3 calls
saved at `/private/tmp/claude-501/-Users-celeste7/793578bd-a949-4268-8fca-2fc4a6cef123/scratchpad/cache_dump_{A,B,C}.ndjson`.

**3 real API calls made (budget was ≤6). Total spend: $0.0741309.**

## Method

Three separate `claude -p` invocations, each a **brand-new session_id** (none used `--resume`), each
passed the **exact same** `--append-system-prompt` file — a fixed, byte-identical 454-word / 2848-byte
block of filler text (a restatement of the JARVIS `term_groups.py` domain taxonomy, used only as inert
deterministic filler — this run does not touch JARVIS/kenoki code or infra). Only the final one-line task
question differed (`A-READY` / `B-READY` / `C-READY`). Full raw `result`/`assistant` events were parsed
for every field matching `/cache/i` (not just the fields `spawn.mjs` normally extracts), plus the full
`usage` objects.

## Raw per-call numbers

| call | session_id | cache_creation_input_tokens | cache_read_input_tokens | sum (prefix size) | total_cost_usd | duration_api_ms | output_tokens (thinking) |
|---|---|---|---|---|---|---|---|
| A (1st, never-before-used exact prefix) | `2caa4cb8-6411-4a76-9d74-7c16b5382b28` | 14365 | 18139 | 32504 | **0.0319939** | **3158** | 4 (88 thinking) |
| B (2nd, brand-new session_id, identical prefix) | `73b235e3-2850-4e56-9ee9-0c8cde44ca01` | 8649 | 23855 | 32504 | **0.0208885** | **2024** | 4 (38 thinking) |
| C (3rd, brand-new session_id, identical prefix) | `c21159de-7839-42e4-ab83-4953ec764c67` | 8649 | 23855 | 32504 | **0.0212485** | **3406** | 4 (120 thinking) |

`cache_creation` in every call carried `ephemeral_1h_input_tokens` (all of it — `ephemeral_5m_input_tokens`
was 0 in all three), i.e. this account is on the 1-hour cache tier for these calls.

## What changed A→B (the crux test)

The **prefix token total is identical in every call (32504)** — direct proof the three prompts really are
byte-identical in size, not just approximately similar. What moved is the **split** between "paid at
cache-write price" and "paid at cache-read price":

- `cache_creation_input_tokens`: 14365 → 8649 (**−5716 tokens**, moved into the read bucket)
- `cache_read_input_tokens`: 18139 → 23855 (**+5716 tokens**, exact mirror of the above)
- `total_cost_usd`: $0.0319939 → $0.0208885 (**−34.7%**)
- `duration_api_ms`: 3158 → 2024 (**−35.9%**)

Session B **never resumed session A** and has a completely distinct `session_id`. The only thing A and B
share is the byte-identical `--append-system-prompt` text plus the identical fixed invocation shape
(model, empty `--allowedTools`, empty `--mcp-config`, `--setting-sources ""`). That is the whole
experiment's answer.

**Note on A's non-zero starting cache:** even call A — the first-ever call with this specific filler
text — was not a fully cold start: it already showed `cache_read_input_tokens=18139` on its *own* first
turn. That is Claude Code's own bootstrapped harness prompt/tool-schema portion (the part that doesn't
depend on our `--append-system-prompt` text at all) being served from a cache warmed by *other*, unrelated
invocations earlier in the same account/day (e.g. the prior G2 run's 16 haiku calls). This is itself
corroborating evidence for the hypothesis, observed passively rather than by design: that shared,
session_id-independent portion was warm before we ever constructed a controlled A/B pair.

## What changed B→C (does it keep warming?)

No further change. B and C have **identical** `cache_creation_input_tokens` (8649) and
`cache_read_input_tokens` (23855) — the split did not improve on the second reuse. Cost/latency in C
($0.0212485 / 3406ms) are close to B's ($0.0208885 / 2024ms); the small differences track a longer
adaptive-thinking pass in C (120 output tokens, 111 of them thinking, vs 38/38 in B), not a caching
effect — the cache-token fields themselves are bit-for-bit identical between B and C.

This is a different pattern from the original G2 test 1 (12 sequential `--resume` turns), where
per-turn cost kept dropping/flattening turn over turn as the *same* session accumulated more history.
Here, across *independent* sessions sharing one static prefix, the discount appears to land in full on
the **first reuse** and then plateau — consistent with a prefix cache-hit/miss mechanism (either the
whole matching prefix segment is a hit or it isn't) rather than a progressive warm-up curve.

## Verdict

**Prefix-sharing across independent session_ids DOES produce a measurable prompt-cache discount, based
on N=3 calls (1 baseline + 2 reuses).** Session B, a completely separate `session_id` that never resumed
session A, got a cache hit purely from sharing an identical `--append-system-prompt` prefix: +5716 tokens
of `cache_read_input_tokens` that were `cache_creation_input_tokens` in A, a 34.7% cost drop, and a 35.9%
latency drop. Session C then showed the discount holds on a second independent reuse but does not compound
further at N=3.

**Explicit confidence caveat:** this is N=3 real calls on one fixed prefix at one point in time, on
`claude-haiku-4-5-20251001` only, on this account's current cache-tier configuration (1-hour ephemeral).
It is not a statistically robust measurement — no repeated trials, no variance estimate, no test of how
long the discount persists past the observed run (cache TTL), no test at a different prefix size, and no
test of whether the discount degrades with a longer delay between calls (these three ran back-to-back,
seconds apart). Treat this as a clear directional signal that unblocks the design question in the G2
background (a compaction strategy that reuses a stable, deterministic prefix across compaction events does
not have to pay full cold-start price every time), not as a validated production number.

## Implication for CARL's design

The original G2 finding was that a brand-new compacted session was 4.63× *more* expensive than resuming,
inferred to be a cold-start cache-write tax paid in full every time. This experiment shows that tax is not
fixed: if the compaction wrapper's system-prompt/tool-scope prefix is kept byte-identical across
compaction events (not just semantically similar — literally the same bytes, tools list, and mcp-config),
a second and third independently-spawned session with that same prefix pays cache-read price for the
shared portion instead of cache-write price. The open follow-up is whether this holds at the scale of a
*real* compacted summary (which varies per compaction event, unlike this experiment's deliberately static
filler) — a real summary's volatile content would need to be placed *after* a stable, reusable prefix
(system prompt + tool schema + a fixed wrapper template) for this effect to apply, per the prefix-caching
render order (`tools` → `system` → `messages`) and cache-breakpoint placement rules.

## Follow-ups

1. Repeat at N≥10 reuses to check whether the plateau observed at B→C truly holds indefinitely, or whether
   a slower secondary warm-up exists that this run's N=3 was too small to detect.
2. Test with a **real** compacted-summary shape (stable wrapper + volatile summary body) instead of fully
   static filler, to see whether keeping only the wrapper/template portion identical (while the summary
   body varies per compaction event) still captures a comparable discount.
3. Test the discount's persistence across a longer wall-clock gap between independent sessions, to
   characterize the cache TTL's practical impact on a real compaction workflow (compaction events may be
   minutes to hours apart, not seconds).
4. Re-run cost accounting once the account's next 7-day rate-limit window resets — this run adds
   $0.0741 in real spend on top of the $0.2024 already spent on the prior G2 run within the same window.
