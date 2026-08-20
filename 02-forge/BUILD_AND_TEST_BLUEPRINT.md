# Build & Test Blueprint — Agentic Control Plane
Date: 2026-08-19 · Seat: CENTRAL · Status: pre-stack, incremental-gate discipline

Governing rule: **every layer gets a standalone kill/pass test before the next layer is
allowed to depend on it.** Nothing gets wired to something unproven. This is the single
mechanism that prevents cascading failure — a bad layer 2 fails layer 2's test and stops
there, instead of surfacing as a mysterious layer 5 bug three days from now.

---

## 0. What's already proven (don't re-test, build on it)

| Claim | Evidence | File |
|---|---|---|
| Headless stream-json works | 16 events, 100% parseable, exit 0 | `01-audit/TEST_REPORT_01…md` |
| Concurrency works | 5/5 spawns, 5.9× speedup, no rejection | same |
| Lean spawn cuts cost/CPU | −48% cost, −95% local CPU vs default | same |
| Rate limit is observable in-stream | `rate_limit_event`, live reading 85%/7d | same |
| Local CARL judge works | qwen3:32b → valid JSON verdict, $0 | same |
| **`--resume <session_id>` carries real state** | resumed session correctly recalled a fact from turn 1 | tested just now, see below |
| JARVIS ontology is portable | `term_groups.py`+`action_class.py`+`route_specs.py`, ~400 lines pure data | `01-audit/EXTRACTION_MANIFEST.md` §B1 |
| unified-terminal is dead weight | fails all 3 gates structurally | same, §A |
| Docker + local Postgres image cached | `postgres:15-alpine` present, Cloud_PMS Supabase stack running | `docker images` |

**New this session — `--resume` works natively.** ⚠️ **CORRECTED 2026-08-19 after review:**
I initially read this as solving checkpoint/revive. It does not. `--resume` reloads the
*entire* existing context window verbatim — it is state **persistence**, not context
**compaction**. An agent 80k tokens deep into a rotted loop, resumed, is still 80k tokens
deep into a rotted loop; `--resume` is a pause button, not a fix. The one thing my test
actually proved is narrower and still useful: session state survives across separate CLI
invocations (needed for G5's poll-and-dispatch loop). It proves nothing about rot recovery.
CARL's actual mechanism must be: extract precise state from the bloated session (the JARVIS
`facts` pattern — see manifest §B3), open a **fresh `session_id`**, inject the compacted
artifact as its opening prompt. `--resume`/`--fork-session` are supporting primitives for
lineage bookkeeping, not the compaction mechanism itself. Corrected in G2 below.

---

## 1. The dependency graph (what can only be tested after what)

```
        [G0] toolchain/hardware      ─ done, passed
                    │
        [G1] spawn primitive          ← 03-daemon/spawn.mjs, PROVEN
                    │
     ┌──────────────┼──────────────────┐
     │              │                  │
[G2] resume/      [G3] CARL judge   [G4] local state
     fork lineage    accuracy at        (Postgres+Redis,
                      REAL scale         local docker)
     │              │                  │
     └──────────────┴──────────────────┘
                    │
        [G5] Sentry→dispatch loop (synthetic, local only)
                    │
        [G6] open-source forge gate (AgentWorks/CloudCLI/AgentControl)
                    │              — only spend time here if G1-G5 show
                    │                a real gap the primitives don't cover
        [G7] tunnel (cloudflared) — Mac ⇄ a throwaway cloud endpoint
                    │
        [G8] Hetzner — REAL state, only after G4 passes locally
                    │
        [G9] Vercel UI skeleton — reads G8, renders G1's event stream
                    │
        [G10] end-to-end: synthetic Sentry error → live UI update
```

Rule: **a gate only opens once the gate above it has a written PASS/FAIL, not a verbal one.**
Each gate below has an exact command or script and an explicit falsifiable pass condition —
pre-registered before running, per your own standing discipline.

---

## 2. The gates

### G0 — Toolchain & hardware — ✅ PASS (done)
Already verified: claude 2.1.236, node 24, ollama 0.21.0 w/ qwen3:32b, cloudflared present,
docker running, 96GB/M2 Max/12 core. No re-test needed.

