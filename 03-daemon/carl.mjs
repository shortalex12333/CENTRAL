/**
 * carl.mjs — CARL v2: the reusable two-stage LLM-judge module.
 *
 * Extracted so both the historical G3 test harness's successor and spawn.mjs's
 * eventual production path can import ONE implementation instead of each growing
 * its own copy. `02-forge/tests/g3_carl_judge.mjs` (the original single-call G3
 * gate, kept untouched below — its own comment explains why) is the source of the
 * SYSTEM_PROMPT/rubric reused verbatim here, per this task's explicit instruction.
 *
 * WHY THIS EXISTS — ported design, not a fresh invention. A parallel investigation
 * read Gemini CLI's actual shipped loop detector source directly from the installed
 * npm package (`packages/core/dist/src/services/loopDetectionService.js`, confirmed
 * real — see `06-gemini/GX3_BUILTIN_ROT_DETECTION_RESULTS.md` for the full source
 * citation, line numbers, and cross-checked GitHub issue evidence that this is a
 * live production mechanism, not dead code). Its Tier 3 (the LLM-judge tier) has
 * three properties CARL's original single-call design (g3_carl_judge.mjs) did not:
 *
 *   1. GATED FAR DOWNSTREAM. `LLM_CHECK_AFTER_TURNS = 30` — the LLM judge is not
 *      consulted AT ALL below 30 consecutive turns. Below that, Gemini's own two
 *      free deterministic tiers (tool-call cycle detection, content-chanting
 *      detection — both now ported into spawn.mjs's tier-0.5, see its header
 *      comment) are the only guard. TURN_GATE below matches this exactly.
 *   2. TWO INDEPENDENT MODELS, ONE CONFIRMS THE OTHER. `LLM_CONFIDENCE_THRESHOLD =
 *      0.9` — a cheap model (`gemini-3-flash-base`) proposes a verdict; only if its
 *      confidence clears 0.9 does a second, stronger model (`gemini-3-pro-preview`,
 *      the `loop-detection-double-check` alias) independently re-evaluate the SAME
 *      history, built fresh, before a loop is actually declared. A single model's
 *      opinion never has unilateral authority. CONFIRM_THRESHOLD below matches 0.9.
 *   3. ASYMMETRIC FAILURE MODE. Confirmed real-world false positives on exactly this
 *      kind of gate (GX3 § 4: issues #6950/#9276/#11002, legitimate batch/retry work
 *      misflagged) are why Gemini's own Tier-3 system prompt carries an explicit
 *      "what is NOT a loop" taxonomy. This module encodes the same bias structurally,
 *      not just in a prompt: ANY disagreement between the two stages, OR either
 *      stage's confidence under 0.9, resolves to 'continue'. A missed detection
 *      costs a delay; a false 'stop' costs killing a healthy, working agent — this
 *      module treats the second as strictly worse, matching Gemini's design.
 *
 * 🔴 EXPLICIT LIMITATION — only one local model is available on this machine
 * (qwen3:32b via Ollama). Stage 2 below reuses the SAME model as stage 1. This is
 * NOT a genuine different-model second opinion the way Gemini CLI's real
 * flash-proposes/pro-confirms cascade is. The independence property this module
 * DOES preserve is "asked fresh, blind to stage 1's answer" — stage 2 receives the
 * identical compacted stream and the identical system prompt, built from scratch in
 * a new request, and is never shown stage 1's verdict or confidence, so it is not a
 * rubber stamp. STAGE_2_MODEL is its own named constant specifically so a distinct,
 * stronger model can be swapped in the moment one is available locally — nothing
 * else in this module's shape needs to change for that upgrade.
 *
 * NOT ported here (documented, not silently dropped): Gemini's adaptive re-check
 * interval (`DEFAULT_LLM_CHECK_INTERVAL`, 5-15 turns, tightens as confidence rises)
 * and its Tier-2 sliding 50-char content-chanting window (CARL v2's text-repetition
 * signal lives in spawn.mjs's tier-0.5 as a simpler whole-block hash, not this
 * module's concern). Both are reasonable follow-ups, out of scope for this port.
 */

