# G5 Results — Sentry→Dispatch Loop, Synthetic and Fully Local, WITH Fallback Path

Date: 2026-08-19 · Seat: CENTRAL · Gate: G5 (`02-forge/BUILD_AND_TEST_BLUEPRINT.md` §G5)

Zero real Sentry involvement anywhere in this run. Reuses G4's already-running local
Postgres (`central-mvp-pg`, port 5433, schema `controlplane`) and Redis (`central-mvp-redis`,
port 6380) — neither container was recreated, both were already `Up` when this gate started.
Reuses `03-daemon/spawn.mjs`'s `Worker` class (imported directly, not re-implemented) for the
one and only dispatch mechanism. This gate explicitly builds and proves the fallback path the
project owner flagged as missing in an earlier review: *"what happens when a webhook fires for
an unknown route, or a cross-boundary error? It must route to a human/queue, not hallucinate an
owner and spawn a destructive agent in the wrong directory."*

**Overall: PASS.** Both happy-path errors correctly spawned a read-only worker in the right
directory with a real logged result. The fallback-path error was correctly detected as
unroutable, spawned nothing, and was logged to a human-review queue instead. At no point did
the dispatcher construct a `Worker` for the unmapped project.

---

## 1. What was built

| Piece | File | Role |
|---|---|---|
| Ownership table | `02-forge/sql/003_ownership.sql` | `controlplane.project_ownership`, 3 seeded rows |
| Fallback queue | `02-forge/sql/004_unrouted_errors.sql` | `controlplane.unrouted_errors` (new table, not `pending_writes` — see §2) |
| Ingest endpoint | `03-daemon/ingest.mjs` | plain Node `http`, `POST /ingest` → Redis `LPUSH errors:incoming` |
| Dispatcher | `03-daemon/dispatcher.mjs` | `BRPOP` poll loop → ownership lookup → route or fallback |

No `npm install` was done. `redis` and `pg` are not installed anywhere in this project
(`node -e "require.resolve('redis')"` and `('pg')` both threw `MODULE_NOT_FOUND` — checked
before writing any code). Both scripts shell out to the already-installed `redis-cli`
(`/opt/homebrew/bin/redis-cli`) and `psql` (`/opt/homebrew/bin/psql`) via Node's `execFile`
(argv arrays, no shell interpolation — safe against payloads containing quotes) rather than
pulling in a client library for one queue and a handful of parameterized-by-hand queries.

### Directory verification (done before seeding, per task instruction)
```
$ ls -la /Users/celeste7/Documents/CelesteOS-Cloud   → real dir, 39 entries, exists
$ ls -la /Users/celeste7/Documents/MYI2               → real dir, 60 entries, exists
$ ls -la /Users/celeste7/Documents/INFLUENCE           → real dir, 27 entries, exists
```
All three are the same directories referenced across MEMORY.md as this operator's real
project checkouts — not placeholders.

### Seeded `controlplane.project_ownership` (exactly 3 rows, as required)
```
 project_id |  project_name   |              local_directory              | confidence_threshold
------------+-----------------+---------------------------------------------+----------------------
 celeste-os | CelesteOS-Cloud | /Users/celeste7/Documents/CelesteOS-Cloud    |                  0.9
 influence  | INFLUENCE       | /Users/celeste7/Documents/INFLUENCE          |                  0.9
 myi2       | MYI2            | /Users/celeste7/Documents/MYI2               |                  0.9
```
`controlplane_ai_writer`/`controlplane_approver` were granted `SELECT` only on this table
(no INSERT/UPDATE/DELETE) — an automated routing decision should never be able to modify who
owns what directory.

## 2. Design decision: `unrouted_errors`, not `pending_writes` (documented, as instructed)

A **new, purpose-built table** (`controlplane.unrouted_errors`) was used instead of reusing
`controlplane.pending_writes`. Reasoning, recorded verbatim in the migration's header comment:

