-- CENTRAL control-plane MVP — G5 addition: project ownership table.
-- Maps a fake/synthetic Sentry "project_id" to a REAL local directory this dispatcher is
-- allowed to spawn a worker inside. Deliberately tiny (3 rows) and deliberately exact-match
-- only — anything not in this table is, by construction, unroutable, which is the whole
-- point of G5's fallback path. See 02-forge/BUILD_AND_TEST_BLUEPRINT.md §G5 and
-- 02-forge/results/G5_RESULTS.md for the full test.
--
-- Each `local_directory` below was verified with `ls -la <dir>` immediately before this file
-- was written — see G5_RESULTS.md §1 for the ls output proving all three are real, existing
-- directories on this machine, not placeholders.

create table if not exists controlplane.project_ownership (
  project_id           text primary key,
  project_name         text not null,
  local_directory       text not null,
  confidence_threshold  numeric not null default 0.9,
  created_at            timestamptz not null default now()
);

insert into controlplane.project_ownership (project_id, project_name, local_directory, confidence_threshold)
values
  ('celeste-os', 'CelesteOS-Cloud', '/Users/celeste7/Documents/CelesteOS-Cloud', 0.9),
  ('myi2',       'MYI2',            '/Users/celeste7/Documents/MYI2',           0.9),
  ('influence',  'INFLUENCE',       '/Users/celeste7/Documents/INFLUENCE',      0.9)
on conflict (project_id) do nothing;

-- Least-privilege: ai_writer (the dispatcher's automated persona, if it were used instead
-- of the direct postgres/service connection — see G5_RESULTS.md for which one the dispatcher
-- actually uses and why) may look up ownership but never modify it. Modifying who owns what
-- directory is an admin/config action, not something an automated routing decision should do.
grant select on controlplane.project_ownership to controlplane_ai_writer;
grant select on controlplane.project_ownership to controlplane_approver;
revoke insert, update, delete, truncate on controlplane.project_ownership from controlplane_ai_writer, controlplane_approver;

-- Verify after apply:
--   select * from controlplane.project_ownership order by project_id;   -- expect 3 rows