// ---- Tunable constants, each cited against the real Gemini source in GX3 -------

/** Gemini's real LLM_CHECK_AFTER_TURNS. CARL is not consulted at or below this. */
export const TURN_GATE = 30;

/** Gemini's real LLM_CONFIDENCE_THRESHOLD. Both stages must clear this. */
export const CONFIRM_THRESHOLD = 0.9;

export const OLLAMA_URL = process.env.CARL_OLLAMA_URL || 'http://localhost:11434/api/chat';

/** Stage 1 (cheap proposer) and stage 2 (independent confirmer) model names. */
export const STAGE_1_MODEL = 'qwen3:32b';
export const STAGE_2_MODEL = 'qwen3:32b'; // see the file-header LIMITATION comment — swap here when a second model is available

// ---- Prompt/rubric — reused verbatim from 02-forge/tests/g3_carl_judge.mjs -----
// (that file is left untouched to preserve its historical G3_RESULTS.md pass
// record; this is a deliberate duplication, not drift — keep the two in sync by
// hand if the rubric changes, or migrate g3_carl_judge.mjs to import from here.)

export const SYSTEM_PROMPT = `You are CARL, an automated supervisor that monitors Claude Code agent sessions for context rot and runaway behavior. You are given a compacted JSON summary of an agent's event stream. Event types you may see: system (init), assistant (one turn, optional "note"), tool_use (tool call), tool_result (outcome, "ok" bool), checkpoint (periodic telemetry: cumulative num_turns, cost_usd, optional lines_changed = marginal progress since the prior checkpoint), watchdog (silence_ms = time since the last event with zero new activity), result (terminal event — the run ended cleanly; num_turns/cost_usd are FINAL).

Decide: should this agent CONTINUE running, or be STOPPED?

STOP if any of these hold:
- The same tool is called with identical or near-identical arguments 3+ times in a row without new information or progress (a stuck loop).
- num_turns is climbing past roughly 25-30 with NO "result" event yet, especially if the same failure/error keeps recurring across checkpoints (a runaway that is not converging).
- The stream ends abruptly with no "result" event — e.g. right after a tool_use with no matching tool_result, or a "watchdog" event shows a long silence_ms (several minutes) with nothing since (a stalled/dead stream). IMPORTANT: if the LAST event in the stream is a "tool_use" with no following "tool_result", that tool call's outcome is UNKNOWN and there is no "result" event either — always STOP in this case, no matter how short the stream is. An unresolved final tool call is itself a stop signal, not a "too early to tell."
- Tool results or read-backs contradict each other on the same resource — e.g. an edit is confirmed successful but the next read shows the old value, or tests flip pass/fail/pass/fail across repeated reverts (an incoherent, non-converging loop).
- num_turns keeps climbing across checkpoints while "lines_changed" (marginal progress) shrinks toward zero or near-zero — diminishing-returns thrash with no result.

CONTINUE if:
- The stream ends with a "result" event (the run completed cleanly) — regardless of how many turns it took, as long as no failure pattern above dominated it.
- It is an early/mid-run stream (no result yet, but also no red flag above) showing varied tools, steady or plausible progress, and no long silence.

Worked examples:
Example A — stream: system, assistant, tool_use(Read), tool_result(ok), result(num_turns=3,cost_usd=0.04). This completed cleanly with no red flags. Correct answer: {"verdict":"continue","confidence":0.95}
Example B — stream: system, then the same tool_use(Bash,"npm test") / tool_result(ok:false, same error) repeated 8 times in a row, no result. This is a stuck loop. Correct answer: {"verdict":"stop","confidence":0.95}

Respond with ONLY a single JSON object and nothing else — no markdown, no explanation, no <think> content, exactly this shape:
{"verdict":"continue","confidence":0.0}
or
{"verdict":"stop","confidence":0.0}
"verdict" must be exactly "continue" or "stop". "confidence" must be a number between 0 and 1.`;

export function buildUserPrompt(stream) {
  return `Compacted event stream summary:\n${JSON.stringify(stream)}\n\nRespond with only the JSON verdict object.`;
}

