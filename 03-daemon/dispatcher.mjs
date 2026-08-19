/**
 * G5 — local synthetic Sentry→dispatch loop, WITH the fallback path.
 *
 * Polls the local Redis list `errors:incoming` (BRPOP, blocking with a timeout — a real poll
 * loop, not a busy-wait) via `redis-cli` (central-mvp-redis, port 6380). For each popped
 * error, looks up `controlplane.project_ownership` (central-mvp-pg, port 5433) by exact
 * `project_id` match:
 *
 *   HAPPY PATH   — project_id matches a seeded row, confidence (1.0 for an exact match)
 *                  clears that row's confidence_threshold → spawn exactly ONE read-only
 *                  worker (role: probe — Read tool only, see spawn.mjs ROLES) inside that
 *                  project's local_directory, via spawn.mjs's Worker class (imported
 *                  directly, not shelled out — same primitive, structured result instead of
 *                  parsed stdout). Result (cost, result text, session_id) is logged to
 *                  controlplane.events.
 *
 *   FALLBACK PATH — no row matches project_id at all. This is the path the project owner
 *                  explicitly flagged as missing: an unroutable error must NEVER cause a
 *                  guessed spawn in a guessed directory. No `Worker` is ever constructed on
 *                  this path — not "constructed then aborted", never constructed at all, see
 *                  handleItem() below. The error is written to
 *                  `controlplane.unrouted_errors` (see sql/004_unrouted_errors.sql for why
 *                  that table exists instead of reusing pending_writes) and a
 *                  'unrouted_error' event is logged. A `ps aux` snapshot is taken
 *                  immediately before and after the decision as an additional, if secondary,
 *                  proof point (secondary because in this sequential single-threaded test run
 *                  any prior worker has already exited by the time the fallback item is
 *                  handled — the real proof is architectural: grep this file for `new Worker`
 *                  and see it only ever appears in the ROUTE branch).
 *
 * DB access note: the dispatcher connects to Postgres as the `postgres` superuser (the
 * daemon/service persona), not as `controlplane_ai_writer`. This mirrors the G4 design
 * precedent explicitly stated in G4_RESULTS.md §7 and repeated in sql/004's header comment:
 * "staging [a human-review row] is the daemon/service-role's job" — ai_writer has zero
 * grants on pending_writes AND (see sql/004) zero grants on unrouted_errors, by design. A
 * real deployment would give the dispatcher its own narrowly-scoped service role; for this
 * local MVP gate, postgres is used directly and that simplification is called out here
 * rather than left implicit.
 *
 * Run:  node dispatcher.mjs [--count 3] [--wait 10]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from './spawn.mjs';

const execFileP = promisify(execFile);

const REDIS_PORT = 6380;
const REDIS_LIST = 'errors:incoming';
const PG = { host: 'localhost', port: '5433', user: 'postgres' };
const PG_ENV = { ...process.env, PGPASSWORD: 'localtest' };

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
}

// ---- Redis -----------------------------------------------------------------
async function brpop(waitSecs) {
  const { stdout } = await execFileP('redis-cli', ['-p', String(REDIS_PORT), 'BRPOP', REDIS_LIST, String(waitSecs)]);
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  if (lines.length < 2) return null; // timeout, nothing popped
  return lines.slice(1).join('\n'); // everything after the key-name line is the value
}

// ---- Postgres (via psql, no npm pg client installed in this project) ------
function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function sqlJsonb(v) {
  return `${sqlStr(JSON.stringify(v ?? null))}::jsonb`;
}
function sqlNum(v) {
  return v === null || v === undefined ? 'NULL' : String(Number(v));
}

const FIELD_SEP = '\x1f';

async function pgSelect(sql) {
  const { stdout } = await execFileP(
    'psql',
    ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-t', '-A', '-F', FIELD_SEP, '-c', sql],
    { env: PG_ENV }
  );
  return stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split(FIELD_SEP));
}

async function pgExec(sql) {
  // -q suppresses psql's command-completion tag (e.g. "INSERT 0 1") so a `RETURNING id`
  // value comes back clean — without it the tag was getting appended to the returned id.
  const { stdout } = await execFileP(
    'psql',
    ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-c', sql],
    { env: PG_ENV }
  );
  return stdout.trim();
}

async function lookupOwnership(projectId) {
  const rows = await pgSelect(
    `select project_id, project_name, local_directory, confidence_threshold ` +
    `from controlplane.project_ownership where project_id = ${sqlStr(projectId)};`
  );
  if (rows.length === 0) return null;
  const [project_id, project_name, local_directory, confidence_threshold] = rows[0];
  return { project_id, project_name, local_directory, confidence_threshold: Number(confidence_threshold) };
}

async function logEvent(kind, severity, body) {
  await pgExec(
    `insert into controlplane.events (kind, severity, body) values (` +
    `${sqlStr(kind)}, ${sqlStr(severity)}, ${sqlJsonb(body)});`
  );
}

async function logUnrouted({ project_id, culprit, exception_type, exception_value, stack_frames, raw_payload, reason, matched_confidence }) {
  const id = await pgExec(
    `insert into controlplane.unrouted_errors ` +
    `(project_id, culprit, exception_type, exception_value, stack_frames, raw_payload, reason, matched_confidence) ` +
    `values (${sqlStr(project_id)}, ${sqlStr(culprit)}, ${sqlStr(exception_type)}, ${sqlStr(exception_value)}, ` +
    `${sqlJsonb(stack_frames)}, ${sqlJsonb(raw_payload)}, ${sqlStr(reason)}, ${sqlNum(matched_confidence)}) ` +
    `returning id;`
  );
  return id;
}

// ---- ps proof ---------------------------------------------------------------
async function claudeStreamJsonProcs() {
  try {
    const { stdout } = await execFileP('ps', ['aux']);
    return stdout.split('\n').filter((l) => l.includes('stream-json') && /claude/.test(l));
  } catch {
    return [];
  }
}

// ---- Core handler -------------------------------------------------------------
async function handleItem(raw, idx) {
  const err = JSON.parse(raw);
  const { project_id, culprit, exception_type, exception_value, stack_frames } = err;

  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`[dispatcher] item #${idx}  project_id=${project_id}  culprit=${culprit}`);

  const psBefore = await claudeStreamJsonProcs();
  console.log(`[dispatcher] ps proof (before decision): ${psBefore.length} claude stream-json process(es) running`);

  const owner = await lookupOwnership(project_id);
  const confidence = owner ? 1.0 : 0.0; // exact match only — no fuzzy matching in this MVP
  const threshold = owner ? owner.confidence_threshold : 0.9;
  const routable = !!owner && confidence >= threshold;

  console.log(`[dispatcher] ownership lookup: ${owner ? `MATCH → ${owner.project_name} @ ${owner.local_directory} (threshold=${threshold})` : 'NO MATCH'}`);
  console.log(`[dispatcher] confidence=${confidence} threshold=${threshold} → ${routable ? 'ROUTE (happy path)' : 'FALLBACK (unroutable)'}`);

  await logEvent('routing_decision', 'info', {
    project_id, culprit, exception_type, exception_value,
    decision: routable ? 'route' : 'fallback',
    matched_project_name: owner?.project_name ?? null,
    matched_directory: owner?.local_directory ?? null,
    confidence, threshold,
  });

  if (routable) {
    // ---- HAPPY PATH ---------------------------------------------------------
    const prompt =
      `A monitoring system reported this error: culprit="${culprit}", ` +
      `exception_type="${exception_type}", exception_value="${exception_value}". ` +
      `In one sentence, name the most likely file or area to investigate first — ` +
      `do not make any changes.`;

    console.log(`[dispatcher] SPAWNING worker role=probe cwd=${owner.local_directory}`);
    const w = new Worker({ role: 'probe', task: prompt, cwd: owner.local_directory, timeoutMs: 120_000 });
    w.on('ready', (r) => console.log(`[worker] ready session=${r.sessionId?.slice(0, 8)} tools=${r.tools}`));
    w.on('tool', (t) => console.log(`[worker] tool_use=${t}`));
    w.on('malformed', (l) => console.warn(`[worker] malformed line: ${l.slice(0, 80)}`));

    const state = await w.run();
    console.log(`[worker] done turns=${state.turns} cost=$${state.costUsd.toFixed(4)} error=${state.error ?? 'none'}`);
    console.log(`[worker] result: ${state.result}`);

    await logEvent('worker_dispatch_result', state.error ? 'error' : 'info', {
      project_id, project_name: owner.project_name, directory: owner.local_directory,
      role: 'probe', session_id: state.sessionId, cost_usd: state.costUsd,
      turns: state.turns, tool_calls: state.toolCalls, result: state.result,
      exit_code: state.exitCode, error: state.error,
    });

    const psAfter = await claudeStreamJsonProcs();
    console.log(`[dispatcher] ps proof (after worker exit): ${psAfter.length} claude stream-json process(es) running`);

    return { decision: 'route', project_id, session_id: state.sessionId, cost_usd: state.costUsd, result: state.result };
  } else {
    // ---- FALLBACK PATH — the part explicitly required by the project owner ---
    // No `Worker` is constructed anywhere on this branch. Nothing is spawned. No directory
    // is touched. This is not a caught exception or an aborted spawn — the code path simply
    // never reaches a `new Worker(...)` call for an unroutable item.
    const reason = owner ? 'confidence_below_threshold' : 'no_ownership_match';
    console.log(`[dispatcher] would-be spawn suppressed — reason=${reason}. NOT spawning any worker. NOT touching any directory.`);

    const unroutedId = await logUnrouted({
      project_id, culprit, exception_type, exception_value, stack_frames: stack_frames ?? [],
      raw_payload: err, reason, matched_confidence: owner ? confidence : null,
    });
    console.log(`[dispatcher] logged to controlplane.unrouted_errors id=${unroutedId} status=needs_human_review`);

    await logEvent('unrouted_error', 'warn', {
      project_id, culprit, exception_type, exception_value, reason,
      unrouted_error_id: unroutedId, would_be_spawn_suppressed: true,
    });

    const psAfter = await claudeStreamJsonProcs();
    console.log(`[dispatcher] ps proof (after suppression): ${psAfter.length} claude stream-json process(es) running`);

    return { decision: 'fallback', project_id, reason, unrouted_error_id: unroutedId };
  }
}

// ---- Main loop ---------------------------------------------------------------
async function main() {
  const count = Number(arg('count', '3'));
  const waitSecs = Number(arg('wait', '10'));
  console.log(`[dispatcher] starting — will process up to ${count} item(s) from "${REDIS_LIST}", BRPOP timeout ${waitSecs}s each`);

  const results = [];
  let processed = 0;
  while (processed < count) {
    const item = await brpop(waitSecs);
    if (!item) {
      console.log(`[dispatcher] BRPOP timed out after ${waitSecs}s with no item — stopping poll loop.`);
      break;
    }
    const r = await handleItem(item, processed + 1);
    results.push(r);
    processed++;
  }

  console.log(`\n[dispatcher] === SUMMARY === processed ${processed}/${count} item(s)`);
  for (const r of results) {
    console.log(`  - ${r.project_id}: ${r.decision}` +
      (r.decision === 'route' ? ` (session=${r.session_id?.slice(0, 8)}, cost=$${r.cost_usd.toFixed(4)})` : ` (reason=${r.reason}, unrouted_id=${r.unrouted_error_id})`));
  }
  console.log(JSON.stringify({ ok: true, processed, results }));
}

main().catch((err) => {
  console.error('[dispatcher] FATAL', err);
  process.exit(1);
});