### G1 — Spawn primitive — ✅ PASS (done)
`03-daemon/spawn.mjs`. Concurrency, cost, and rate-limit telemetry all proven live.

### G2 — Resume/fork lineage integrity AND compaction — 🟡 one test done, five more needed
**What could cascade-fail if untested:** if resume silently drops state under some condition,
lineage bookkeeping breaks. Separately and more dangerously: **if we ship believing `--resume`
performs compaction, CARL never actually fixes context rot — it just re-loads the rot and
calls it recovery.** That failure mode would not be visible in any test that only checks
"did the agent still know things" — it would only show up as unbounded token cost and
degraded output quality weeks into real operation. Test compaction as a distinct claim.

Pre-registered pass/fail (write this BEFORE running each):
1. **Basic recall** — ✅ already done: told a fact, resumed, correctly recalled it. This
   proves persistence only, NOT compaction — do not cite it as evidence CARL works.
2. **Resume after tool use** — spawn with `Write` allowed, have it write a file, resume,
   ask it to read the file back without being told the path again. FAIL if it can't find it
   or hallucinates a path.
3. **Resume across a process restart** — kill the node process (not just the CLI), then
   resume the same `session_id` fresh. FAIL if state doesn't survive the restart (this
   matters because a crashed daemon must recover, not just a graceful handoff).
4. **`--fork-session` isolation** — fork once, mutate state in the fork, resume the
   *original* session_id. FAIL if the fork's mutation leaked into the original — this is
   the isolation guarantee multi-agent branching depends on.
5. **🔴 NEW — Compaction vs. resume (the real CARL primitive, test it directly).**
   Drive one session to ~50 turns / meaningfully large token count (script a loop of small
   tool-using tasks against it). Record `result.total_cost_usd` / token count for that
   session at turn 50. Then: (a) `--resume` it and ask one more question — confirm cost/
   latency scale with the *existing* 50-turn window (proves resume does NOT compact —
   expected and fine, this is the control case, not a failure). (b) Separately, extract a
   compact state summary from that same 50-turn session (facts/decisions/pending-tasks only,
   JARVIS `facts` shape) and open a **brand-new `session_id`** with that summary as the
   opening prompt. Ask it the same follow-up question. **PASS condition: the fresh session
   answers correctly with a materially smaller `duration_api_ms`/cost than the resumed one.**
   If the fresh-session answer is wrong, the extraction is losing load-bearing state and the
   summarizer prompt needs work before CARL can rely on it.
6. **🔴 NEW — Concurrent local-state write safety.** Claude Code persists session state in
   local files under `~/.claude`. Launch 10 concurrent `spawn.mjs` workers against 10
   *different* fresh sessions simultaneously (not the same session_id — that's a different,
   also-worth-testing case). Kill the parent Node daemon mid-run (`kill -9`) while all 10 are
   still writing. Restart, then attempt to `--resume` each of the 10 session_ids individually.
   FAIL if any session's local state file is corrupted/unreadable, or if a resume returns
   another session's content (cross-contamination). This is a precondition for running any
   real concurrency on this daemon — an undiscovered corruption mode here would surface as
   a data-integrity incident, not a clean crash.

Script: `02-forge/tests/g2_resume.sh` (build before running — 30 min, was 15, test 5 and 6 added).

### G3 — CARL judge accuracy at real scale — 🔴 not yet tested, HIGHEST RISK gate
**What was tested:** one clean 16-event stream, correctly judged "continue." That is the
easy case, and n=1 is statistical noise, not evidence — LLM judges are non-deterministic
even at low temperature, and a single lucky pass tells us nothing about reliability. **What
was NOT tested:** the hard case at any real sample size, and whether the judge is fast
enough to sit in a live pipeline at all — an unmeasured 45-second verdict on a 1000-line
tool-call stream would silently stall every worker behind it.

Pre-registered pass condition, corrected: **feed CARL 20 synthetic streams (10 healthy,
10 pathological — repeated identical tool call, cost runaway with no terminal result,
stalled/incomplete stream, contradictory tool results, slow-burn turn-count creep — at
temperature 0), requiring:**
1. **Accuracy: 20/20 correct**, strictly outputting valid JSON
   `{"verdict":"continue|stop","confidence":0-1}` — not prose, not a variant shape.
