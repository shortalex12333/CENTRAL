/**
 * Zero-API-cost verification of the tier-0.5 rot heuristics in spawn.mjs.
 * Feeds fabricated stream-json events directly into Worker.ingest() — no
 * subprocess, no network call. Run: node spawn.unit-test.mjs
 */
import { Worker } from './spawn.mjs';

function fresh() {
  const w = new Worker({ role: 'probe', task: 'unit-test', cwd: '.' });
  const seen = [];
  w.on('nudge', (e) => seen.push(['nudge', e.reason]));
  w.on('suspect-rot', (e) => seen.push(['suspect-rot', e.reason]));
  return { w, seen };
}

function toolUse(id, name, input) {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } };
}
function toolResult(id, is_error) {
  return { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error }] } };
}

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// Test 1: identical fingerprint repeated should nudge at 3, hard-stop at 4.
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
  check('varying tool names do not falsely trip identical-run', !seen.some(([t]) => t === 'suspect-rot' && seen[0]?.[1] === 'repeated_identical_tool_call'));
}

// Test 3: A-B-A-B-A-B alternation (period-2 cycle) — the case name-only repetition misses entirely.
{
  const { w, seen } = fresh();
  for (let i = 0; i < 6; i++) {
    w.ingest(toolUse(`c${i}`, i % 2 === 0 ? 'Read' : 'Grep', { path: i % 2 === 0 ? '/a.txt' : 'foo' }));
  }
  check('catches A-B-A-B alternating cycle', seen.some(([t, r]) => t === 'suspect-rot' && r === 'alternating_tool_cycle'));
}

// Test 4: is_error now actually consumed — 3 consecutive errors on the same fingerprint hard-stops.
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

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail === 0 ? 0 : 1);
