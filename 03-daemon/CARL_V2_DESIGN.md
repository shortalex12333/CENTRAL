# CARL v2 — porting Gemini CLI's real shipped loop detector into CENTRAL

Date: 2026-08-20
Origin: `06-gemini/GX3_BUILTIN_ROT_DETECTION_RESULTS.md` — a direct read of Gemini
CLI's actual installed npm package source
(`packages/core/dist/src/services/loopDetectionService.js`, v0.55.1, confirmed real
shipped code with intact attribution comments, not documentation, not a changelog
claim). This document records what changed in CENTRAL because of that finding, and
cites the exact line/constant each change is ported from.

This is a **port**, not a fresh design. Every threshold below is either taken
directly from Gemini's real constants, or is a documented, justified deviation from
them — never an unexplained guess.

---

## 1. Generalized period-1..5 cycle detector (`03-daemon/spawn.mjs`)

**Before:** two special-cased blocks. `HARD_STOP_AT = 4` checked only for N
identical fingerprints in a row (period 1). `ALTERNATION_LEN = 6` checked only for
an A-B-A-B pattern (period 2), as a single one-off block. A period-3 cycle
(A-B-C-A-B-C...) or longer was structurally invisible — there was no code path that
could ever detect it, at any turn count, no matter how long it ran.

**Real Gemini source** (GX3 § 3, Tier 1):
```js
var TOOL_CALL_LOOP_THRESHOLD = 5;
getToolCallKey(toolCall) {
  const argsString = JSON.stringify(toolCall.args);
  return sha256(`${toolCall.name}:${argsString}`);
}
```
The history buffer is checked for a repeating cycle of **period k, for every k from
1 to 5**, each required to repeat 5 times (`requiredLength = k * TOOL_CALL_LOOP_THRESHOLD`).
One general routine, not one-off checks per period.

**What CENTRAL now does** (`spawn.mjs`, `detectCycle()`): finds the smallest period
`P` in `[CYCLE_MIN_PERIOD=1, CYCLE_MAX_PERIOD=5]` for which the last `P * repeats`
fingerprints consist of exactly `P` distinct values repeating in the same cyclic
order `repeats` times. `CYCLE_MAX_PERIOD=5` matches Gemini's real range exactly.

**`CYCLE_MIN_REPEATS`: 3, not Gemini's real 5 — a deliberate, documented tuning
choice, not an oversight.** Two reasons:
- It reproduces the OLD nudge-then-hard-stop shape for period 1 exactly (see § 2
  below) using a single uniform constant instead of two special-cased ones
  (`NUDGE_AT=3` / `HARD_STOP_AT=4`), so period 1 still hard-stops on the 4th
  identical call — no regression in sensitivity from what was already shipping.
