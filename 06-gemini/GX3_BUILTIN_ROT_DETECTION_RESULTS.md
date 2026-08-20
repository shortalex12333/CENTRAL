# GX3 — Does Gemini CLI already solve loop/stuck/context-degradation detection?

Date: 2026-08-20 · Machine: this Mac · Gemini CLI version: **0.55.1**
(`gemini --version`; installed via `npm i -g @google/gemini-cli`, NOT the deprecated
Homebrew cask — `brew info gemini-cli` shows that formula is "Not installed" and
deprecated 2026-12-18 in favor of `antigravity-cli`. The live binary is
`/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/gemini.js`.)

Method: direct local commands (`gemini hooks`, `gemini gemma`, `gemini --help`),
direct read of Gemini CLI's own shipped source (the npm bundle ships largely
un-minified, attributed source — `// packages/core/dist/src/services/loopDetectionService.js`
comments are intact), local settings/docs read, one WebSearch pass cross-checked
against the public `google-gemini/gemini-cli` GitHub issue tracker. **No live
`gemini -p ...` calls were made against the actual model** — nothing below required
spending API budget; everything is either a `--help`/config-file read or a source-code
read. Total cost: **$0.00**.

## Answer, up front

**Yes — Gemini CLI has a native, on-by-default, three-tier loop detector, and one of
its three tiers is genuinely an LLM-judge — not a hypothetical, a real ~460-line
shipped class (`LoopDetectionService`, `packages/core/dist/src/services/loopDetectionService.js`)
read directly from the installed package.** This directly updates the open gap in
`SYNTHESIS.md` (which explicitly did not cover Gemini CLI): Gemini CLI's LLM-judge
tier is real and shipped, not vaporware. **But it does not primary-detect** —
it is the third of three tiers, gated to fire only after two purely deterministic,
free tiers have already run and found nothing, and it needs **two separate models to
agree** before it's allowed to declare a loop. This is the same
nudge-then-hard-stop / deterministic-first architecture `SYNTHESIS.md` found converged
on independently elsewhere — Gemini CLI is now a fourth independent confirmation of
that shape, not a counter-example to it. Separately: **`gemini gemma` is not a
supervision mechanism at all** — it is a cost-tiering request classifier (routes
"simple" prompts to Flash, "complex" ones to Pro), unrelated to loop/stuck detection,
confirmed by reading its docs, its `--help`, its source, and by running
`gemini gemma status` live (not installed/not enabled on this machine).

---

## 1. `gemini hooks` — what hook points actually exist

```
$ gemini hooks --help
Manage Gemini CLI hooks.
Commands:
  gemini hooks migrate  Migrate hooks from Claude Code to Gemini CLI
```

There is no `gemini hooks list` subcommand (that guess in the task brief was wrong —
verified by running `--help`, not assumed). Hook *events* are enumerated in
`docs/hooks/reference.md` and `docs/hooks/index.md` inside the installed package
(`/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/docs/hooks/`), read directly:

| Event | When it fires | Impact |
|---|---|---|
| `SessionStart` / `SessionEnd` | session begins/ends | inject context / advisory |
| `BeforeAgent` / `AfterAgent` | before/after a full turn | block turn / **force retry or halt** |
| `BeforeModel` / `AfterModel` | around the LLM call | swap models, mock response, redact |
| `BeforeToolSelection` | before tool choice | filter available tools |
| `BeforeTool` / `AfterTool` | around a tool call | block/rewrite args, block/replace result |
| `PreCompress` | before context summarization | **advisory only** — cannot block or modify |
| `Notification` | system alert | advisory |

**Claude Code parallel, checked directly against it:** Claude Code has both
`PreCompact` *and* `PostCompact` (confirmed in the prior `G2_NATIVE_FEATURE_CHECK.md`
gate — hooks that can *block* compaction with exit code 2). Gemini CLI has **only
`PreCompress`, and it is explicitly documented as "Advisory Only... cannot block or
modify the compression process. Flow-control fields are ignored."** — a real,
verified divergence: Gemini's compression hook is strictly weaker than Claude's
`PreCompact` (observe-only, no veto), and there is no `PostCompress` equivalent to
Claude's `PostCompact` at all in the reference doc.

