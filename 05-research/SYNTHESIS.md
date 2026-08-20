# Context-Rot Detection — Research Synthesis
Date: 2026-08-19 · 4 parallel research tracks · Full detail: `A_FRAMEWORK_DETECTORS.md`,
`B_MEASURABLE_SIGNALS.md`, `C_WATCHDOG_LIBRARIES.md`, `D_PRODUCTION_PRACTICES.md`

## The question that started this: does "ask the agent if it's rotted" ever work?

No. Confirmed independently across all four tracks, not just asserted. **Zero surveyed
framework, library, or disclosed production system uses an LLM-judge as the primary
detector.** Where an LLM appears at all (AutoGPT's escalation to a stronger model, CrewAI's
forced-final-answer), it fires only *after* a deterministic counter or equality check has
already tripped — never as the trigger itself.

## What the industry actually converged on, independently, many times over

The same ~40-100 line primitive was reinvented from scratch in at least seven unrelated
places: OpenHands' `StuckDetector`, AutoGPT classic's `WatchdogComponent`, and five
standalone GitHub projects (`loopgain`, `contextrot`, `opencode-anti-loop`, `AgentCircuit`,
NousResearch/hermes-agent's `tool_guardrails.py`, a 233k-star production framework). None of
them import it from each other. **That convergence is itself the strongest evidence this is
the correct primitive** — not a citation, an observed pattern:

> Fingerprint a tool call (name + canonicalized arguments), keep a sliding window, count
> exact repeats. Nudge below a threshold, hard-stop at it.

Real-world validation: **a documented anthropics/claude-code runaway incident (#4095)**
showed 913 identical repeated commands and 38 consecutive tool errors as its forensic
signature — exactly the two signals this pattern catches.

## What's genuinely NOT covered by the obvious version of this

- **Period-2 alternation (A-B-A-B...).** OpenHands is the only system found that checks for
  this. A naive "last N identical" check misses an agent oscillating between two distinct
  actions — arguably the more common real failure mode, not the rarer one.
- **Tool errors specifically**, tracked separately from tool repetition. Same tool, same
  args, failing three times in a row is a different signal than looping on a *successful*
  call, and needs its own streak counter.
- **No adoptable drop-in library exists.** `loopgain` and `contextrot` are real but early
  (loopgain: 124 stars, pushed 2 days before this research). Every serious implementation
  hand-rolls the fingerprint+threshold core rather than importing it — itself informative:
  this piece is meant to be built per-host-architecture, not installed.

## What's a dead end on this specific stack

- **Perplexity/logprobs** — strongest academic backing of any candidate (Nature 2024
  semantic-entropy paper), but Claude's API/CLI exposes no logprobs field at all. Not
  available to us, full stop.
- **Anthropic's own SDK hooks** (`PreCompact`/`PostCompact`, ~30 lifecycle events total) are
  confirmed entirely structural — they fire on token count, never on output quality. This
  reconfirms the earlier finding: compaction is not a rot detector.

## One idea from the production track worth carrying forward, not yet implemented

Anthropic's own "Effective harnesses for long-running agents" post: judge agent progress by
**external ground truth** — actual test/build exit codes, git diff/commit activity, file
mtimes — checked from *outside* the subprocess, rather than trusting anything the subprocess
reports about itself. This is a different axis from tool-call fingerprinting (which watches
*behavior*) — this watches *effect*. Not built yet; worth its own gate once workers are doing
real file-mutating work, not just read-only probes.

## Action taken immediately (see `03-daemon/spawn.mjs`, verified via `spawn.unit-test.mjs`, 7/7)

Two real, concrete gaps this research found in our own code, fixed same-session:
1. `tool_result.is_error` was flowing through every stream-json event **completely unread**
   — `ingest()` had no `user`-event case at all. Now tracked with a per-fingerprint error
   streak (nudge at 2, hard-stop at 3, matching OpenHands' validated thresholds).
2. The existing loop heuristic matched on **tool name only** (`Read` three times in a row
   trips it, even with three different paths). Upgraded to a canonicalized name+args
   fingerprint, plus the period-2 alternation check nothing else in our stack had.

CARL's Ollama judge is unchanged in role: still downstream, reserved for the ambiguous case
none of this catches — no literal repeat, no error streak, but visibly not progressing.
