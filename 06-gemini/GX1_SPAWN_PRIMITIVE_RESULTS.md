# GX1 — Gemini CLI Spawn Primitive: Foundational Gate

Date: 2026-08-20 (calls made 2026-08-19 → 2026-08-20) · Seat: CENTRAL · Machine: Apple M2 Max, 96 GB, macOS 26.4.1
Gemini CLI **0.55.1** (globally installed) and **0.56.0** (fetched fresh via `npx @google/gemini-cli@latest`, both tested) · node v24.4.1
Auth on this machine: Google account `celeste7ltd@gmail.com` via `oauth-personal`. No `GEMINI_API_KEY`/`GOOGLE_API_KEY` present.
Raw stdout/stderr for every call in `../logs/gemini/`. **11 real `gemini` process invocations were made. Zero reached the model. Zero dollars spent.**

## Verdict: GATE FAILS. Not a code problem — this Google account's tier is rejected by the gemini-cli client outright.

---

## T1 — Auth/billing model: **DETERMINED, and it's currently BROKEN**

`~/.gemini/settings.json` → `security.auth.selectedType: "oauth-personal"`. This is Google-account login
(`~/.gemini/google_accounts.json` → `active: "celeste7ltd@gmail.com"`), backed by an OAuth token
(`~/.gemini/oauth_creds.json`, keys present: `access_token, refresh_token, scope, token_type, id_token, expiry_date` —
values not printed). **No API key anywhere**: `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_GENERATIVE_AI_API_KEY` are unset
in the environment and were not found in any reachable dotenv file on the machine.

The installed bundle confirms three real, mutually-exclusive auth types exist in this client
(`AuthType.LOGIN_WITH_GOOGLE`, `AuthType.USE_GEMINI` ← triggered by `GEMINI_API_KEY`, `AuthType.USE_VERTEX_AI`
← triggered by `GOOGLE_CLOUD_PROJECT`/ADC). So the underlying premise of the check is correct: **Gemini's billing
model is a genuinely separate account/quota system from Claude's** — a real capacity-spreading argument, in principle.

**In practice, on this machine, right now, it does not work.** The very first real call failed before touching the model:

```
Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for
individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google
  ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT', tierId: 'free-tier',
                       tierName: 'Gemini Code Assist for individuals' }]
```

