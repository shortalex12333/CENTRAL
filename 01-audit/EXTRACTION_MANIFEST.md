# Phase 2 — Legacy Audit: Extraction Manifest
Date: 2026-08-19 · Read-only audit, nothing modified · Seat: CENTRAL

Two targets audited. One rejected outright. One holds a genuinely valuable core.

---

# A. `unified-terminal` → **REJECT**

Not a prior control plane. It is the Vercel deploy root for kenoki.app: a compiled JARVIS
chat SPA, a vis-network contact graph, and 23 serverless files that are `fetch()` proxies to
a remote runner.

| Gate | Result |
|---|---|
| spawns CLI | ❌ zero `child_process` imports repo-wide |
| stream-json | ❌ SSE + Ollama NDJSON only; zero hits for `tool_use` / `session_id` |
| MCP / Code Mode | ❌ zero occurrences of "mcp" in the non-build tree |

Disqualifying beyond the gates: the Next.js cockpit exists **only as ~5.5 MB of Turbopack
output — no source, no `package.json`, no `app/`**. You cannot build on a build artifact.
`maxDuration: 60` on Vercel serverless is structurally incompatible with supervising
long-lived `claude -p` subprocesses. Dead since 2026-06-06; its own pressure-test doc
concluded it needs a rewrite, not features.

**Salvage: nothing.** Two files worth a 5-minute read as reference (`kenoki/app.js:36`
NDJSON line-buffer with correct partial-final-line handling; `api/confirm.js:2` approval-gate
contract shape). Do not import.

---

# B. `JARVIS` → **HARVEST — high value, tightly scoped**

3,991 MB on disk but **3,963 MB is vendored** (.venv ×3, node_modules, whisper/bge weights).
Real source is **~28 MB**: ~170 Python, 18 TS, 25 SQL. A small dense repo wearing a large coat.

Not its own git repo — an untracked subtree inside the home repo. Only 4 files tracked.
Everything below exists **only on this disk, unversioned**.

## B1. 🏆 The crown jewel — a complete agent-authority ontology in ~400 lines of pure data

The brief asked for "hierarchical topology definitions" and expected an org chart. What
exists is better: a **declarative topology that is simultaneously the documentation and the
live routing table**. A UI rendering these three files renders the running system, not a
drawing of it. **If only three files survive this audit, these are the three.**

| File | Lines | What it encodes |
|---|---|---|
| `jarvis-runner/src/jarvis_runner/extraction/term_groups.py` | 18-159 | 11 domains × 7 verb classes → 6 execution lanes → per-cell data scope. Four-level parent/child hierarchy, zero code. Renders directly: domains as parent nodes, verb-cells as children, lanes as colour, table sets as leaf edges. |
| `jarvis-runner/src/jarvis_runner/action_class.py` | 22-129 | **The permission matrix.** Two orthogonal axes — confidence × consequence — composed through an explicit 9-cell `GATE_MATRIX` (84-94). Tier promotions are *monotonic*: they can only raise (25-31). Invariant cell at 87: `('high','write_external') → 'confirm'` — **confidence can never buy past consequence**. |
| `jarvis-runner/src/jarvis_runner/route_specs.py` | 20-144 | Per-route JSON Schema + promotion rules. "Adding a route = one entry, zero classifier changes." Key idea: **consequence is a function of the DATA, not just the intent** — any `attendees` value promotes read→write_external (113). |

Supporting: `extraction/rails.py:16-88` — deterministic <5 ms resolver, no model call, keeps
genuine ties as `candidate_whats` so ambiguity escalates instead of being silently resolved,
and computes a token-coverage ratio as an honest "do I actually understand this" gate.

**Port these near-unchanged. Rename domains to agent departments; the structure survives.**

## B2. Two orthogonal safety layers — the repo's best structural idea

Writes are constrained **twice, independently**, and neither layer trusts the other:

- **Python:** `capabilities/supabase_write.py:69-140` — default-deny table *and column*
  allowlist. Five stated invariants: eq-only filters (never `ilike`, which silently turns an
  UPDATE into a mass-update); UPDATE must match exactly one row via a before-image SELECT;
  no DELETE exposed at all. Two Supabase clients at two privilege levels (50-57) — **the
  component that stages approvals is not writable by the component that does the work**.
- **Postgres:** `sql/014_ai_writer_role.sql:23-90` — dedicated `kenoki_ai_writer` role,
  column-level `GRANT UPDATE (col,…)`, explicit `REVOKE delete, truncate, references, trigger`.
  A prompt injection defeating the Python layer still hits the database role.

Port both. Write the parity test that `014`'s header comment (line 12) only asks for.

## B3. Schema — the control-plane state model, largely already written

