/**
 * CENTRAL fleet dashboard — tiny read-only API.
 *
 * Deliberately plain: Node's built-in `http` module, no framework. Five GET endpoints,
 * each a straight SELECT against the real `controlplane.*` tables in the already-running
 * `central-mvp-pg` docker container (localhost:5433, db `postgres`, schema `controlplane`
 * — see 02-forge/results/G4_RESULTS.md), plus one endpoint that shells out to the
 * read-only `sqlite3` CLI against the live `~/.claude-peers.db` (WAL-mode, other real
 * sessions depend on it — this process only ever SELECTs from it, never writes).
 *
 * No auth, no build step, no ORM. This is the "final job is UX polish, not now" MVP the
 * founder asked for — see 06-dashboard/README.md for what's explicitly deferred.
 *
 * Run:  node api.mjs [--port 8792]
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const execFileP = promisify(execFile);

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
}

const PORT = Number(arg('port', process.env.PORT || 8792));
const PEERS_DB = path.join(os.homedir(), '.claude-peers.db');

// ---- Postgres pool -----------------------------------------------------------
// Same connection shape as every other gate today (02-forge/results/G4_RESULTS.md):
// host=localhost port=5433 user=postgres password=localtest db=postgres, schema=controlplane.
// Local-only container, deliberately plaintext password (matches the rest of this repo's
// SQL files — 'localtest' is the known-safe throwaway credential, not a real secret).
const pool = new pg.Pool({
  host: 'localhost',
  port: 5433,
  user: 'postgres',
  password: 'localtest',
  database: 'postgres',
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});
pool.on('error', (err) => {
  // A background idle-client error must never crash this process — log and keep serving.
  console.error('[pg pool] background error (non-fatal):', err.message);
});

async function pgQuery(sql, params = []) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows;
  } finally {
    client.release();
  }
}

// ---- claude-peers.db (read-only, via the sqlite3 CLI) ------------------------
// `sqlite3 --version` confirmed 3.51.0 on this machine, which supports `-json`.
// `-readonly` on top of that as belt-and-suspenders — this process must never be the one
// that writes to a live, other-sessions-depend-on-it WAL database.
async function readPeers() {
  const sql = 'SELECT id, cwd, summary, last_seen, has_channel FROM peers ORDER BY last_seen DESC;';
  const { stdout } = await execFileP('sqlite3', ['-readonly', '-json', PEERS_DB, sql]);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

// ---- tiny router ---------------------------------------------------------------
const ROUTES = {
  '/segments': async () => pgQuery('SELECT * FROM controlplane.project_ownership ORDER BY project_id;'),

  '/events': async (query) => {
    const limitRaw = Number(query.get('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
    return pgQuery('SELECT * FROM controlplane.events ORDER BY emitted_at DESC LIMIT $1;', [limit]);
  },

  '/unrouted': async () => pgQuery('SELECT * FROM controlplane.unrouted_errors ORDER BY received_at DESC;'),

  '/pending-writes': async () => pgQuery('SELECT * FROM controlplane.pending_writes ORDER BY created_at DESC;'),

  '/peers': async () => readPeers(),
};

function send(res, status, body) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    // CORS preflight — no body needed.
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    send(res, 405, { error: `method not allowed: ${req.method}` });
    return;
  }

  const handler = ROUTES[url.pathname];
  if (!handler) {
    send(res, 404, {
      error: `no such route: ${url.pathname}`,
      routes: Object.keys(ROUTES),
    });
    return;
  }

  try {
    const rows = await handler(url.searchParams);
    send(res, 200, { ok: true, count: Array.isArray(rows) ? rows.length : undefined, rows });
  } catch (err) {
    // Never crash, never hang — always a real JSON error body with a message.
    console.error(`[api] ${url.pathname} failed:`, err.message);
    send(res, 500, { ok: false, error: err.message, route: url.pathname });
  }
});

server.listen(PORT, 'localhost', () => {
  console.log(`[api] listening on http://localhost:${PORT}`);
  console.log(`[api] routes: ${Object.keys(ROUTES).join(', ')}`);
});

process.on('SIGINT', async () => {
  console.log('\n[api] shutting down...');
  await pool.end();
  server.close(() => process.exit(0));
});
