/**
 * mac_execution_daemon — live browser<->subprocess bridge
 *
 * Minimal WebSocket server. Listens on localhost. On each new WS client connection,
 * spawns ONE new PersistentWorker (one worker per client, never shared/global). Every
 * event the worker emits is JSON-stringified and sent to that specific client. Every
 * text message the client sends over the socket becomes one turn via worker.send().
 * On disconnect, the worker is closed.
 *
 * This is deliberately a dumb pipe — no framing/formatting decisions, no auth, no
 * multi-client fanout. That polish is explicitly out of scope for this proof.
 *
 * Run:  node ws-bridge.mjs            (defaults to port 8791)
 *       node ws-bridge.mjs --port 9000
 */
import { WebSocketServer } from 'ws';
import { PersistentWorker } from './persistent-worker.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 8791));
const ROLE = arg('role', 'probe');

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });

let clientSeq = 0;

wss.on('connection', (ws) => {
  const id = ++clientSeq;
  console.error(`[bridge] client #${id} connected — spawning PersistentWorker (role=${ROLE})`);

  const worker = new PersistentWorker({ role: ROLE });

  const sendToClient = (payload) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  };

  // Forward every worker event to this client, one-to-one.
  worker.on('event',     (ev) => sendToClient({ from: 'worker', kind: 'event', ev }));
  worker.on('ready',     (r)  => sendToClient({ from: 'worker', kind: 'ready', ...r }));
  worker.on('tool',      (t)  => sendToClient({ from: 'worker', kind: 'tool', name: t }));
  worker.on('result',    (r)  => sendToClient({ from: 'worker', kind: 'result', ...r }));
  worker.on('sent',      (t)  => sendToClient({ from: 'worker', kind: 'sent', text: t }));
  worker.on('malformed', (l)  => sendToClient({ from: 'worker', kind: 'malformed', line: l }));
  worker.on('exit',      (s)  => sendToClient({ from: 'worker', kind: 'exit', exitCode: s.exitCode, error: s.error }));

  ws.on('message', (data) => {
    const text = data.toString();
    console.error(`[bridge] client #${id} -> worker: ${JSON.stringify(text)}`);
    try {
      worker.send(text);
    } catch (err) {
      sendToClient({ from: 'bridge', kind: 'error', message: err.message });
    }
  });

  ws.on('close', async () => {
    console.error(`[bridge] client #${id} disconnected — closing worker pid=${worker.state.pid}`);
    await worker.close();
  });

  ws.on('error', (err) => {
    console.error(`[bridge] client #${id} ws error: ${err.message}`);
  });
});

wss.on('listening', () => {
  console.error(`[bridge] listening on ws://127.0.0.1:${PORT} (role=${ROLE})`);
});

wss.on('error', (err) => {
  console.error(`[bridge] server error: ${err.message}`);
  process.exit(1);
});