| File | Lines | Asset |
|---|---|---|
| `jarvis-runner/sql/001_init.sql` | 8-136 | `capabilities` (self-describing tool registry w/ JSON-Schema contracts + `provider.resource.verb` CHECK at 55-57), `events` (append-only audit + duration_ms), `items` (durable queue w/ status enum), `mcp_registry` (secret_ref **pointer**, not value) |
| `jarvis-runner/sql/006_stage_3_4.sql` | 17-50 | `pending_writes` — **the human-in-the-loop approval primitive**, directly transplantable |
| `jarvis-runner/sql/007_facts.sql` | 16-39 | Append-only S/P/O triple store with `supersedes` self-reference. **This is the precise-state-extraction substrate that replaces transcript replay.** |
| `kenoki-worker/migrations/003_atomic_claim_rpc.sql` | 15-52 | `FOR UPDATE SKIP LOCKED` batch claim — the one primitive making N concurrent Mac workers safe against one Hetzner Postgres. **Copy verbatim.** |
| `kenoki-worker/migrations/002_inference_extensions.sql` | 26-167 | Typed-edge graph engine: LEAST/GREATEST orientation-dedup index + pluggable inference functions. Add an edge_type, add a function, no app code. Caveat: unproven — `inferred_edges` listed as empty in `docs/v4_plan.md:142`. |
| `jarvis-runner/sql/009_embedding_substrate.sql` | 43-390 | Any table gains embeddings via one trigger; one queue + one atomic claim RPC serves all 13. |
| ⛔ `jarvis-runner/sql/002_grants.sql` | 5-16 | **DELETE — do not port.** Grants `anon` full write on the entire runner schema *including* `pending_writes` (the approval fence) and `token_store` (OAuth tokens). Directly contradicted by 014 in the same directory. |

## B4. Queue hardening — three properties someone already paid for

`jarvis-runner/src/jarvis_runner/workers/embed_queue.py:1-171`. Documented at 6-18:
(a) stale-reclaim is **age-gated** so a restarted sibling can't yank a live worker's rows;
(b) a reclaim **burns an attempt** so a hard-crashed row reaches `failed` instead of wedging
the queue head forever; (c) finalize is **ownership-guarded** so it won't clobber a
re-enqueued row. These are exactly the failure modes a Mac Studio daemon hits under launchd
KeepAlive. Do not re-derive.

## B5. Voice — retained, with the credential path replaced

`voice/tts.py` — ElevenLabs `eleven_turbo_v2_5`, one provider-swap seam (`_eleven_stream`),
explicit 401/429 error taxonomy, and a graceful-degradation ladder: pre-rendered clip bank
(<250 ms ack) → ElevenLabs → macOS `say`, so it never goes silently mute.
`voice/stt.py:37-42` — **the hallucination guard is the non-obvious asset.** Whisper invents
"thank you for watching" on silence; without this filter a noise burst becomes a phantom
agent invocation. Applied to both engines at 117.
`jarvis-cockpit/lib/vad.ts:1-90` — echo suppression (`setPaused` during TTS) — the hardest
part of a hands-free loop, already solved.

⚠️ `_load_creds()` (tts.py:26, 83-88) reads the key **by regex out of a markdown file**.
Replace with env/secret manager on port. Everything else stands.

## B6. macOS execution discipline — small, load-bearing

- `binpath.py:1-35` — absolute paths to every external binary. A relative name works in a
  shell and **fails invisibly under launchd**, whose PATH lacks `/opt/homebrew/bin`.
- 4 working launchd plists. Carry the caveat: **KeepAlive restart masks a crash-looping
  service — supervise the supervisor.**
- `voice_loop.py:12-14` — a launchd daemon **cannot** trigger the macOS TCC mic prompt;
  first run must be foreground. This will bite on the Mac Studio.

## B7. Streaming scorecard

Genuinely incremental: `jarvis-cockpit/lib/ask.ts:24-56` (SSE frame parser, tolerant of
partial chunks and malformed JSON — **the parser to port**), `kenoki-worker/api.py:98-109`
(NDJSON passthrough — **closest shape to stream-json; the transport to prefer**),
`ingest_1.py:735-759`, `tts.py:45-73`. Blocking: `self_test.py:34`, all voice subprocesses.

---

## REFACTOR / DELETE

### 🔴 The one genuine context-rot offender — and it carries a live bug
`stages/ingest_1.py:1141-1148` (`_conv_load`), called at **481, 562, 822, 897**. Returns raw
`{role, content}` rows and passes them verbatim into router, cortex, and opinion paths.

**It has been feeding the wrong ten turns for the life of the system.**
`.order('created_at', desc=False).limit(10)` returns the **oldest** ten messages, not the most
recent. Any session past 10 turns permanently re-feeds its opening exchange and never sees
anything since. Nobody would notice — the model still gets plausible-looking context.

This is the shape of defect that migrating to precise state extraction eliminates **by
construction rather than by fixing**. The replacement already exists in-repo:
`runner.facts` (sql/007) + `facts.relevant_facts_semantic` + `format_facts_block`
(facts.py:201-208). Delete `_conv_load`; extract state instead.

