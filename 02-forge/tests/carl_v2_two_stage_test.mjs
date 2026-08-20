#!/usr/bin/env node
/**
 * CARL v2 — two-stage judge verification.
 *
 * Two independent blocks:
 *
 *   PART 1 — zero-cost, zero-latency, deterministic. Injects a fabricated `call`
 *   responder into carl.mjs's judge() (dependency injection — see carl.mjs's
 *   `opts.call`) so every branch of the turn-gate / confidence-bar / independent-
 *   confirmation / fail-toward-continue logic is proven WITHOUT touching Ollama at
 *   all. This includes the specific proof the task asked for: a synthetic
 *   turns=15 case where the injected responder THROWS if ever invoked — if CARL
 *   consulted it below the turn gate, this test would fail loudly, not silently.
 *
 *   PART 2 — real local Ollama calls (qwen3:32b), zero Claude API dollars, a few
 *   seconds of local wall-clock time. Proves the wiring actually works end-to-end
 *   against the live model, not just the branching logic in isolation. Reuses
 *   02-forge/tests/g3_fixtures.json's pathological fixtures that carry turns >= 30
 *   (p03, p04, p09, p10 — the only fixtures in that set that clear TURN_GATE=30;
 *   no HEALTHY fixture in g3_fixtures.json reaches turn 30, so one synthetic
 *   healthy-but-long stream is fabricated here to cover that case, in the same
 *   compacted-stream shape g3_fixtures.json already uses).
 *
 * Run: node 02-forge/tests/carl_v2_two_stage_test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  judge, isGatedIn, TURN_GATE, CONFIRM_THRESHOLD, callOnce,
} from '../../03-daemon/carl.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = path.join(__dirname, 'g3_fixtures.json');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}
async function checkAsync(name, fn) {
  try { check(name, await fn()); }
  catch (e) { fail++; console.log(`  FAIL ${name} — threw: ${e.message}`); }
}

// A trivial fabricated stream — content doesn't matter for PART 1 since the
// injected `call` responder ignores it; only the branching logic is under test.
const DUMMY_STREAM = [{ t: 'system', s: 'init' }];

function mockCall(sequence) {
  // Returns a `call(model, stream, url)` that hands back the next canned response
  // each time it's invoked, and records every invocation for assertion.
  let i = 0;
  const calls = [];
  const fn = async (model, stream, url) => {
    calls.push({ model, stream, url });
    if (i >= sequence.length) throw new Error('mockCall invoked more times than expected');
    const r = sequence[i++];
    return { model, httpStatus: 200, raw: JSON.stringify(r), parsed: r, validShape: true, parseError: null, latencyMs: 0 };
  };
  fn.calls = calls;
  return fn;
}

console.log('=== PART 1 — zero-cost mocked branching logic ===\n');

// Boundary check on the gate itself — "turns EXCEEDS the gate", not "reaches it".
check('isGatedIn(29) is false (below gate)', isGatedIn(29) === false);
check('isGatedIn(30) is false (AT the gate does not count — must exceed)', isGatedIn(30) === false);
check('isGatedIn(31) is true (just past the gate)', isGatedIn(31) === true);
check('TURN_GATE is 30, matching Gemini CLI\'s real LLM_CHECK_AFTER_TURNS (GX3)', TURN_GATE === 30);
check('CONFIRM_THRESHOLD is 0.9, matching Gemini CLI\'s real LLM_CONFIDENCE_THRESHOLD (GX3)', CONFIRM_THRESHOLD === 0.9);

await checkAsync('turns=15 (below gate): CARL is not consulted at all — the responder THROWS if called, proving zero Ollama invocation, not just an unused result', async () => {
  const throwingCall = async () => { throw new Error('judge() called Ollama below TURN_GATE — this must never happen'); };
  const result = await judge(DUMMY_STREAM, 15, { call: throwingCall });
  return result.consulted === false && result.verdict === 'continue' && result.gate === 'below_turn_gate';
});

await checkAsync('turns=35, stage1 confidence 0.6 (< 0.9): verdict is continue, and stage 2 is NEVER called (only 1 invocation happened)', async () => {
  const mock = mockCall([{ verdict: 'stop', confidence: 0.6 }]);
  const result = await judge(DUMMY_STREAM, 35, { call: mock });
  return result.verdict === 'continue' && result.consulted === true &&
    result.reason === 'stage1_below_confirm_bar' && mock.calls.length === 1;
});

await checkAsync('turns=35, stage1 stop@0.95, stage2 continue: independent disagreement resolves to continue (fail toward continue)', async () => {
  const mock = mockCall([{ verdict: 'stop', confidence: 0.95 }, { verdict: 'continue', confidence: 0.8 }]);
  const result = await judge(DUMMY_STREAM, 35, { call: mock });
  return result.verdict === 'continue' && result.reason === 'stage2_did_not_confirm' && mock.calls.length === 2;
});

await checkAsync('turns=35, stage1 stop@0.95, stage2 stop@0.85 (agrees on verdict but UNDER the confidence bar): still continue', async () => {
  const mock = mockCall([{ verdict: 'stop', confidence: 0.95 }, { verdict: 'stop', confidence: 0.85 }]);
  const result = await judge(DUMMY_STREAM, 35, { call: mock });
  return result.verdict === 'continue' && result.reason === 'stage2_did_not_confirm';
});

await checkAsync('turns=35, both stages stop with confidence >= 0.9: verdict is stop, with real two-call authority', async () => {
  const mock = mockCall([{ verdict: 'stop', confidence: 0.95 }, { verdict: 'stop', confidence: 0.92 }]);
  const result = await judge(DUMMY_STREAM, 35, { call: mock });
  return result.verdict === 'stop' && result.reason === 'both_stages_agreed' && mock.calls.length === 2;
});

await checkAsync('a malformed/invalid-JSON stage1 response fails toward continue, not a crash', async () => {
  const badCall = async (model) => ({ model, httpStatus: 200, raw: 'not json', parsed: null, validShape: false, parseError: 'boom', latencyMs: 0 });
  const result = await judge(DUMMY_STREAM, 35, { call: badCall });
  return result.verdict === 'continue' && result.reason === 'stage1_below_confirm_bar';
});

console.log(`\nPart 1: ${pass}/${pass + fail} checks passed so far.\n`);

console.log('=== PART 2 — real local Ollama (qwen3:32b), $0 Claude API cost ===\n');

const fixturesFile = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8'));
const gatedInPathological = fixturesFile.fixtures.filter((f) => {
  const turns = f.stream.filter((e) => 'num_turns' in e).map((e) => e.num_turns);
  return f.expected === 'stop' && turns.length && Math.max(...turns) > TURN_GATE;
});
console.log(`Found ${gatedInPathological.length} pathological fixtures with turns > ${TURN_GATE}: ${gatedInPathological.map((f) => f.id).join(', ')}`);

// No healthy fixture in g3_fixtures.json reaches turn 30 (checked directly against
// the fixture file) — fabricate one clean long-running stream to cover that case,
// in the same compacted shape the other fixtures use.
const HEALTHY_LONG_STREAM = [
  { t: 'system', s: 'init' },
  ...Array.from({ length: 15 }, (_, i) => {
    const tool = ['Read', 'Edit', 'Bash'][i % 3];
    return [
      { t: 'assistant' },
      { t: 'tool_use', tool, args: { file: `module_${i}.py` } },
      { t: 'tool_result', tool, ok: true },
    ];
  }).flat(),
  { t: 'checkpoint', num_turns: 32, cost_usd: 1.2, lines_changed: 8 },
  { t: 'result', num_turns: 35, cost_usd: 1.35 },
];

let realCalls = 0;
const realCallCounter = async (model, stream, url) => { realCalls++; return callOnce(model, stream, url); };

for (const f of gatedInPathological) {
  const turns = Math.max(...f.stream.filter((e) => 'num_turns' in e).map((e) => e.num_turns));
  await checkAsync(`[${f.id}] real Ollama, turns=${turns} (pathological, gated in): CARL v2 reaches a verdict`, async () => {
    const result = await judge(f.stream, turns, { call: realCallCounter });
    console.log(`      -> verdict=${result.verdict} consulted=${result.consulted} reason=${result.reason} ` +
      `stage1=${result.stage1?.parsed ? JSON.stringify(result.stage1.parsed) : 'n/a'} ` +
      `stage2=${result.stage2?.parsed ? JSON.stringify(result.stage2.parsed) : 'not called'}`);
    return result.consulted === true; // report the verdict; a live model can legitimately disagree with the label
  });
}

await checkAsync('synthetic healthy-but-long stream (turns=35, clean result, varied tools): reaches a verdict via real Ollama', async () => {
  const result = await judge(HEALTHY_LONG_STREAM, 35, { call: realCallCounter });
  console.log(`      -> verdict=${result.verdict} consulted=${result.consulted} reason=${result.reason} ` +
    `stage1=${result.stage1?.parsed ? JSON.stringify(result.stage1.parsed) : 'n/a'} ` +
    `stage2=${result.stage2?.parsed ? JSON.stringify(result.stage2.parsed) : 'not called'}`);
  return result.consulted === true;
});

console.log(`\nTotal real Ollama calls made in Part 2: ${realCalls} (local model, $0.00 Claude API cost).`);
console.log(`\n${pass}/${pass + fail} total checks passed`);
process.exit(fail === 0 ? 0 : 1);
