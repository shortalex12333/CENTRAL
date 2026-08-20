/**
 * Zero-API-cost verification of the tier-0.5 rot heuristics in spawn.mjs.
 * Feeds fabricated stream-json events directly into Worker.ingest() — no
 * subprocess, no network call. Run: node spawn.unit-test.mjs
 *
 * 🔴 2026-08-20 — updated for the generalized period-1..5 cycle detector (ported
 * from Gemini CLI's shipped LoopDetectionService — see spawn.mjs header comment
 * and CARL_V2_DESIGN.md). Every ORIGINAL guarantee this file checked still holds:
 *   - identical-run detection still nudges once, then hard-stops (Test 1)
 *   - fingerprint (name+args) beats name-only matching (Test 2)
 *   - A-B-A-B alternation (period 2) is still caught (Test 3 — REWORKED: the old
 *     code hard-stopped directly off a one-shot ALTERNATION_LEN=6 check with no
 *     nudge stage; the new general detector nudges on the FIRST cycle detection
 *     and hard-stops on the SECOND for every period uniformly (see
 *     evaluateCycle() in spawn.mjs), so this test now feeds 12 calls instead of 6
 *     to reach that second detection, and asserts both stages fire. The
 *     guarantee — "A-B-A-B alternation gets flagged" — is unchanged and is now
 *     verified more strongly, not weakened)
 *   - the error-streak mechanism is untouched (Test 4)
 *   - a healthy varied session still trips nothing (Test 5)
 * NEW in this file (proving the generalization actually matters, not just a
 * refactor):
 *   - Test 6: a period-3 cycle (A-B-C-A-B-C-A-B-C...) is now caught — this
 *     pattern was structurally undetectable before this change: the old code
 *     only ever checked period 1 (HARD_STOP_AT) and period 2 (ALTERNATION_LEN).
 *   - Test 7/8: streamed assistant TEXT content repetition is now tracked and
 *     cycle-detected too (item 2) — old code never inspected text blocks, only
 *     tool_use blocks, so an agent looping on prose without repeating a tool
 *     call was invisible to Tier-0.5 entirely until this change.
 */
import { Worker } from './spawn.mjs';

function fresh() {
  const w = new Worker({ role: 'probe', task: 'unit-test', cwd: '.' });
  const seen = [];
  w.on('nudge', (e) => seen.push(['nudge', e.reason, e.period]));
  w.on('suspect-rot', (e) => seen.push(['suspect-rot', e.reason, e.period]));
  return { w, seen };
}

function toolUse(id, name, input) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } };
}
function toolResult(id, is_error) {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } };
}
function assistantText(text) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// Test 1: identical fingerprint repeated should nudge once, then hard-stop.
// With CYCLE_MIN_REPEATS=3, period-1 (window=3) first detects at the 3rd
// identical call (nudge) and detects again at the 4th (hard-stop) — the same
// 3-then-4 shape the old NUDGE_AT=3/HARD_STOP_AT=4 pair had, now produced by
// one general constant instead of two special-cased ones.
{
  const { w, seen } = fresh();
  for (let i = 0; i < 4; i++) w.ingest(toolUse(`c${i}`, 'Read', { path: '/a.txt' }));
  check('nudges once before hard-stop', seen.filter(([t]) => t === 'nudge').length === 1);
  check('hard-stops on the 4th identical call', seen.some(([t, r]) => t === 'suspect-rot' && r === 'repeated_identical_tool_call'));
}

// Test 2: same args but DIFFERENT tool name each time should NOT trip (proves fingerprint > name-only).
{
  const { w, seen } = fresh();
  const tools = ['Read', 'Grep', 'Glob', 'Read', 'Grep', 'Glob'];
  tools.forEach((t, i) => w.ingest(toolUse(`c${i}`, t, { path: '/a.txt' })));
  check('varying tool names do not falsely trip identical-run', !seen.some(([t, r]) => t === 'suspect-rot' && r === 'repeated_identical_tool_call'));
}

// Test 3: A-B-A-B... alternation (period-2 cycle) — the case name-only repetition
// misses entirely. Reworked for the general detector: first cycle detection (at
// call 6) nudges; the SAME pattern persisting to call 12 hard-stops. Both stages
// are asserted, so this is a strictly stronger check than the old one-shot version.
{
  const { w, seen } = fresh();
  for (let i = 0; i < 12; i++) {
    w.ingest(toolUse(`c${i}`, i % 2 === 0 ? 'Read' : 'Grep', { path: i % 2 === 0 ? '/a.txt' : 'foo' }));
  }
  check('catches A-B-A-B alternating cycle (nudge stage)', seen.some(([t, r, p]) => t === 'nudge' && r === 'cyclic_tool_pattern' && p === 2));
  check('catches A-B-A-B alternating cycle (hard-stop stage)', seen.some(([t, r, p]) => t === 'suspect-rot' && r === 'cyclic_tool_pattern' && p === 2));
}

