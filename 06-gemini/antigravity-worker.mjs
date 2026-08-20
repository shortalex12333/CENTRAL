/**
 * AntigravityWorker — a third parallel, comparable primitive alongside
 * 03-daemon/spawn.mjs's Worker (Claude) and 06-gemini/gemini-worker.mjs
 * (Gemini CLI, never live-proven — auth-blocked, see GX5 results). This one
 * wraps the REAL, CONFIRMED-WORKING `agy` binary (Antigravity's headless CLI,
 * v1.1.16, /Users/celeste7/.local/bin/agy) — no API key, same auth as the
 * desktop Antigravity app.
 *
 * spawn.mjs and gemini-worker.mjs are NOT modified. This file writes into the
 * SAME `controlplane.events` table both of those write to, tagged
 * `runtime='antigravity'` via 06-gemini/sql/002_antigravity_runtime.sql
 * (applied live — widens the existing CHECK constraint from
 * ('claude','gemini') to ('claude','gemini','antigravity')).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ①  RBAC / TOOL-SCOPING — READ THIS BEFORE TRUSTING ANY DISPATCH THAT USES
 *     THIS WORKER. Full investigation + evidence: ANTIGRAVITY_WORKER_RESULTS.md.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The project's own history (spawn.mjs's ROLES comment) already found this
 * exact bug class once: Claude's `--allowedTools` did NOT reliably restrict
 * under `--dangerously-skip-permissions` — only `--disallowedTools` actually
 * enforced. Gemini CLI had an identical real CVE (GHSA-wpqr-6v78-jr5g,
 * CVSS 10.0). So `agy` was investigated empirically, not assumed either way:
 *
 *   1. `agy --help` — NO `--allowedTools`/`--disallowedTools`-equivalent flag
 *      exists at all. Confirmed by reading the full flag list.
 *   2. `agy mcp` / `agy plugin` — scope only MCP-provided / plugin tools.
 *      Neither can restrict the 53 BUILT-IN tools (run_command,
 *      write_to_file, browser_*, etc.) — those aren't MCP or plugin tools.
 *   3. `~/.gemini/antigravity-cli/settings.json` has a `permissions.allow`
 *      list (`action(target)` syntax: `command(prefix)`, `read_file(/path)`,
 *      `write_file(/path)`, `read_url(domain)`, `execute_url(domain)`,
 *      `mcp(server/tool)`, `unsandboxed(prefix)`) with Deny > Ask > Allow
 *      precedence — a REAL policy engine. BUT it is a single GLOBAL file,
 *      not a per-invocation CLI flag, and the SAME file already has
 *      `"toolPermission": "always-proceed"` set — meaning on THIS machine,
 *      as configured, every action is auto-approved regardless of what the
 *      allow/deny lists say. This worker does NOT rely on it: it cannot be
 *      scoped per-role per-process the way spawn.mjs's --disallowedTools is,
 *      only globally and destructively (editing the one shared settings
 *      file every other agy invocation on this machine also reads).
 *   4. `--sandbox` restricts TERMINAL command execution specifically
 *      (`enableTerminalSandbox` → "OS containment rings" per the CLI
 *      reference) — it does not touch write_to_file or browser_* at all.
 *      Not a general tool-scoping mechanism.
 *   5. `--dangerously-skip-permissions` and the observed `permission_mode:
 *      "always-proceed"` in the real `init` event (present even without
 *      passing that flag, because global settings.json already sets
 *      `toolPermission: "always-proceed"`) together confirm: headless -p
 *      mode on this machine runs with NO per-tool interactive gate at all.
 *
 *   THE ONE REAL, PER-INVOCATION, DETERMINISTIC ENFORCEMENT MECHANISM FOUND:
 *   `.agents/hooks.json` — a PreToolUse hook, external to the model, that can
 *   return `{"decision":"deny"}` for a tool-name regex match BEFORE the tool
 *   runs. This is genuinely process-external (a shell command spawned by the
 *   `agy` runtime itself, not something the model can talk its way past) and
 *   is placed per-workspace (`cwd`-relative `.agents/hooks.json`), which
 *   means — unlike the global settings.json permissions list — it CAN be
 *   scoped per-role per-invocation, mirroring spawn.mjs's ROLES/disallowed
 *   pattern. This worker uses that mechanism (see ROLES below) and DOES NOT
 *   ship an unrestricted default.
 *
 *   EMPIRICAL RESULT (see ANTIGRAVITY_WORKER_RESULTS.md §1 for the full
 *   transcript): a `.agents/hooks.json` PreToolUse hook matching
 *   `run_command|write_to_file|replace_file_content|multi_replace_file_content|sed_file`
 *   and returning `{"decision":"deny",...}` was tested against a task
 *   explicitly designed to read a file, run a shell command, AND write a
 *   file. Real observed outcome recorded in the results doc — READ IT before
 *   trusting this worker for anything beyond the role it was tested under.
 *
 *   This worker writes a `hooks.json` into the target `cwd`'s `.agents/`
 *   directory before every run, scoped to the role, and DOES NOT clean it up
 *   afterward by default (a stale hooks.json is a fail-SAFE default — it can
 *   only over-restrict a later run in that directory, never under-restrict).
 *   If no `cwd`-writable location is available the run is refused rather
 *   than silently dispatched unrestricted — see `args()`/`run()` below.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ②  EVENT SCHEMA — confirmed live against the real binary (v1.1.16), not
 *     assumed to match Claude's or Gemini's shape.
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   {"event":"init","conversation_id":..,"init":{"cwd":..,"tools":[...53],"permission_mode":"always-proceed"}}
 *   {"event":"step_update","step_update":{"conversation_id":..,"step_index":N,
 *      "state":"ACTIVE"|"DONE","step_type":"user_input"|"checkpoint"|"agent_response"|"tool_call"|...,
 *      "text_delta":..,"duration_seconds":..,"usage":{...}}}
 *   {"event":"result","result":{"conversation_id":..,"status":"SUCCESS"|"ERROR",
 *      "response":"...","error":"...","duration_seconds":..,"num_turns":..,"usage":{...}}}
 *
 *   Real fields observed live (trivial "Reply with exactly: PONG" run):
 *     step_index 0: step_type="user_input", state=DONE (no text_delta/usage)
 *     step_index 1: step_type="checkpoint", state=DONE, duration_seconds only
 *     step_index 2: step_type="agent_response", state=ACTIVE then DONE,
 *                   text_delta streamed in chunks ("PONG" then "\n"),
 *                   final DONE chunk carries duration_seconds + usage
 *     terminal result: status="SUCCESS", response is the FULL final text
 *       (unlike Gemini's schema, which carries no response text at all and
 *       must be reconstructed — Antigravity's result event DOES carry it
 *       directly, same convenience as Claude's `ev.result`), duration_seconds,
 *       num_turns, usage — NO dollar-cost field anywhere (confirmed, matches
 *       what the task brief already told us to expect).
 *
 *   Tool-call step_updates (step_type naming for run_command/write_to_file/etc,
 *   and whether tool args/results appear as distinct fields) — confirmed
 *   against the real 3-step read+shell+write test run; exact field names
 *   captured in ANTIGRAVITY_WORKER_RESULTS.md §1 and reflected in ingest()
 *   below. `toolCalls` is populated from any step_update whose `step_type`
 *   names a real tool (not user_input/checkpoint/agent_response), keyed by
 *   `step_index` since these events carry no `tool_use_id`/`id` field the
 *   way Claude's content blocks or Gemini's `tool_id` do.
 *
 * Run:  node antigravity-worker.mjs --role probe --task "Reply with exactly: PONG"
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const execFileP = promisify(execFile);

/**
 * Per-role tool scoping via `.agents/hooks.json` PreToolUse deny hooks — the
 * only real, per-invocation, model-external enforcement mechanism found (see
 * header §1). `denyToolPattern` is a regex ALTERNATION STRING matched against
 * agy's tool names (see the 53-tool list in a real `init` event) — NOT a
 * Claude-style tool allow-list, because agy has no allow-list flag at all.
 *
 * Every role denies every non-explicitly-safe mutating/dangerous tool by
 * default. `probe`/`auditor` are the only roles proven safe by the empirical
 * test in ANTIGRAVITY_WORKER_RESULTS.md §1 — `fixer`/`architect` are included
 * for shape-parity with spawn.mjs's ROLES but are UNPROVEN beyond the deny
 * hook itself (no live test dispatched a real fixer/architect task) and
 * should not be used for real dispatch without an additional empirical pass.
 */
