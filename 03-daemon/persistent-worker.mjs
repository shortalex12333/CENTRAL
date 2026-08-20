/**
 * mac_execution_daemon — persistent-turn worker
 *
 * PersistentWorker keeps ONE `claude` subprocess alive across multiple turns fed
 * over stdin, instead of spawn.mjs's Worker (one process per task, stdin:'ignore',
 * respawn-per-turn). This is the primitive a live browser<->subprocess bridge needs:
 * a client sends N messages over time, each one becomes a turn in the SAME
 * conversation, same session_id, same pid, warm prompt cache.
 *
 * Built on the proven primitive documented at
 * 05-research/G2_NATIVE_FEATURE_CHECK.md §4 (real 2-turn subprocess test already run:
 * same pid, same session_id, turn 2 read back essentially all of turn 1's context from
 * cache) — this is NOT a fresh discovery, it's productionizing that finding.
 *
 * Wire format on stdin, confirmed both by `claude --help` (--input-format stream-json
 * "(realtime streaming input)", pairs with --replay-user-messages / --output-format
 * stream-json) and by the empirical scratch-harness test referenced above: ONE JSON
 * object per line (NDJSON), shape
 *   {"type":"user","message":{"role":"user","content":"<turn text>"}}
 * mirroring the `user` event shape --output-format stream-json emits on stdout for
 * tool-result turns. No closing bracket, no array wrapper — just newline-delimited
 * objects, written incrementally, stdin left open between turns.
 *
 * CRITICAL: does NOT modify spawn.mjs's Worker class or its stdio stdin:'ignore'
 * default. That default is a deliberate fix for a real, documented 3s stdin-wait
 * stall (01-audit/TEST_REPORT_01_execution_layer.md: "`< /dev/null` is not optional —
 * without it every spawn stalls 3s waiting on stdin"), and every existing caller of
 * Worker (spawn.mjs's own CLI harness, dispatcher.mjs from G5) depends on that
 * default staying put. This is a NEW, separate class for the one use case that
 * actually wants stdin open across turns: a live multi-turn bridge.
 *
 * Run:  node persistent-worker.mjs   (2-turn FALCON codeword proof, haiku, real spend)
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { ROLES } from './spawn.mjs';

/** Minimal Read-only default if an unknown/unspecified role is requested. */
const DEFAULT_ROLE_SPEC = { tools: ['Read'], mcp: {}, model: 'claude-haiku-4-5-20251001' };

export class PersistentWorker extends EventEmitter {
  constructor({ role = 'probe', cwd = process.cwd(), timeoutMs = 600_000 } = {}) {
    super();
    this.role = role;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.spec = ROLES[role] ?? DEFAULT_ROLE_SPEC; // reuse spawn.mjs's RBAC/cost-control matrix
    this.state = {
      sessionId: null, pid: null, events: 0, turnsCompleted: 0,
      costUsd: 0, lastResult: null, error: null, exitCode: null,
      startedAt: Date.now(), endedAt: null,
    };
    this._closing = false;
    this._exitPromise = null;
    this._start();
  }

  args() {
    return [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',              // keeps the process alive across turns
      '--verbose',                                   // required with -p + stream-json
      '--model', this.spec.model,
      '--strict-mcp-config',                         // reject inherited MCP config
      '--mcp-config', JSON.stringify({ mcpServers: this.spec.mcp }),
      '--allowedTools', this.spec.tools.join(','),
      '--setting-sources', '',                       // no inherited settings or hooks
      '--dangerously-skip-permissions',
    ];
  }

