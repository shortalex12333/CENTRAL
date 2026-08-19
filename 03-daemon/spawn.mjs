/**
 * mac_execution_daemon — spawn primitive
 *
 * The ONLY sanctioned way to start a worker. Encodes every correction from
 * TEST_REPORT_01: lean tool scope, no inherited settings/hooks, stdin closed,
 * stream-json parsed incrementally, rate-limit telemetry surfaced.
 *
 * Language: Node (v24) — one language across daemon and Next.js UI, and the
 * stream-json contract is JSON-native.
 *
 * Run:  node spawn.mjs --role probe --task "Reply with exactly: PONG"
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

/** Per-role scoping. This is the RBAC matrix AND the cost control — one mechanism. */
export const ROLES = {
  probe:     { tools: ['Read'],                            mcp: {}, model: 'claude-haiku-4-5-20251001' },
  auditor:   { tools: ['Read', 'Grep', 'Glob'],            mcp: {}, model: 'claude-haiku-4-5-20251001' },
  fixer:     { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash'], mcp: {}, model: 'claude-sonnet-5' },
  architect: { tools: ['Read', 'Grep', 'Glob', 'Write'],   mcp: {}, model: 'claude-sonnet-5' },
};

/** Backpressure thresholds, driven by the CLI's own rate_limit_event. */
const RATE_LIMIT_PAUSE = 0.92;  // stop admitting new work
const RATE_LIMIT_WARN  = 0.75;  // matches provider's surpassedThreshold

export class Worker extends EventEmitter {
  constructor({ role, task, cwd = process.cwd(), timeoutMs = 600_000 }) {
    super();
    const spec = ROLES[role];
    if (!spec) throw new Error(`unknown role: ${role} (have: ${Object.keys(ROLES)})`);
    Object.assign(this, { role, task, cwd, spec, timeoutMs });
    this.state = {
      sessionId: null, events: 0, turns: 0, costUsd: 0,
      toolCalls: [], rateLimit: null, error: null, result: null,
      startedAt: Date.now(), endedAt: null,
    };
  }

  args() {
    return [
      '-p', this.task,
      '--output-format', 'stream-json',
      '--verbose',                                   // required with -p + stream-json
      '--model', this.spec.model,
      '--strict-mcp-config',                         // reject inherited MCP config
      '--mcp-config', JSON.stringify({ mcpServers: this.spec.mcp }),
      '--allowedTools', this.spec.tools.join(','),
      '--setting-sources', '',                       // no inherited settings or hooks
      '--dangerously-skip-permissions',
    ];
  }

  run() {
    return new Promise((resolve) => {
      const proc = spawn('claude', this.args(), {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],            // 'ignore' == < /dev/null, saves 3s/spawn
      });
      this.proc = proc;

      const killer = setTimeout(() => {
        this.state.error = 'timeout';
        this.emit('timeout', this.state);
        proc.kill('SIGTERM');
      }, this.timeoutMs);

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d; });

      // Incremental NDJSON — never buffer the whole stream.
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
        if (code !== 0 && !this.state.error) {
          this.state.error = `exit_${code}: ${stderr.slice(0, 500)}`;
        }
        this.emit('done', this.state);
        resolve(this.state);
      });
    });
  }

  /** Route one stream-json event into checkpointable state. */
  ingest(ev) {
    this.state.events++;
    this.emit('event', ev);

    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          this.state.sessionId = ev.session_id;           // CARL's resume handle
          this.emit('ready', { sessionId: ev.session_id, tools: ev.tools?.length });
        }
        break;

      case 'assistant':
        for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_use') {
            this.state.toolCalls.push(b.name);
            this.emit('tool', b.name);
          }
        }
        break;

      case 'rate_limit_event': {
        const rl = ev.rate_limit_info;
        this.state.rateLimit = rl;
        if (rl.utilization >= RATE_LIMIT_PAUSE)      this.emit('backpressure', rl);
        else if (rl.utilization >= RATE_LIMIT_WARN)  this.emit('rate-warn', rl);
        break;
      }

      case 'result':
        this.state.turns   = ev.num_turns ?? 0;
        this.state.costUsd = ev.total_cost_usd ?? 0;
        this.state.result  = ev.result;
        if (ev.is_error) this.state.error = ev.api_error_status ?? ev.subtype;
        break;
    }

    // Tier-0 rot heuristics: free, no model call. Escalate to CARL only on suspicion.
    const looping = this.state.toolCalls.length >= 6 &&
      new Set(this.state.toolCalls.slice(-6)).size === 1;
    if (looping) this.emit('suspect-rot', { reason: 'repeated_identical_tool', state: this.state });
    if (this.state.turns > 40) this.emit('suspect-rot', { reason: 'turn_cap', state: this.state });
  }

  /** Precise state extraction — the anti-context-dump handoff artifact. */
  handoff() {
    return {
      role: this.role, originalTask: this.task, cwd: this.cwd,
      sessionId: this.state.sessionId,
      turnsSpent: this.state.turns, costUsd: this.state.costUsd,
      toolsUsed: [...new Set(this.state.toolCalls)],
      error: this.state.error,
      lastResult: this.state.result,
      // Deliberately absent: full transcript. See blueprint §9 "Context Dump Fallacy".
    };
  }
}

// --- CLI harness -----------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
  const w = new Worker({ role: arg('role', 'probe'), task: arg('task', 'Reply with exactly: PONG') });

  w.on('ready',        (r)  => console.log(`[ready] session=${r.sessionId?.slice(0,8)} tools=${r.tools}`));
  w.on('tool',         (t)  => console.log(`[tool ] ${t}`));
  w.on('rate-warn',    (rl) => console.warn(`[rate ] ${(rl.utilization*100).toFixed(0)}% of ${rl.rateLimitType}`));
  w.on('backpressure', (rl) => console.error(`[STOP ] ${(rl.utilization*100).toFixed(0)}% — halt admissions`));
  w.on('suspect-rot',  (s)  => console.warn(`[rot? ] ${s.reason}`));
  w.on('malformed',    (l)  => console.error(`[bad  ] ${l.slice(0,80)}`));

  const s = await w.run();
  console.log(`\n[done ] events=${s.events} turns=${s.turns} cost=$${s.costUsd.toFixed(4)} ` +
              `wall=${s.endedAt - s.startedAt}ms err=${s.error ?? 'none'}`);
  console.log(`[result] ${JSON.stringify(s.result)}`);
  console.log(`[handoff] ${JSON.stringify(w.handoff())}`);
}