const MUTATING_AND_DANGEROUS_TOOLS = [
  'run_command', 'command_status', 'send_command_input',
  'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file',
  'notebook_edit', 'notebook_execution',
  'browser_click_element', 'browser_drag_pixel_to_pixel', 'browser_input',
  'browser_mouse_down', 'browser_mouse_up', 'browser_move_mouse',
  'browser_press_key', 'browser_refresh_page', 'browser_scroll', 'browser_scroll_dom',
  'browser_select_option', 'click_browser_pixel', 'execute_browser_javascript',
  'open_browser_url',
  'delete_knowledge', 'schedule', 'send_message', 'manage_inbox', 'manage_task',
  'manage_subagents', 'define_subagent', 'invoke_subagent', 'browser_subagent',
  'call_mcp_tool', 'generate_image',
];
const READ_ONLY_TOOLS = [
  'view_file', 'list_dir', 'find_by_name', 'grep_search', 'read_url_content',
  'read_resource', 'list_resources', 'list_permissions', 'read_browser_page',
  'capture_browser_screenshot', 'capture_browser_console_logs',
  'list_browser_pages', 'browser_get_dom', 'browser_get_network_request',
  'browser_list_network_requests', 'search_web', 'wait', 'wait_5_seconds', 'finish',
  'ask_permission', 'ask_custom_permission', 'ask_question',
];