`pending_writes` models a **staged write awaiting human confirm/cancel before a known side
effect executes** — it has `route`, `action_class`, `resolved_fields`, `confirmed_at`,
`executed_at`, `side_effect_id`. It assumes the action is already decided and just needs a
gate. An unrouted error is the opposite case: the dispatcher does **not** know what action to
take or who owns it. Forcing it into `pending_writes`' shape would mean inventing a fake
`route`/`action_class` for a decision that was never made — which is close to the exact
failure mode this gate exists to prevent (fabricating certainty where there is none).
`unrouted_errors` instead stores exactly what came in, why it couldn't be routed
(`reason`, `matched_confidence`), and a `status` a human can disposition
(`needs_human_review` → `reviewed_assigned` / `reviewed_discarded`).

Same staging precedent as G4: `controlplane_ai_writer` has **zero** grants on
`unrouted_errors` (cannot even read it) — the automated persona that failed to route an error
must not be able to quietly clear its own overflow queue. `controlplane_approver` gets
`SELECT` + column-scoped `UPDATE` on the disposition fields only. The dispatcher itself writes
new rows connected as the `postgres` service/daemon persona — see §3 for why.

## 3. DB access note (a simplification, called out rather than left implicit)

The dispatcher connects to Postgres as the `postgres` superuser, not as
`controlplane_ai_writer`. This mirrors G4's own stated precedent
(`G4_RESULTS.md` §7: *"staging is the daemon/service-role's job"*) — a real deployment would
give the dispatcher its own narrowly-scoped service role distinct from both `ai_writer` and
`approver`; for this local MVP gate `postgres` is used directly for the dispatcher's own
writes (routing-decision events, unrouted-error rows), and that simplification is written down
here rather than silently assumed.

## 4. The pipeline run — exact payloads, in order

Ingest server started: `node ingest.mjs --port 8899` (plain `http`, listening on
`127.0.0.1:8899`). Health check confirmed live: `{"ok":true,"service":"g5-ingest","redis_port":6380,"list":"errors:incoming"}`.

### Payload 1 — happy path, `celeste-os`
```json
{
  "project_id": "celeste-os",
  "culprit": "apps/api/routes/billing.ts in processInvoice",
  "exception_type": "TypeError",
  "exception_value": "Cannot read properties of undefined (reading 'amount')",
  "stack_frames": [
    {"filename": "apps/api/routes/billing.ts", "function": "processInvoice", "lineno": 142},
    {"filename": "apps/api/lib/stripeClient.ts", "function": "createInvoiceItem", "lineno": 58}
  ]
}
```
`curl -X POST http://localhost:8899/ingest` → `{"ok":true,"queued":true,"list":"errors:incoming","list_len_after_push":1}`

### Payload 2 — happy path, `myi2`
```json
{
  "project_id": "myi2",
  "culprit": "src/handlers/quoteHandler.py in calculate_premium",
  "exception_type": "KeyError",
  "exception_value": "'coverage_limit'",
  "stack_frames": [
    {"filename": "src/handlers/quoteHandler.py", "function": "calculate_premium", "lineno": 87},
    {"filename": "src/services/underwriting.py", "function": "apply_rules", "lineno": 33}
  ]
}
```
`curl -X POST http://localhost:8899/ingest` → `{"ok":true,"queued":true,"list":"errors:incoming","list_len_after_push":2}`

### Payload 3 — FALLBACK path, `acme-legacy-checkout` (deliberately unmapped, simulating a cross-boundary/unknown-route error)
```json
{
  "project_id": "acme-legacy-checkout",
  "culprit": "unknown/service/checkoutProxy in handleRequest",
  "exception_type": "ConnectionError",
  "exception_value": "Could not resolve host checkout-legacy.internal — cross-boundary error, project not in ownership table",
  "stack_frames": [
    {"filename": "unknown/service/checkoutProxy.js", "function": "handleRequest", "lineno": 19}
  ]
}
```
`curl -X POST http://localhost:8899/ingest` → `{"ok":true,"queued":true,"list":"errors:incoming","list_len_after_push":3}`

`acme-legacy-checkout` does not appear anywhere in the 3-row `project_ownership` table seeded
in §1 — confirmed by inspection, not assumed.

