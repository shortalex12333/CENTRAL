# TEST REPORT 01 — Execution Layer Feasibility
Date: 2026-08-19 · Seat: CENTRAL · Machine: Apple M2 Max, 96 GB, 12 cores
Claude Code 2.1.236 · node v24.4.1 · ollama 0.21.0
All results below were produced by commands actually run on this machine. Raw NDJSON in `../logs/`.

## Verdict: the architecture's core assumption is SOUND. Three corrections required.

---

## T1 — Headless stream-json multiplexing: **PROVEN**
`claude -p --output-format stream-json --verbose` → exit 0, 16 well-formed NDJSON events, 100% parseable.
`--verbose` is mandatory alongside `-p --output-format stream-json`.

Event types observed: `system/hook_started`, `system/hook_response`, `system/init`,
`system/thinking_tokens`, `assistant`, `rate_limit_event`, `result/success`.

## T2 — Concurrency: **PROVEN, 5.9× speedup**
5 simultaneous spawns → **5/5 succeeded**, distinct `session_id`s, no rate-limit rejection.
Wall clock **6.10 s** vs ~36 s serial. Total cost $0.1142.

## T3 — CARL local supervision: **PROVEN, zero API cost**
Compacted a real 16-event stream to 1,065 bytes (precise state extraction, not a history dump)
and fed it to `qwen3:32b`. Returned valid JSON: `{"rot_detected":false,...,"action":"continue"}` —
the correct verdict. 13.95 s including cold model load. **$0.00.**

---

## FINDING 1 — 🔴 Default spawns are catastrophically fat. Fixed: −48% cost, −95% local CPU.

A default `claude -p` subprocess loads **113 tools and 13 MCP servers** — Gmail, Stripe,
Playwright, Google Calendar, Supabase, Linear — into an agent asked to say one word.
Global `SessionStart` hooks also fire **inside every spawned worker**, injecting irrelevant
plugin context into each one.

This is not a tuning detail. **It is a primary cause of the very context rot CARL exists to fix**,
and it is paid on every single spawn.

| | default spawn | lean spawn | delta |
|---|---|---|---|
| tools loaded | 113 | 30 | −73% |
| MCP servers | 13 | 0 | −100% |
| SessionStart hooks | 3 fired | 0 | eliminated |
| **cost (1-word reply)** | **$0.0402** | **$0.0208** | **−48%** |
| local CPU per spawn | 8.73 s user | 0.44 s user | **−95%** |

**Mandatory worker invocation:**
```
claude -p "<task>" \
  --output-format stream-json --verbose \
  --strict-mcp-config --mcp-config '{"mcpServers":{...role-specific only...}}' \
  --allowedTools "<role-scoped list>" \
  --setting-sources "" \
  < /dev/null
```
`< /dev/null` is not optional — without it every spawn stalls **3 s** waiting on stdin
("no stdin data received in 3s"). At 50 agents that is 150 s of pure dead time.

**Architectural consequence:** the RBAC/permission matrix (custom-build Domain 1) is not
only a governance layer — `--allowedTools` + per-role `--mcp-config` is *also* the cost and
context-hygiene control. One mechanism, three payoffs. Build it early.

## FINDING 2 — 🔴 Rate limits are observable in-stream. And we are at 85% right now.

The blueprint treats provider rate limits as an opaque wall requiring a guesswork throttler.
**They are not opaque.** The CLI emits a first-class event:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed_warning","rateLimitType":"seven_day",
  "utilization":0.85,"surpassedThreshold":0.75,
  "isUsingOverage":false,"resetsAt":1787198400}}
```

Two consequences:

1. **The backpressure controller (Domain 5) gets a real telemetry signal, not a heuristic.**
   Read `utilization`, apply backpressure at threshold, drain the queue before the wall.
   This de-risks the single largest scaling unknown in the plan.
2. **Live constraint: the seven-day window is 85% consumed and past its 0.75 warning
   threshold.** Multiplexing a real workforce on this account *today* will hit the wall.
   Capacity planning is required before scale-up, not after.

## FINDING 3 — 🟡 The result event is free observability. Use it as the daemon's spine.

Every run terminates with a `result` event carrying:
`session_id` · `total_cost_usd` · `duration_ms` · `duration_api_ms` · `ttft_ms` ·
`num_turns` · `stop_reason` · `is_error` · `api_error_status` · `terminal_reason` · `result`

`session_id` is the resumability handle CARL needs for checkpoint/revive.
`num_turns` + `total_cost_usd` are the cheapest possible rot heuristics — no model call needed
to notice an agent burning turns without progressing. **Tier CARL:** free counters first,
local 32B model only on suspicion, cloud model never.

## FINDING 4 — 🟡 Model sizing: 70B is likely over-spec.

Blueprint specifies a quantised 70B for CARL. Pulled locally: `qwen3:32b` (20 GB),
`qwen3.5:27b` (17 GB), plus small Qwens. The 32B produced a correct, well-formed
structured verdict on a real stream. A 70B (~40 GB) would consume roughly half the
machine's unified memory and slow every supervision tick.

Recommendation: **run CARL on qwen3:32b**, keep the headroom for concurrent workers.
Escalate to 70B only if measured verdict quality proves insufficient — that is a test to run,
not an assumption to bake in.

**Implementation note:** `ollama run` emits TTY escape sequences that corrupt piped output.
The daemon must use the **HTTP API (`/api/generate`, `"stream":true`)**, never the CLI.

---

## Environment status
| Component | Status |
|---|---|
| claude 2.1.236 · node v24.4.1 · git · docker · bun | present |
| ollama 0.21.0 + qwen3:32b, qwen3.5:27b, nomic-embed-text | present |
| cloudflared | **present** — tunnel step is unblocked |
| psql / redis-cli clients | present |
| tailscale | absent (cloudflared chosen, not required) |
| uv, pnpm | absent (minor) |
| local Postgres | not running (by design — state lives on Hetzner) |
| local Redis | not running (needed for local dev of the dispatch queue) |

## Immediate next steps
1. Codify the lean-spawn invocation as the daemon's only spawn path — no default spawns, ever.
2. Build the rate-limit backpressure controller against the real `rate_limit_event` signal.
3. Capacity-plan the account before scale-up (85% of seven-day window consumed).
4. Tiered CARL: counters → qwen3:32b via HTTP API → escalate only on evidence.
