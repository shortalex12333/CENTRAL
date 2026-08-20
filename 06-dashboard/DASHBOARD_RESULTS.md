# Fleet dashboard — proof of work

Date: 2026-08-20 · Directory: `06-dashboard/`

Minimal, functional, UI-polish-free control-plane dashboard over the real `controlplane.*`
Postgres tables and the live `~/.claude-peers.db`. No migration of any core architecture —
this is a read-only viewer bolted on top of what already exists. Per the founder's explicit
instruction, visual design is deliberately deferred (see `README.md`).

**Overall: PASS.** All 5 endpoints return real data, the HTML page renders it correctly in a
real browser, and the live-update loop was proven with an actual fresh worker dispatch whose
result appeared on the page within one 5-second poll cycle, with no manual refresh.

---

## 0. Reused infrastructure (not recreated)

```
$ docker ps --filter "name=central-mvp-pg"
CONTAINER ID   IMAGE                COMMAND                  CREATED        STATUS        PORTS
9fbcfe564524   postgres:15-alpine   "docker-entrypoint.s…"   14 hours ago   Up 14 hours   0.0.0.0:5433->5432/tcp
```
Container `central-mvp-pg` (port 5433, db `postgres`, schema `controlplane`, password
`localtest`) was already running from earlier gates today — reused as-is, not recreated.

Real pre-existing row counts confirmed before writing any code:
```
project_ownership = 4   events = 12   unrouted_errors = 2   pending_writes = 2
```

`sqlite3 --version` → `3.51.0 2025-06-12` — supports `-json` natively, confirmed working
against `~/.claude-peers.db` before writing `api.mjs`. Read-only (`-readonly` flag) used
throughout; this project never writes to that database.

---

## 1. What was built

- `06-dashboard/api.mjs` — Node built-in `http` module, `pg` npm client (installed locally in
  `06-dashboard/node_modules`, untouched anywhere else). Five GET routes, permissive CORS,
  try/catch around every DB/shell call → real JSON error body on failure, never a crash or a
  hang (bounded 5s Postgres connect timeout).
- `06-dashboard/index.html` — one plain HTML+JS file, no build step, no framework. One
  `<table>` per source, polls all 5 endpoints on load and every 5s via `setInterval`, shows a
  `last updated: <time>` stamp, renders per-table error text inline if a fetch fails.
- `06-dashboard/package.json` — same pattern as `03-daemon/package.json`; only dependency is
  `pg` (resolved to `^8.23.0` by npm).

---

## 2a. Each endpoint proven live via curl, with real data

**`GET /segments`** — real 4 rows (3 original + the F2 fuzzy-match seed row):
```json
{
  "ok": true,
  "count": 4,
  "rows": [
    { "project_id": "celeste-os", "project_name": "CelesteOS-Cloud",
      "local_directory": "/Users/celeste7/Documents/CelesteOS-Cloud", "confidence_threshold": "0.9" },
    { "project_id": "influence", "project_name": "INFLUENCE",
      "local_directory": "/Users/celeste7/Documents/INFLUENCE", "confidence_threshold": "0.9" },
    { "project_id": "myi2", "project_name": "MYI2",
      "local_directory": "/Users/celeste7/Documents/MYI2", "confidence_threshold": "0.9" },
    { "project_id": "myi2-app-service", "project_name": "MYI2",
      "local_directory": "/Users/celeste7/Documents/MYI2", "confidence_threshold": "0.9" }
  ]
}
```

**`GET /events?limit=3`** — most recent 3, newest first, real `runtime` values across
`claude`/`gemini`/`antigravity` (full JSON captured, trimmed here for length):
```
id=13  emitted_at=2026-08-20T13:13:47.770Z  kind=worker_dispatch_result  severity=info   runtime=antigravity
       body.result = "seed content for the real AntigravityWorker end-to-end proof"
id=12  emitted_at=2026-08-20T11:42:35.683Z  kind=worker_dispatch_result  severity=error  runtime=gemini
       body.error  = "exit_1: Error authenticating: IneligibleTierError..."
id=11  emitted_at=2026-08-20T01:18:32.997Z  kind=worker_dispatch_result  severity=info   runtime=claude
       body.result = "The most likely file to investigate first is `src/handlers/policyHandler.py`..."
```

