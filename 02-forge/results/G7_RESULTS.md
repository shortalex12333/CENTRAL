# G7 — Secure Tunnel Primitive (Mac Studio → public internet → back to local service)

**Status: PASS**
**Run window:** 2026-08-19 23:02–23:05 UTC
**Host:** Mac Studio (this machine)

## Objective

Prove the "ephemeral cloudflared quick tunnel" primitive works end-to-end — local
service → public `*.trycloudflare.com` URL → back to the local service — using an
entirely throwaway, zero-config, zero-credential setup, with **zero interaction**
with either of this Mac's existing production tunnels:

- `/Users/celeste7/.cloudflared/kenoki.yml` (launchd `com.kenoki.tunnel`, serves live
  traffic at `api.kenoki.app`)
- `/Users/celeste7/.cloudflared/config.yml` (CelesteOS backend, separate live product)

Neither file was edited, and neither associated process/service was started, stopped,
or restarted at any point in this run.

## What was built

A 10-line Node HTTP server returning a fixed JSON body on an unusual local port
(8799), fronted by an anonymous `cloudflared tunnel --url` quick tunnel (no config
file, no DNS, no Cloudflare login/credentials).

`echo_server.js`:

```js
const http = require('http');
const PORT = 8799;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, source: 'central-mvp-echo' }));
});
server.listen(PORT, () => {
  console.log(`G7 echo server listening on :${PORT}`);
});
```

## Important mid-run finding (self-caught, corrected before any risk materialized)

The very first tunnel launch (`cloudflared tunnel --url http://localhost:8799`, run
with the ambient real `$HOME`) printed a `Settings` line showing
`cred-file:/Users/celeste7/.cloudflared/6c8b0aba-....json
credentials-file:/Users/celeste7/.cloudflared/6c8b0aba-....json` — and
`6c8b0aba-17f2-4efd-80cc-27e06fa57422` is **exactly** the `tunnel:` ID declared in
the production `config.yml` (CelesteOS backend). This meant cloudflared's default
config-file lookup (`$HOME/.cloudflared/config.yml`) was silently discovering and
parsing the production config even though `--url` was passed and no `--config` flag
was given.

That process was killed immediately (SIGTERM, confirmed dead) out of caution,
**before any of the 5 round-trip tests ran against it** — no round trips, no public
requests, no data ever flowed through that first process. It never appears in the
"5 round trips" evidence below.

Both subsequent tunnel launches (the two used for the actual evidence in this
report) were run with `HOME` overridden to an empty scratch directory
(`.../scratchpad/g7/isolated_home`, containing no `.cloudflared` subdirectory at
all), which made discovery of `config.yml`/`kenoki.yml`/any credentials file
structurally impossible. Both confirmed this in their own logs:

```
Cannot determine default configuration path. No file [config.yml config.yaml] in
[~/.cloudflared ~/.cloudflare-warp ~/cloudflare-warp /etc/cloudflared /usr/local/etc/cloudflared]
```

and their `Settings` maps contained only `ha-connections`, `protocol`, `url` — no
`cred-file` / `credentials-file` keys. This is the isolation technique used for both
runs reported below. **Takeaway for anyone reusing this pattern: always pass an
isolated `HOME` (or an explicit `--config` pointing somewhere empty) when running a
throwaway `cloudflared` quick tunnel on a machine that also hosts named production
tunnels — do not rely on `--url` alone to skip the default config lookup.**

## Exact commands used

```bash
# 1. Start local echo server
node echo_server.js &            # binds 0.0.0.0:8799

# 2. Launch isolated ephemeral quick tunnel (HOME pointed at an empty scratch dir
#    with no .cloudflared subdir, so it cannot discover any local named-tunnel config)
env HOME=/private/tmp/.../scratchpad/g7/isolated_home \
  cloudflared tunnel --url http://localhost:8799 &

# 3. Curl the PUBLIC URL 5 times, from stderr-parsed https://<random>.trycloudflare.com
curl -s -o body.json -w "HTTP:%{http_code} TIME:%{time_total}" "$URL"

# 4. Kill both (clean restart)
kill -TERM <cloudflared_pid>
kill -TERM <node_pid>

# 5. Repeat 1-2-3 fresh — new random URL, new connector ID

# 6. Final cleanup: kill both again, confirm `lsof -i :8799` empty
```