This is **not a version bug** — I re-ran the identical prompt through `npx @google/gemini-cli@latest` (resolved to
0.56.0, a separately-fetched, newer bundle than the global 0.55.1) and got the byte-for-byte identical
`IneligibleTierError`. It is a server-side account-tier decision: the free "Gemini Code Assist for individuals" tier
that this Google account is on has been sunset for the standalone `gemini` CLI client, full stop, and the CLI is
telling users to move to the Antigravity product instead. `which antigravity` → not found on this machine (only
Antigravity's config directories exist under `~/.gemini/antigravity*`, no installed binary).

After ~8 more invocations in the same 2-minute window, the error signature changed to a distinct, separate failure:

```
Error: Resource has been exhausted (e.g. check quota). code: 429, status: 'RESOURCE_EXHAUSTED'
url: 'https://cloudcode-pa.googleapis.com/v1internal:onboardUser'
```

So there are *two* stacked blockers on this account: (1) the tier itself is rejected by the client, and (2) even the
pre-flight `onboardUser` handshake that produces error (1) is itself rate-limited — it started 429'ing after roughly
8 repeated attempts inside ~2 minutes. Neither error is a model-inference charge; the model was never reached.

## T2 — Headless spawn + stream-json parity: **BLOCKED. 0/11 calls produced any output.**

`gemini --help` confirms the real flag: `-o, --output-format` with choices `text | json | stream-json` (not
`--output-format` as a guessed long-only flag — both `-o` and `--output-format` work; I used `-o stream-json`).

Command run verbatim: `gemini -p "Reply with exactly: PONG" -o stream-json --allowed-mcp-server-names __none__ < /dev/null`

**stdout was 0 bytes in every single attempt** (`T1_default_stream_json.ndjson`, `T3_default_timed.log`,
`T3_scoped_timed.log`, all 5 `concurrency/c*.out` — verified with `wc -c`, all report `0`). No `--output-format
stream-json` framing was ever emitted because the process throws an *unhandled* JS exception (raw Node stack trace,
to stderr, not JSON) before it ever reaches the point of writing a first event. There is consequently:
- **no event schema to compare to Claude's** (`type`/`subtype`, `system/init`, `assistant`, `result`) — never observed
- **no `session_id`** ever printed
- **no `rate_limit_event`-equivalent telemetry** — the only rate-limit signal seen was a raw HTTP 429 JS exception on
  an internal onboarding endpoint, not a structured in-stream event a caller could parse and act on
- **no cost/result event** — nothing resembling `total_cost_usd`/`duration_ms`/`num_turns`

This is a hard, falsifiable finding: as currently configured, Gemini CLI headless mode cannot be integrated as a
second runtime using the stream-json contract CENTRAL's daemon expects, because it never produces stream-json at all
under this auth state.

## T3 — Lean invocation / default overhead: **PROVEN real overhead exists, even though every call fails**

`gemini mcp list` (real output, not from docs) shows **13 configured MCP servers** on this machine: `supabase`,
`linear` (both from `settings.json`, both showed `Disconnected`), plus 11 more from a "data-agent-kit" (`dak`)
extension — `notebook`, `visualization`, `bigquery`, `spanner`, `alloydb-postgres-admin`, `alloydb-postgres`,
`cloud-sql-postgresql-admin`, `cloud-sql-postgresql`, `knowledge_catalog`, `dataproc`, `serverless-spark`,
`bigtable` — 5 of those `Connected`. Separately, `~/.gemini/config/mcp_config.json` configures 4 more non-disabled
servers (`claude-peers`, `github`, `linear`, `supabase`, `visualization`, `data-agent-kit` proxies) that a bare
`gemini -p` will attempt to reach. **This is the same shape of finding as Claude's "113 tools / 13 MCP servers"** —
a one-word headless prompt pulls in a full, unscoped MCP surface by default.

The flag exists to fix it: `--allowed-mcp-server-names` (confirmed in `gemini --help`, plural/array). Real,
measured, timed (`/usr/bin/time -p`) comparison of the exact same failing prompt:

| | default invocation | `--allowed-mcp-server-names __none__` | delta |
|---|---|---|---|
| wall clock | **5.08 s** | **2.21 s** | **−56%** |
| user CPU | **16.40 s** | **1.08 s** | **−93%** |
| sys CPU | 6.14 s | 0.10 s | −98% |

Both invocations fail identically on auth — this is pure MCP-connection overhead being paid (and then discarded)
before the auth error ever fires, on every default spawn. The magnitude (16.4 s → 1.1 s user CPU) is even more
extreme than Claude's 8.73 s → 0.44 s in TEST_REPORT_01, because several of these MCP servers are live remote HTTP
endpoints (`mcp.supabase.com`, `mcp.linear.app`) and several more are local `npx`-fetched stdio servers that must be
resolved/spawned every time.

🔴 **Secondary finding, flagged not detailed:** `~/.gemini/config/mcp_config.json` contains a **live plaintext GitHub
PAT and a live plaintext Vercel bearer token** as `env`/`headers` values for the `github` and `vercel` MCP entries.
Per standing policy this report does not reproduce the values. This is a real credential-hygiene issue independent
of the Gemini-as-runtime question and should be rotated/moved to a secret store — flagged as a follow-up, not
fixed here (out of this gate's scope).

## T4 — Concurrency: **Process-level concurrency PROVEN. API-level concurrency UNVERIFIABLE (never got past auth).**

5 simultaneous `gemini -p "Reply with exactly: PONG-$i" -o stream-json --allowed-mcp-server-names __none__` as
background shell jobs, same pattern as the original Claude test. Real measured wall clock: **2.40 s** for all 5,
essentially identical to the 2.21 s a single scoped call took — i.e. 5 processes ran in ~1.09× the time of 1, so the
OS/process layer parallelizes cleanly with no observed lock contention or serialization. **5/5 exited (code 1)** —
all 5 failed, all in the same 2.4 s window, no hang, no deadlock.

What could **not** be confirmed: "distinct session identifiers" per the task's own success condition — because no
call ever reached the point of emitting a `session_id` (0 bytes stdout on all 5, as in T2). So the concurrency
primitive (spawn N processes, they don't block each other, they don't crash the host) is real and works; the
API-level claim (N independent authenticated sessions) is not verifiable from this account today.

## T5 — `--session-id`/`--resume`: **BLOCKED, could not be tested**

`--session-id <uuid>` (generated fresh) telling the model "My favorite number is 42" → failed at the same
`onboardUser` step (this attempt is the one that had already flipped to `429 RESOURCE_EXHAUSTED`, per T1). A
follow-up `--resume latest` asking "What is my favorite number?" failed identically. `gemini --list-sessions` also
failed with the same 429 against `cloudcode-pa.googleapis.com`. No fact was ever told to the model, so recall could
not be tested in either direction. The flags exist and are real (`-r/--resume`, `--session-id`, `--session-file`,
`--list-sessions`, `--delete-session` all present in `--help`) but none could be exercised end-to-end.

---

## Verdict table

| Check | Result | Evidence |
|---|---|---|
| T1 Auth model determined | ✅ oauth-personal, Google account, separate quota pool from Claude | `settings.json`, bundle `AuthType` enum |
| T1 Auth **works** | ❌ FAILS | `IneligibleTierError` (UNSUPPORTED_CLIENT), then `429 RESOURCE_EXHAUSTED` |
| T2 stream-json parseable | ❌ FAILS — 0 bytes stdout on 11/11 calls | `wc -c` on every log file |
| T2 schema parity to Claude | ❌ Cannot compare — no schema ever emitted | same |
| T2 rate-limit telemetry | 🟡 Present but unstructured (raw HTTP 429 exception, not an in-stream event) | `c1.err`, `c3.err` |
| T3 default spawn is fat | ✅ CONFIRMED, real MCP overhead | 5.08s/16.40s CPU → 2.21s/1.08s CPU with scoping |
| T3 scoping flag exists & works | ✅ `--allowed-mcp-server-names` | measured delta above |
| T4 process concurrency | ✅ 5/5 ran in parallel, 2.40s for 5 vs 2.21s for 1 | `concurrency/c*.exit` |
| T4 distinct session IDs | ❌ Unverifiable — no session ever created | 0 bytes stdout |
| T5 session persistence | ❌ Unverifiable — blocked before first turn | `T5_session_set.log`, `T5_resume.log` |

**Gate condition ("pass iff stream-json genuinely parseable AND concurrency works"): FAILS.** Stream-json was never
produced once. Concurrency works only at the OS-process level, not at the level the gate cares about (independent
authenticated sessions).

---

## Environment status

| Component | Status |
|---|---|
| `gemini` 0.55.1 at `/opt/homebrew/bin/gemini` | present, symlinked into `@google/gemini-cli` npm bundle |
| `@google/gemini-cli@latest` (0.56.0) via `npx` | present, tested, **identical failure** — rules out a local-version bug |
| Auth: `oauth-personal` / `celeste7ltd@gmail.com` | present but **tier rejected by client** (`free-tier` / "Gemini Code Assist for individuals") |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` (alternate auth path) | **absent** — not set, not found in any dotenv on disk |
| `GOOGLE_CLOUD_PROJECT` / Vertex AI ADC (alternate auth path) | not checked — out of scope for "what's already configured" |
| Antigravity CLI/binary (the product the error tells users to migrate to) | **not installed** (`which antigravity` → not found); only config dirs exist |
| `gemini mcp list` | 13 servers configured, 5 connected, 8 disconnected at rest |
| `~/.gemini/config/mcp_config.json` | contains 2 live plaintext credentials (GitHub PAT, Vercel bearer token) — flagged, not detailed |

## Immediate next steps

1. **This is a provisioning problem, not an integration problem.** Before any further Gemini-runtime work: either
   (a) get a `GEMINI_API_KEY` from Google AI Studio (pay-per-token, `USE_GEMINI` auth path — bundle confirms this
   path exists and is independent of the broken oauth-personal free tier), or (b) upgrade the Google account to a
   paid Code Assist / Gemini API tier, or (c) evaluate whether Antigravity (the product the CLI itself points to)
   has its own headless/CLI spawn primitive that could substitute for `gemini -p` entirely — none of this was
   testable today because no working auth existed.
2. Once *any* auth path succeeds, re-run T2 (schema capture), T4 (real distinct-session concurrency), and T5
   (session recall) — none of the flags or command shapes need re-verification, only a live credential.
3. Rotate the plaintext GitHub PAT and Vercel bearer token currently sitting in `~/.gemini/config/mcp_config.json`
   — independent of the Gemini-runtime decision, this is a live credential-exposure issue on this machine.
4. If a `GEMINI_API_KEY` is obtained, mirror T3's `--allowed-mcp-server-names` finding into the mandatory lean-spawn
   invocation the same way TEST_REPORT_01 did for Claude's `--strict-mcp-config`/`--allowedTools` — the scoping
   flag is real and the overhead it removes (93% of user CPU on this measurement) is even larger than Claude's.