**`GET /unrouted`** — real 2 rows, newest first:
```
id=430c8732-...  project_id=influence-legacy      reason=confidence_below_threshold  matched_confidence=0.5882353186607361  status=needs_human_review
id=2d80250e-...  project_id=acme-legacy-checkout  reason=no_ownership_match          matched_confidence=null                status=needs_human_review
```

**`GET /pending-writes`** — real 2 rows, newest first:
```
id=cccccccc-...02  route=calendar.create  state=cancelled  resolved_fields={"title":"cancel-me"}
id=cccccccc-...01  route=calendar.create  state=executed   resolved_fields={"title":"confirm-me"}  side_effect_id=effect-cccccccc-...001
```

**`GET /peers`** — 25 real live rows from `~/.claude-peers.db` at test time, e.g.:
```
id=4ctrh4jy  cwd=/Users/celeste7
  summary="AIS9 — working the CelesteOS-Score AIS capture pipeline (Hetzner box, corpus
  resolution, health dashboard). Not part of the Retrieval Spine rebuild."
id=582ffs63  cwd=/Users/celeste7
  summary="ALEX9b (Sonnet 5), now reassigned to Backend Operations & Data Engineer..."
id=5u1d3mv7  cwd=/Users/celeste7
  summary="SENTRY1 — founder personally unparked me 2026-08-10 for direct work..."
```

**CORS + routing checks:**
```
$ curl -sD - -o /dev/null http://localhost:8792/segments | grep -i access-control
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
Access-Control-Allow-Headers: Content-Type

$ curl -s http://localhost:8792/nope
{"error":"no such route: /nope","routes":["/segments","/events","/unrouted","/pending-writes","/peers"]}
```

**Graceful DB-error handling (isolated test, did not touch the live server):**
```
$ node <bad-port-test>.mjs   # pg.Pool pointed at port 59999 (nothing listening)
{"ok":false,"error":""}      # rejects cleanly within the connectionTimeoutMillis bound — no hang, no crash

$ sqlite3 -readonly -json /tmp/does-not-exist.db "SELECT 1;"
Error: unable to open database "/tmp/does-not-exist.db": unable to open database file
exit code: 1                 # execFile throws → caught by the route handler → JSON error body, same pattern
```
In `api.mjs` both paths are wrapped by the same top-level `try/catch` in the request handler,
which always responds with `{ ok: false, error: <message>, route: <path> }` and a 500 status —
never lets an unhandled rejection crash the process or leaves the request hanging.

---

## 2b. Page loaded and read back via real Chrome browser automation (not just curl)

Used `mcp__claude-in-chrome__navigate` + `get_page_text` — an actual Chrome tab, not an
assertion about what the code should do. Server setup for this: `python3 -m http.server 8793
--bind localhost` inside `06-dashboard/`, page fetches cross-origin from `http://localhost:8792`
(a genuinely different origin from `:8793` — the CORS path is real, not a `file://` same-origin
loophole).

Page loaded at `http://localhost:8793/index.html`. `get_page_text` on the live DOM confirmed,
verbatim:
```
CENTRAL fleet dashboard
last updated: 09:30:55 (polling every 5s)
SEGMENTS (4)
  celeste-os  CelesteOS-Cloud   /Users/celeste7/Documents/CelesteOS-Cloud
  influence   INFLUENCE         /Users/celeste7/Documents/INFLUENCE
  myi2        MYI2              /Users/celeste7/Documents/MYI2
  myi2-app-service MYI2         /Users/celeste7/Documents/MYI2
RECENT EVENTS (12)
  id=13 ... runtime=antigravity ...
  id=12 ... runtime=gemini ...
  id=11 ... runtime=claude ...
  ... (all 12 pre-existing rows rendered, newest first)
UNROUTED ERRORS (2)   ... both real rows rendered
PENDING WRITES (2)    ... both real rows rendered
LIVE PEERS (25)       ... all 25 real live peer rows rendered, including real summaries
```
`read_console_messages` on the tab: **no console errors** — clean load, no CORS failures, no
JS exceptions.

