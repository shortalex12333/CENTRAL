# C — Live Browser↔Subprocess Bridge: Results

Date: 2026-08-19/20 · Machine: this Mac · Claude Code version: 2.1.236 · Node v24.4.1

Goal: prove ONE mechanism — a live, bidirectional channel between a browser and a
running headless `claude` subprocess, with real messages flowing both ways and real
session persistence across turns. Deliberately "dumb terminal" only: no nodes, no
graph, no visual design. That polish is explicitly deferred.

**Answer, up front: proven.** A browser tab connected over a real WebSocket to a real
Node server, which spawned one real, long-lived `claude --input-format stream-json`
subprocess. Two turns were sent from a real WS client into that subprocess; turn 2
correctly recalled state from turn 1, proving one continuous session — not two
independent single-shot calls. Total real API spend across both proof steps: **$0.0754**.

---

## 1. `PersistentWorker` — new file, spawn.mjs untouched

**File:** `03-daemon/persistent-worker.mjs`

Read `03-daemon/spawn.mjs` in full first (its `Worker` class, `ROLES` matrix, and CLI
harness) and `01-audit/TEST_REPORT_01_execution_layer.md` (line 55-56: `< /dev/null` /
`stdio:'ignore'` is a deliberate fix for a real 3s stdin-wait stall). **`Worker` in
spawn.mjs was not modified in any way** — `git diff` confirms zero changes to that
file; `PersistentWorker` is a wholly new, separate `EventEmitter` subclass in a new
file, imported `ROLES` from `spawn.mjs` for its RBAC/cost-control matrix (reuse, not
reinvention) rather than duplicating it.

### Wire format — confirmed, not guessed

Two independent confirmations before writing any code:

1. `claude --help`, ran directly (no cost, local only):
   ```
   --input-format <format>   Input format (only works with --print):
                              "text" (default), or "stream-json"
                              (realtime streaming input)
   --replay-user-messages    Re-emit user messages from stdin back on stdout for
                              acknowledgment (only works with
                              --input-format=stream-json and --output-format=stream-json)
   ```
2. The existing research at `05-research/G2_NATIVE_FEATURE_CHECK.md` §4 already ran a
   live empirical test (scratch harnesses `stdin_persist_test.mjs` /
   `stdin_multiturn_test.mjs`, both read in full) proving: the process blocks on stdin
   for more input after a turn's `result` event rather than exiting; writing
   `JSON.stringify({type:'user', message:{role:'user', content:'...'}}) + '\n'` to
   stdin as a second turn is accepted and produces a second `result` on the **same
   pid** and **same `session_id`**, with the second turn's `cache_read_input_tokens`
   (31,785) matching turn 1's `cache_read + cache_creation` (23,132 + 8,653 = 31,785)
   — a full warm-cache hit, confirming real conversational continuity, not a fresh
   session dressed up to look continuous.

`PersistentWorker` productionizes exactly that verified primitive: one NDJSON line per
turn, `{"type":"user","message":{"role":"user","content":"<text>"}}`, stdin left open
between turns, `stdio: ['pipe','pipe','pipe']` (not `'ignore'`).

### Interface

- `new PersistentWorker({ role, cwd, timeoutMs })` — spawns immediately, `role`
  defaults to `'probe'` and is looked up in `spawn.mjs`'s `ROLES` (falls back to a
  minimal `{tools:['Read']}` spec for an unknown role).
- `.send(text)` — writes one NDJSON turn to stdin.
- `.close()` — ends stdin, returns a promise that resolves with final state once the
  process actually exits.
- Events: `'event'` (every parsed stream-json line, unfiltered), `'ready'`
  (system/init, carries `sessionId`/`pid`/`tools`), `'tool'` (tool_use blocks),
  `'result'` (one per completed turn, carries `sessionId`/`result`/`costUsd`/
  `turnsCompleted`), `'sent'`, `'malformed'`, `'exit'`. Shape deliberately mirrors
  `spawn.mjs`'s `Worker.ingest()` so tier-0.5 rot heuristics could point at this class
  unchanged — **not wired in for this task**, out of scope per the brief.

