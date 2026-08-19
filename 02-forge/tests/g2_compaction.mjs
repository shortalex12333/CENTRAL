#!/usr/bin/env node
/**
 * G2 — resume (persistence) vs compaction (fresh session + extracted state).
 *
 * Reuses the invocation style of 03-daemon/spawn.mjs (stream-json, verbose,
 * strict-mcp-config, no inherited settings, stdin closed) but is a standalone
 * script because spawn.mjs's ROLES matrix pins sonnet for fixer/architect and
 * we are constrained to claude-haiku-4-5-20251001 for this whole run.
 *
 * Sub-tests:
 *  1. Inflate one real session across N sequential --resume turns, planting
 *     5 facts among padding turns. Record the final turn's result event.
 *  2. Control: --resume the SAME session, ask it to recall 2 planted facts.
 *     Record cost/duration — expected to be correct but NOT cheap.
 *  3. Compaction: deterministically (no model call) build a compact state
 *     artifact containing only the 5 facts, open a BRAND NEW session with it
 *     as the opening prompt + the same recall question. Record cost/duration.
 *  4. Fork isolation: --fork-session from the original, teach the fork a new
 *     fact (codename BANANA). Then --resume the ORIGINAL (unforked) session
 *     and ask for the codename — must NOT know it.
 *
 * Run: node g2_compaction.mjs
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const MODEL = 'claude-haiku-4-5-20251001';
const CWD = '/Users/celeste7/Documents/CENTRAL/02-forge/tests';
const SCRATCH_DIR = path.join(CWD, 'scratch');
const SCRATCH_FILE = path.join(SCRATCH_DIR, 'g2_session_log.txt');
mkdirSync(SCRATCH_DIR, { recursive: true });
// Start each run with a clean scratch file so turn counts / line counts are reproducible.
writeFileSync(SCRATCH_FILE, '');

const ALL_RESULTS = []; // every result event seen, for the total-cost sum

/**
 * Spawn one `claude -p` invocation and resolve with { sessionId, resultEvent, allText }.
 * opts: { prompt, resumeSessionId, forkSession, allowedTools }
 */
function runTurn(opts) {
  const { prompt, resumeSessionId, forkSession = false, allowedTools = 'Bash' } = opts;
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', MODEL,
    '--strict-mcp-config',
    '--mcp-config', JSON.stringify({ mcpServers: {} }),
    '--allowedTools', allowedTools,
    '--setting-sources', '',
    '--dangerously-skip-permissions',
  ];
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
    if (forkSession) args.push('--fork-session');
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd: CWD,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let sessionId = null;
    let resultEvent = null;
    let stderr = '';
    const t0 = Date.now();

    proc.stderr.on('data', (d) => { stderr += d; });

    createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (!line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'system' && ev.subtype === 'init') {
        sessionId = ev.session_id;
      }
      if (ev.type === 'result') {
        resultEvent = ev;
      }
    });

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      const wallMs = Date.now() - t0;
      if (!resultEvent) {
        reject(new Error(`no result event, exit=${code}, stderr=${stderr.slice(0, 800)}`));
        return;
      }
      ALL_RESULTS.push(resultEvent);
      resolve({ sessionId, resultEvent, wallMs, stderr });
    });
  });
}