Redis list confirmed to hold exactly 3 items post-POST (`LLEN errors:incoming` → `3`), content
verified via `LRANGE 0 -1` before the dispatcher touched it — proving the HTTP→Redis leg
independent of the dispatcher.

## 5. Dispatcher run — full transcript (`node dispatcher.mjs --count 3 --wait 8`)

```
[dispatcher] starting — will process up to 3 item(s) from "errors:incoming", BRPOP timeout 8s each

──────────────────────────────────────────────────────────────
[dispatcher] item #1  project_id=celeste-os  culprit=apps/api/routes/billing.ts in processInvoice
[dispatcher] ps proof (before decision): 0 claude stream-json process(es) running
[dispatcher] ownership lookup: MATCH → CelesteOS-Cloud @ /Users/celeste7/Documents/CelesteOS-Cloud (threshold=0.9)
[dispatcher] confidence=1 threshold=0.9 → ROUTE (happy path)
[dispatcher] SPAWNING worker role=probe cwd=/Users/celeste7/Documents/CelesteOS-Cloud
[worker] ready session=806c11be tools=30
[worker] done turns=1 cost=$0.0191 error=none
[worker] result: Investigate **apps/api/routes/billing.ts** to find what object or variable is undefined when `processInvoice` tries to access the `.amount` property on it.
[dispatcher] ps proof (after worker exit): 0 claude stream-json process(es) running

──────────────────────────────────────────────────────────────
[dispatcher] item #2  project_id=myi2  culprit=src/handlers/quoteHandler.py in calculate_premium
[dispatcher] ps proof (before decision): 0 claude stream-json process(es) running
[dispatcher] ownership lookup: MATCH → MYI2 @ /Users/celeste7/Documents/MYI2 (threshold=0.9)
[dispatcher] confidence=1 threshold=0.9 → ROUTE (happy path)
[dispatcher] SPAWNING worker role=probe cwd=/Users/celeste7/Documents/MYI2
[worker] ready session=4f5d46d6 tools=30
[worker] done turns=1 cost=$0.0184 error=none
[worker] result: The `calculate_premium` function in `src/handlers/quoteHandler.py` — check where it's accessing the 'coverage_limit' key and verify the data structure being passed to it has that field.
[dispatcher] ps proof (after worker exit): 0 claude stream-json process(es) running

──────────────────────────────────────────────────────────────
[dispatcher] item #3  project_id=acme-legacy-checkout  culprit=unknown/service/checkoutProxy in handleRequest
[dispatcher] ps proof (before decision): 0 claude stream-json process(es) running
[dispatcher] ownership lookup: NO MATCH
[dispatcher] confidence=0 threshold=0.9 → FALLBACK (unroutable)
[dispatcher] would-be spawn suppressed — reason=no_ownership_match. NOT spawning any worker. NOT touching any directory.
[dispatcher] logged to controlplane.unrouted_errors id=2d80250e-26c3-4895-8b25-602d30fa9085
[dispatcher] ps proof (after suppression): 0 claude stream-json process(es) running

[dispatcher] === SUMMARY === processed 3/3 item(s)
  - celeste-os: route (session=806c11be, cost=$0.0191)
  - myi2: route (session=4f5d46d6, cost=$0.0184)
  - acme-legacy-checkout: fallback (reason=no_ownership_match, unrouted_id=2d80250e-26c3-4895-8b25-602d30fa9085)
```
Full unedited output preserved at `02-forge/results/g5_dispatcher.log`.

Redis queue confirmed empty after the run (`LLEN errors:incoming` → `0`) — all 3 items were
consumed exactly once, none left behind, none duplicated.

## 6. Proof the fallback path spawned NOTHING — three independent kinds of evidence

**(a) Architectural — the code path itself.** In `dispatcher.mjs`, `new Worker(...)` appears
exactly once in the entire file, inside the `if (routable)` branch of `handleItem()`. The
`else` branch (fallback) never references `Worker` at all — there is no code path from
"no ownership match" to a spawn call to abort; the spawn call is never reached in source, not
merely skipped at runtime.