2. **Latency SLA: p95 < 5.0 seconds** per verdict, measured end-to-end via the HTTP API
   (never the `ollama run` CLI — confirmed in TEST_REPORT_01 to corrupt piped output).
3. If either bar is missed, **CARL is not the gate** — `spawn.mjs`'s free tier-0 heuristics
   (`suspect-rot`: repeated-tool detection, turn-cap) remain the primary and possibly *only*
   automated gate, with human review as the fallback for anything they don't catch. A
   sub-threshold CARL becomes an advisory signal in the UI, not an autonomous halt authority.

Script: `02-forge/tests/g3_carl_judge.mjs`. This is the gate most likely to reveal that CARL
needs a rubric/few-shot prompt rather than a bare "judge this" ask — budget time for iteration,
and budget time to separately verify 32B is even the right size once latency is measured
(escalating to 70B would make the SLA harder, not easier — measure before considering it).

### G4 — Local state substrate (Postgres + Redis, on this Mac, NOT Hetzner) — 🔴 not tested
**Why local first:** Hetzner is a real, billed, network-dependent, harder-to-reset resource.
Every schema mistake, every RLS bug, every queue-semantics bug identified in the JARVIS audit
(the `002_grants.sql` anon-write hole, the ordering bug in `_conv_load`) should be re-provoked
and caught **locally** before the schema ever touches Hetzner.

Steps:
1. `docker run` a throwaway `postgres:15-alpine` (already cached, zero pull time) + a
   throwaway `redis:7-alpine`.