### Proof run — real, 2 turns, haiku, `node persistent-worker.mjs`

```
[sent  ] "Remember: the codeword is FALCON. Reply with exactly: OK"
[ready ] pid=50097 session=7f33c921-7509-4f2d-a1a7-ce96a88aa680
[result] turn=1 pid=50097 session=7f33c921-7509-4f2d-a1a7-ce96a88aa680 cost=$0.0170514 text="OK"
[sent  ] "What is the codeword? Reply with exactly that word."
[result] turn=2 pid=50097 session=7f33c921-7509-4f2d-a1a7-ce96a88aa680 cost=$0.0199876 text="FALCON"
[exit  ] code=0 err=none

[PROOF] pid_stable=50097 session_stable=7f33c921-7509-4f2d-a1a7-ce96a88aa680 turns=2 totalCost=$0.0370
```

- **Same pid (50097) across both turns.**
- **Same `session_id` (7f33c921-7509-4f2d-a1a7-ce96a88aa680) across both turns.**
- **Turn 2 correctly answered `FALCON`** — recall of state set in turn 1, proving one
  continuous conversation over the open stdin pipe.
- Cost: turn 1 $0.0170514 + turn 2 $0.0199876 = **$0.0370390**.

---

## 2. `ws-bridge.mjs` — WebSocket bridge server

**File:** `03-daemon/ws-bridge.mjs`. Uses the `ws` package (standard choice, tried
first per the brief — installed successfully, no fallback needed).

**Note on the `npm install`:** the brief said to run it inside `03-daemon`. Doing so
against an empty directory with no local `package.json` present, npm walked up the
directory tree to the git repo root (`/Users/celeste7`, confirmed the actual repo root
via `git -C /Users/celeste7 status`, not `CENTRAL`) and installed `ws` there instead —
creating a stray `package.json`/`package-lock.json`/`node_modules` at the home root.
Caught and fixed: those stray root artifacts were deleted, a minimal
`03-daemon/package.json` (`{"type":"module","dependencies":{"ws":"^8.18.0"}}`) was
added so `03-daemon` is a proper local install boundary, and `npm install` was re-run
scoped there — verified with a fresh `node --check` + listen-socket test after the
fix, confirming behavior was unaffected by the relocation (ESM/CJS module resolution
walks up from the importing *file's* location, and both `persistent-worker.mjs` and
`ws-bridge.mjs` live in `03-daemon`, so the correct `node_modules` is found either
way).

Behavior, exactly per the brief:
- Listens on `127.0.0.1:8791` (configurable via `--port`).
- On each new WS connection: spawns **one new** `PersistentWorker` (one worker per
  client, never shared/global) — verified live: two separate connections in testing
  produced two separate pids (50687, then 51214).
- Every event the worker emits is JSON-stringified (`{from:'worker', kind:..., ...}`)
  and sent to that specific client only.
- Every text message received from the client becomes one `worker.send(text)` call.
- On client disconnect: `await worker.close()` — verified live, see server log below,
  no orphaned `claude` subprocess left behind after either test client disconnected.

---

## 3. `terminal.html` — dumb terminal test page

**File:** `04-face/terminal.html`. Single self-contained file, inline JS only, no
build step, no framework. Connects `new WebSocket('ws://localhost:8791')` on load,
appends every incoming message as a raw-JSON line in a scrolling `<div id="log">`
(plus a couple of minimally-parsed `>> result:` / `>> ready:` / `>> tool:` lines for
readability — no further formatting, explicitly deferred per the brief), one
`<input>` + Send button that calls `ws.send()` on Enter or click.