export const ROLES = {
  // Empirically tested — see ANTIGRAVITY_WORKER_RESULTS.md §1.
  probe:   { deny: MUTATING_AND_DANGEROUS_TOOLS, model: undefined },
  auditor: { deny: MUTATING_AND_DANGEROUS_TOOLS, model: undefined },
  // Shape-parity with spawn.mjs's ROLES, NOT independently live-tested — flagged
  // in follow_ups. Do not use for real dispatch until tested the same way probe was.
  fixer:     { deny: MUTATING_AND_DANGEROUS_TOOLS.filter((t) => !['run_command', 'write_to_file'].includes(t)), model: undefined },
  architect: { deny: MUTATING_AND_DANGEROUS_TOOLS.filter((t) => t !== 'write_to_file'), model: undefined },
};

function hooksJsonFor(denyList) {
  const pattern = denyList.join('|');
  return {
    'antigravity-worker-rbac': {
      PreToolUse: [
        {
          matcher: pattern,
          hooks: [
            {
              type: 'command',
              // Deterministic, model-external deny. See header §1 for why this
              // is the mechanism chosen over settings.json permissions (global,
              // not per-invocation) or --sandbox (terminal-only).
              command:
                `echo '{"decision":"deny","reason":"AntigravityWorker RBAC: tool blocked for this role"}'`,
              timeout: 10,
            },
          ],
        },
      ],
    },
  };
}

export class AntigravityWorker extends EventEmitter {
  constructor({ role, task, cwd = process.cwd(), timeoutMs = 300_000 }) {
    super();
    const spec = ROLES[role];
    if (!spec) throw new Error(`unknown role: ${role} (have: ${Object.keys(ROLES)})`);
    Object.assign(this, { role, task, cwd, spec, timeoutMs });
    this.state = {
      conversationId: null,
      events: 0,
      toolCalls: [],        // [{stepIndex, stepType}] — see header §2, no tool_use_id in this schema
      steps: [],             // raw step_update history, bounded
      resultText: null,      // from the terminal result event's `response` field — real, not reconstructed
      status: null,           // "SUCCESS" | "ERROR"
      error: null,
      usage: null,            // final usage object (input/output/thinking/cache_read/total tokens)
      costUsd: null,           // ALWAYS null — agy's result schema has no dollar-cost field (confirmed)
      durationSeconds: null,
      numTurns: null,
      rawEvents: [],
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      hooksPath: null,        // where the RBAC deny-hook was written, for the DB record
    };
  }

  /** Write the per-role .agents/hooks.json deny gate into cwd BEFORE spawning. */
  async prepareRbacGate() {
    const agentsDir = path.join(this.cwd, '.agents');
    const hooksPath = path.join(agentsDir, 'hooks.json');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(hooksPath, JSON.stringify(hooksJsonFor(this.spec.deny), null, 2));
    this.state.hooksPath = hooksPath;
    return hooksPath;
  }

  args() {
    const a = [
      '-p', this.task,
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      // LOAD-BEARING, not optional — confirmed empirically (results doc §2): without
      // --add-dir pointing at the real target directory, agy silently falls back to
      // an unrelated default scratch/brain directory under
      // ~/.gemini/antigravity-cli/{scratch,brain/<conversation_id>}/ for ALL file
      // ops (read_file tools even roamed as far as searching from "/"), and
      // write_to_file refuses any TargetFile outside that fallback location. This
      // reproduced reliably when `cwd` was outside settings.json's
      // `trustedWorkspaces` ("/Users/celeste7" only, on this machine). Passing
      // --add-dir with the real cwd fixed it in the live test (view_file correctly
      // read the real target file; see results doc §2 before vs. after).
      '--add-dir', this.cwd,
    ];
    if (this.spec.model) a.push('--model', this.spec.model);
    return a;
  }