  _start() {
    const proc = spawn('claude', this.args(), {
      cwd: this.cwd,
      // stdin:'pipe' — deliberately NOT 'ignore'. spawn.mjs's Worker uses 'ignore'
      // because its tasks are one-shot (-p <task>, no follow-up input ever needed);
      // this class exists specifically to keep stdin open and feed it more turns.
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.state.pid = proc.pid;

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    this._stderrTail = () => stderr.slice(-500);

    createInterface({ input: proc.stdout, crlfDelay: Infinity })
      .on('line', (line) => {
        if (!line.trim()) return;
        let ev;
        try { ev = JSON.parse(line); }
        catch { this.emit('malformed', line); return; }
        this._ingest(ev);
      });

    this._exitPromise = new Promise((resolve) => {
      proc.on('error', (err) => {
        this.state.error = `spawn_failed: ${err.message}`;
        this.state.endedAt = Date.now();
        this.emit('exit', this.state);
        resolve(this.state);
      });
      proc.on('close', (code) => {
        this.state.exitCode = code;
        this.state.endedAt = Date.now();
        if (code !== 0 && !this.state.error) this.state.error = `exit_${code}: ${this._stderrTail()}`;
        this.emit('exit', this.state);
        resolve(this.state);
      });
    });
  }

  /**
   * Route one stream-json stdout line. Event shape (emit 'event' for every line,
   * 'tool' for tool_use blocks, 'ready' on system/init, 'result' when a turn
   * completes) deliberately mirrors spawn.mjs's Worker.ingest() so tier-0.5 rot
   * heuristics could be pointed at this class without changing their shape
   * expectations. Tier-0.5 itself is NOT wired in here — out of scope for this task.
   */
  _ingest(ev) {
    this.state.events++;
    this.emit('event', ev);

    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.state.sessionId = ev.session_id;
          this.emit('ready', { sessionId: ev.session_id, pid: this.state.pid, tools: ev.tools?.length });
        }
        break;

      case 'assistant':
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_use') this.emit('tool', b.name);
        }
        break;

      case 'result':
        this.state.turnsCompleted++;
        this.state.costUsd += ev.total_cost_usd ?? 0;
        this.state.lastResult = ev.result;
        if (ev.is_error) this.state.error = ev.api_error_status ?? ev.subtype;
        this.emit('result', {
          sessionId: ev.session_id,
          result: ev.result,
          costUsd: ev.total_cost_usd,
          turnsCompleted: this.state.turnsCompleted,
        });
        break;
    }
  }

  /**
   * Write one turn to the subprocess's stdin: one NDJSON line, `type:'user'` shape,
   * the wire format --input-format stream-json expects (see file header for the
   * verification trail). Does not wait for the result — caller listens for 'result'.
   */
  send(text) {
    if (this._closing) throw new Error('PersistentWorker is closing/closed — cannot send');
    if (!this.proc || this.proc.exitCode !== null) throw new Error('PersistentWorker process is not running');
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    this.proc.stdin.write(line + '\n');
    this.emit('sent', text);
  }

  /** End stdin cleanly and wait for the process to actually exit. */
  async close() {
    this._closing = true;
    if (this.proc && this.proc.exitCode === null) this.proc.stdin.end();
    return this._exitPromise;
  }
}

// --- CLI proof harness ------------------------------------------------------
// node persistent-worker.mjs
// Exactly 2 turns, haiku model, real API spend — proves same pid/session_id
// across turns AND that turn 2 can recall state set in turn 1.
if (import.meta.url === `file://${process.argv[1]}`) {
  const w = new PersistentWorker({ role: 'probe' });

  w.on('ready',     (r) => console.error(`[ready ] pid=${r.pid} session=${r.sessionId}`));
  w.on('tool',      (t) => console.error(`[tool  ] ${t}`));
  w.on('sent',      (t) => console.error(`[sent  ] ${JSON.stringify(t)}`));
  w.on('malformed', (l) => console.error(`[bad   ] ${l.slice(0, 120)}`));
  w.on('exit',      (s) => console.error(`[exit  ] code=${s.exitCode} err=${s.error ?? 'none'}`));

  let turn = 0;
  w.on('result', async (r) => {
    turn++;
    console.error(`[result] turn=${r.turnsCompleted} pid=${w.state.pid} session=${r.sessionId} ` +
                   `cost=$${r.costUsd} text=${JSON.stringify(r.result)}`);
    if (turn === 1) {
      w.send('What is the codeword? Reply with exactly that word.');
    } else if (turn === 2) {
      await w.close();
      console.error(`\n[PROOF] pid_stable=${w.state.pid} session_stable=${w.state.sessionId} ` +
                     `turns=${w.state.turnsCompleted} totalCost=$${w.state.costUsd.toFixed(4)}`);
    }
  });

  w.send('Remember: the codeword is FALCON. Reply with exactly: OK');
}