// Test 4: is_error now actually consumed — 3 consecutive errors on the same fingerprint hard-stops.
// UNCHANGED — ERROR_HARD_STOP_AT is a separate mechanism this task explicitly left alone.
{
  const { w, seen } = fresh();
  for (let i = 0; i < 3; i++) {
    w.ingest(toolUse(`c${i}`, 'Bash', { cmd: 'flaky' }));
    w.ingest(toolResult(`c${i}`, true));
  }
  check('nudges on repeated tool errors before hard-stop', seen.some(([t, r]) => t === 'nudge' && r === 'tool_repeatedly_erroring'));
  check('hard-stops on 3rd consecutive error', seen.some(([t, r]) => t === 'suspect-rot' && r === 'tool_repeatedly_erroring'));
}

// Test 5: a healthy, varied, non-erroring session should trip NOTHING.
{
  const { w, seen } = fresh();
  const calls = [['Read', 'a'], ['Grep', 'b'], ['Read', 'c'], ['Write', 'd'], ['Bash', 'e'], ['Read', 'f']];
  calls.forEach(([name, arg], i) => {
    w.ingest(toolUse(`c${i}`, name, { path: arg }));
    w.ingest(toolResult(`c${i}`, false));
  });
  check('healthy varied session trips nothing', seen.length === 0);
}

// Test 6 (NEW): A-B-C-A-B-C-A-B-C... period-3 cycle. This is the concrete proof
// the generalization matters, not just a refactor — the OLD code could not detect
// this at all (it only special-cased period 1 and period 2; a period-3 cycle would
// have run forever, invisible, under the pre-change logic). First 9 calls (3 full
// A-B-C cycles) trigger the nudge stage; a further 9 (persisting past the nudge)
// trigger the hard-stop stage — mirroring Test 1/3's nudge-then-hard-stop shape,
// now proven at a period the old code structurally could not reach.
{
  const { w, seen } = fresh();
  const seq = ['Read', 'Grep', 'Glob'];
  for (let i = 0; i < 9; i++) {
    w.ingest(toolUse(`c${i}`, seq[i % 3], { path: seq[i % 3] }));
  }
  check('period-3 cycle (A-B-C x3) nudges — old code could not see this at all',
    seen.some(([t, r, p]) => t === 'nudge' && r === 'cyclic_tool_pattern' && p === 3));
  check('no premature hard-stop on the first period-3 detection',
    !seen.some(([t]) => t === 'suspect-rot'));

  for (let i = 9; i < 18; i++) {
    w.ingest(toolUse(`c${i}`, seq[i % 3], { path: seq[i % 3] }));
  }
  check('period-3 cycle persisting past the nudge hard-stops',
    seen.some(([t, r, p]) => t === 'suspect-rot' && r === 'cyclic_tool_pattern' && p === 3));
}

// Test 7 (NEW): repeated assistant TEXT content (no tool calls at all) is now
// tracked and cycle-detected — item 2. Old code never looked at 'text' content
// blocks, only 'tool_use' blocks, so an agent looping on prose alone was
// completely invisible to Tier-0.5 before this change.
{
  const { w, seen } = fresh();
  const line = "Let me try a different approach to fix this.";
  for (let i = 0; i < 6; i++) w.ingest(assistantText(line));
  check('repeated identical text content nudges',
    seen.some(([t, r]) => t === 'nudge' && r === 'repeated_text_content'));
  check('repeated identical text content hard-stops after the nudge',
    seen.some(([t, r]) => t === 'suspect-rot' && r === 'repeated_text_content'));
  check('text-cycle detection does not cross-contaminate the tool-cycle reason',
    !seen.some(([t, r]) => r === 'cyclic_tool_pattern' || r === 'repeated_identical_tool_call'));
}

// Test 8 (NEW): varied, non-repeating assistant text should trip nothing — proves
// the text detector isn't just firing on "any text present."
{
  const { w, seen } = fresh();
  const lines = [
    'Reading the config file first.',
    'Found the bug in the validator.',
    'Applying the fix now.',
    'Running the test suite.',
    'Tests pass, wrapping up.',
  ];
  for (const line of lines) w.ingest(assistantText(line));
  check('varied assistant text trips nothing', seen.length === 0);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
