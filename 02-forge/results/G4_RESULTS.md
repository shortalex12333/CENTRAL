# G4 Results — Local State Substrate (Postgres + Redis)

Date: 2026-08-19 · Seat: CENTRAL · Gate: G4 (BUILD_AND_TEST_BLUEPRINT.md)

Stands in for the future Hetzner-hosted state layer (explicitly NOT attempted here — this
gate is local-only, per the standing G4-before-G8 discipline). Proves the durable-queue and
human-approval primitives extracted from the JARVIS legacy audit
(`01-audit/EXTRACTION_MANIFEST.md` §B3/B4), INCLUDING re-provoking the two real bugs that
audit found, before this schema goes anywhere near a real server.

**Overall: PASS.** Every sub-condition below holds with observed output, not inference.

---

## 1. Containers

```
docker run -d --name central-mvp-pg -e POSTGRES_PASSWORD=localtest -p 5433:5432 postgres:15-alpine
docker run -d --name central-mvp-redis -p 6380:6379 redis:7-alpine
```

Confirmed healthy:
```
central-mvp-redis   Up   0.0.0.0:6380->6379/tcp   →  redis-cli ping → PONG
central-mvp-pg      Up   0.0.0.0:5433->5432/tcp    →  pg_isready -U postgres → accepting connections
```
`postgres:15-alpine` was already cached locally (`docker images` showed `3d0f7584ed7d`,
408MB) — zero pull time, per the instruction to use what's already pulled rather than 16.

## 2. Schema — applied cleanly, in the exact requested order