**(b) `ps` snapshots around the decision.** Before and after the fallback item's routing
decision, `ps aux | grep stream-json` (the `--output-format stream-json` flag is unique to
`spawn.mjs`'s `Worker.args()` and appears in no other process on this machine) returned **0
matching processes both times.** Recorded honestly: because this test run is sequential and
single-threaded, the two prior happy-path workers had already exited (each `await w.run()`
completes before the next item is even popped) — so a 0→0 reading here is the *expected*
result of the suppression working correctly, not a coincidence, but it is a weaker signal in
isolation than (a) and (c) precisely because nothing was racing at that instant. It is included
as corroboration, not sole proof.

**(c) Database-level absence.** `controlplane.events` contains exactly 2 `worker_dispatch_result`
rows total (`project_id` = `celeste-os` and `myi2` only) and **zero** rows of that kind for
`acme-legacy-checkout` — confirmed by `select kind, count(*) from controlplane.events group by
kind`: `worker_dispatch_result=2, unrouted_error=1, routing_decision=3`. No `session_id` was
ever minted for the unmapped project (a `session_id` only exists once `system/init` streams
back from a real spawned `claude` process — `spawn.mjs:110-113`). If a spawn had happened for
`acme-legacy-checkout`, it would show up here as a third `worker_dispatch_result` row with a
real cost and session id; it does not.

Post-run process check, after the dispatcher itself had exited:
```
$ ps aux | grep -i "stream-json" | grep -v grep
(no output — zero claude worker processes of any kind running)
```

## 7. Final database state (authoritative)

`controlplane.events` — 6 rows, in emission order:

| id | kind | severity | key body fields |
|---|---|---|---|
| 1 | routing_decision | info | celeste-os → route, confidence=1, threshold=0.9, matched_directory=/…/CelesteOS-Cloud |
| 2 | worker_dispatch_result | info | celeste-os, session=806c11be…, cost_usd=0.0190544, result="Investigate **apps/api/routes/billing.ts**…" |
| 3 | routing_decision | info | myi2 → route, confidence=1, threshold=0.9, matched_directory=/…/MYI2 |
| 4 | worker_dispatch_result | info | myi2, session=4f5d46d6…, cost_usd=0.0184274, result="The `calculate_premium` function…" |
| 5 | routing_decision | info | acme-legacy-checkout → **fallback**, confidence=0, matched_directory=**null** |
| 6 | unrouted_error | warn | acme-legacy-checkout, reason=no_ownership_match, unrouted_error_id=2d80250e…, would_be_spawn_suppressed=**true** |

Full row dump: `02-forge/results/g5_events_final.txt`.

`controlplane.unrouted_errors` — exactly 1 row:
```
                  id                  |      project_id      |                    culprit                     | exception_type  |       reason       | matched_confidence |       status       |          received_at
--------------------------------------+-----------------------+-------------------------------------------------+------------------+---------------------+---------------------+---------------------+-------------------------------
 2d80250e-26c3-4895-8b25-602d30fa9085 | acme-legacy-checkout | unknown/service/checkoutProxy in handleRequest | ConnectionError | no_ownership_match |      (null)        | needs_human_review | 2026-08-19 23:38:55.709054+00
```
`matched_confidence` is `NULL` (not `0`) — deliberately distinguishing "no candidate row even
existed to score" from "a candidate scored below threshold" (the latter would have stored a
numeric confidence). This run only exercised the first case; the code path for the second
(a matched row whose confidence still falls under `confidence_threshold`) exists
(`routable = !!owner && confidence >= threshold`) but was not separately exercised since the
task's minimum bar (at least one unmapped-project fallback) was already met and exact-match-only
lookup means every match in this MVP is confidence 1.0 by construction — noted as a real gap,
not glossed over, in §9.

Full row dump: `02-forge/results/g5_unrouted_final.txt`.

## 8. A cosmetic bug found and fixed mid-run (disclosed, not hidden)

