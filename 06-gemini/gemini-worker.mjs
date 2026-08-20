/**
 * GeminiWorker — a parallel, comparable primitive to 03-daemon/spawn.mjs's Worker class,
 * proving (or disproving) that CENTRAL's dispatch pipeline is genuinely runtime-agnostic.
 *
 * spawn.mjs is NOT modified. This file is a separate, self-contained implementation that
 * writes into the SAME `controlplane.events` table (see 02-forge/sql/001_schema.sql and
 * 03-daemon/dispatcher.mjs's logEvent()), tagged with a `runtime` column added by
 * 06-gemini/sql/001_runtime_column.sql.
 *
 * ── Flag shape — CONFIRMED, not assumed ──────────────────────────────────────────────
 * `gemini --help` (v0.55.1, installed at /opt/homebrew/lib/node_modules/@google/gemini-cli)
 * confirms: `-p, --prompt <string>` (headless mode trigger) and
 * `-o, --output-format <text|json|stream-json>` — same flag NAME as Claude's
 * `--output-format stream-json`, so the task brief's assumed shape happens to be right
 * for THIS flag. It is NOT right for the event schema underneath it — see below.
 *
 * ── Event schema — CONFIRMED from real shipped source, NOT assumed to match Claude ──
 * Read directly out of the installed package (comments intact —
 * `// packages/cli/src/nonInteractiveCli.js` region of
 * bundle/gemini-63IMHOLI.js, and `// packages/core/src/output/stream-json-formatter.ts`
 * in bundle/chunk-QCOIICKD.js — both real, shipped, un-minified-enough to read). Also
 * cross-confirmed against `docs/cli/headless.md`'s "Streaming JSON output" section,
 * shipped inside the same package.
 *
 * Six event types (JsonStreamEventType enum, packages/core/dist/src/output/types.js):
 *
 *   {type:"init", timestamp, session_id, model}
 *   {type:"message", timestamp, role:"user"|"assistant", content, delta?:true}
 *   {type:"tool_use", timestamp, tool_name, tool_id, parameters}
 *   {type:"tool_result", timestamp, tool_id, status:"success"|"error", output, error?:{type,message}}
 *   {type:"error", timestamp, severity:"error"|"warning", message}
 *   {type:"result", timestamp, status:"success"|"error", error?:{type,message}, stats:{
 *       total_tokens, input_tokens, output_tokens, cached, input, duration_ms,
 *       tool_calls, models:{[modelName]:{total_tokens,input_tokens,output_tokens,cached,input}}
 *   }}
 *
 * Three structural differences from spawn.mjs's Claude schema, all real, all load-bearing
 * for this parser (this is exactly what the task asked to verify rather than assume):
 *
 *   1. Claude bundles assistant text AND tool_use requests together inside one
 *      `assistant` event's `message.content[]` array. Gemini emits them as two entirely
 *      separate event types (`message` vs `tool_use`) — never combined.
 *   2. Claude's terminal `result` event carries the final answer text directly
 *      (`ev.result`). Gemini's terminal `result` event carries ONLY `status` + `stats` —
 *      NO response text field at all. The final answer must be reconstructed by
 *      concatenating every `message` event where `role === "assistant"` (they arrive as
 *      `delta:true` streamed chunks, confirmed at the emission site above).
 *   3. Claude's `result` event exposes `total_cost_usd` (a real dollar figure — see
 *      spawn.mjs `state.costUsd = ev.total_cost_usd ?? 0`). Gemini's `stats` object
 *      (built by `StreamJsonFormatter.convertToStreamStats`, read in full) exposes ONLY
 *      `total_tokens` / `input_tokens` / `output_tokens` / `cached` / `input` /
 *      `duration_ms` / `tool_calls` — there is NO cost-in-dollars field anywhere in the
 *      real schema. `state.costUsd` below is therefore permanently `null`, not a
 *      fabricated 0 or an invented estimate — Gemini's own CLI does not compute or expose
 *      this number in stream-json mode.
 *
 * Field-name mapping vs Claude, for anyone diffing this against spawn.mjs:
 *   session id   : Claude `session_id` on a `system`/init event  ↔  Gemini `session_id` on `init` (same name, real parity)
 *   tool name    : Claude content-block `name`                    ↔  Gemini `tool_name`
 *   tool call id : Claude content-block `id`                      ↔  Gemini `tool_id`
 *   tool args    : Claude content-block `input`                   ↔  Gemini `parameters`
 *   tool error   : Claude `is_error` boolean on a `user` event    ↔  Gemini `status:"error"` string on `tool_result`
 *
 * Run:  node gemini-worker.mjs --task "Reply with exactly: PONG"
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export class GeminiWorker extends EventEmitter {
  constructor({ task, cwd = process.cwd(), model = 'flash-lite', timeoutMs = 120_000 }) {
    super();
    Object.assign(this, { task, cwd, model, timeoutMs });
    this.state = {
      sessionId: null,
      model: null,
      events: 0,
      toolCalls: [],          // [{name, id, parameters}]
      toolResults: [],        // [{id, status, output, error}]
      messages: [],           // raw {role, content, delta} chunks, in arrival order
      resultText: null,       // reconstructed from role:"assistant" message chunks — see header
      status: null,           // "success" | "error", from the terminal `result` event
      error: null,
      warnings: [],           // non-fatal `error` events with severity:"warning"
      stats: null,            // real Gemini token/duration stats, or null if never received
      costUsd: null,          // ALWAYS null — Gemini's stream-json schema has no dollar-cost field. Not fabricated.
      rawEvents: [],          // bounded audit trail of every parsed NDJSON line
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
    };
  }

  args() {
    return [
      '-p', this.task,
      '--output-format', 'stream-json',
      '-m', this.model,        // 'flash-lite' — cheapest alias, keeps a trivial-task test near-zero cost
      '--approval-mode', 'plan', // read-only: no tool-approval prompt can block a non-interactive stdin-closed run
    ];
  }

  run() {
    return new Promise((resolve) => {
      const proc = spawn('gemini', this.args(), {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],   // same defensive shape as spawn.mjs: stdin closed, not inherited
      });
      this.proc = proc;

      const killer = setTimeout(() => {
        this.state.error = 'timeout';
        this.emit('timeout', this.state);
        proc.kill('SIGTERM');
      }, this.timeoutMs);

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d; });

      createInterface({ input: proc.stdout, crlfDelay: Infinity })
        .on('line', (line) => {
          if (!line.trim()) return;
          let ev;
          try { ev = JSON.parse(line); }
          catch { this.emit('malformed', line); return; }
          this.ingest(ev);
        });

      proc.on('error', (err) => {
        clearTimeout(killer);
        this.state.error = `spawn_failed: ${err.message}`;
        this.state.endedAt = Date.now();
        resolve(this.state);
      });

      proc.on('close', (code) => {
        clearTimeout(killer);
        this.state.exitCode = code;
        this.state.endedAt = Date.now();
        // A real, observed CLI behavior (not hypothesized): on a fatal setup error
        // (confirmed live: IneligibleTierError during OAuth tier check) the process
        // writes nothing at all to stdout and exits 1 with only a stderr stack trace —
        // no stream-json `result` event is ever emitted, because the crash happens
        // before `config`/`streamFormatter` exist. Surface that real stderr here so it
        // isn't silently swallowed just because no NDJSON line carried it.
        if (code !== 0 && !this.state.error) {
          this.state.error = `exit_${code}: ${stderr.trim().slice(0, 800)}`;
        }
        this.emit('done', this.state);
        resolve(this.state);
      });
    });
  }

  /** Route one real Gemini stream-json NDJSON line into checkpointable state. */
  ingest(ev) {
    this.state.events++;
    this.state.rawEvents.push(ev);
    if (this.state.rawEvents.length > 200) this.state.rawEvents.shift(); // bounded, mirrors spawn.mjs anti-context-dump stance
    this.emit('event', ev);

    switch (ev.type) {
      case 'init':
        this.state.sessionId = ev.session_id ?? null;
        this.state.model = ev.model ?? null;
        this.emit('ready', { sessionId: this.state.sessionId, model: this.state.model });
        break;

      case 'message':
        this.state.messages.push({ role: ev.role, content: ev.content, delta: !!ev.delta });
        if (ev.role === 'assistant') {
          this.state.resultText = (this.state.resultText ?? '') + (ev.content ?? '');
        }
        break;

      case 'tool_use':
        this.state.toolCalls.push({ name: ev.tool_name, id: ev.tool_id, parameters: ev.parameters });
        this.emit('tool', ev.tool_name);
        break;

      case 'tool_result':
        this.state.toolResults.push({
          id: ev.tool_id, status: ev.status, output: ev.output, error: ev.error ?? null,
        });
        break;

      case 'error':
        if (ev.severity === 'warning') this.state.warnings.push(ev.message);
        else this.state.error = this.state.error ?? ev.message; // first hard error wins, mirrors spawn.mjs
        break;

      case 'result':
        this.state.status = ev.status ?? null;
        this.state.stats = ev.stats ?? null;        // real token/duration stats — never a cost figure, see header
        if (ev.status === 'error' && ev.error) {
          this.state.error = this.state.error ?? `${ev.error.type}: ${ev.error.message}`;
        }
        break;

      default:
        this.emit('unknown-event-type', ev);
    }
  }

  /** Precise handoff, same shape/intent as spawn.mjs's Worker.handoff(). */
  handoff() {
    return {
      runtime: 'gemini',
      originalTask: this.task, cwd: this.cwd, model: this.model,
      sessionId: this.state.sessionId,
      toolsUsed: [...new Set(this.state.toolCalls.map((t) => t.name))],
      error: this.state.error,
      lastResult: this.state.resultText,
      costUsd: this.state.costUsd,   // always null — see header note 3
      stats: this.state.stats,
    };
  }
}

