-- AntigravityWorker — extend the `runtime` CHECK constraint added by
-- 001_runtime_column.sql to allow 'antigravity' as a third valid value,
-- alongside the existing 'claude'/'gemini'.
--
-- Checked FIRST, live, before writing this:
--   \d controlplane.events               → confirms the column exists as
--                                           `runtime text not null default 'claude'`
--                                           with constraint `events_runtime_check
--                                           CHECK (runtime = ANY (ARRAY['claude','gemini']))`.
--   select runtime, count(*) from controlplane.events group by runtime;
--                                         → claude=10, gemini=1 (11 rows total) at time
--                                           of this migration. No 'antigravity' rows yet
--                                           — this migration only widens the allowed set,
--                                           it does not touch any existing row.
--
-- Postgres has no `ALTER CONSTRAINT ... ADD VALUE` for a plain CHECK (that syntax is
-- only for native ENUM types, which this column is not — it's `text` + CHECK, matching
-- 001's own choice). The only way to widen a CHECK is drop + recreate it. This is safe
-- here: it's a metadata-only operation (no table rewrite, no lock beyond a brief
-- ACCESS EXCLUSIVE on the constraint), and the new constraint is a strict superset of
-- the old one, so no existing row can violate it.

alter table controlplane.events
  drop constraint if exists events_runtime_check;

alter table controlplane.events
  add constraint events_runtime_check
  check (runtime in ('claude', 'gemini', 'antigravity'));

-- Verify after apply:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conname = 'events_runtime_check';
--     -- expect: CHECK (runtime = ANY (ARRAY['claude','gemini','antigravity']))
--   select runtime, count(*) from controlplane.events group by runtime order by runtime;
--     -- expect: claude/gemini counts unchanged, 0 antigravity rows until
--     -- AntigravityWorker's first real write.
