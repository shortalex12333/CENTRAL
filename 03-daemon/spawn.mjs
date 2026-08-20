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

/**
 * Per-role scoping. This is the RBAC matrix AND the cost control — one mechanism.
 *
 * 🔴 CORRECTED 2026-08-19: `--allowedTools` alone does NOT reliably restrict tool
 * access under `--dangerously-skip-permissions` — confirmed empirically (F3: a
 * role:'probe' worker scoped to tools:['Read'] used Bash twice in real captured
 * streams; a follow-up test proved `--disallowedTools` DOES block it). Every prior
 * claim in this project that a probe/auditor worker was "read-only" was therefore
 * an assumption, not an enforced guarantee, until this fix. `--disallowedTools` is
 * now the actual enforcement mechanism; `tools` stays as the allow-list for
 * documentation/UI purposes and is passed through --allowedTools too, but nothing
 * downstream should trust the allow-list alone as a safety boundary.
 */
const ALL_MUTATING_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit'];

export const ROLES = {
  probe:     { tools: ['Read'],                            mcp: {}, model: 'claude-haiku-4-5-20251001' },
  auditor:   { tools: ['Read', 'Grep', 'Glob'],            mcp: {}, model: 'claude-haiku-4-5-20251001' },
  fixer:     { tools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash'], mcp: {}, model: 'claude-sonnet-5' },
  architect: { tools: ['Read', 'Grep', 'Glob', 'Write'],   mcp: {}, model: 'claude-sonnet-5' },
};

// Compute each role's deny-list: any mutating tool NOT explicitly allowed.
for (const spec of Object.values(ROLES)) {
  spec.disallowed = ALL_MUTATING_TOOLS.filter((t) => !spec.tools.includes(t));
}

/** Backpressure thresholds, driven by the CLI's own rate_limit_event. */
const RATE_LIMIT_PAUSE = 0.92;  // stop admitting new work
const RATE_LIMIT_WARN  = 0.75;  // matches provider's surpassedThreshold

/**
 * Tier-0.5 rot detection. Deterministic fingerprint+count checks, zero LLM calls —
 * the pattern independently reinvented by OpenHands' StuckDetector, AutoGPT's
 * WatchdogComponent, and a real anthropics/claude-code runaway incident (#4095:
 * 913 identical repeated commands, 38 consecutive tool errors). No surveyed
 * framework or production company uses an LLM-judge as the primary trigger —
 * CARL's Ollama judge stays downstream of this, for genuinely ambiguous cases only.
 * Research: 05-research/{A_FRAMEWORK_DETECTORS,B_MEASURABLE_SIGNALS}.md.
 *
 * 🔴 2026-08-20 — the cycle detector below is a direct port of Gemini CLI's shipped
 * `LoopDetectionService` (`packages/core/dist/src/services/loopDetectionService.js`,
 * read from the real installed npm package, not documentation — see
 * `06-gemini/GX3_BUILTIN_ROT_DETECTION_RESULTS.md` for the full source citation).
 * Gemini's Tier 1 checks a repeating cycle of period k for EVERY k from 1 to 5
 * (`requiredLength = k * TOOL_CALL_LOOP_THRESHOLD`, `TOOL_CALL_LOOP_THRESHOLD = 5`)
 * — one general routine, not a one-off period-1 check plus a one-off period-2
 * check. It replaces the two special-cased blocks that used to live here
 * (`HARD_STOP_AT=4` identical-in-a-row, `ALTERNATION_LEN=6` period-2-only), which
 * could not see a period-3+ cycle (A-B-C-A-B-C...) at all — see
 * `spawn.unit-test.mjs` for a fabricated proof that a period-3 cycle is now caught.
 */
const STUCK_WINDOW = 20;          // OpenHands' scan window
const ERROR_HARD_STOP_AT = 3;     // same tool erroring N times in a row — UNCHANGED, unrelated mechanism
const CYCLE_MIN_PERIOD = 1;       // period-1 == N-identical-calls-in-a-row (subsumes the old HARD_STOP_AT check)
const CYCLE_MAX_PERIOD = 5;       // matches Gemini's real checked range (k=1..5), not a guess
// Real Gemini ships TOOL_CALL_LOOP_THRESHOLD=5 (5 reps required at every period).
// We deliberately tune down to 3 here: (a) it reproduces the exact nudge-then-
// hard-stop behavior the old NUDGE_AT=3/HARD_STOP_AT=4 pair had for period 1 with
// a single uniform constant (see evaluateCycle() below — first detection nudges,
// a second detection after that hard-stops, so period 1 hard-stops on the 4th
// identical call exactly as before); (b) this project's standing bias is to flag
// over silently trust (MEMORY: bias_toward_flagging) and Tier-0.5 is free/local —
// a false 'suspect-rot' here costs nothing but a swallowed nudge, while a missed
// one costs a runaway. 5 remains a one-line tuning knob if 3 proves too sensitive
// once this runs against real traffic.
const CYCLE_MIN_REPEATS = 3;

/** Stable fingerprint of a tool call: name + canonicalized args, not name alone. */
function fingerprint(name, input) {
  const canon = (v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
      : v;
  return `${name}:${JSON.stringify(canon(input ?? {}))}`;
}

/**
 * Non-cryptographic stable hash of a streamed text block, for the content-chanting
 * detector (item 2 — Gemini's Tier 2 hashes 50-char streamed chunks; this ports the
 * simpler per-block version the task called for: hash each assistant TEXT block
 * whole, not a sliding sub-string window — see CARL_V2_DESIGN.md for the exact gap
 * this leaves relative to Gemini's real Tier 2, and why it's an accepted trade-off
 * here). FNV-1a-style; collisions only ever cause an extra flag, never a missed one.
 */
export function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `text:${(h >>> 0).toString(16)}:${s.length}`;
}

/**
 * General period-P cycle detector, P in [CYCLE_MIN_PERIOD, CYCLE_MAX_PERIOD].
 * Finds the SMALLEST period P for which the last (P * repeats) hashes consist of
 * exactly P distinct values, repeating in the same cyclic order, `repeats` times
 * in a row. Ported from Gemini CLI's `LoopDetectionService` tool-call-cycle check
 * (see the file-header comment above) — one routine subsumes what used to be two
 * special-cased blocks (period 1 = old HARD_STOP_AT, period 2 = old ALTERNATION_LEN)
 * and additionally catches period 3, 4, and 5 cycles neither old block could see.
 * Requiring exactly P distinct values in the pattern (not "at least") prevents a
 * smaller period's run from also spuriously matching a larger P (e.g. AAAAAA is
 * period 1, not also a degenerate period 2 of [A,A]) — checking P in ascending
 * order means the smallest true period is always the one reported.
 */
export function detectCycle(hashes, repeats) {
  for (let period = CYCLE_MIN_PERIOD; period <= CYCLE_MAX_PERIOD; period++) {
    const windowLen = period * repeats;
    if (hashes.length < windowLen) continue;
    const tail = hashes.slice(-windowLen);
    const pattern = tail.slice(0, period);
    if (new Set(pattern).size !== period) continue; // exactly P distinct values in one period
    const cyclic = tail.every((v, i) => v === pattern[i % period]);
    if (cyclic) return { period, pattern };
  }
  return null;
}

/**
 * Translate a detectCycle() match into the project's nudge-then-hard-stop shape,
 * mirroring Gemini CLI's own consumer logic (loop `count === 1` → inject a
 * corrective message and continue; `count > 1` → hard stop — see
 * GX3_BUILTIN_ROT_DETECTION_RESULTS.md § "What happens on detection"). One flag per
 * signal family (`familyKey`, e.g. 'tool' or 'text') stored in the existing
 * `nudged` Set is enough to reproduce the 1-vs-2+ distinction: the FIRST time this
 * family detects a cycle, only a nudge fires and the run continues; if the SAME
 * family detects a cycle AGAIN afterward (the nudge didn't resolve it), it
 * hard-stops. This deliberately does not implement Gemini's turn-budget reduction
 * on nudge (`boundedTurns - 1`) — this codebase has no equivalent turn-budget
 * concept at the Tier-0.5 layer; CARL v2's TURN_GATE is the analogous idea one
 * layer up.
 */
export function evaluateCycle(worker, hashes, familyKey, reasonPeriod1, reasonOther) {
  const hit = detectCycle(hashes, CYCLE_MIN_REPEATS);
  if (!hit) return;
  const nudgeKey = `cycle:${familyKey}`;
  const reason = hit.period === 1 ? reasonPeriod1 : reasonOther;
  if (!worker.state.nudged.has(nudgeKey)) {
    worker.state.nudged.add(nudgeKey);
    worker.emit('nudge', { reason, period: hit.period, pattern: hit.pattern });
  } else {
    worker.emit('suspect-rot', { reason, period: hit.period, pattern: hit.pattern, state: worker.state });
  }
}

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
      // Tier-0.5: fingerprint history (not just tool names) + per-fingerprint error streaks.
      // textFingerprints: rolling hashes of streamed assistant TEXT blocks — separate
      // from tool-call fingerprints, see hashText()/evaluateCycle() (item 2, GX3-derived).
      fingerprints: [], textFingerprints: [], errorStreaks: new Map(), nudged: new Set(),
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
      '--disallowedTools', this.spec.disallowed.join(','),  // the real enforcement — see ROLES comment
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
            this.state.fingerprints.push({ id: b.id, fp: fingerprint(b.name, b.input) });
            this.emit('tool', b.name);
          } else if (b.type === 'text' && b.text && b.text.trim()) {
            // Item 2 — text-content-repetition tracking. Old code only ever looked at
            // tool_use blocks; an agent that loops on saying similar things without
            // repeating a tool call was invisible to Tier-0.5 entirely until this.
            this.state.textFingerprints.push(hashText(b.text.trim()));
          }
        }
        break;

      // Tool results arrive as 'user' events (mirrors the Messages API tool_result
      // shape) — this case did not exist before; is_error flowed through unread.
      case 'user':
        for (const b of ev.message?.content ?? []) {
          if (b.type !== 'tool_result') continue;
          const call = this.state.fingerprints.find((f) => f.id === b.tool_use_id);
          const key = call?.fp ?? b.tool_use_id;
          const streak = b.is_error ? (this.state.errorStreaks.get(key) ?? 0) + 1 : 0;
          this.state.errorStreaks.set(key, streak);
          if (streak === ERROR_HARD_STOP_AT - 1 && !this.state.nudged.has(`err:${key}`)) {
            this.state.nudged.add(`err:${key}`);
            this.emit('nudge', { reason: 'tool_repeatedly_erroring', key, streak });
          }
          if (streak >= ERROR_HARD_STOP_AT) {
            this.emit('suspect-rot', { reason: 'tool_repeatedly_erroring', key, streak, state: this.state });
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

    // Tier-0.5 rot heuristics: free, no model call, deterministic fingerprint+count
    // only — the pattern every framework/production case in the research converged
    // on, and the one Gemini CLI's own shipped Tier 1/Tier 2 independently confirm
    // (GX3_BUILTIN_ROT_DETECTION_RESULTS.md). Escalate to CARL's judge only for what
    // these can't resolve.
    //
    // General period-1..5 cycle detector, run against two independent signal
    // families — tool-call fingerprints (unchanged data source) and, new, streamed
    // assistant text hashes (item 2). Subsumes the old identical-run (period 1) and
    // alternating-cycle (period 2) special cases, plus catches period 3/4/5 neither
    // could see at all — see detectCycle()/evaluateCycle() above for the algorithm
    // and the nudge-then-hard-stop translation.
    evaluateCycle(
      this,
      this.state.fingerprints.slice(-STUCK_WINDOW).map((f) => f.fp),
      'tool',
      'repeated_identical_tool_call',
      'cyclic_tool_pattern',
    );
    evaluateCycle(
      this,
      this.state.textFingerprints.slice(-STUCK_WINDOW),
      'text',
      'repeated_text_content',
      'cyclic_text_pattern',
    );

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
  w.on('nudge',        (s)  => console.warn(`[nudge] ${s.reason}`));
  w.on('suspect-rot',  (s)  => console.warn(`[rot? ] ${s.reason}`));
  w.on('malformed',    (l)  => console.error(`[bad  ] ${l.slice(0,80)}`));

  const s = await w.run();
  console.log(`\n[done ] events=${s.events} turns=${s.turns} cost=$${s.costUsd.toFixed(4)} ` +
              `wall=${s.endedAt - s.startedAt}ms err=${s.error ?? 'none'}`);
  console.log(`[result] ${JSON.stringify(s.result)}`);
  console.log(`[handoff] ${JSON.stringify(w.handoff())}`);
}