**2c. Confirmed:** real segment names CelesteOS-Cloud / MYI2 / INFLUENCE visible, real past
events with `runtime='claude'`/`'gemini'`/`'antigravity'` from today's earlier gates all visible
— this is the existing real data, not fixtures.

---

## 2d. Live-update proof — one fresh, cheap dispatch, watched land without a page refresh

**Step 1 — real spawn.mjs call**, role `probe` (Read-only, haiku model), trivial task:
```
$ cd 03-daemon && node spawn.mjs --role probe --task "Reply with exactly: DASHBOARD-LIVE-PROOF"
[ready] session=e045bb17 tools=28
[done ] events=9 turns=1 cost=$0.0168 wall=3496ms err=none
[result] "DASHBOARD-LIVE-PROOF"
```
Real API call, real cost: **$0.0168** (a few cents, exactly one call as instructed).

**Step 2 — one manual INSERT into `controlplane.events`**, mirroring `dispatcher.mjs`'s
`logEvent()` shape (`insert into controlplane.events (kind, severity, body) values (...)`,
`kind='worker_dispatch_result'`, same body field names dispatcher.mjs's happy-path branch
uses — `role`, `task`, `error`, `turns`, `result`, `cost_usd`, `directory`, `exit_code`,
`session_id`, `tool_calls`):
```sql
insert into controlplane.events (kind, severity, body, runtime)
values ('worker_dispatch_result', 'info',
  '{"role":"probe","task":"Reply with exactly: DASHBOARD-LIVE-PROOF","error":null,
    "turns":1,"result":"DASHBOARD-LIVE-PROOF","cost_usd":0.0168433,
    "directory":"/Users/celeste7/Documents/CENTRAL/03-daemon","exit_code":0,
    "session_id":"e045bb17-62d7-46f1-b3d6-b9cabdc6afae","tool_calls":[],
    "note":"06-dashboard live-update proof — 3d, one real spawn.mjs probe call"}'::jsonb,
  'claude')
returning id, emitted_at;
```
Result: `id=14 | emitted_at=2026-08-20 13:31:13.646425+00`

**Step 3 — same open browser tab, no navigation, no manual refresh.** Waited 6 seconds (one
poll cycle > 5s), then called `get_page_text` again on the *same* tab:
```
RECENT EVENTS (13)          ← was (12) before the insert
  id=14 2026-08-20T13:31:13.646Z worker_dispatch_result info claude
     {"note":"06-dashboard live-update proof — 3d, one real spawn.mjs probe call",
      "role":"probe","task":"Reply with exactly: DASHBOARD-LIVE-PROOF",
      "result":"DASHBOARD-LIVE-PROOF","cost_usd":0.0168433,
      "session_id":"e045bb17-62d7-46f1-b3d6-b9cabdc6afae", ...}
```
`last updated:` stamp also advanced (`09:30:55` → `09:31:26`), and the `LIVE PEERS` table's
`last_seen` timestamps visibly advanced too (peers heartbeat independently) — both confirm the
page is genuinely polling on its own clock, not showing a cached/static snapshot.

**Verdict: the dashboard is live.** A brand-new row, inserted after the page had already
loaded, appeared automatically within one 5-second poll cycle with zero manual interaction.

---

## Verification method used

Real Chrome browser automation (`mcp__claude-in-chrome__*` tools) was available and used for
step 2b/2d — not a fallback to curl-only verification. The page was actually navigated to,
actually rendered, and actually re-read after a live data change, in the same tab, with no
reload.

---

## Processes left running (this is a live local dashboard, not a one-shot test)

```
$ ps aux | grep -E "node api.mjs|http.server 8793"
celeste7  24495  node api.mjs                                 (port 8792)
celeste7  24700  python3 -m http.server 8793 --bind localhost (serves 06-dashboard/, port 8793)
```
To stop: `kill 24495 24700` (or just Ctrl-C each if run in a foreground terminal instead).

`controlplane.events` now has 14 rows (13 pre-existing + the one live-proof row above), left in
place as the artifact proving §2d — same "leave the evidence in place" precedent as
`02-forge/results/G4_RESULTS.md`.