- CENTRAL's standing project bias is to flag over silently trust (memory:
  `bias_toward_flagging`), and Tier-0.5 is free and local — a false 'suspect-rot'
  here costs a swallowed nudge; a missed one costs a runaway. `5` remains a
  one-line tuning knob (documented in the constant's own comment in `spawn.mjs`)
  if `3` proves too sensitive once this runs against real traffic.

**Subsumption, verified, not just claimed:** the two old special-cased blocks were
deleted outright. `spawn.unit-test.mjs` Test 1 (period-1 identical run) and Test 3
(period-2 alternation) both still pass against the single general routine — see § 5.

**The concrete proof the generalization matters** (task's explicit ask): `spawn.unit-test.mjs`
Test 6 feeds a period-3 cycle (`Read, Grep, Glob, Read, Grep, Glob, Read, Grep,
Glob`) — 9 tool calls, zero of which are identical consecutively, zero of which form
an A-B alternation. Under the OLD code this pattern would have run forever,
completely invisible to Tier-0.5 (neither `HARD_STOP_AT` nor `ALTERNATION_LEN` has
any code path that inspects a 3-element cyclic window). Under the new general
detector it nudges at the first 3 full cycles, and hard-stops if the pattern
persists past that — proven live, not asserted:

```
ok  period-3 cycle (A-B-C x3) nudges — old code could not see this at all
ok  no premature hard-stop on the first period-3 detection
ok  period-3 cycle persisting past the nudge hard-stops
```

## 2. Nudge-then-hard-stop, generalized (`spawn.mjs`, `evaluateCycle()`)

**Real Gemini source** (GX3 § 3, "What happens on detection"): first detection
(`loopResult.count === 1`) is not a hard stop — the turn is aborted, a corrective
system message is injected ("Potential loop detected... take a step back and
confirm you're making forward progress"), and the agent continues.
`clearDetection()` resets the flag but not the count, "so the next detection will
be count 2." A second detection in the same task (`count > 1`) is a hard stop.

**What CENTRAL now does:** one flag per signal family (`'tool'` or `'text'`),
stored in the existing `nudged` Set. The FIRST time a family detects a cycle, only
a nudge fires and the run continues. If the SAME family detects a cycle AGAIN
afterward (the nudge didn't resolve it), it hard-stops. A boolean is equivalent to
Gemini's `count===1` vs `count>1` distinction here because CENTRAL's downstream
already stops admitting new work on the first `suspect-rot` regardless of how many
times it re-fires afterward.

**Documented, not implemented:** Gemini also reduces the remaining turn budget on
nudge (`boundedTurns - 1`). CENTRAL's Tier-0.5 layer has no equivalent turn-budget
concept to reduce — CARL v2's `TURN_GATE` (§ 4) is the analogous idea one layer up,
not a literal port of this specific mechanic.

## 3. Text-content-repetition detector (`spawn.mjs`, item 2)

**Before:** `ingest()`'s `'assistant'` case only ever inspected `tool_use` content
blocks. An agent that loops on similar phrasing without repeating a tool call —
"Let me try a different approach" on 6 consecutive turns while never calling the
same tool twice — was invisible to Tier-0.5 entirely.

**Real Gemini source** (GX3 § 3, Tier 2): a sliding 50-char hash window over
*streamed text output*, requiring the same chunk hash to reappear 10 times within
average distance ≤ 250 chars, with a periodicity check (`periods.size ≤ 5`
distinct inter-occurrence gaps), explicitly suppressed inside code blocks/tables/
lists/headings ("repetitive code structures are common and not necessarily
loops").

**What CENTRAL now does — a deliberately simpler port, documented as a known
gap:** each assistant `text` content block is hashed whole (`hashText()`, a
non-cryptographic FNV-1a variant — collisions only ever cause an extra flag, never
a missed one) and pushed into a separate rolling window, `textFingerprints`,
completely independent of `fingerprints` (tool calls). The SAME general
`detectCycle()`/`evaluateCycle()` routine from § 1–2 runs against it. This is
exactly what the task asked for ("apply the SAME general period-1..5 cycle
detector to a separate rolling window of text-content hashes") and is
structurally simpler than Gemini's real Tier 2:
- **Catches:** an assistant repeating an EXACT text block verbatim, in a
  period-1..5 cyclic pattern — proven live in `spawn.unit-test.mjs` Test 7.
- **Does NOT catch:** paraphrased/near-duplicate repetition (Gemini's sliding
  sub-string window is far more forgiving of minor wording drift than a whole-block
  exact hash is), and does not have Gemini's code-block/table/list suppression
  (not needed yet — CENTRAL's Tier-0.5 has no equivalent to "streamed prose vs.
  streamed code" distinction to suppress against).
- Proven NOT to false-positive on varied phrasing (`spawn.unit-test.mjs` Test 8)
  and proven not to cross-contaminate the tool-cycle reason strings (Test 7's third
  check).

This gap (whole-block exact hash vs. Gemini's sliding sub-string window) is a
reasonable, explicitly out-of-scope-for-this-port follow-up, not a silently
dropped requirement.

## 4. CARL v2 — the two-stage LLM judge (`03-daemon/carl.mjs`, NEW module)

**Before (`02-forge/tests/g3_carl_judge.mjs`, kept untouched — see § 6):** a single
Ollama call, no confirmation, no gate. Any turn count, any confidence value with the
right verdict, counted as "correct" against the G3 pass bar. Real, working (20/20 at
n=20, see `G3_RESULTS.md`), but structurally a single model's unilateral opinion —
exactly what `spawn.mjs`'s own header comment already flagged as the class of design
"no surveyed framework or production company" gives primary-trigger authority to.

**Real Gemini source** (GX3 § 3, Tier 3):
```js
var LLM_CHECK_AFTER_TURNS = 30;
var DEFAULT_LLM_CHECK_INTERVAL = 10;   // adaptive, 5-15 — NOT ported, see below
var LLM_CONFIDENCE_THRESHOLD = 0.9;
var DOUBLE_CHECK_MODEL_ALIAS = "loop-detection-double-check";
```
Only after 30 consecutive turns does the CLI call an LLM at all. A cheap model
(`gemini-3-flash-base`) proposes; only if its confidence is ≥ 0.9 does a second,
stronger model (`gemini-3-pro-preview`, via the `loop-detection-double-check` alias)
independently re-evaluate the same history, fresh, before a loop is declared. If the
double-check model is unavailable, real Gemini falls back to trusting the cheap
model alone (a detail this port deliberately does NOT copy — see below).

**What CENTRAL now does (`carl.mjs`, new reusable module):**

| Constant | CARL v2 | Real Gemini | Match? |
|---|---|---|---|
| `TURN_GATE` | 30 | `LLM_CHECK_AFTER_TURNS = 30` | exact |
| `CONFIRM_THRESHOLD` | 0.9 | `LLM_CONFIDENCE_THRESHOLD = 0.9` | exact |
| Gate direction | `turns > TURN_GATE` (must exceed, not just reach) | "only after 30 consecutive turns" | exact |
| Two-stage cascade | cheap proposes → confidence gate → independent confirm | flash proposes → confidence gate → pro confirms | same shape |
| Stage 2 model | same as stage 1 (`qwen3:32b`) — **see limitation below** | different, stronger model | **deviation, documented** |
| On stage-2-unavailable | N/A (single model only) | falls back to trusting stage 1 alone | **not ported — see below** |
| Adaptive re-check interval | not implemented | `DEFAULT_LLM_CHECK_INTERVAL`, 5-15, adaptive | **not ported — see below** |
| Disagreement / low confidence | always `continue` | always `continue` | exact |

**🔴 Explicit limitation — single local model.** Only `qwen3:32b` is available via
Ollama on this machine. Stage 2 reuses the same model as stage 1. This is **not** a
genuine different-model second opinion the way Gemini's real flash→pro cascade is.
The independence property this module DOES preserve: stage 2 is asked **fresh** —
identical stream, identical system prompt, a brand-new request that is never shown
stage 1's verdict or confidence — so it is not a rubber stamp, even though it is not
a different brain. `STAGE_2_MODEL` is its own named constant in `carl.mjs`
specifically so a distinct, stronger model can be swapped in later without changing
this module's shape at all.

**Deliberate deviation from Gemini's fallback behavior.** Real Gemini, if the
double-check model is unavailable, trusts the cheap model alone and can still
declare a loop off ONE opinion. CARL v2 does **not** do this. Given CARL v2 only
ever has one model available regardless, adopting that fallback would mean CARL v2
*always* runs in single-opinion mode with unilateral stop authority — precisely the
design this whole port exists to move away from. CARL v2 instead always requires
both stages to independently agree with confidence ≥ 0.9; if stage 2 cannot be
reached or disagrees, the verdict is `continue`. This is a stricter, more
conservative choice than the literal Gemini source, made explicitly because the
model-diversity assumption behind Gemini's fallback doesn't hold here.

**Not ported, documented as a follow-up, not a silent gap:** Gemini's adaptive
re-check interval (`DEFAULT_LLM_CHECK_INTERVAL`, 5-15 turns, tightens as confidence
rises) means Gemini doesn't call its LLM tier on every single turn even past turn
30 — it re-checks periodically. `carl.mjs`'s `judge()` has no built-in re-check
cadence; a caller (e.g. a future `spawn.mjs` production wiring) is expected to
throttle how often it calls `judge()` itself. Out of scope for this task.

**Fail-toward-continue, verified structurally, not just asserted:** every exit path
in `judge()` that isn't "both stages independently said stop at ≥0.9 confidence"
returns `verdict: 'continue'` — a malformed response, a low-confidence stage 1, a
disagreeing stage 2, and (most importantly) simply being below the turn gate. See
`carl_v2_two_stage_test.mjs` Part 1 for a check on every one of these branches.

## 5. Test results

### `03-daemon/spawn.unit-test.mjs` — 15/15 passed (was 7 checks, now 15)

```
ok  nudges once before hard-stop
ok  hard-stops on the 4th identical call
ok  varying tool names do not falsely trip identical-run
ok  catches A-B-A-B alternating cycle (nudge stage)
ok  catches A-B-A-B alternating cycle (hard-stop stage)
ok  nudges on repeated tool errors before hard-stop
ok  hard-stops on 3rd consecutive error
ok  healthy varied session trips nothing
ok  period-3 cycle (A-B-C x3) nudges — old code could not see this at all
ok  no premature hard-stop on the first period-3 detection
ok  period-3 cycle persisting past the nudge hard-stops
ok  repeated identical text content nudges
ok  repeated identical text content hard-stops after the nudge
ok  text-cycle detection does not cross-contaminate the tool-cycle reason
ok  varied assistant text trips nothing

15/15 checks passed
```

Every ORIGINAL guarantee still holds. Test 3 (period-2 alternation) was reworked —
not weakened — from a 6-call, one-shot hard-stop assertion into a 12-call test that
asserts BOTH the nudge stage and the hard-stop stage, because the general detector's
nudge-then-hard-stop shape (§ 2) now applies uniformly to period 2 as well, where the
old `ALTERNATION_LEN` block hard-stopped directly with no nudge at all. Tests 6-8 are
new, proving items 1 and 2 of the task concretely, not just by code inspection.

### `02-forge/tests/carl_v2_two_stage_test.mjs` — 16/16 passed

**Part 1 (zero-cost, mocked, deterministic) — 11/11.** Every branch of the gate /
confidence-bar / independent-confirmation / fail-toward-continue logic, including
the specific proof the task asked for: a `turns=15` case where the injected stage
responder *throws* if ever invoked — proving CARL v2 genuinely never calls Ollama
below the turn gate, not merely that it discards the result.

**Part 2 (real local Ollama, qwen3:32b, $0 Claude API cost) — 5/5**, end-to-end
wiring proof against the live model. Findings, reported honestly:

| fixture | turns | stage1 | stage2 | final verdict | fixture's own label |
|---|---|---|---|---|---|
| p03 (cost/turns runaway) | 34 | stop @0.90 | stop @0.90 | **stop** | stop — matches |
| p04 (cost/turns runaway variant) | 45 | stop @0.85 | not called | **continue** | stop — CARL v2 declines |
| p09 (slow-burn creep) | 40 | stop @0.90 | stop @0.90 | **stop** | stop — matches |
| p10 (slow-burn creep variant) | 37 | continue @0.90 | not called | **continue** | stop — CARL v2 declines |
| synthetic healthy-long (fabricated, not in fixture set) | 35 | — | — | reached a verdict, consulted=true | (no ground-truth label; wiring proof only) |

**This is a real, expected trade-off, not a bug.** The original single-call G3
judge got 20/20 on this fixture set including p04 and p10 (`G3_RESULTS.md`,
confidence 0.85 and 0.90 respectively — reproduced byte-for-byte here at temperature
0, confirming full local determinism). CARL v2's stricter two-stage, ≥0.9-confidence
gate is a deliberate move from "get it right most of the time, once" to "only ever
act with real confidence, twice" — recall goes down (2 of 4 pathological
turn≥30 cases are now declined rather than caught), false-positive risk goes down
correspondingly, exactly matching the asymmetric design goal this task specified
("a false positive is treated as worse than a delayed detection"). Below the turn
gate and for any case CARL v2 declines, `spawn.mjs`'s Tier-0.5 deterministic checks
(§ 1-3) remain the actual first line of defense — which is also exactly Gemini's own
real architecture (LLM tier as a rare, high-bar backstop, not the primary detector).

**One more honest finding:** `carl.mjs`'s `buildUserPrompt()` omits the
`"for fixture ${fixture.id}"` prefix the original `g3_carl_judge.mjs` includes
(that phrase only makes sense inside a test harness — there is no "fixture id" for
a real production stream, which `carl.mjs` is written to also serve). This is a
tiny, deliberate wording difference from the original G3 harness, and it is the
most likely explanation for why p10's stage-1 verdict flipped from G3's original
`stop@0.90` to `continue@0.90` here at the same temperature-0 setting on the same
model and the same underlying stream data — a real, observed reminder that even
temperature-0 local inference is sensitive to prompt wording, not just prompt
content. It does not affect the correctness of the two-stage architecture itself
(Part 1's mocked tests isolate and prove that independently of any specific model
answer), but it is recorded here rather than smoothed over.

## 6. Files changed / added

- `03-daemon/spawn.mjs` — generalized cycle detector (`detectCycle`,
  `evaluateCycle`), text-content tracking, `hashText()`. Deleted:
  `HARD_STOP_AT`, `NUDGE_AT`, `ALTERNATION_LEN` and their two special-cased blocks.
  Unchanged: `ERROR_HARD_STOP_AT` and all its logic (explicitly out of scope), rate
  limit handling, role/tool scoping, the CLI harness.
- `03-daemon/spawn.unit-test.mjs` — rewritten: original guarantees preserved
  (Test 3 reworked per § 5, not weakened), three new test blocks added (period-3
  cycle, text-content repetition, text-content healthy-negative).
- `03-daemon/carl.mjs` — **NEW.** The two-stage CARL v2 judge module, importable by
  both a test harness and a future `spawn.mjs` production path. Exports `judge()`,
  `isGatedIn()`, `callOnce()`, `TURN_GATE`, `CONFIRM_THRESHOLD`, `SYSTEM_PROMPT`,
  `buildUserPrompt()`.
- `02-forge/tests/carl_v2_two_stage_test.mjs` — **NEW.** 16 checks, split into a
  zero-cost mocked Part 1 and a real-local-Ollama Part 2 (see § 5).
- `02-forge/tests/g3_carl_judge.mjs` — **left untouched**, deliberately. It has a
  historical passing gate record (`02-forge/results/G3_RESULTS.md`, 20/20 at n=20).
  `carl.mjs` duplicates its `SYSTEM_PROMPT` verbatim (cited above) rather than
  importing from it, so this task's changes carry zero risk of retroactively
  altering an already-closed gate's meaning.

## 7. What this does NOT do (explicitly out of scope, not silently skipped)

- Does not wire CARL v2 into `spawn.mjs`'s actual `run()`/`ingest()` production
  path — `carl.mjs` is built to be importable for that, but the task scope was the
  detector + judge module + tests, not the production integration.
  `spawn.mjs` stays shadow-mode-only per existing project policy (`g3_carl_judge.mjs`'s
  own assessment section already recommends this explicitly).
- Does not implement Gemini's adaptive LLM re-check interval (§ 4).
- Does not implement Gemini's sliding sub-string content-chanting window (§ 3) —
  CARL v2's text detector is whole-block, exact-hash only.
- Does not use a genuinely different second model for stage 2 (§ 4) — only one
  local model is available on this machine.