2. Apply the extracted schema, in this order (matches `EXTRACTION_MANIFEST.md` §"Extraction
   order"): `sql/001_init.sql` subset (capabilities, events, items) → `sql/006` pending_writes
   → `sql/007` facts → `kenoki-worker/migrations/003_atomic_claim_rpc.sql`.
   **Do NOT apply `sql/002_grants.sql`** — it's the flagged anon-write hole.
3. Prove the claim RPC is actually concurrency-safe: spawn 10 concurrent local processes
   racing `claim_enrichment_batch`, assert zero duplicate claims. This is the primitive every
   later worker depends on — falsify it now while a bug costs nothing.
4. Prove `pending_writes` round-trips: stage a write, confirm it, verify state transition;
   stage a write, cancel it, verify it never executes.

Pass condition: 10/10 concurrent claims are unique, both `pending_writes` transitions work,
`anon` role (if created) cannot write to `pending_writes` or `token_store`.

### G5 — Sentry→dispatch loop, synthetic and fully local — 🔴 not tested
Don't touch real Sentry yet. Prove the *shape* of the pipeline first:
1. A local script POSTs a fake Sentry-shaped payload to a local HTTP endpoint.
2. That endpoint pushes to local Redis (from G4).
3. `spawn.mjs`-based daemon polls Redis, looks up "owning" node from the G4 Postgres schema
   (start with a hardcoded 2-3 row ownership table — CelesteOS-Cloud, MYI2, INFLUENCE),
   spawns a worker in that directory with the fake trace as prompt.
4. Verify the worker's `result` event and cost land back in the `events` table.

Pass condition: fake error in → correct directory selected → worker spawned → result logged.
Only once this passes locally does it become worth pointing at a real Sentry webhook.

### G6 — Open-source forge gate — condition on G1-G5, not automatic
Given findings so far: **our own `spawn.mjs` already passes the stream-json + concurrency
gates that AgentWorks/CloudCLI/AgentControl were meant to provide, and JARVIS had zero
working MCP or spawner code to inherit.** Don't clone speculatively. Only pull a candidate
repo if G1-G5 surface a *specific* gap — e.g., "we need RBAC policy evaluation at a
sophistication our hand-rolled matrix doesn't reach" — and even then, apply the blueprint's
own spot-check (stream-json parsing + genuine MCP/Code Mode support) before spending time on
it. Time saved here goes into hardening the gates above instead.

### G7 — Secure tunnel (cloudflared) — 🔴 not tested, cheap and isolated
Test in isolation, pointed at nothing real yet: stand up `cloudflared tunnel` to a throwaway
local HTTP echo server, confirm two-way traffic over the tunnel from an external curl. Pass
condition: round-trip latency measured, tunnel survives a `cloudflared` process restart
without manual re-auth.

### G8 — Hetzner — only after G4 passes locally
Port the *same* schema that passed G4, unchanged. If G4 caught the bugs, G8 is a repeat, not
a discovery step. Pass condition: identical to G4's pass condition, run against the real host.

### G9 — Vercel UI skeleton — reads real state, tokenized styling
Render `term_groups.py`'s topology as static nodes first (no live data), THEN wire one
real WebSocket/SSE channel to one real `spawn.mjs` run and confirm a live tool-call event
appears in the UI within a bounded latency. Don't build the full "Agent Slack" chat before
this single live wire is proven.

### G10 — End-to-end
Only attempted after G1-G9 each have a written pass. Synthetic Sentry error → real dispatch
→ real worker → real UI update, across the real tunnel, against real (not local) state.

---

## 2b. 🔴🔴 STOP-SHIP CORRECTION, 2026-08-19 — G2's FAIL was a test-design artifact.
Claude Code already has native compaction. Do not build CARL's extraction mechanism as
first designed. Architecture of `spawn.mjs` itself is now suspect.

Four things landed together and none of them are optional reading before touching G1/G2 again:

**1. G2 compared the worst possible case, and Anthropic says so explicitly.** Real `/compact`
forks the *same cached session* — system prompt and tools stay cache-warm, only history
resets — while G2's "compaction" opened a genuinely cold `session_id` and paid full
cache-write price for the whole prefix. From Anthropic's own docs: *"This is why /compact
costs the most when you resume an old session"* — that sentence describes G2's exact test
shape. **The G2 FAIL verdict stands as measured, but "compaction is cost-inferior" does not
generalize — it was never given a fair fight.**

**2. Anthropic never justifies compaction by cost at all — only by quality/context-rot.**
Their "Effective context engineering" guidance frames it purely as a coherence fix. G2's
12 clean turns never approached the scale where degradation is documented (Liu et al. 2023
"Lost in the Middle": >30% accuracy loss on mid-context info; Chroma's 2025 "Context Rot"
study, 18 models: reasoning degrades and models hallucinate novel content starting ~500-750
words under stress, independent of retrieval). **G2 measured the wrong axis. The deferred
deep re-run must test correctness-under-length with planted distractors, not $/turn.**

**3. Claude Code already auto-compacts, on by default, right now, on this account.**
`~/.claude/settings.json` → `autoCompactEnabled: true`. `/compact` and `/autocompact` are
live slash commands. `--resume` is *designed* to load the compact summary once a session has
been auto-compacted, not full history (changelog confirms this explicitly, and confirms it
fires in headless `-p` mode too, not just interactive). There are `PreCompact`/`PostCompact`
hooks. **Building CARL as a from-scratch "extract facts → open fresh session" pipeline
duplicates a feature that already exists.** Revised design: CARL hooks `PreCompact`/
`PostCompact` and owns the halt/escalate *decision*; native auto-compact owns the mechanism.

**4. `spawn.mjs`'s core architecture — spawn-per-turn via `--resume` — is now known to be
the expensive option.** `--input-format stream-json` keeps ONE subprocess alive across
multiple turns fed via stdin. Measured: turn 2 of a persistent process read back 31,785
cache tokens against only 98 new cache-write tokens — near-total reuse, no respawn, no
`--resume` needed. **This is a real architecture question for G1, not a footnote** — prototype
a persistent stream-json worker mode and gate it the same way every other layer was gated,
before more is built on the current spawn-per-turn model.

**5. Confirmed empirically (E1, N=3, explicitly flagged as directional not conclusive):**
prompt-cache hits are keyed by **org + model + byte-exact prefix hash — not session_id.**
Two fully independent sessions sharing an identical system-prompt prefix cache-hit on each
other: cost −34.7%, latency −35.9%, session A→B. **A "fresh" compacted session does not
have to be expensive** if its wrapper prefix is kept deterministic — this was the actual fix
G2 needed and never tried.

**Net effect on the roadmap:** the deep 50-100 turn G2 re-run is still deferred (rate limit),
but its design changes — test *native* autocompact left on, in both arms, measuring
correctness at real depth, not a hand-rolled extraction pipeline against a cold session.
Full detail: `02-forge/results/G2_PRIOR_ART_SURVEY.md`, `G2_NATIVE_FEATURE_CHECK.md`,
`G2_CACHE_REUSE_EXPERIMENT.md`.

## 2c. G5 — Sentry→dispatch loop, PASS, fallback path proven closed
Direct answer to the systemic gap flagged earlier: *"what happens when a webhook fires for
an unknown route — it must route to a human queue, not hallucinate an owner."* Built and ran
end to end, fully local (Postgres `controlplane.project_ownership`/`unrouted_errors`, Redis
queue, `spawn.mjs`-based dispatcher): 2 happy-path fake errors correctly matched real
directories (`CelesteOS-Cloud`, `MYI2`) and spawned real read-only probe workers with logged
results; 1 deliberately unmapped error was correctly detected as unroutable and **spawned
nothing** — proven three independent ways: the dispatch code path structurally never
references `Worker` in the fallback branch, zero `stream-json` processes appeared in `ps`
around the decision, and zero rows landed in the events table for that project — instead
exactly one row in `unrouted_errors` flagged `needs_human_review`. Full detail:
`02-forge/results/G5_RESULTS.md`. Follow-up: the low-confidence *fuzzy*-match branch
(a row matches but scores below threshold) exists in the code but was never exercised —
this run only tested exact-match and no-match, not the middle case.

## 3. What NOT to build yet (explicitly deferred, to keep the incremental discipline honest)
- Governance/RBAC frameworks beyond the JARVIS-derived matrix — it already exists and is
  higher quality than most stated-generic "governance toolkits."
- Voice layer — retained in the manifest, zero urgency; nothing in G0-G10 depends on it.
- Multi-project WebSocket broker between MYI/CelesteOS agents — premature until at least one
  single-project loop (G5/G10) is proven end-to-end.
- Any UI polish — tokenized/generic until G9 proves the data flow.

## 4. GATE RESULTS — 2026-08-19, run in parallel via Workflow, real measured numbers

| Gate | Verdict | Headline number |
|---|---|---|
| **G2** resume vs. compaction | 🟡 **FAIL, but test was unfair — see §2b** | naive `--resume` beat a *cold* compacted session 4.63× on cost; real `/compact` never goes cold, so this doesn't generalize |
| **G3** CARL judge, n=20 | ✅ **PASS** (after 1 rubric fix) | 20/20 accuracy, 100% valid JSON, p95 latency **3768.8ms** (< 5.0s bar) |
| **G4** local Postgres/Redis | ✅ **PASS** | 15/15 unique concurrent claims, 0 dupes, **even under ~9,000 tps pgbench contention**; both audit bugs re-provoked and confirmed closed |
| **G5** Sentry→dispatch loop | ✅ **PASS** | happy paths spawn correct workers; unmapped error **spawns nothing**, routes to human review — proven 3 independent ways |
| **G7** tunnel pattern | ✅ **PASS** | 10/10 round trips 200 OK across 2 independent ephemeral tunnels; **self-caught near-miss**, see below |

Full detail in `02-forge/results/G{2,3,4,7}_RESULTS.md`. Raw data: `g2_raw_report.json`,
`G3_RAW_RESULTS*.json`.

### G2 — the compaction hypothesis is REFUTED at the tested scale, not confirmed
This is the most important result of the session, and it inverts what §0 originally claimed.
`--resume` rides Anthropic prompt-cache reads on the accumulated prefix (per-turn cost
flattened from $0.0353 → ~$0.009 across 12 turns); a fresh session pays full cold-start/
cache-write price with nothing to amortize it. **At small scale, naive resume is CHEAPER
than compaction, not more expensive.** The blueprint's assumption that compaction always
wins was wrong to state as settled — it is an open empirical question whose crossover point
(if one exists) is still unmeasured. Fork-session isolation held cleanly (no leakage).
Real spend: $0.202 across 16 turns — against the account's existing 85%-of-7-day headroom,
so the deeper 50-100 turn re-run needed to find the real crossover is explicitly deferred
until rate-limit headroom returns, not squeezed in now.
**Consequence: do not build CARL's halt/revive path on "always compact." Test both paths'
cost at the depth a real rotted session would actually reach before choosing one — possibly
depth-conditional (resume below some turn/token count, compact above it).**

### G3 — PASS, with an honest miss disclosed, not hidden
First run: 19/20, missed a stream ending on an unresolved `tool_use` with no result event —
a real gap in the rubric, not noise. One targeted rubric-sentence fix, full fresh re-run:
20/20, p95 3768.8ms. Both attempts are preserved on disk (`*_attempt1.md/json`) rather than
overwritten. Cold model load adds ~6s (`load_duration`) — **qwen3:32b must stay resident**
in Ollama or the very first verdict after idle blows the 5s SLA. n=20 clears the
pre-registered bar but is still a small sample from fabricated fixtures, not a real rotted
stream — recommendation carried into next steps below.

### G4 — PASS, both re-provoked JARVIS bugs confirmed closed
`ai_writer` role: 4/4 DELETE/TRUNCATE attempts denied, 3/3 direct `pending_writes` writes
denied — the `002_grants.sql` anon-write hole does not exist in the new schema.
`claim_batch()`: 15/15 unique claims, zero duplicates, **both unloaded (0.092s) and under
real pgbench contention at ~9,000 tps (0.128s, no deadlock)** — the concurrency bug is
closed with margin. `pending_writes` stage/confirm/cancel round-trips verified, including
proof a cancelled write's linked item was never touched. New finding: `claim_batch()` does
not yet burn an attempt on claim (unlike JARVIS's `embed_queue.py` hardening, manifest §B4)
— a real worker daemon needs that before relying on reclaim semantics.

### G7 — PASS, but a real near-miss on the live production tunnel, self-caught
🟡 **Worth your attention even though it passed.** cloudflared's `--url` quick-tunnel flow
still performs its normal `$HOME/.cloudflared/config.yml` discovery by default. The agent's
first (unreported) launch surfaced the **live production `kenoki.yml` tunnel's credential
file** in its own settings before a single request had been sent — caught immediately,
killed, confirmed dead, and re-run with an isolated `$HOME` for both reported tunnels
(verified via a log line confirming zero config discovery). The production tunnel (pid
57605) ran continuously and untouched throughout, verified before and after. **New standing
rule for this Mac: any future ephemeral cloudflared work must override `$HOME` explicitly —
the default flow is not as isolated as "no config file" implies.** 10/10 round trips across
two independent tunnels, ~75ms steady-state latency after cold start.

## 2d. Context-rot detection — research complete, findings shipped into spawn.mjs

Directly answers "will asking the agent if it's rotted ever work?" — no, confirmed across
4 parallel research tracks (frameworks, measurable signals, watchdog libraries, production
practice), not just asserted: **zero surveyed system uses an LLM-judge as the primary
detector.** The converged, independently-reinvented pattern (OpenHands, AutoGPT, 5+ standalone
projects, a real anthropics/claude-code runaway incident #4095): fingerprint a tool call
(name + canonicalized args), sliding window, count exact repeats, nudge then hard-stop.

Two real gaps this found in our own code, fixed same-session in `03-daemon/spawn.mjs`,
verified via `spawn.unit-test.mjs` (7/7, zero API cost — fabricated events fed directly into
`ingest()`, no subprocess): (1) `tool_result.is_error` flowed through every event completely
unread — no `user`-event case existed; now tracked with a per-fingerprint error streak.
(2) The loop heuristic matched tool **name only**; upgraded to a name+args fingerprint, plus
a period-2 A-B-A-B alternation check — the one failure mode found that name-only or
identical-repeat checks both miss entirely. CARL's Ollama judge is unchanged in role: still
downstream, for the ambiguous case none of this catches. Full detail: `05-research/`.

**Dead end confirmed, don't pursue:** perplexity/logprobs has the strongest academic backing
of any candidate but Claude's API/CLI exposes no logprobs field — not available on this stack.

**Carried forward, not yet built:** Anthropic's own guidance judges agent progress by
*external ground truth* (test/build exit codes, git diff activity, file mtimes) checked from
outside the subprocess — a different axis (effect, not behavior) worth its own gate once
workers do real file-mutating work, not just read-only probes.

## 🔴 Live constraint, 2026-08-19 later same day — rate limit hit 99%

A single smoke-test spawn after the above patch returned `rate_limit_event` at **99%
utilization**, tripping the daemon's own 92% backpressure threshold (was 85% earlier the same
day). **No further real API-consuming tests until this clears.** All work past this point in
the session was zero-API-cost only (unit tests against fabricated events, research, docs,
git). Resume real-workload testing (the deferred deep G2 re-run, CARL validation against a
real session, any new spawn.mjs integration test) only once headroom returns.

## 5. Immediate next actions, in order (revised post-gate-run + post-correction)
1. **Decision needed from you, not a test:** tunnel/UI reuse. **RESOLVED 2026-08-19** — new
   subdomain under `kenoki.app` (e.g. `central.kenoki.app`) on a brand-new, isolated
   cloudflared tunnel, never touching the live `kenoki.yml`. **Deferred until later per
   owner's direction** — use ephemeral quick tunnels (G7's proven pattern) for testing until
   there's a real daemon worth exposing persistently.
2. **Architecture decision, not urgent but load-bearing:** prototype a persistent
   `--input-format stream-json` worker mode as an alternative to `spawn.mjs`'s current
   spawn-per-turn `--resume` pattern (§2b.4) — gate it the same way before adopting.
3. Redesign CARL around native compaction rather than a from-scratch pipeline: hook
   `PreCompact`/`PostCompact`, own the halt/escalate decision, let auto-compact own the
   mechanism (§2b.3). Keep CARL in **shadow mode only** until validated against a real
   rotted session, not fabricated fixtures.
4. Harden `claim_batch()` with attempt-burn semantics (G4 follow-up) before any real worker
   daemon depends on reclaim.
5. Exercise G5's untested fuzzy-match branch (a row matches but scores below the 0.9
   confidence threshold) — this run only proved exact-match and no-match.