Nothing in the hooks table names "loop," "stuck," or "repeated" — the closest is
`AfterAgent`'s stated purpose, "Primary use case is **response validation and
automatic retries**" (`decision: "deny"` → forces a retry with `reason` fed back to
the model as a correction prompt; `continue: false` stops the session outright). This
is a general-purpose hook a supervisor *could* use to implement its own judge, but it
is not itself a loop detector — it fires once per turn with no memory of prior turns
built in.

`gemini hooks migrate --from-claude` exists specifically to port **Claude Code**
hook configs into Gemini CLI's format (not run — it would write files; confirmed via
`--help` only: `--from-claude  Migrate from Claude Code hooks [boolean]`). This
signals Google is deliberately targeting parity with Claude Code's hook surface for
migration purposes, which makes the `PreCompress`-only gap above more likely a current
snapshot than a permanent design choice.

## 2. `gemini gemma` — NOT a supervision/judge model, confirmed by running it

```
$ gemini gemma --help
Manage local Gemma model routing
Commands:
  gemini gemma setup   Download and configure Gemma local model routing
  gemini gemma start   Start the LiteRT-LM server
  gemini gemma stop    Stop the LiteRT-LM server
  gemini gemma status  Check Gemma local model routing status
  gemini gemma logs    View LiteRT-LM server logs

$ gemini gemma status
Gemma Local Model Routing Status
  Binary:    ✗ Not installed
  Model:     ✗ gemma3-1b-gpu-custom not found
  Server:    ✗ Not running on port 9379
  Settings:  ✗ Not enabled in settings.json
```

Ran live — exit code 1, all four checks fail on this machine (never set up here).
Read `docs/core/gemma-setup.md` and `docs/core/local-model-routing.md` from the
installed package for what it's *for*, quoted verbatim:

> "Local model routing uses a local Gemma 3 1B model running on your machine to
> **classify and route user requests**. It routes simple requests (like file reads) to
> Gemini Flash and complex requests (like architecture discussions) to Gemini Pro."
>
> "How it works under the hood: Local Gemma classifies each request as 'simple' or
> 'complex' (~100ms). Simple → Flash, Complex → Pro. If the local server is down, the
> CLI silently falls back to the cloud classifier — no errors, no disruption."

Confirmed against the actual source too — `bundle/liteRtServerManager-3I2T6MGB.js`
(`packages/cli/src/services/liteRtServerManager.ts`), a small, fully-readable file:
it only ever calls `ensureRunning(gemmaSettings)`, which checks
`gemmaSettings?.enabled`, finds/starts a LiteRT-LM binary, and does nothing else —
no supervisor logic, no error/repeat tracking, no hook into the loop detector at all.

**This is a cost/latency optimization for model selection (Flash vs Pro), not a
supervision, safety, or degradation-detection mechanism.** It is disabled by default
(`experimental.gemmaModelRouter.enabled`: `false`, confirmed in
`docs/reference/configuration.md`) and, per `docs/reference/configuration.md:2006`,
there is a *separate* `experimental.gemma` flag (default `true`) that only "enables
access to Gemma 4 models via the Gemini API" as ordinary chat-completion models — also
unrelated to supervision. **The name is the only thing this shares with CARL's Qwen
router; the function does not overlap with CARL's role at all.**

## 3. The actual finding — `LoopDetectionService`, read directly from shipped source

Location in the installed package (comment left intact by the bundler):
`bundle/chunk-32XQ54AJ.js:340642` → `// packages/core/dist/src/services/loopDetectionService.js`.
This is the real, currently-shipping implementation for v0.55.1 — not a doc claim, not
a changelog line, the actual class body, read in full (`sed -n '340642,341126p'`).

### Tier 1 — deterministic tool-call cycle detection (free, runs on every tool call)

```js
var TOOL_CALL_LOOP_THRESHOLD = 5;
getToolCallKey(toolCall) {
  const argsString = JSON.stringify(toolCall.args);
  return sha256(`${toolCall.name}:${argsString}`);
}
```

