/**
 * G5 — local synthetic Sentry-shaped ingest endpoint.
 *
 * Zero real Sentry involvement. Accepts a POST with a fake Sentry-shaped error payload,
 * validates it minimally, strips it to the fields the dispatcher needs, and LPUSHes it as a
 * JSON string onto the local Redis list `errors:incoming` (central-mvp-redis, port 6380).
 *
 * Plain Node `http` — no Express, nothing to `npm install` for a script this small.
 * Redis write goes through `redis-cli` via execFile (argv array, no shell interpolation —
 * safe even if the payload contains quotes/newlines), not a Node redis client library
 * (none was installed in this project; this avoids adding a dependency for one LPUSH).
 *
 * Run:  node ingest.mjs [--port 8899]
 * Send: curl -s -X POST http://localhost:8899/ingest -H 'content-type: application/json' \
 *         -d '{"project_id":"celeste-os","culprit":"...","exception_type":"...", ...}'
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const REDIS_PORT = 6380;
const REDIS_LIST = 'errors:incoming';

function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
}
const PORT = Number(arg('port', '8899'));

const REQUIRED_FIELDS = ['project_id', 'culprit', 'exception_type', 'exception_value'];

async function lpush(jsonString) {
  const { stdout } = await execFileP('redis-cli', ['-p', String(REDIS_PORT), 'LPUSH', REDIS_LIST, jsonString]);
  return stdout.trim(); // new list length, as text
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { req.destroy(); reject(new Error('payload too large')); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'g5-ingest', redis_port: REDIS_PORT, list: REDIS_LIST }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/ingest') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    return;
  }

  try {
    const raw = await readBody(req);
    let payload;
    try { payload = JSON.parse(raw); }
    catch { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'invalid_json' })); return; }

    const missing = REQUIRED_FIELDS.filter((f) => !(f in payload));
    if (missing.length) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing_fields', missing }));
      return;
    }

    // Strip down to exactly the fields the dispatcher needs — minimal Sentry-shaped subset.
    const stripped = {
      project_id: String(payload.project_id),
      culprit: String(payload.culprit),
      exception_type: String(payload.exception_type),
      exception_value: String(payload.exception_value),
      stack_frames: Array.isArray(payload.stack_frames) ? payload.stack_frames : [],
      received_at: new Date().toISOString(),
    };

    const jsonString = JSON.stringify(stripped);
    const newLen = await lpush(jsonString);

    console.log(`[ingest] queued project_id=${stripped.project_id} culprit=${stripped.culprit} → ${REDIS_LIST} (len=${newLen})`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, queued: true, list: REDIS_LIST, list_len_after_push: Number(newLen) }));
  } catch (err) {
    console.error('[ingest] error', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ingest] listening on http://127.0.0.1:${PORT}  POST /ingest, GET /health`);
  console.log(`[ingest] pushes to redis list "${REDIS_LIST}" on port ${REDIS_PORT}`);
});