### Other refactors
- `stages/classify_2b.py:117-122` — verbatim transcript prepended to system prompt. Bounded
  to 6 turns but untruncated per turn. Side effect at 120: presence of history silently
  switches model from hosted router to local qwen2.5:7b — routing quality changing with
  context *shape*. Remove that coupling.
- `stages/cortex_5.py:547,578,614` — tool loop appends without compaction; `[:4000]` is a
  **blind character slice of a JSON document**, handing the model invalid JSON cut mid-token
  whenever a tool returns anything large. Cheap to fix, silent while unfixed.
- `articulation/articulate.py:201-206` — unbounded per-row text into prompt. Cap it; keep the
  provenance prefix (it enables the hallucination cross-check at 191-198).
- `clients/ollama.py`, `clients/deepseek.py` — dead backends. Extract one idea first:
  `openai_client.py:143` returns an "Ollama-shaped message block" — that format became the
  provider-neutral internal interface. Keep the abstraction, drop the backends.
- `PLAN.md`, `HURDLES.md` — self-marked HISTORICAL. `JARVIS_AGENT_CONFIG.md` is *not*
  banner-marked but is equally stale (documents Ollama as live; `CLAUDE.md` says hosted
  OpenAI). Stale docs reading as current teach a false model. Re-banner or delete.
- `archive/` — 2 dead files. Delete.

### What does NOT exist, despite the docs implying otherwise
- **No MCP implementation.** `mcp_registry` table, transport enum and a seeded npx row all
  exist — but `call.py:105-106` raises `NotImplementedError`. No client, no server, no stdio
  spawn. Keep the table as a data model; the dispatcher must be written from scratch.
- **No `prompt_array.py`.** `docs/KENOKI_PROMPT_ARCHITECTURE_REVIEW.md:29-70` designs it in
  detail. It was never built. (The *trust hierarchy* it describes is still worth porting:
  route_class is deterministic and never sourced from the LLM; the model may only refine
  within an already-locked lane.)
- **No headless-CLI or agent-spawning code of any kind.** Every subprocess in the repo is a
  media/test binary — ffmpeg, whisper-cli, `say`, pytest. Nothing to salvage for the
  Mac Studio spawner beyond `binpath.py` discipline and the plists.

---

## 🔴 SECURITY — 12 plaintext credentials on disk, 5 of them live and high-blast-radius

**Mitigating:** none are git-tracked. JARVIS is untracked inside the home repo. No key is in
git history. **Not mitigating:** they are plaintext in `~/Documents`, readable by any process
with home access, and the ElevenLabs one is *read at runtime by regex* — it is not a note, it
is the live credential store.

| File:line | Key | Severity |
|---|---|---|
| `SUPABASE_PAT.md:10` | `JARVIS_SUPABASE_PAT` (sbp_) | 🔴 **Management-API scope, not just data** |
| `KENOKI_SUPABASE_DB.md:7` | service_role JWT | 🔴 **Full DB access, bypasses all RLS** |
| `OPENAI_API.md:2` | `OPENAI_API_KEY` | 🔴 live |
| `DEEPSEEK_API.md:7` + `docs/deepseek_api.md:4` | `DEEPSEEK_API_KEY` (duplicated) | 🔴 live |
| `docs/ELEVENLABS API keys.md:4` | ElevenLabs `sk_` | 🔴 live, read at runtime |
| `KENOKI_SUPABASE_DB.md:6,12` | anon key, storage signing token | ⚠️ |
| `jarvis-cockpit/lib/supabase.ts:11` | anon key as **hardcoded literal fallback** | ⚠️ |
| `jarvis-cockpit/public/kenoki/app.js:7` | anon key in a publicly-served static asset | ⚠️ |
| `jarvis-cockpit/.env.local.example:5` | **a real key in a file named `.example`** | ⚠️ |
| `analytics-node/scripts/apply_schema.sh:28` | DB password in a connection URL | ⚠️ |

**Recommend rotating all five live keys regardless of git status.**

Separately, in `unified-terminal/`: `KENOKI_SUPABASE_DB.md` holds service_role + JWT signing
secret + DB password. Verified untracked and matched by `.gitignore:5` — but `vercel.json`
sets `outputDirectory: "."` and there is **no `.vercelignore`**. One line of one file is the
sole defence. Add a `.vercelignore`.

---

## Extraction order (highest value first)
1. `term_groups.py` + `action_class.py` + `route_specs.py` → the ontology and permission matrix.
2. `sql/001` (capabilities/events/items) + `sql/006` (pending_writes) + `sql/007` (facts) → Hetzner state model.
3. `003_atomic_claim_rpc.sql` → multi-worker safety. Verbatim.
4. `embed_queue.py` hardening properties → daemon queue semantics.
5. `supabase_write.py` + `sql/014` → the two-layer write fence, plus the parity test.
6. `ask.ts` parser shape + NDJSON transport → already superseded by `03-daemon/spawn.mjs`.
7. Voice layer, credential path replaced.