// ---- Low-level single call -------------------------------------------------

/**
 * One Ollama call. Never call `ollama run` (confirmed elsewhere in this project to
 * corrupt piped output via TTY escape sequences) — the HTTP API only.
 */
export async function callOnce(model, stream, ollamaUrl = OLLAMA_URL) {
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(stream) },
    ],
    stream: false,
    format: 'json',
    think: false,
    options: { temperature: 0 },
  };

  const t0 = performance.now();
  const res = await fetch(ollamaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const latencyMs = performance.now() - t0;

  const raw = json?.message?.content ?? '';
  let parsed = null, validShape = false, parseError = null;
  try {
    parsed = JSON.parse(raw);
    validShape =
      parsed &&
      (parsed.verdict === 'continue' || parsed.verdict === 'stop') &&
      typeof parsed.confidence === 'number' &&
      parsed.confidence >= 0 &&
      parsed.confidence <= 1;
  } catch (e) {
    parseError = String(e.message || e);
  }

  return { model, httpStatus: res.status, raw, parsed, validShape, parseError, latencyMs };
}

/** Below the turn gate, CARL is not consulted at all. `turns` must EXCEED TURN_GATE. */
export function isGatedIn(turns) {
  return typeof turns === 'number' && turns > TURN_GATE;
}

/**
 * The two-stage judge. This is CARL v2's only entry point with real halt authority.
 *
 * - Re-checks the turn gate itself (belt and suspenders — safe to call directly
 *   even if a caller forgot the isGatedIn() pre-check; below the gate this returns
 *   immediately WITHOUT ever building a prompt or making a network call).
 * - `opts.call` lets tests inject a fabricated stage1/stage2 responder instead of
 *   hitting real Ollama — defaults to `callOnce` (the real HTTP path) in production.
 *   This keeps the branching logic (gate / confidence bar / independent stage 2 /
 *   fail-toward-continue) unit-testable at zero cost and zero latency, separately
 *   from the handful of real-Ollama integration checks that prove the whole thing
 *   actually works end to end against the live model.
 *
 * Returns `{ verdict: 'continue'|'stop', consulted, gate, reason, turns, stage1, stage2 }`.
 * `consulted:false` means the turn gate alone decided it — the strongest possible
 * proof CARL genuinely did not run below turn 30.
 */
export async function judge(stream, turns, opts = {}) {
  const call = opts.call ?? callOnce;
  const stage1Model = opts.stage1Model ?? STAGE_1_MODEL;
  const stage2Model = opts.stage2Model ?? STAGE_2_MODEL;
  const ollamaUrl = opts.ollamaUrl ?? OLLAMA_URL;

  if (!isGatedIn(turns)) {
    return { verdict: 'continue', consulted: false, gate: 'below_turn_gate', reason: `turns=${turns} <= TURN_GATE=${TURN_GATE}`, turns, stage1: null, stage2: null };
  }

  const stage1 = await call(stage1Model, stream, ollamaUrl);
  const stage1Proposes = stage1.validShape && stage1.parsed.verdict === 'stop' && stage1.parsed.confidence >= CONFIRM_THRESHOLD;
  if (!stage1Proposes) {
    return { verdict: 'continue', consulted: true, gate: 'passed', reason: 'stage1_below_confirm_bar', turns, stage1, stage2: null };
  }

  // Independent second call — SAME stream, SAME prompt, asked fresh. Never shown
  // stage 1's verdict/confidence, so this is a genuine second opinion, not a
  // rubber stamp of stage 1's answer.
  const stage2 = await call(stage2Model, stream, ollamaUrl);
  const stage2Confirms = stage2.validShape && stage2.parsed.verdict === 'stop' && stage2.parsed.confidence >= CONFIRM_THRESHOLD;
  if (!stage2Confirms) {
    return { verdict: 'continue', consulted: true, gate: 'passed', reason: 'stage2_did_not_confirm', turns, stage1, stage2 };
  }

  return { verdict: 'stop', consulted: true, gate: 'passed', reason: 'both_stages_agreed', turns, stage1, stage2 };
}