**Confirmed NOT linked from `04-face/index.html`** — `index.html` was never opened or
modified this session; `git status` shows `terminal.html` as the only new file under
`04-face/`. Not deployed to Vercel — served only from a throwaway local
`python3 -m http.server 8792` bound to `127.0.0.1`, used purely to get a `http://`
origin the Chrome extension could navigate to (`file://` URLs are blocked by the
extension's own navigation guard), then torn down.

---

## 4. End-to-end proof — real server, real WebSocket frames, two lines of evidence

### 4a. Programmatic WS client (primary evidence)

Started `node ws-bridge.mjs` as a real background process (confirmed via `lsof -i
:8791`, `LISTEN`), then drove it with a real `ws` client script
(`_ws_test_client.mjs`, run from `03-daemon` so module resolution worked, deleted
after the run) — not a code-review claim, an actual running server exchanging actual
WS frames.

**Turn 1** — client sends `"Reply with exactly: BRIDGE-WORKS"`. Raw frames observed:

```
[client] WS OPEN — sending turn 1
[client] RECV {"from":"worker","kind":"sent","text":"Reply with exactly: BRIDGE-WORKS"}
[client] RECV {"from":"worker","kind":"ready","sessionId":"00f2d2bd-a20a-48f7-b82e-66721d8f3d55","pid":50687,"tools":30}
... (raw stream-json 'event' frames forwarded verbatim, thinking-token deltas, assistant text block) ...
[client] RECV {"from":"worker","kind":"result","sessionId":"00f2d2bd-a20a-48f7-b82e-66721d8f3d55","result":"BRIDGE-WORKS","costUsd":0.0171794,"turnsCompleted":1}
[client] === RESULT #1 === text="BRIDGE-WORKS" session=00f2d2bd-a20a-48f7-b82e-66721d8f3d55
```

**Turn 2** — client sends `"What word did I just ask you to reply with in the
previous message? Reply with exactly that word and nothing else."` (a recall probe
referencing turn 1, on the same open WS connection, same worker):

```
[client] sending turn 2 (recall probe)
[client] RECV {"from":"worker","kind":"ready","sessionId":"00f2d2bd-a20a-48f7-b82e-66721d8f3d55","pid":50687,"tools":30}
... raw event: assistant "thinking" block shows the model reasoning about what
    "the word" it was asked to reply with was, before answering ...
[client] RECV {"from":"worker","kind":"result","sessionId":"00f2d2bd-a20a-48f7-b82e-66721d8f3d55","result":"BRIDGE-WORKS","costUsd":0.0211858,"turnsCompleted":2}
[client] === RESULT #2 === text="BRIDGE-WORKS" session=00f2d2bd-a20a-48f7-b82e-66721d8f3d55
[client] closing after 2 results
[client] WS CLOSED
```

- **Same pid (50687) across both turns.**
- **Same `session_id` (00f2d2bd-a20a-48f7-b82e-66721d8f3d55) across both turns.**
- **Turn 2's raw `assistant` event's `usage.cache_read_input_tokens` = 25204** — a
  large warm-cache hit carrying turn 1's context forward, the same signature the
  original research used to distinguish real persistence from a disguised fresh call.
- **Turn 2 correctly answered `BRIDGE-WORKS`** — recall of exactly the word set in
  turn 1's instruction, via a real WebSocket round trip, not a direct subprocess call.

Server-side log, independently confirming the same events from the other end of the
wire:

```
[bridge] listening on ws://127.0.0.1:8791 (role=probe)
[bridge] client #1 connected — spawning PersistentWorker (role=probe)
[bridge] client #1 -> worker: "Reply with exactly: BRIDGE-WORKS"
[bridge] client #1 -> worker: "What word did I just ask you to reply with in the previous message? Reply with exactly that word and nothing else."
[bridge] client #1 disconnected — closing worker pid=50687
```

Cost this step: turn 1 $0.0171794 + turn 2 $0.0211858 = **$0.0383652**.

### 4b. Real browser load (secondary evidence, zero extra API cost)

Used the `claude-in-chrome` extension to navigate an actual Chrome tab to
`http://127.0.0.1:8792/terminal.html` (static server, see §3). `get_page_text`
returned the live rendered DOM:

```
[client] connecting to ws://localhost:8791 ...
[client] WS OPEN
```

Cross-checked against the bridge server's own log at the same moment:

```
[bridge] client #2 connected — spawning PersistentWorker (role=probe)
```

Confirms the actual `terminal.html` page, loaded in a real browser tab, opened a real
WebSocket connection to the real bridge server, which spawned a second, independent
`PersistentWorker` (a **different** pid, 51214, from the programmatic client's 50687 —
confirming "one worker per client connection," not shared/global). No message was
sent from the browser (would have cost real API spend beyond the budgeted 4 turns);
closing the tab triggered `ws.on('close')` → `worker.close()`, confirmed by the log
line `[bridge] client #2 disconnected — closing worker pid=51214` and by `ps aux`
showing no orphaned `claude` subprocess afterward.

---

## Cost accounting

| Step | Turns | Model | Cost (USD) |
|---|---|---|---|
| §1 PersistentWorker proof (FALCON codeword) | 2 | haiku-4.5 | $0.0370390 |
| §4a end-to-end bridge proof (BRIDGE-WORKS) | 2 | haiku-4.5 | $0.0383652 |
| §4b browser load (no message sent) | 0 | — | $0.00 |
| **Total** | **4** | | **$0.0754042** |

No exploratory turns beyond these 4 were run.

---

## Cleanup performed

- Killed `ws-bridge.mjs` background process and the throwaway static file server.
- Deleted the scratch WS test client (`03-daemon/_ws_test_client.mjs`).
- Deleted the accidental home-root `package.json`/`package-lock.json`/`node_modules`
  created by the initial un-scoped `npm install`; replaced with a proper
  `03-daemon/package.json` + local `node_modules`.
- Verified `git diff` shows **zero changes** to `03-daemon/spawn.mjs`.
- Confirmed no orphaned `claude` subprocesses remain (`ps aux | grep claude`, clean).

## Files

- `03-daemon/persistent-worker.mjs` (new)
- `03-daemon/ws-bridge.mjs` (new)
- `03-daemon/package.json` (new — scopes the `ws` dependency to this directory)
- `04-face/terminal.html` (new, standalone, not linked from `index.html`, not
  deployed)
- `02-forge/results/C_LIVE_BRIDGE_RESULTS.md` (this file)

## Follow-ups (not attempted — out of scope for this proof)

1. **Tunnel routing**: this bridge only listens on `127.0.0.1`. Routing it over
   whatever tunnel mechanism the wider CENTRAL project uses for remote access needs a
   separate decision (reverse proxy vs. binding a non-loopback interface vs. an
   authenticated relay) — nothing here assumes or blocks a particular choice.
2. **Multiple concurrent clients**: the one-worker-per-connection design already
   supports N simultaneous independent conversations (proven above: two connections
   got two distinct pids/sessions) — what's still unbuilt is any shared state, a
   connection cap, or backpressure/rate-limit handling across many simultaneous
   `PersistentWorker`s (spawn.mjs's `RATE_LIMIT_PAUSE`/`RATE_LIMIT_WARN` logic is not
   wired into `PersistentWorker` at all yet).
3. **`--input-format stream-json` wire protocol notes worth keeping**: (a) the
   `system`/`init` `ready` event does not fire until the *first* turn is sent — an
   idle, just-spawned `PersistentWorker` with no turns yet produces no `ready` event
   (observed directly in §4b: the browser-only connection with no message sent never
   received a `ready` frame); (b) `--dangerously-skip-permissions` was carried over
   from `spawn.mjs`'s `Worker.args()` to avoid interactive permission prompts stalling
   a persistent process indefinitely — worth a deliberate decision later about whether
   a live human-facing bridge should instead surface permission prompts to the browser
   UI rather than bypass them; (c) tier-0.5 rot heuristics (fingerprint/loop detection)
   are not wired into `PersistentWorker` — the event shape is compatible but nothing
   currently watches a long-lived bridge session for the runaway patterns `spawn.mjs`'s
   `Worker` already guards against.