6. Defer the redesigned deep G2 re-run (50-100 turns, native autocompact ON in both arms,
   testing correctness-under-length not $/turn) until 7-day rate-limit headroom recovers —
   account spent $0.202 + $0.074 + $0.098 + $0.037 ≈ **$0.41 across this session's real API
   tests**, against a window that was already at 85% before any of it.

   **Correction, same day, later:** the 99% reading did not turn into a hard block. Real API
   calls continued to succeed for the rest of the day (§6 below). Treat this metric as
   informational, not a stop condition — noted per the project owner's own framing ("small
   metric, what does that matter").

## 6. 3-hour execution block — 2026-08-19, end of day. Real bridge proven, real RBAC bug found+fixed.

Four tracks run in parallel: 3 fragmented hardening items (F1, F2, F3) + the one combined
vertical slice (C) that IS G9's actual pass condition, attempted for the first time.
**4/4 passed.** Full detail: `02-forge/results/{F1_ATTEMPT_BURN,F2_FUZZY_MATCH,
F3_REAL_STREAM_VALIDATION,C_LIVE_BRIDGE}_RESULTS.md`.

### F1 — `claim_batch()` attempt-burn — ✅ PASS
Ported JARVIS's `embed_queue.py` hardening properties for real. Live-tested 3 full reclaim
cycles (attempts 0→1→2→3), confirmed the row reaches terminal `failed` at `max_attempts` and
is then permanently excluded from both `pending` and `processing` — proven by a subsequent
reclaim AND a subsequent `claim_batch()` both returning zero rows for it.

