-- CENTRAL control-plane MVP — F2: fuzzy-confidence ownership lookup.
--
-- G5's ownership lookup was EXACT-MATCH-ONLY (see 003_ownership.sql's own header comment:
-- "deliberately exact-match only"). That meant `confidence` was always exactly 1.0 (a row
-- existed) or the row simply didn't exist at all — there was no partial-match concept, and
-- the `confidence < threshold` branch of the dispatcher's routing logic was written but
-- structurally unreachable (see G5_RESULTS.md §7/§9: "exact-match-only lookup means every
-- match in this MVP is confidence 1.0 by construction"). This migration builds the piece
-- that makes that branch reachable for the first time.
--
-- pg_trgm ships in the standard postgres:15-alpine contrib modules; confirmed present via
-- `SELECT * FROM pg_extension` (only plpgsql was enabled before this) and enabled here.
create extension if not exists pg_trgm;

-- GIN trigram index — not required for correctness (similarity() works without it), but a
-- fuzzy-match function that claims to use pg_trgm should actually be indexed for it, not
-- just happen to have the extension loaded. Sequential scan over 4 rows would work fine too;
-- this is about the function being genuinely production-shaped, not a scale requirement.
create index if not exists project_ownership_trgm_idx
  on controlplane.project_ownership using gin (project_id gin_trgm_ops);

-- New seeded row: a genuine near-miss PAIR against the existing 'myi2' row, pointing at the
-- SAME real directory (MYI2 is one project with two plausible identifiers a monitoring
-- system might send — e.g. a legacy vs current service name). Deliberately NOT a copy of the
-- task's own literal 'myi2-app' example — this project uses a longer id
-- ('myi2-app-service') specifically because a short base string (8 chars) trigram-caps a
-- clean single-character-typo similarity at exactly 0.90 (verified empirically — see
-- F2_FUZZY_MATCH_RESULTS.md §2), which is not "clearly above" the 0.9 threshold. The longer
-- id leaves room for a one-character typo to land comfortably above 0.9 (0.9444, see below)
-- while still being an obvious, natural near-miss of 'myi2'.
insert into controlplane.project_ownership (project_id, project_name, local_directory, confidence_threshold)
values
  ('myi2-app-service', 'MYI2', '/Users/celeste7/Documents/MYI2', 0.9)
on conflict (project_id) do nothing;

-- controlplane.lookup_owner_fuzzy(incoming_project_id)
--
-- Returns at most one row: the owner match plus how it was matched and its score.
--   1. EXACT match (project_id = incoming_project_id) always wins when it exists, scored
--      1.0 by construction — an exact string match is never re-scored through similarity()
--      and re-exposed to float rounding; match_type='exact'.
--   2. Otherwise, FUZZY fallback: trigram similarity() of the incoming id against every
--      seeded project_id, best match wins, match_type='fuzzy'. This ALWAYS returns the best
--      available candidate, even when its score is low (e.g. 0.03) — the function's job is
--      only to report the best match and its score, never to decide routability. The CALLER
--      (dispatcher.mjs) compares similarity_score against that row's own confidence_threshold
--      and treats a below-threshold result as unroutable, exactly as the exact-match path
--      already did for confidence=1.0 vs threshold.
--
-- Returns zero rows only if controlplane.project_ownership is completely empty.
create or replace function controlplane.lookup_owner_fuzzy(incoming_project_id text)
returns table (
  project_id            text,
  project_name          text,
  local_directory        text,
  confidence_threshold   numeric,
  match_type             text,
  similarity_score       double precision
)
language sql
stable
as $$
  select po.project_id, po.project_name, po.local_directory, po.confidence_threshold,
         'exact'::text as match_type, 1.0::double precision as similarity_score
  from controlplane.project_ownership po
  where po.project_id = incoming_project_id

  union all

  -- Fuzzy branch is its own subquery so ORDER BY/LIMIT scope to IT alone, not to the
  -- combined UNION ALL result (a bare top-level ORDER BY after UNION ALL can only see output
  -- column names, not table aliases like po — this subquery avoids that trap).
  select project_id, project_name, local_directory, confidence_threshold, match_type, similarity_score
  from (
    select po.project_id, po.project_name, po.local_directory, po.confidence_threshold,
           'fuzzy'::text as match_type,
           similarity(po.project_id, incoming_project_id)::double precision as similarity_score
    from controlplane.project_ownership po
    where not exists (
      select 1 from controlplane.project_ownership where project_id = incoming_project_id
    )
    order by similarity(po.project_id, incoming_project_id) desc, po.project_id asc
    limit 1
  ) fuzzy_best;
$$;

comment on function controlplane.lookup_owner_fuzzy(text) is
  'F2: ownership lookup with trigram fallback. Exact match scores 1.0; otherwise returns the '
  'single best fuzzy candidate (by pg_trgm similarity) and its real score. Caller decides '
  'routability by comparing the returned similarity_score to the returned confidence_threshold.';

-- Same least-privilege posture as the table itself (003_ownership.sql): a lookup is read-only
-- and safe to expose to the automated persona even though the dispatcher in this MVP connects
-- as postgres directly (see G5_RESULTS.md §3 for why).
grant execute on function controlplane.lookup_owner_fuzzy(text) to controlplane_ai_writer;
grant execute on function controlplane.lookup_owner_fuzzy(text) to controlplane_approver;

-- Verify after apply:
--   select * from controlplane.project_ownership order by project_id;              -- expect 4 rows
--   select * from controlplane.lookup_owner_fuzzy('myi2');                         -- exact, score 1.0
--   select * from controlplane.lookup_owner_fuzzy('myi2-appp-service');            -- fuzzy, ~0.944
--   select * from controlplane.lookup_owner_fuzzy('influence-legacy');             -- fuzzy, ~0.588
