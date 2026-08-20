# F1 — claim_batch() attempt-burn hardening: RESULTS

**Target:** `controlplane` schema, docker container `central-mvp-pg` (port 5433, db `postgres`) — reused, not recreated.
**Migration:** `02-forge/sql/005_claim_attempt_burn.sql` — applied to the live container.
**Source of hardening properties:** `01-audit/EXTRACTION_MANIFEST.md` §B4, traced to `JARVIS/jarvis-runner/src/jarvis_runner/workers/embed_queue.py:1-171` (read-only reference — file was read, never modified or executed).

## 1. What changed and what didn't (column audit against `001_schema.sql`)

`controlplane.items` **already had** `attempts int not null default 0` and `max_attempts int not null default 3` (`001_schema.sql:86-87`) — the migration's `add column if not exists` for both is a no-op guard, confirmed by the apply-time NOTICEs:

```
NOTICE:  column "attempts" of relation "items" already exists, skipping
NOTICE:  column "max_attempts" of relation "items" already exists, skipping
```

`claimed_at` for age-gating was **not added as a new column.** `claim_batch()` (`001_schema.sql:190-193`) already sets `started_at = now()` at the exact moment a row is claimed — semantically identical to what a new `claimed_at` column would hold. Adding a second timestamp meaning the same thing as an existing one is exactly the duplication the task's own instructions warn against for `attempts`; the same discipline was applied here. **Decision: age-gating reads `started_at`. No new timestamp column exists in the schema.**

Because no new column was added beyond the no-op guard, no new grants were needed on `items` — `controlplane_ai_writer`'s existing column-scoped UPDATE grant (`status, attempts, last_error, claimed_by, started_at, finished_at`, from `002_roles.sql:48-49`) already covers everything `reclaim_stale_batch()` touches. Only `EXECUTE` on the new function was granted.

## 2. New function: `controlplane.reclaim_stale_batch(p_stale_seconds int default 300, p_batch_size int default 1000)`

Added **alongside** `claim_batch()`, not a rewrite of it — `claim_batch()`'s own `WHERE status = 'pending'` already structurally excludes anything this function marks `'failed'`, so it needed no change to stay safe.

Ports all three §B4 properties:
- **(a) age-gated**: only reclaims `status='processing'` rows whose `started_at < now() - p_stale_seconds`. A live/fresh claim is never touched (proven §3 below).
- **(b) burns an attempt**: every reclaim does `attempts = attempts + 1`; if the new count `>= max_attempts` (per-row column, not a global constant) the row goes **terminal `'failed'`** instead of back to `'pending'`.
- **(c) ownership-guarded**: the `UPDATE` re-checks `status = 'processing'` in its own `WHERE`, on top of `FOR UPDATE SKIP LOCKED` in the candidate CTE — mirrors `embed_queue.py`'s `finalize()` guard.

Verified live: `select proname, prosecdef from pg_proc where proname='reclaim_stale_batch';` → `reclaim_stale_batch | t` (SECURITY DEFINER, matches `claim_batch`).

## 3. Live test — exact row states and attempt counts observed

Test script: `reclaim_stale_batch` exercised against three seeded rows in `controlplane.items` (`source` = `f1_test_a/b/c`), stale threshold **3 seconds** (short threshold for a real test, per task instruction), staleness simulated by directly backdating `started_at` by 10s. "Claim" steps use a direct `UPDATE` setting the identical fields `claim_batch()` sets internally (`status='processing', started_at=now(), claimed_by=<worker>`), which avoids a real contamination hazard found in a first draft of this test: the shared `items` table already held leftover `pending`/`processing` rows from a prior gate's `round-trip-test` fixture, and `claim_batch()`'s global-oldest-first ordering grabbed those instead of the row a naive test expected — a live illustration of exactly the kind of "could it have fired on the wrong row" check this project's engineering discipline requires. All three test rows started `pending, attempts=0, max_attempts=3` (the table default).

**Round 0 — negative control (age-gate does not fire on a fresh claim):**
`item_a` and `item_c` claimed (`status=processing`, `attempts=0`, `started_at=now()`). `reclaim_stale_batch(3, 100)` called **immediately** (same second) → returned 0 rows for either. Confirms the age gate genuinely gates: a live in-flight claim is not yanked just because it is `status='processing'`.

