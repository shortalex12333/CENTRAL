-- CENTRAL control-plane MVP — F1: attempt-burn hardening for the claim queue.
--
-- Porting the three properties documented in 01-audit/EXTRACTION_MANIFEST.md §B4,
-- sourced from JARVIS/jarvis-runner/src/jarvis_runner/workers/embed_queue.py:1-171
-- (read-only reference, NOT modified, NOT executed — the pattern is ported, the file isn't):
--   (a) stale-reclaim is AGE-GATED (embed_queue.py:82-92, reclaim_stale) so a restarted
--       sibling can never yank a live worker's fresh in-flight rows;
--   (b) a reclaim BURNS AN ATTEMPT (embed_queue.py:94-102) so a row whose worker hard-crashes
--       repeatedly (skips finalize) eventually reaches 'failed' instead of wedging the queue
--       head forever;
--   (c) finalize is OWNERSHIP-GUARDED (embed_queue.py:49-79, .eq("status","processing")) so
--       it never clobbers a row a sibling has since reclaimed or that was re-enqueued.
--
-- ── Column audit against 001_schema.sql (avoid duplicating what already exists) ───────────
-- `attempts` (int, default 0) and `max_attempts` (int, default 3) are ALREADY on
-- controlplane.items (001_schema.sql:86-87) — JARVIS's embed_queue used a single global
-- EMBED_MAX_ATTEMPTS constant; controlplane.items already generalizes that to a per-row
-- column, which this migration's reclaim function uses as the terminal threshold. The
-- `alter table ... add column if not exists` below is therefore a no-op guard, not new state.
--
-- `claimed_at` for age-gating: controlplane.items has NO column by that literal name, but
-- claim_batch() (001_schema.sql:190-193) already sets `started_at = now()` at the exact
-- moment a row is claimed — semantically identical to what a `claimed_at` column would hold.
-- Adding a second timestamp column that means the same thing as an existing one is exactly
-- the duplication this task's own instructions warn against for `attempts`; the same
-- discipline applies here. DECISION: reclaim_stale_batch() below age-gates on `started_at`,
-- not a new `claimed_at` column. No new timestamp column is added.
--
-- Grants: no new columns beyond a no-op guard means no new column-grant surface either.
-- controlplane_ai_writer's existing grant (002_roles.sql:48-49) already covers every column
-- reclaim_stale_batch() touches (status, attempts, last_error, claimed_by, started_at,
-- finished_at) — only EXECUTE on the new function needs to be added below.

alter table controlplane.items add column if not exists attempts int not null default 0;
alter table controlplane.items add column if not exists max_attempts int not null default 3;

-- ────────────────────────────────────────────────────────────────────────────────────────
-- RECLAIM_STALE_BATCH — age-gated, attempt-burning stale-processing reclaim. Added ALONGSIDE
-- claim_batch() (not a rewrite of it): claim_batch's own WHERE (status='pending') already
-- excludes anything this function marks 'failed', so claim_batch needs no change to stay
-- safe — a poison row simply stops being visible to it once status flips to 'failed'.
--
-- Ownership guard mirrors embed_queue.py's finalize(): the UPDATE re-checks
-- `status = 'processing'` in its own WHERE, on top of `FOR UPDATE SKIP LOCKED` in the
-- candidates CTE, so two concurrent reclaim calls (or a reclaim racing a live finalize)
-- can't double-burn the same row's attempt count.
-- ────────────────────────────────────────────────────────────────────────────────────────
create or replace function controlplane.reclaim_stale_batch(
  p_stale_seconds int default 300,   -- production default: 5 min. Tests pass a short value.
  p_batch_size     int default 1000
)
returns setof controlplane.items
language plpgsql
security definer
set search_path = controlplane, pg_temp
as $$
begin
  return query
  with candidates as (
    select i.id
    from controlplane.items i
    where i.status = 'processing'
      and i.started_at is not null
      and i.started_at < now() - (p_stale_seconds || ' seconds')::interval
    order by i.started_at asc
    limit p_batch_size
    for update skip locked
  )
  update controlplane.items i
  set attempts    = i.attempts + 1,
      status      = case when i.attempts + 1 >= i.max_attempts
                          then 'failed'::controlplane.item_status
                          else 'pending'::controlplane.item_status
                     end,
      finished_at = case when i.attempts + 1 >= i.max_attempts then now() else i.finished_at end,
      -- non-terminal branch: clear started_at so the row reads as truly un-claimed again
      -- (claim_batch sets it fresh on the next real claim); terminal branch: leave it as
      -- the timestamp of the last (fatal) processing attempt, for forensics.
      started_at  = case when i.attempts + 1 >= i.max_attempts then i.started_at else null end,
      claimed_by  = case when i.attempts + 1 >= i.max_attempts then i.claimed_by else null end,
      last_error  = case when i.attempts + 1 >= i.max_attempts
                          then 'reclaimed: stale processing exceeded max_attempts'
                          else 'reclaimed: stale processing (attempt burned)'
                     end
  from candidates c
  where i.id = c.id
    and i.status = 'processing'   -- ownership guard, belt-and-braces alongside SKIP LOCKED
  returning i.*;
end;
$$;

grant execute on function controlplane.reclaim_stale_batch(int, int) to controlplane_ai_writer;

-- Verify after apply:
--   select proname, prosecdef from pg_proc where proname = 'reclaim_stale_batch';  -- prosecdef = true
--   select column_name from information_schema.columns
--     where table_schema='controlplane' and table_name='items' and column_name in ('attempts','max_attempts');