  async run() {
    // Fail-closed: refuse to dispatch if the RBAC gate can't be written, rather
    // than silently falling through to an unrestricted run. Mirrors the task
    // brief's explicit instruction not to ship silent unrestricted dispatch.
    try {
      await this.prepareRbacGate();
    } catch (err) {
      this.state.error = `rbac_gate_write_failed: ${err.message}`;
      this.state.endedAt = Date.now();
      this.emit('done', this.state);
      return this.state;
    }

    return new Promise((resolve) => {
      const proc = spawn('agy', this.args(), {
        cwd: this.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],   // same defensive shape as spawn.mjs/gemini-worker.mjs: stdin closed
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

      // REAL, EMPIRICALLY-HIT bug, not theoretical: `proc.on('close', ...)` alone
      // hung indefinitely (4+ min, past agy's own 5-minute --print-timeout) on TWO
      // separate live test runs, even though the `agy` process itself had already
      // produced its full NDJSON output (init + tool events visible) and — per `ps`
      // — no longer existed in the process table. `'close'` only fires once a
      // child's stdio STREAMS report closed, which is a different, stronger
      // condition than the child process having exited: if `agy` (or something it
      // spawns internally — not independently confirmed, no orphan was left behind
      // to inspect, but this is the textbook Node.js child_process gotcha for
      // exactly this symptom) leaves the write end of the stdout pipe held open by
      // anything other than `agy` itself, `'close'` can wait forever past the
      // process's own real exit. `'exit'` fires on the process's own termination
      // regardless of stream state — using it here, with a `setImmediate` grace
      // tick to let any already-buffered stdout drain through readline first, is
      // what actually let the SAME task (that hung under `close`-only, twice)
      // complete cleanly end-to-end (see ANTIGRAVITY_WORKER_RESULTS.md §3). Both
      // listeners still resolve exactly once, whichever fires first.
      let finished = false;
      const finish = (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(killer);
        this.state.exitCode = code;
        this.state.endedAt = Date.now();
        if (code !== 0 && !this.state.error) {
          this.state.error = `exit_${code}: ${stderr.trim().slice(0, 800)}`;
        }
        this.emit('done', this.state);
        resolve(this.state);
      };
      proc.on('close', (code) => finish(code));
      proc.on('exit', (code) => { setImmediate(() => finish(code)); });
    });
  }

  /** Route one real agy stream-json NDJSON line into checkpointable state. */
  ingest(ev) {
    this.state.events++;
    this.state.rawEvents.push(ev);
    if (this.state.rawEvents.length > 200) this.state.rawEvents.shift(); // bounded, matches gemini-worker.mjs stance
    this.emit('event', ev);

    switch (ev.event) {
      case 'init':
        this.state.conversationId = ev.init?.conversation_id ?? ev.conversation_id ?? null;
        this.emit('ready', { conversationId: this.state.conversationId, tools: ev.init?.tools?.length, permissionMode: ev.init?.permission_mode });
        break;

      case 'step_update': {
        const su = ev.step_update ?? {};
        this.state.steps.push(su);
        // CONFIRMED live (results doc §2, real 3-step read+shell+write transcript):
        // a tool call is `step_type:"tool"` (NOT the tool name itself) carrying a
        // separate `tool_name` field plus `tool_info:{name,parameters,output?,error?}`.
        // Fires once with state:"ACTIVE" (call started) and again with the SAME
        // step_index at state:"DONE" (succeeded, tool_info.output present) or
        // state:"ERROR" (blocked/failed, tool_info.error present — this is exactly
        // how a PreToolUse hook deny surfaces: tool_info.error.message ===
        // "tool call denied by pre-tool hook: <reason>"). No tool_use_id/id field
        // exists in this schema — step_index is the only correlation key, unlike
        // Claude's block id or Gemini's tool_id.
        if (su.step_type === 'tool') {
          const call = {
            stepIndex: su.step_index,
            state: su.state,
            toolName: su.tool_name ?? su.tool_info?.name ?? null,
            parameters: su.tool_info?.parameters ?? null,
            output: su.tool_info?.output ?? null,
            error: su.tool_info?.error ?? null,
            deniedByHook: su.state === 'ERROR' &&
              typeof su.tool_info?.error?.message === 'string' &&
              su.tool_info.error.message.startsWith('tool call denied by pre-tool hook'),
          };
          this.state.toolCalls.push(call);
          if (su.state === 'ACTIVE') this.emit('tool', call.toolName);
          if (call.deniedByHook) this.emit('tool-denied', call);
        }
        if (su.usage) this.state.usage = su.usage;
        break;
      }

      case 'result': {
        const r = ev.result ?? {};
        this.state.status = r.status ?? null;
        this.state.resultText = r.response ?? null;
        this.state.durationSeconds = r.duration_seconds ?? null;
        this.state.numTurns = r.num_turns ?? null;
        if (r.usage) this.state.usage = r.usage;
        if (r.status === 'ERROR') {
          this.state.error = this.state.error ?? (r.error || 'unknown_error');
        }
        break;
      }

      default:
        this.emit('unknown-event-type', ev);
    }
  }

  /** Precise handoff, same shape/intent as spawn.mjs's / gemini-worker.mjs's. */
  handoff() {
    return {
      runtime: 'antigravity',
      role: this.role, originalTask: this.task, cwd: this.cwd,
      conversationId: this.state.conversationId,
      toolsUsed: [...new Set(this.state.toolCalls.map((t) => t.toolName))],
      toolsDenied: this.state.toolCalls.filter((t) => t.deniedByHook).map((t) => t.toolName),
      deniedToolPattern: this.spec.deny.join('|'),
      error: this.state.error,
      lastResult: this.state.resultText,
      costUsd: this.state.costUsd,   // always null — see header §2
      usage: this.state.usage,
      numTurns: this.state.numTurns,
    };
  }
}

// --- Shared events-table write — SAME table, SAME `kind` taxonomy Claude/Gemini
// workers use, distinguished only by `runtime`. psql-shell-out pattern copied
// deliberately from gemini-worker.mjs (itself copied from 03-daemon/dispatcher.mjs's
// logEvent()) — reproduced here 1:1 so this file stays self-contained. ------
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
 * Writes ONE row into controlplane.events, runtime='antigravity' — requires
 * 06-gemini/sql/002_antigravity_runtime.sql applied first (widens the CHECK
 * constraint 001_runtime_column.sql added; applied live, see results doc).
 */
export async function logAntigravityEvent(state, { role, task, cwd }) {
  const severity = state.error ? 'error' : 'info';
  const body = {
    role, task, directory: cwd,
    conversation_id: state.conversationId,
    result: state.resultText, status: state.status,
    tool_calls: state.toolCalls,
    denied_tool_pattern: null, // filled by caller if desired; kept out of the hot path here
    usage: state.usage,
    cost_usd: state.costUsd,   // null — honestly absent, not fabricated, see class header §2
    exit_code: state.exitCode,
    error: state.error,
    events_parsed: state.events,
    hooks_path: state.hooksPath,
  };
  const id = await pgExec(
    `insert into controlplane.events (kind, severity, runtime, body) values (` +
    `${sqlStr('worker_dispatch_result')}, ${sqlStr(severity)}, ${sqlStr('antigravity')}, ${sqlJsonb(body)}) ` +
    `returning id;`
  );
  return id;
}

// --- CLI harness -----------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
  const role = arg('role', 'probe');
  const task = arg('task', 'Reply with exactly: PONG');
  const cwd = arg('cwd', process.cwd());
  const w = new AntigravityWorker({ role, task, cwd });

  w.on('ready', (r) => console.log(`[ready] conv=${r.conversationId ?? 'none'} tools=${r.tools ?? 'n/a'} permission_mode=${r.permissionMode ?? 'n/a'}`));
  w.on('tool', (t) => console.log(`[tool ] ${t}`));
  w.on('malformed', (l) => console.error(`[bad  ] ${l.slice(0, 80)}`));
  w.on('unknown-event-type', (ev) => console.warn(`[warn ] unrecognized event: ${JSON.stringify(ev).slice(0, 120)}`));

  const s = await w.run();
  console.log(`\n[done ] events=${s.events} status=${s.status ?? 'none'} ` +
              `wall=${s.endedAt - s.startedAt}ms exit=${s.exitCode} err=${s.error ?? 'none'}`);
  console.log(`[result] ${JSON.stringify(s.resultText)}`);
  console.log(`[usage ] ${JSON.stringify(s.usage)}`);

  const rowId = await logAntigravityEvent(s, { role, task, cwd });
  console.log(`[db] wrote controlplane.events id=${rowId} runtime=antigravity`);
  console.log(`[handoff] ${JSON.stringify(w.handoff())}`);
}