**Round 1:** `item_a.started_at` backdated 10s (> 3s threshold). `reclaim_stale_batch(3, 100)`:
- `item_a`: `attempts 0 → 1`, `status: processing → pending`, `started_at → NULL`, `last_error = "reclaimed: stale processing (attempt burned)"`.
- `item_c` (never backdated, control): unchanged — `status=processing, attempts=0`.

**Round 2:** `item_a` re-claimed (`worker-2`, `status=processing, attempts=1`), backdated again. `reclaim_stale_batch(3, 100)`:
- `item_a`: `attempts 1 → 2`, `status: processing → pending`.

**Round 3 (terminal):** `item_a` re-claimed (`worker-3`, `status=processing, attempts=2`), backdated again. `reclaim_stale_batch(3, 100)`:
- `item_a`: `attempts 2 → 3` (`== max_attempts`), **`status: processing → failed`** (not `pending`), `finished_at` set to the reclaim timestamp, `claimed_by` retained as `worker-3` (forensic trail of the last fatal attempt), `last_error = "reclaimed: stale processing exceeded max_attempts"`.

Full cycle observed: **pending → processing → stale → pending → processing → stale → pending → processing → stale → failed**, attempts `0 → 1 → 2 → 3`, exactly matching the pending↔processing↔stale cycling + terminal-on-cap requirement.

**Round 4 — subsequent reclaim on the failed row:** `reclaim_stale_batch(3, 100)` called again (row's `started_at` is still 10s+ old, would satisfy the age predicate if status mattered) → **0 rows returned**, `item_a` unchanged (`status=failed, attempts=3`). Structurally excluded by `WHERE status='processing'` — a failed row is never reclaimed again regardless of how stale its timestamp looks.

**Round 5 — subsequent claim attempt on the failed row:** `select * from claim_batch(50, 3, 'worker-4') where id = <item_a>` → **0 rows**. Structurally excluded by `claim_batch`'s own `WHERE status='pending'`.

**Final proof query:** `select count(*) from items where id=<item_a> and status in ('pending','processing')` → **`0`**. `item_a` is in neither set — confirmed absent from both.

**Final row states (verbatim from the live table):**

| source | status | attempts | max_attempts | claimed_by | last_error |
|---|---|---|---|---|---|
| `f1_test_a` | **failed** | **3** | 3 | worker-3 | reclaimed: stale processing exceeded max_attempts |
| `f1_test_b` | processing | 0 | 3 | worker-4 | *(null)* |
| `f1_test_c` | processing | 0 | 3 | worker-fresh | *(null)* |

`item_b` note: it was never touched by any `reclaim_stale_batch` call (it was `status='pending'` throughout every reclaim round, structurally invisible to a function that only ever selects `status='processing'`); it was legitimately picked up by the final `claim_batch(50,…)` call in Round 5 as an ordinary pending row — expected behavior, and its `attempts` staying at `0` confirms it was never attempt-burned, only ever claimed once as a normal (non-stale) item. `item_c` is the clean "claimed once, left fresh" control: it survived all four `reclaim_stale_batch` calls in this run untouched (`status=processing, attempts=0` throughout) because it was never backdated — direct proof the age gate discriminates on actual staleness, not merely on `status='processing'`.

## 4. Verdict

All five task requirements confirmed against the live container:
1. Seeded 3 items — done.
2. Claimed a row, marked `processing` with a fresh claim timestamp — done, and proven **not** reclaimable while fresh (Round 0).
3. Backdated to simulate staleness (10s age vs. 3s threshold) — done.
4. Repeated reclaim: `attempts` incremented each round (0→1→2→3), row cycled `pending → processing → stale → pending` three times — done, observed directly.
5. After `attempts >= max_attempts`, row landed in terminal `failed` and a subsequent reclaim call did not touch it, and is absent from both the pending and processing sets — done, observed directly (Rounds 4/5 + final proof query, both returning 0 rows).

**PASS.**