The first `pgExec()` implementation captured `psql`'s stdout without the `-q` flag, so an
`INSERT … RETURNING id` came back as `"<uuid>\nINSERT 0 1"` instead of just `"<uuid>"`. This
never affected the actual database — the `unrouted_errors.id` column itself is a clean UUID
(confirmed in §7) — it only polluted the `unrouted_error_id` field logged into the
`unrouted_error` event's body (event id 6) and the summary line printed to the terminal.
Fixed by adding `-q` to `pgExec()`'s `psql` invocation (verified with a throwaway test insert
that came back clean), and the one affected event row was corrected in place via a direct
`jsonb_set` UPDATE rather than re-running the pipeline — re-spawning two more real workers to
regenerate a cosmetic logging field would have been wasteful, real spend for no new evidence.
`03-daemon/dispatcher.mjs` on disk now reflects the fix.

## 9. Honest gaps / what this run does NOT prove

- **Low-confidence fuzzy match was not separately exercised.** The task allowed but did not
  require it ("if you want to also simulate…"). Lookup here is exact-match-only, so every
  match is confidence 1.0 — the `confidence < threshold` branch of the fallback logic is
  written and reachable but untested by this run. A future gate should seed a row with a
  measured confidence below 0.9 (e.g. a fuzzy/partial project-id match) to exercise it.
- **`ps`-based non-spawn proof is weak in isolation** (see §6b) because this run is strictly
  sequential — a concurrent dispatcher (multiple items in flight) would be a stronger test of
  "the fallback item's processing never overlaps with an active spawn." The database-level
  absence (§6c) and the architectural argument (§6a) are the load-bearing proofs here, not the
  `ps` snapshots.
- **Only 1 worker role (`probe`) was exercised**, per the task's explicit read-only
  requirement. `spawn.mjs`'s `auditor` role (also read-only: `Read, Grep, Glob`) was not used
  in this run; `fixer`/`architect` (which include `Edit`/`Write`/`Bash`) were correctly never
  invoked anywhere in this pipeline — appropriate for a probe-only investigative dispatch, not
  a gap.
- **The ingest HTTP server was stopped after the test** (`pkill -f "node ingest.mjs"`,
  confirmed via a failed health check afterward) — it is not a persistent service. Postgres and
  Redis containers were left running per the standing reuse instruction.

## 10. Gate verdict

| Sub-condition | Result |
|---|---|
| `project_ownership` table created, 3 rows, real verified directories | PASS |
| HTTP ingest endpoint accepts fake Sentry payload, pushes to Redis | PASS — `LLEN` 0→1→2→3, `LRANGE` confirmed exact JSON |
| Dispatcher polls Redis (`BRPOP`), consumes all 3, queue ends empty | PASS |
| Happy path 1 (`celeste-os`) — correct dir, real worker, real result, cost & session logged to `events` | PASS |
| Happy path 2 (`myi2`) — correct dir, real worker, real result, cost & session logged to `events` | PASS |
| Fallback path (`acme-legacy-checkout`) — detected unroutable, **zero** `Worker` constructed | PASS |
| Fallback logged to a purpose-built human-review queue (`unrouted_errors`), not silently dropped | PASS |
| No hallucinated owner / no spawn in a guessed directory for the unmapped project | **PASS — the explicit failure mode did not occur** |

**G5: PASS.**

## 11. Containers / processes left running

```
central-mvp-redis   Up (unchanged from G4, port 6380)   ← reused, not recreated
central-mvp-pg      Up (unchanged from G4, port 5433)   ← reused, not recreated, schema now has 7 tables (5 from G4 + project_ownership + unrouted_errors)
node ingest.mjs      STOPPED (test server, killed after the run)
claude worker procs   NONE running (both happy-path workers exited cleanly, exit_code=0; fallback path never started one)
```

## 12. Real cost

Two real Claude spawns, `role: probe` (`claude-haiku-4-5-20251001`), 1 turn each, `Read`-tool
only, read-only by construction (no `Edit`/`Write`/`Bash` in the `probe` role's tool list):
- `celeste-os` worker: **$0.0190544**
- `myi2` worker: **$0.0184274**
- **Total: $0.0374818** (~$0.0375)

The fallback-path item spawned nothing and cost $0.