### F2 — G5's fuzzy-match branch — ✅ PASS, and it turned out not to exist yet
On inspection this branch was never actually buildable before: the lookup was exact-match
only, so "confidence" was always exactly 1.0 or the row didn't exist. Built real `pg_trgm`
similarity scoring and wired it into the dispatcher for real. Proved both sides live:
similarity 0.588 (below the 0.9 threshold) correctly suppressed — zero workers spawned,
routed to `unrouted_errors` with the real score attached; similarity 0.944 (above threshold)
correctly spawned a real worker in the right directory. Closes the exact gap G5 flagged.

### F3 — CARL + tier-0.5 against a REAL stream — ✅ PASS, honest true-negative
Checked every real stream-json log already captured this session first (zero cost) — all
were clean, no pathology. Per the cost-conscious fallback, spent 2 cheap real calls on
genuinely underspecified read-only tasks (not instructed to loop). Both real streams: tier-0.5
correctly stayed silent, CARL independently returned `continue`/0.95 — full agreement, both
correct against ground truth. **Stated plainly, not manufactured: no real loop/error-streak
pathology has been found yet in either direction — true-positive validation is still open.**

### C — Live bridge — ✅ PASS. This is the thing the founder asked whether we'd proven.
Built `PersistentWorker` (new file, existing `Worker` untouched — no regression risk to the
hardened one-shot path), `ws-bridge.mjs`, and a bare `terminal.html`. Proved twice with real
API calls: a direct 2-turn FALCON-codeword recall test (same pid, same session_id), then the
full path over a real WebSocket — a programmatic client AND a real Chrome tab each opened
independent live connections, one `PersistentWorker` per connection, correct turn-2 recall
with a 25,204-token warm-cache hit proving session continuity. **This is G9's own stated pass
condition, met for the first time.** Deliberately no visual polish — a scrolling log and a
text box, per the founder's explicit "perfect the frontend later" instruction.