## Tunnel #1

- **Public URL:** `https://donald-adapters-lived-ratings.trycloudflare.com`
- **Connector ID:** `00f2ffe0-0c7f-4187-b9f1-650aa11e3f7e` (freshly generated, anonymous)
- **Local target:** `http://localhost:8799`

### 5 round trips (public URL → Cloudflare edge → back to localhost:8799)

| # | HTTP | Latency (s) | Body |
|---|------|-------------|------|
| 1 | 200 | 0.420230 | `{"ok":true,"source":"central-mvp-echo"}` |
| 2 | 200 | 0.074957 | `{"ok":true,"source":"central-mvp-echo"}` |
| 3 | 200 | 0.074371 | `{"ok":true,"source":"central-mvp-echo"}` |
| 4 | 200 | 0.075189 | `{"ok":true,"source":"central-mvp-echo"}` |
| 5 | 200 | 0.076758 | `{"ok":true,"source":"central-mvp-echo"}` |

5/5 succeeded, correct JSON body every time. Request 1 pays the cold-start/TLS
handshake cost (~420ms); requests 2-5 settle to a steady ~74-77ms round trip
(client and server co-located on this Mac, but the request still traverses out to
Cloudflare's edge in Miami — `location=mia05` — and back, exercising the real
network path, not a localhost shortcut).

## Clean restart

Both processes SIGTERM'd, confirmed dead via `ps -p <pid>`, port 8799 confirmed free
via `lsof -i :8799`. Both restarted fresh (new node process, new cloudflared process,
same isolated-`HOME` technique).

## Tunnel #2 (post-restart)

- **Public URL:** `https://own-employed-keeps-market.trycloudflare.com` (new random
  URL, as expected — quick tunnels are not persistent/named)
- **Connector ID:** `f08d6ab2-4f6d-4d91-b924-1ec99ddde7fd` (new, different from #1)

### 5 round trips

| # | HTTP | Latency (s) | Body |
|---|------|-------------|------|
| 1 | 200 | 0.403474 | `{"ok":true,"source":"central-mvp-echo"}` |
| 2 | 200 | 0.088900 | `{"ok":true,"source":"central-mvp-echo"}` |
| 3 | 200 | 0.085295 | `{"ok":true,"source":"central-mvp-echo"}` |
| 4 | 200 | 0.169654 | `{"ok":true,"source":"central-mvp-echo"}` |
| 5 | 200 | 0.075245 | `{"ok":true,"source":"central-mvp-echo"}` |

5/5 succeeded, correct JSON body every time — confirms the daemon recovers cleanly
from a full restart and re-establishes a working public tunnel with a fresh identity.

## Final cleanup verification

```
$ lsof -i :8799
CONFIRMED: port 8799 free

$ ps aux | grep -E "echo_server|tunnel --url http://localhost:8799"
none remain - all G7 test processes cleaned up

$ ps aux | grep "kenoki.yml"
celeste7  57605  ...  /opt/homebrew/bin/cloudflared tunnel --config /Users/celeste7/.cloudflared/kenoki.yml run kenoki-api
```

The production kenoki tunnel (pid 57605) ran continuously throughout this entire
exercise, untouched — same pid before and after. `config.yml`'s tunnel
(`6c8b0aba-...`) and the `com.kenoki.tunnel` launchd service were never started,
stopped, restarted, or reconfigured. No `launchctl` command was issued against
either. `kenoki.yml` and `config.yml` were only ever *read* (via `grep`, to verify
the isolation finding above) — never opened for editing, never passed to a
`cloudflared` process this run controlled.

## Explicit scope note

**This proves the tunnel PATTERN only.** Reusing existing inventory (the
`kenoki.app` domain, or the dead `unified-terminal` Vercel project) for a NAMED,
persistent, DNS-backed tunnel is a decision requiring the project owner's explicit
confirmation before touching either live asset — **not attempted here.**

## Files

- `echo_server.js`, tunnel/server logs, round-trip logs, isolated scratch `HOME`:
  `/private/tmp/claude-501/-Users-celeste7/793578bd-a949-4268-8fca-2fc4a6cef123/scratchpad/g7/`
  (session-scoped scratchpad; ephemeral, not part of any tracked repo)