// --- Shared events-table write — SAME table, SAME `kind` taxonomy Claude workers use,
// distinguished only by the new `runtime` column. psql-shell-out pattern copied
// deliberately from 03-daemon/dispatcher.mjs's logEvent() (proven pattern, not reinvented
// — see that file's PG/pgExec/sqlStr/sqlJsonb helpers, reproduced here 1:1 so this file
// stays self-contained and doesn't require modifying or importing from 03-daemon). ------
const PG = { host: 'localhost', port: '5433', user: 'postgres' };
const PG_ENV = { ...process.env, PGPASSWORD: 'localtest' };

function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}
function sqlJsonb(v) {
  return `${sqlStr(JSON.stringify(v ?? null))}::jsonb`;
}

async function pgExec(sql) {
  const { stdout } = await execFileP(
    'psql',
    ['-h', PG.host, '-p', PG.port, '-U', PG.user, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A', '-c', sql],
    { env: PG_ENV }
  );
  return stdout.trim();
}

/**
 * Writes ONE row into controlplane.events, runtime='gemini', reusing the exact same
 * `kind`/`severity`/`body` shape dispatcher.mjs's logEvent() uses for Claude workers
 * (kind='worker_dispatch_result') — the SAME taxonomy, so a reader of this table cannot
 * tell runtimes apart by `kind` at all, only by the new `runtime` column. That is the
 * actual point of this proof.
 */
export async function logGeminiEvent(state, { task, cwd }) {
  const severity = state.error ? 'error' : 'info';
  const body = {
    role: 'probe', // parity label with spawn.mjs's role vocabulary; Gemini has no role system of its own
    task, directory: cwd,
    session_id: state.sessionId, model: state.model,
    result: state.resultText, status: state.status,
    tool_calls: state.toolCalls.map((t) => t.name),
    stats: state.stats,
    cost_usd: state.costUsd,   // null — honestly absent, not fabricated, see class header
    exit_code: state.exitCode,
    error: state.error,
    events_parsed: state.events,
  };
  const id = await pgExec(
    `insert into controlplane.events (kind, severity, runtime, body) values (` +
    `${sqlStr('worker_dispatch_result')}, ${sqlStr(severity)}, ${sqlStr('gemini')}, ${sqlJsonb(body)}) ` +
    `returning id;`
  );
  return id;
}

// --- CLI harness -----------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
  const task = arg('task', 'Reply with exactly: PONG');
  const cwd = arg('cwd', process.cwd());
  const w = new GeminiWorker({ task, cwd });

  w.on('ready', (r) => console.log(`[ready] session=${r.sessionId ?? 'none'} model=${r.model ?? 'none'}`));
  w.on('tool', (t) => console.log(`[tool ] ${t}`));
  w.on('malformed', (l) => console.error(`[bad  ] ${l.slice(0, 80)}`));
  w.on('unknown-event-type', (ev) => console.warn(`[warn ] unrecognized event type: ${ev.type}`));

  const s = await w.run();
  console.log(`\n[done ] events=${s.events} status=${s.status ?? 'none'} ` +
              `wall=${s.endedAt - s.startedAt}ms exit=${s.exitCode} err=${s.error ?? 'none'}`);
  console.log(`[result] ${JSON.stringify(s.resultText)}`);
  console.log(`[stats ] ${JSON.stringify(s.stats)}`);

  const rowId = await logGeminiEvent(s, { task, cwd });
  console.log(`[db] wrote controlplane.events id=${rowId} runtime=gemini`);
  console.log(`[handoff] ${JSON.stringify(w.handoff())}`);
}