Every tool call is hashed (name + full JSON args, not name alone — this is the same
"canonicalized name+args fingerprint" upgrade `SYNTHESIS.md` records CENTRAL's own
`spawn.mjs` just made). The history buffer is checked for a repeating cycle of
**period k, for every k from 1 to 5**, each required to repeat **5 times**
(`requiredLength = k * R`, checked for k=1..5). This is a direct generalization of the
one gap `SYNTHESIS.md` flagged as under-covered industry-wide — "Period-2 alternation
… OpenHands is the only system found that checks for this." **Gemini CLI checks
periods 1 through 5, not just period-1 (identical-repeat) or period-2
(alternation) — a broader deterministic check than anything else the CENTRAL research
found**, still 100% deterministic, zero LLM cost.

### Tier 2 — deterministic content-chanting detection (free, runs on every streamed text chunk)

```js
var CONTENT_LOOP_THRESHOLD = 10;
var CONTENT_CHUNK_SIZE = 50;
```

Sliding 50-char hash window over the model's *streamed text output* (not tool calls —
this catches an agent repeating the same sentence/plan in prose, which a tool-call
fingerprint can't see). A loop requires the same chunk hash to reappear 10 times
within an average distance ≤ 250 chars, **and** a `periods.size` check that rejects
the match if there are more than 5 distinct inter-occurrence substrings — i.e. it also
requires the repeat to be *periodic*, not just frequent. Explicitly suppressed inside
code blocks, tables, lists, and headings ("repetitive code structures are common and
not necessarily loops" — a stated, deliberate false-positive guard).

### Tier 3 — the LLM-judge (costs tokens, gated to fire rarely)

```js
var LLM_CHECK_AFTER_TURNS = 30;
var DEFAULT_LLM_CHECK_INTERVAL = 10;   // adaptive, 5-15
var LLM_CONFIDENCE_THRESHOLD = 0.9;
var DOUBLE_CHECK_MODEL_ALIAS = "loop-detection-double-check";
```

Only after **30 consecutive turns inside a single prompt/task**, and then only
periodically (every 5–15 turns, tightened as confidence rises — `updateCheckInterval`),
does the CLI call an LLM at all. When it does:

1. Sends the last 20 history turns (`LLM_LOOP_CHECK_HISTORY_COUNT`) plus the original
   user request to a **`loop-detection` model config** — confirmed in
   `docs/reference/configuration.md:806-809` to resolve to `gemini-3-flash-base` — with
   a long, explicit system prompt (`LOOP_DETECTION_SYSTEM_PROMPT`, read in full) that
   distinguishes true loops ("same tool, semantically equivalent args, same outcome,
   5+ times, zero net progress") from things that only *look* repetitive ("cross-file
   batch operations," "incremental same-file edits," "retry with variation"). It
   returns a JSON `{unproductive_state_analysis, unproductive_state_confidence}`.
2. If Flash's confidence is **< 0.9**, no loop — done, cheap.
3. If Flash's confidence is **≥ 0.9**, it escalates to a **second, stronger model**
   — `loop-detection-double-check`, confirmed to resolve to `gemini-3-pro-preview`
   (`configuration.md:810-814`) — with the *same* prompt and history, and only
   declares `LoopType.LLM_DETECTED_LOOP` if the **Pro model also scores ≥ 0.9**. If
   the double-check model is unavailable, it falls back to trusting Flash alone.

This is a genuine two-model escalation ladder (cheap judge → confirm with an expensive
judge), gated behind two free deterministic tiers, gated further behind a 30-turn
floor, and gated a third time behind an adaptive re-check interval so it doesn't run
every turn even after 30. It is real, shipped, and reads exactly like the "AutoGPT's
escalation to a stronger model" pattern `SYNTHESIS.md` already names — just far more
elaborate, with a genuine confidence-threshold-gated two-model confirmation step
`SYNTHESIS.md`'s survey didn't find anywhere else.

### What happens on detection — nudge, then hard-stop (verified from the consumer code)

Read the calling site (`chunk-32XQ54AJ.js:345036-345100`, `:345362`):

- **First detection** (`loopResult.count === 1`): **not a hard stop.** The turn is
  aborted and `_recoverFromLoop` injects a synthetic system message back into history
  — *"System: Potential loop detected... Please take a step back and confirm you're
  making forward progress... Avoid repeating the same tool calls or responses without
  new results."* — then **automatically continues** with one fewer remaining turn
  budget (`boundedTurns - 1`). `clearDetection()` resets the flag but **not** the
  count, "so that the next detection will be count 2" (comment in source).
- **Second detection in the same task** (`loopResult.count > 1`): hard stop —
  `yield { type: GeminiEventType.LoopDetected }` and the turn returns immediately, no
  further recovery attempt.
- Separately, `model.maxSessionTurns` (default `-1`, unlimited) can independently fire
  `GeminiEventType.MaxSessionTurns` if the turn budget runs out during a recovery
  attempt.

**This is exactly the "nudge below a threshold, hard-stop at it" shape `SYNTHESIS.md`
already identified as the industry-converged pattern** — now confirmed present,
independently, in a fourth codebase (after OpenHands, AutoGPT classic, and the five
standalone GitHub projects `SYNTHESIS.md` already lists), and confirmed to include an
LLM-judge tier that none of those others document doing at this level of rigor.

The whole thing is toggleable — `model.disableLoopDetection` (default `false`,
confirmed in `docs/cli/settings.md:108`), and per changelog PR #8231
("Loop detection confirmation… presented with a dialog to disable detection for the
current session") the interactive UI surfaces a per-session opt-out when a loop fires,
which matches `this.loopDetector.disableForSession()` in source.

## 4. Cross-check against public issue tracker (WebSearch pass)

Searched `"gemini cli loop detection LLM confidence double-check flash pro model"` and
a second `site:github.com/google-gemini` pass. Neither search surfaced Google's own
docs describing the two-model confidence cascade in prose (it isn't blogged about —
the source read above is the only place this is documented at all). What the search
**did** corroborate:
- The error string agents actually see — *"A potential loop was detected. This can
  happen due to repetitive tool calls or other model behavior. The request has been
  halted."* — appears across multiple real user-filed issues (#8928, #8237, #5761),
  confirming this is a live, user-facing production mechanism, not dead code.
- A recurring complaint pattern (issues #6950, #9276, #11002): early/deterministic-only
  loop detection produced **false positives on legitimate repetitive batch work**
  ("10 shell commands in a row," "loop an audio file 8 times") — which is the exact
  failure mode the Tier-3 system prompt's "What is NOT an unproductive state" section
  (cross-file batch ops, incremental edits, retry-with-variation) reads as having been
  written specifically to fix. The LLM-judge tier is best read as a **false-positive
  reducer bolted onto an already-existing deterministic detector**, not a from-scratch
  supervision layer — consistent with, not contradicting, `SYNTHESIS.md`'s framing
  that LLM-judges show up only downstream of a deterministic trigger.
- One architectural discussion (#5594) independently flags that the LLM check itself
  can misfire on Flash and cause "weird" corrective behavior in Pro — real-world
  confirmation that even a two-model confidence gate is not immune to false positives,
  a useful caution for CARL's own design, not just a feature to copy uncritically.

Sources:
- [Loop feature triggers Loop Detection even on a lower threshold #6950](https://github.com/google-gemini/gemini-cli/issues/6950)
- ['A potential loop was detected' error renders Gemini CLI unusable #8237](https://github.com/google-gemini/gemini-cli/issues/8237)
- [always got this error on gemini 2.5 flash... #8928](https://github.com/google-gemini/gemini-cli/issues/8928)
- [Selective loop detection exceptions #9276](https://github.com/google-gemini/gemini-cli/issues/9276)
- [Improving loop detection #11002](https://github.com/google-gemini/gemini-cli/issues/11002)
- [Architectural observations discussion #5594](https://github.com/google-gemini/gemini-cli/discussions/5594)
- [All sessions fail with loop detected #5761](https://github.com/google-gemini/gemini-cli/issues/5761)

## 5. What this means for CARL

1. **This does not replace CARL, but it is directly reusable prior art for CARL's
   architecture, not just its existence.** `SYNTHESIS.md`'s core finding — deterministic
   fingerprinting first, LLM-judge only as a gated escalation, nudge-then-hard-stop —
   is now confirmed independently a fourth time, in a system CENTRAL didn't survey
   yet, at a level of engineering maturity (two-model confidence cascade, adaptive
   re-check interval, explicit false-positive taxonomy in the judge's own system
   prompt) beyond anything else found so far. **CARL's Ollama/Qwen judge is the right
   general shape; Gemini CLI is evidence to *build it exactly like this*, not evidence
   to abandon it.**
2. Concretely worth lifting into CARL's design, in priority order:
   - **The period-1-through-5 cycle check** (Tier 1 here) is strictly better than a
     plain "last N identical" or even a period-2-only check — worth adopting outright
     in CARL's deterministic tier, on top of the fingerprinting fix `SYNTHESIS.md`
     already shipped this session.
   - **The gating cascade** (deterministic tiers run on every event for free; LLM
     tier only after a turn floor, only periodically, only escalating past a fixed
     confidence bar) is a concrete, working template for exactly the "ambiguous case
     none of this catches" role `SYNTHESIS.md` already reserved for CARL's judge —
     Gemini CLI's system prompt taxonomy (batch-ops / incremental-edits /
     retry-with-variation as explicit NOT-a-loop cases) is a ready-made checklist for
     CARL's own judge prompt.
   - **Two-model confirmation before acting** (cheap model flags, expensive model
     confirms) is a cost/reliability trade CARL doesn't currently make (CARL is a
     single local Qwen judge) — worth evaluating once CARL's judge is live enough to
     measure its own false-positive rate, per the #5594 caution above that even Google's
     two-model gate isn't immune.
   - **Nudge-then-hard-stop, with the nudge as an in-band corrective message rather
     than an out-of-band kill**, is worth comparing against CARL's current halt
     behavior — Gemini's first strike doesn't kill the session, it *tells the agent it
     looks stuck and lets it self-correct*, only escalating to a real stop on repeat.
3. Gemini's `PreCompress` hook is weaker than Claude's `PreCompact`/`PostCompact` pair
   (advisory-only, no veto, no post-event) — if CENTRAL ever runs CARL against a
   Gemini-CLI-driven worker, it cannot lean on hook-level compaction visibility the
   way the Claude-side G2 gate showed was possible; CARL would need its own external
   watch (file mtimes / process output) for that runtime specifically, reinforcing
   the "external ground truth" idea `SYNTHESIS.md` already flagged as not-yet-built.
4. **`gemini gemma` is a dead end for this question** — confirm this explicitly in
   any downstream summary so nobody re-investigates it: it is a cost router, not a
   supervisor, disabled by default, unrelated to CARL's role.

## Files referenced (all read-only; nothing under the gemini-cli package was modified)

- `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/chunk-32XQ54AJ.js`
  (lines 340642–341126, `LoopDetectionService`; lines 331500–331520,
  `GeminiEventType` enum; lines 344976–345100 and 345362, consumer/turn logic;
  lines 276432–276439, `LoopType` enum; lines 277217–283945, telemetry event names)
- `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/liteRtServerManager-3I2T6MGB.js`
  (full file, Gemma auto-start logic)
- `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/docs/hooks/index.md`,
  `docs/hooks/reference.md` (hook event table, schemas, exit codes)
- `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/docs/core/gemma-setup.md`,
  `docs/core/local-model-routing.md` (Gemma router purpose)
- `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/docs/reference/configuration.md`
  (lines 806–815 loop-detection model aliases; lines 2006, 2147–2178 gemma settings)
- `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/docs/cli/settings.md`
  (line 108, `model.disableLoopDetection`; lines 106-107, session turns/compression)
- `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/docs/changelogs/index.md`
  (PR #8231 loop-detection confirmation dialog; PR #28470/#28424 loop mitigations)
- `~/.gemini/settings.json` (read-only, confirms no gemma/hooks config on this account)
- `/Users/celeste7/Documents/CENTRAL/05-research/SYNTHESIS.md` (background, read)
- `/Users/celeste7/Documents/CENTRAL/02-forge/results/G2_NATIVE_FEATURE_CHECK.md`
  (background, read — rigor template followed above)

Live commands run: `gemini --version`, `gemini --help`, `gemini hooks --help`,
`gemini hooks migrate --help`, `gemini gemma --help`, `gemini gemma setup --help`,
`gemini gemma status --help`, `gemini gemma status` (exit 1, not installed).

## Cost accounting

**$0.00.** No `gemini -p` / model-invoking call was made. All evidence came from
`--help` output, live non-model CLI subcommands (`gemma status`), and direct reads of
the installed npm package's shipped source and docs, plus one free WebSearch pass.