Files (read-only source SQL verified against actual files, not the manifest summary — see
each file's header comments for the exact source:line mirrored):

- `/Users/celeste7/Documents/CENTRAL/02-forge/sql/001_schema.sql` — schema `controlplane`,
  tables in order (a) `capabilities` (b) `events` (c) `items`+`item_status` enum
  (d) `pending_writes` (e) `facts` (f) `claim_batch()`.
- `/Users/celeste7/Documents/CENTRAL/02-forge/sql/002_roles.sql` — least-privilege roles
  (task 3, detailed in §3 below).

**Ordering note:** `events` (b) logically references `items` (c) and `capabilities` (a), but
the task specifies `events` before `items`. Rather than reordering the table list, `events`
is created first with its `item_id`/`capability_id` columns as bare `uuid`/`text`, and the two
FK constraints are added via `ALTER TABLE ... ADD CONSTRAINT` immediately after `items` exists
— same effective schema, requested table order preserved.

**Source verification, not manifest-summary invention:**
- `capabilities` mirrors `jarvis-runner/sql/001_init.sql:40-57` — same namespacing CHECK
  regex `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$` copied verbatim.
- `events` mirrors `jarvis-runner/sql/001_init.sql:110-119` verbatim in shape.
- `items` generalizes `kenoki-worker/migrations/001_enrichment_schema.sql:42-54`
  (`enrichment_queue`) — NOT JARVIS's own `runner.items` (`001_init.sql:13-30`), because the
  JARVIS version has no `attempts`/`queued_at`/`started_at`/`finished_at` columns and
  `claim_batch()` needs them. This was confirmed by actually reading both files side by side.
- `pending_writes` mirrors `jarvis-runner/sql/006_stage_3_4.sql:17-33` near-verbatim.
- `facts` mirrors `jarvis-runner/sql/007_facts.sql:16-25` near-verbatim (S/P/O + `supersedes_id`
  self-FK).
- `claim_batch()` generalizes `kenoki-worker/migrations/003_atomic_claim_rpc.sql:15-49`
  (`claim_enrichment_batch`) onto `controlplane.items` — same `FOR UPDATE SKIP LOCKED` CTE
  pattern, same `SECURITY DEFINER`, copied deliberately rather than re-derived.

Apply output (both files, `psql -v ON_ERROR_STOP=1`, exit code 0 both times):
```
001_schema.sql → CREATE SCHEMA, CREATE TABLE, ALTER TABLE, CREATE TABLE, CREATE INDEX ×2,
                 CREATE TYPE, CREATE TABLE, CREATE INDEX ×2, ALTER TABLE ×2, CREATE TABLE,
                 CREATE INDEX ×2, CREATE TABLE, CREATE INDEX ×2, CREATE FUNCTION   (19 statements, 0 errors)
002_roles.sql   → DO, GRANT ×6, REVOKE ×2, DO, GRANT ×3, REVOKE            (13 statements, 0 errors)
```
Post-apply verification:
```
\dt controlplane.*  →  capabilities, events, facts, items, pending_writes   (5 tables)
select proname, prosecdef from pg_proc where proname='claim_batch';  →  claim_batch | t
select rolname, rolcanlogin from pg_roles where rolname like 'controlplane_%';
  →  controlplane_ai_writer | t
     controlplane_approver  | t
```

## 3. Least-privilege roles (replacing `002_grants.sql`, task 3)

**`jarvis-runner/sql/002_grants.sql` was read and explicitly NOT ported.** It grants `anon`
(plus `authenticated`, `service_role`) `ALL` on every table in the runner schema, including
`pending_writes` (the approval fence) and `token_store` (OAuth tokens) — directly contradicted
by `014_ai_writer_role.sql` in the same source directory, which was read in full and mirrored
instead (column-level `GRANT UPDATE (col,…)`, explicit `REVOKE delete, truncate, references,
trigger`, zero access by default).

Two roles created, `002_roles.sql`:
- **`controlplane_ai_writer`** — automated worker/agent persona. `SELECT, INSERT` on
  `capabilities, events, items, facts`. Column-scoped `UPDATE` only on `items`
  (`status, attempts, last_error, claimed_by, started_at, finished_at`) and `capabilities.enabled`.
  `facts` has no UPDATE grant at all (append-only by design, matching 014's treatment of
  `runner.facts`). **Zero grants of any kind on `pending_writes`.** `EXECUTE` on `claim_batch()`.
  `DELETE/TRUNCATE/REFERENCES/TRIGGER` explicitly revoked on every table in the schema.
- **`controlplane_approver`** — human-in-the-loop persona. `SELECT` on `pending_writes, items`.
  Column-scoped `UPDATE` only on `pending_writes`
  (`state, confirmed_at, cancel_reason, executed_at, side_effect_id`). No access to
  `items/events/facts/capabilities` beyond that one SELECT. `DELETE/TRUNCATE/REFERENCES/TRIGGER`
  revoked.

Unlike `014` (`NOLOGIN`, reached only via Supabase's `authenticator` PostgREST role switch),
both roles here are `LOGIN` roles with passwords — this MVP is tested directly over
`psql`/libpq; there is no PostgREST/`authenticator` layer in this local substrate. The
privilege *shape* is what's ported, not the login mechanism.

## 4. Bug 1 re-provocation — the grants hole — **PASS (4/4 negative assertions correct)**

Task 4a — DELETE from any table, as `controlplane_ai_writer`:
```
DELETE FROM controlplane.items;           → ERROR: permission denied for table items       (exit 1)
DELETE FROM controlplane.capabilities;     → ERROR: permission denied for table capabilities (exit 1)
DELETE FROM controlplane.pending_writes;   → ERROR: permission denied for table pending_writes (exit 1)
TRUNCATE controlplane.facts;               → ERROR: permission denied for table facts        (exit 1)
```
Task 4b — write to `pending_writes` directly, as `controlplane_ai_writer`:
```
INSERT INTO controlplane.pending_writes (...) → ERROR: permission denied for table pending_writes (exit 1)
SELECT * FROM controlplane.pending_writes;     → ERROR: permission denied for table pending_writes (exit 1)
UPDATE controlplane.pending_writes SET state='confirmed'; → ERROR: permission denied for table pending_writes (exit 1)
```
`controlplane_ai_writer` has **zero** access to `pending_writes` — not read, not write, not
transition. This is stricter than "cannot confirm it"; it cannot even see it exists.

Control checks (to prove the split is real, not "both roles blocked"):
```
controlplane_approver SELECT + UPDATE(state) on pending_writes → succeeds (INSERT 0 1 / UPDATE 1)
controlplane_approver INSERT INTO controlplane.items            → ERROR: permission denied for table items (exit 1)
```
The approver can transition `pending_writes.state` but has no access to `items` — confirming
the two personas are structurally separated, not just union-of-privileges.

**Bug 1 verdict: CLOSED.** The `002_grants.sql` pattern (broad `anon` write including the
approval fence) cannot recur here — `controlplane_ai_writer` was tested directly against the
exact two actions the audit flagged, and both fail.

## 5. Bug 2 re-provocation — concurrent claim race, no load — **PASS (15/15 unique, 0 dupes)**

Seeded 15 `pending` items. Ran 10 concurrent `psql` processes (bash background jobs, `wait`),
each as `controlplane_ai_writer`, each calling `select id from controlplane.claim_batch(2,3,'worker_N')`
— batch size 2, so up to 20 claim slots contending for 15 rows.

```
Elapsed: 0.092 s (10 processes, wall clock, `date +%s.%N` around the `wait`)
Per-worker claims: worker_1..6=2 each, worker_7=1, worker_8=0, worker_9=2, worker_10=0
Total claimed across all workers:  15
Unique claimed ids (sort -u):      15   ← equals total → ZERO duplicates
stderr from any worker:            (empty)
```
DB-side confirmation (authoritative, independent of the shell aggregation above):
```
SELECT status, count(*) FROM controlplane.items GROUP BY status;
  processing | 15        ← all 15 seeded rows claimed, none left pending, none double-counted
SELECT claimed_by, count(*) FROM controlplane.items WHERE status='processing' GROUP BY claimed_by;
  worker_1..6 = 2 each, worker_7 = 1, worker_9 = 2   (8 of 10 workers got rows; worker_8/worker_10
  raced for the exhausted tail and correctly got 0 via SKIP LOCKED — not an error, correct behavior)
```
Union of all claims = exactly the 15 seeded rows, batch size respected (no worker exceeded 2),
zero duplicates, zero errors.

## 6. Bug 2 under simulated heavy load — **PASS (15/15 unique, 0 dupes, no deadlock, ~1.4× slower)**

`pgbench` was present in the `postgres:15-alpine` image (`/usr/local/bin/pgbench`, v15.18) —
no extra install needed. Initialized against the **same `postgres` database** the
`controlplane` schema lives in (`pgbench -i -s 10 postgres`, separate `public.pgbench_*`
tables, no collision with `controlplane.*`), then ran heavy concurrent load in the background:

```
docker exec -d central-mvp-pg sh -c "pgbench -U postgres -c 16 -j 4 -T 60 -P 5 postgres"
```
Confirmed genuinely active via `pg_stat_activity` before racing: **17 active pgbench
connections**, 22 total connections. Sustained throughput during the race window (progress
lines from pgbench itself):
```
progress:  5.0 s, 8760.2 tps, lat 1.817 ms stddev 3.550, 0 failed
progress: 10.0 s, 9053.7 tps, lat 1.760 ms stddev 1.416, 0 failed
progress: 15.0 s, 8841.8 tps, lat 1.802 ms stddev 1.472, 0 failed
progress: 20.0 s, 9531.2 tps, lat 1.672 ms stddev 1.367, 0 failed
```
Re-seeded 15 fresh `pending` items, re-ran the identical 10-way `claim_batch(2,3,'lworker_N')`
race while the above load was live:
```
Elapsed (under load): 0.128 s
Per-worker claims: lworker_1=2, 2=2, 3=1, 4=2, 5=2, 6=0, 7=0, 8=2, 9=2, 10=2
Total claimed: 15   |   Unique claimed: 15   ← ZERO duplicates
stderr from any worker: (empty)
```
DB-side confirmation: `status='processing'` count = 15, `claimed_by` breakdown sums to 15
across 8 distinct workers (same shape as the no-load run — 2 workers raced the exhausted tail
and correctly got 0 rows).

**Timing comparison:** 0.092 s (no load) → 0.128 s (under ~9,000 tps of contending load) —
**≈1.4× slower, still sub-second, still 100% correct.**

**Deadlock check:** `docker logs central-mvp-pg | grep -i "deadlock\|PANIC"` → **empty**. The
only `FATAL` lines in the container log (`connection to client lost` ×2) are from `pkill
pgbench` abruptly closing two pgbench client connections during cleanup afterward — unrelated
to the claim race, not a deadlock, not a `claim_batch` failure.

**Bug 2 verdict: CLOSED, and holds up under real contention.** `FOR UPDATE SKIP LOCKED`
degraded gracefully (workers whose claim would have blocked simply skipped to the next
available row or returned nothing) rather than serializing into a pileup or deadlocking.

## 7. `pending_writes` round-trip — **PASS (stage → confirm → execute, and stage → cancel → never-executed, both verified)**

Two items seeded (`aaaaaaaa-…01`, `aaaaaaaa-…02`, both `status='pending'`). Two
`pending_writes` rows staged against them by the service/superuser persona (neither
`controlplane_ai_writer` nor `controlplane_approver` can INSERT into `pending_writes` at all —
confirmed above in §4b; staging is the daemon/service-role's job, matching the original
`006_stage_3_4.sql` design where the daemon bypasses RLS to stage, and a human confirms):

```
pending_writes seeded: …001 route=calendar.create title=confirm-me  state=pending
                        …002 route=calendar.create title=cancel-me   state=pending
```
**Confirm path**, as `controlplane_approver`:
```
UPDATE pending_writes SET state='confirmed', confirmed_at=now() WHERE id=…001;  → UPDATE 1
```
**Cancel path**, as `controlplane_approver`:
```
UPDATE pending_writes SET state='cancelled', cancel_reason='user_cancel' WHERE id=…002; → UPDATE 1
```
**Executor** (simulated — mirrors the real daemon's rule: only ever act on `state='confirmed'`
rows): flips confirmed rows to `executed` + stamps `side_effect_id`, then applies the
corresponding effect to the linked `items` row (`status='done'`). **The cancelled row is never
touched by the executor query at all** — its `WHERE pw.state='confirmed'` predicate structurally
excludes it.

Final state:
```
pending_writes:
  …001 | state=executed  | side_effect_id=effect-…001 | title=confirm-me
  …002 | state=cancelled | cancel_reason=user_cancel   | side_effect_id=NULL | title=cancel-me

items:
  aaaaaaaa-…01 | status=done    | finished_at=2026-08-19 23:07:05  ← effect applied
  aaaaaaaa-…02 | status=pending | finished_at=NULL                 ← untouched, proves cancel = no effect
```
The cancelled write's linked item is still `status='pending'` with `finished_at IS NULL` —
direct proof no corresponding effect row/side-effect was ever created for it, per the pass
condition in task 7.

---

## Final state left running

```
docker ps --filter "name=central-mvp"
central-mvp-redis   Up   0.0.0.0:6380->6379/tcp
central-mvp-pg      Up   0.0.0.0:5433->5432/tcp
```
Final `controlplane` row counts (left in place, intentionally non-empty — the round-trip
test's 2 items + 2 pending_writes rows are the artifact proving §7, left as evidence):
```
capabilities=0  events=0  items=2  pending_writes=2  facts=0
```
`pgbench`'s `public.pgbench_*` tables were dropped after the load test (transient test
scaffolding, not part of the ported schema). `pgbench` process itself was killed
(`pkill pgbench` inside the container) after capturing the progress log above — no load
generator left running.

**Containers were left running per instruction (not torn down).** To reset when needed:
```bash
docker stop central-mvp-pg central-mvp-redis
docker rm central-mvp-pg central-mvp-redis
```
To reapply the schema fresh after a reset:
```bash
docker run -d --name central-mvp-pg -e POSTGRES_PASSWORD=localtest -p 5433:5432 postgres:15-alpine
docker run -d --name central-mvp-redis -p 6380:6379 redis:7-alpine
# wait for pg_isready, then:
PGPASSWORD=localtest docker exec -i central-mvp-pg psql -U postgres -v ON_ERROR_STOP=1 \
  < /Users/celeste7/Documents/CENTRAL/02-forge/sql/001_schema.sql
PGPASSWORD=localtest docker exec -i central-mvp-pg psql -U postgres -v ON_ERROR_STOP=1 \
  < /Users/celeste7/Documents/CENTRAL/02-forge/sql/002_roles.sql
```

## Gate verdict

| Sub-condition | Result |
|---|---|
| Schema applies cleanly, exact requested order | ✅ 19+13 statements, 0 errors |
| `controlplane_ai_writer` cannot DELETE/TRUNCATE any table | ✅ 4/4 denied |
| `controlplane_ai_writer` cannot touch `pending_writes` (read or write) | ✅ 3/3 denied |
| 10/10 concurrent claims unique, no load | ✅ 15/15 unique, 0 errors, 0.092s |
| 10/10 concurrent claims unique, under ~9,000 tps load | ✅ 15/15 unique, 0 errors, 0.128s, no deadlock |
| `pending_writes` stage → confirm → executed works | ✅ verified end state |
| `pending_writes` stage → cancel → never executes | ✅ linked item unchanged, no side_effect_id |

**G4: PASS.**