### 🔴 Real finding, fixed same session: the RBAC claim was never actually enforced
F3 surfaced it directly: a `role:'probe'` worker, scoped to `tools:['Read']` only, used
`Bash` twice in real captured streams. Confirmed via a direct A/B test:
`--allowedTools` alone does **not** reliably restrict tool access once
`--dangerously-skip-permissions` is set — but `--disallowedTools` (an explicit deny list)
does. **Every prior claim in this project that a probe/auditor worker was "read-only" was an
unenforced assumption, not a guarantee, until this fix.** `spawn.mjs`'s `ROLES` now compute
an explicit deny-list (`ALL_MUTATING_TOOLS` minus whatever's allowed) and pass it via
`--disallowedTools`. Reproduced F3's exact failing scenario post-fix: same class of task,
zero `Bash` used. Mitigating factor worth naming: G4's Postgres-level column grants
(`ai_writer`/`approver` role split) were always an independent, DB-enforced layer — the
"two orthogonal safety layers" pattern praised in the JARVIS audit — so this gap was real at
the application layer but the database was never actually exposed by it.

## 7. Scope check against `/peers`, session storage, and existing project structure

The founder pushed back mid-block: does any of this need building at all, given what already
exists? Verified, not assumed:

- **Session resume across ALL existing projects, not just daemon-spawned ones — needs no new
  storage.** Every Claude Code session is a real JSONL transcript under `~/.claude/projects/`.
  405 project directories exist on this machine, 43 touched in the last 7 days — including
  the real transcript of one of our own G5-dispatched workers. A GUI can enumerate and
  `--resume` any of them today by directory-scanning.
- **`/peers` genuinely substitutes for the blueprint's custom "Inter-Agent WebSocket Broker"
  — for coordination, not for live viewing.** Confirmed live: 15 real peers running across
  genuinely different projects right now, real bidirectional messaging. Caveat, confirmed not
  assumed: it's an async mailbox (most peers show "queued only, no channel consumer"), not a
  push/stream channel — fine for "tell another agent something," not sufficient alone for
  "watch a terminal live," which is exactly what §6 track C's bridge is for. Complementary,
  not redundant.
- **Project↔repo linkage — already fully true, zero gap.** CelesteOS/Cloud_PMS, Cloud_DMG,
  MYI2, and Influence720 each already have their own real, distinct GitHub remote.
- **Candidate open-source GUI, gate not yet run:** `siteboon/claudecodeui` — named
  speculatively in this project's very first research pass, now verified for real:
  13,349 stars, pushed within 24 hours of checking, 779 commits, actively maintained. Session/
  project browsing, file explorer, git integration, terminal access, multi-CLI. **Not yet
  confirmed** whether it does genuine `stream-json` parsing or true `--resume` across
  arbitrary directories — the standing gate (verify empirically, never trust docs/stars alone)
  has not been run. Next step: clone and trial it locally against a real session before
  writing more of the "browse my own existing sessions" UI from scratch — it's a different job
  from §6's bridge (new dispatch-triggered workers), not a competing build.