function logStep(label, obj) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  const report = { startedAt: new Date().toISOString(), subtests: {} };

  // ---------------------------------------------------------------------
  // STEP 1 — inflate a real session across 12 sequential --resume turns.
  // 5 planted facts interleaved with 7 padding turns. Every turn appends
  // one line to the scratch file via Bash, matching spawn.mjs's tool-using
  // pattern, so the transcript accumulates real tool_use/tool_result blocks
  // (not just chat text) — a closer analogue of real agentic session growth.
  // ---------------------------------------------------------------------
  const FACTS = [
    { key: 'FACT1', text: 'the deploy port is 8791' },
    { key: 'FACT2', text: "agent role X's name is ORACLE" },
    { key: 'FACT3', text: 'file g2_manifest.txt contains 42 lines' },
    { key: 'FACT4', text: 'the fallback region is eu-west-2' },
    { key: 'FACT5', text: 'the retry budget is 3 attempts' },
  ];
  // 12 turns total: facts land on turns 1,4,6,9,12; rest are padding.
  const turnPlan = [];
  const factTurnIndices = [1, 4, 6, 9, 12];
  let factCursor = 0;
  for (let i = 1; i <= 12; i++) {
    if (factTurnIndices.includes(i)) {
      turnPlan.push({ n: i, kind: 'fact', fact: FACTS[factCursor++] });
    } else {
      turnPlan.push({ n: i, kind: 'pad' });
    }
  }

  let originalSessionId = null;
  const inflateTurns = [];
  for (const t of turnPlan) {
    const prompt = t.kind === 'fact'
      ? `Run this exact Bash command: echo '${t.fact.key}: ${t.fact.text}' >> ${SCRATCH_FILE}\n` +
        `Then reply with exactly: LOGGED ${t.fact.key}`
      : `Run this exact Bash command: echo 'PAD turn ${t.n}: routine housekeeping note ${t.n}' >> ${SCRATCH_FILE}\n` +
        `Then reply with exactly: LOGGED PAD${t.n}`;

    const res = await runTurn({
      prompt,
      resumeSessionId: originalSessionId, // null on first turn -> fresh session
      allowedTools: 'Bash',
    });
    if (!originalSessionId) originalSessionId = res.sessionId;
    inflateTurns.push({
      turn: t.n, kind: t.kind, fact: t.fact?.key ?? null,
      sessionId: res.sessionId,
      cost_usd: res.resultEvent.total_cost_usd,
      duration_api_ms: res.resultEvent.duration_api_ms,
      num_turns: res.resultEvent.num_turns,
      result_text: res.resultEvent.result,
      is_error: res.resultEvent.is_error,
    });
    logStep(`step1 turn ${t.n}/${t.kind}`, inflateTurns[inflateTurns.length - 1]);
  }

  const finalInflateTurn = inflateTurns[inflateTurns.length - 1];
  report.subtests.step1_inflate = {
    description: '12 sequential --resume turns on one session, 5 facts planted',
    originalSessionId,
    turns: inflateTurns,
    finalTurnBaseline: {
      cost_usd: finalInflateTurn.cost_usd,
      duration_api_ms: finalInflateTurn.duration_api_ms,
      num_turns: finalInflateTurn.num_turns,
    },
  };

  // ---------------------------------------------------------------------
  // STEP 2 — control case: naive resume, ask it to recall 2 of the 5 facts.
  // ---------------------------------------------------------------------
  const recallPrompt =
    'Without running any tools, answer from memory only: ' +
    '(1) What is the deploy port? (2) What is agent role X\'s name? ' +
    'Reply in exactly this format: PORT=<value> ROLE=<value>';

  const step2 = await runTurn({
    prompt: recallPrompt,
    resumeSessionId: originalSessionId,
    allowedTools: 'Bash',
  });
  const step2Text = step2.resultEvent.result ?? '';
  const step2Correct = /8791/.test(step2Text) && /ORACLE/i.test(step2Text);
  report.subtests.step2_naive_resume_control = {
    description: 'Same session, resumed one more time, asked to recall 2 planted facts',
    sessionId: step2.sessionId,
    cost_usd: step2.resultEvent.total_cost_usd,
    duration_api_ms: step2.resultEvent.duration_api_ms,
    num_turns: step2.resultEvent.num_turns,
    result_text: step2Text,
    correct: step2Correct,
  };
  logStep('step2 naive resume control', report.subtests.step2_naive_resume_control);

  // ---------------------------------------------------------------------
  // STEP 3 — compaction: deterministic extraction (no model call), then a
  // BRAND NEW session opened with the compact artifact as the prompt.
  // ---------------------------------------------------------------------
  const compactArtifact = {
    facts: FACTS.reduce((acc, f) => { acc[f.key] = f.text; return acc; }, {}),
    pending: 'none',
  };
  const compactJson = JSON.stringify(compactArtifact, null, 0);
  // sanity: keep this well under 500 tokens (roughly 4 chars/token)
  const approxTokens = Math.ceil(compactJson.length / 4);

  const step3Prompt =
    `You are resuming from a compacted state summary, not a full transcript. ` +
    `Compact state: ${compactJson}\n\n` +
    'Without running any tools, answer from the state above only: ' +
    '(1) What is the deploy port? (2) What is agent role X\'s name? ' +
    'Reply in exactly this format: PORT=<value> ROLE=<value>';

  const step3 = await runTurn({
    prompt: step3Prompt,
    resumeSessionId: null, // fresh session, no --resume
    allowedTools: 'Bash',
  });
  const step3Text = step3.resultEvent.result ?? '';
  const step3Correct = /8791/.test(step3Text) && /ORACLE/i.test(step3Text);
  report.subtests.step3_compaction = {
    description: 'Deterministically-extracted 5-fact artifact opened in a FRESH session, same recall question',
    compactArtifact,
    compactJsonCharLen: compactJson.length,
    approxTokens,
    sessionId: step3.sessionId,
    cost_usd: step3.resultEvent.total_cost_usd,
    duration_api_ms: step3.resultEvent.duration_api_ms,
    num_turns: step3.resultEvent.num_turns,
    result_text: step3Text,
    correct: step3Correct,
  };
  logStep('step3 compaction', report.subtests.step3_compaction);

  // ---------------------------------------------------------------------
  // STEP 4 — fork-session isolation.
  // ---------------------------------------------------------------------
  const step4a = await runTurn({
    prompt: 'Without running any tools, just remember this for later in this conversation: ' +
            'the codename is BANANA. Reply with exactly: NOTED BANANA',
    resumeSessionId: originalSessionId,
    forkSession: true,
    allowedTools: 'Bash',
  });
  const forkedSessionId = step4a.sessionId;

  const step4b = await runTurn({
    prompt: 'Without running any tools, answer from memory only: what is the codename? ' +
            'If you were never told a codename in this conversation, reply exactly: NO CODENAME KNOWN. ' +
            'Otherwise reply exactly: CODENAME=<value>',
    resumeSessionId: originalSessionId, // the ORIGINAL, non-forked session
    allowedTools: 'Bash',
  });
  const step4bText = step4b.resultEvent.result ?? '';
  const leaked = /BANANA/i.test(step4bText);
  const forkIsolationPass = !leaked && forkedSessionId !== originalSessionId;

  report.subtests.step4_fork_isolation = {
    description: '--fork-session teaches BANANA to a fork; original session must not know it',
    originalSessionId,
    forkedSessionId,
    forkProducedDistinctSessionId: forkedSessionId !== originalSessionId,
    step4a: {
      cost_usd: step4a.resultEvent.total_cost_usd,
      duration_api_ms: step4a.resultEvent.duration_api_ms,
      result_text: step4a.resultEvent.result,
    },
    step4b: {
      cost_usd: step4b.resultEvent.total_cost_usd,
      duration_api_ms: step4b.resultEvent.duration_api_ms,
      result_text: step4bText,
    },
    leaked,
    pass: forkIsolationPass,
  };
  logStep('step4 fork isolation', report.subtests.step4_fork_isolation);

  // ---------------------------------------------------------------------
  // AGGREGATE
  // ---------------------------------------------------------------------
  const totalCostUsd = ALL_RESULTS.reduce((s, r) => s + (r.total_cost_usd ?? 0), 0);
  const totalApiInvocations = ALL_RESULTS.length;

  const costDelta = report.subtests.step2_naive_resume_control.cost_usd - report.subtests.step3_compaction.cost_usd;
  const latencyDelta = report.subtests.step2_naive_resume_control.duration_api_ms - report.subtests.step3_compaction.duration_api_ms;
  const compactionCheaper = costDelta > 0 || latencyDelta > 0;

  report.aggregate = {
    totalCostUsd,
    totalApiInvocations,
    step3_vs_step2: {
      step2_cost_usd: report.subtests.step2_naive_resume_control.cost_usd,
      step3_cost_usd: report.subtests.step3_compaction.cost_usd,
      cost_delta_usd: costDelta,
      step2_duration_api_ms: report.subtests.step2_naive_resume_control.duration_api_ms,
      step3_duration_api_ms: report.subtests.step3_compaction.duration_api_ms,
      duration_delta_ms: latencyDelta,
      step3_correct: step3Correct,
      pass: step3Correct && compactionCheaper,
    },
    fork_isolation_pass: forkIsolationPass,
    overall_pass: (step3Correct && compactionCheaper) && forkIsolationPass,
  };

  logStep('AGGREGATE', report.aggregate);

  const outPath = path.join(CWD, '..', 'results', 'g2_raw_report.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nRaw report written to ${outPath}`);
  console.log(`TOTAL COST USD: ${totalCostUsd}`);
  console.log(`TOTAL API INVOCATIONS: ${totalApiInvocations}`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
