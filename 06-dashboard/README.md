# CENTRAL fleet dashboard

A minimal, read-only viewer over the real `controlplane.*` Postgres tables (in the already
-running `central-mvp-pg` docker container) and the live `~/.claude-peers.db`. Built to show
real data working end to end — not a design exercise. See `DASHBOARD_RESULTS.md` for the full
proof (real curl output, real browser render, and a real live-update proof).

## Run it — two commands

```bash
# 1. Start the API (from 06-dashboard/, after `npm install` once)
node api.mjs                              # listens on http://localhost:8792

# 2. Serve the static page (from 06-dashboard/, in a second terminal)
python3 -m http.server 8793 --bind localhost
# then open http://localhost:8793/index.html in a browser
```

Use a static server rather than `file://` — the page fetches cross-origin from
`http://localhost:8792`, and while the API sends permissive CORS headers, some browsers
restrict `fetch()` from a `file://` origin regardless of the response headers. A one-line
`python3 -m http.server` avoids that entirely and needs nothing installed.

Prerequisites already assumed running (not started by this dashboard):
- docker container `central-mvp-pg` (port 5433, db `postgres`, schema `controlplane`)
- the `sqlite3` CLI (used read-only against `~/.claude-peers.db`)

## What this is

- `api.mjs` — Node's built-in `http` module + the `pg` client. Five GET endpoints
  (`/segments`, `/events`, `/unrouted`, `/pending-writes`, `/peers`), each a straight
  read against real data. Permissive CORS. Every DB/shell call is wrapped so a failure
  returns a real JSON error body — it never crashes the process or hangs a request.
- `index.html` — one plain HTML+JS file, no build step, no framework, no CSS beyond a
  monospace font and table borders. Polls all five endpoints on load and every 5 seconds,
  re-renders each table, and shows a `last updated: <time>` stamp so it's visibly live.

## Deliberately NOT included (per the founder's "final job is UX polish" instruction)

- **No auth.** Anyone who can reach `localhost:8792` can read everything. Fine for a
  local-only Mac Studio control plane; not fine to expose past localhost as-is.
- **No tunnel / no remote exposure.** This binds to `localhost` only, on purpose.
- **No WebSocket / no live-push.** Updates arrive via 5-second polling
  (`setInterval` + `fetch`), not a push channel. Simple, and good enough for this MVP —
  a WebSocket upgrade is a separate, later piece of work if ever needed.
- **No visual design.** Monospace font, plain borders, dark background for contrast —
  that's the entire design budget, spent deliberately. Not a placeholder for something
  prettier to come later in this same file; a real redesign is its own future task.
- **No embedding of the separate live-terminal bridge** (`03-daemon/ws-bridge.mjs`) —
  that stays its own thing, reachable separately, not iframed or proxied in here.
- **No embedding of the separate ontology graph page** (the INFLUENCE dashboards under
  `Documents/INFLUENCE/05-build/`) — unrelated project, not pulled into this view.
- **No write endpoints.** Every route in `api.mjs` is a `SELECT`. This dashboard cannot
  approve a pending write, dismiss an unrouted error, or mutate anything — it only shows
  what's there.
