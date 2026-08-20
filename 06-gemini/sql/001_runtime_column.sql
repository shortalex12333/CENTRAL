-- GX5 — add a `runtime` column to controlplane.events so a single shared events table
-- can distinguish which agent runtime produced each row.
--
-- Checked FIRST, live, before writing this (GX5 results doc has the full transcript):
--   \d controlplane.events            → columns are only id/emitted_at/kind/severity/
--                                        item_id/capability_id/duration_ms/body — no
--                                        runtime column, no runtime-shaped column at all.
--   select body ? 'runtime' ...        → false for every existing row (11 rows at time
--                                        of this migration, all from spawn.mjs/
--                                        dispatcher.mjs's Claude Worker — 03-daemon/
--                                        dispatcher.mjs's logEvent() never sets a
--                                        `runtime` key in `body` either).
-- So there is no existing way to distinguish runtime, and no ambiguity about what the
-- existing rows ARE: every row already in this table was produced by a Claude worker.
-- Existing rows are therefore explicitly backfilled to 'claude' (via the column
-- default, applied to existing rows automatically since this is a constant default —
-- no table rewrite/lock concern at this table's local-MVP row count) rather than left
-- NULL, matching the task brief's "runtime='claude' (or NULL, if that's how existing
-- rows are tagged -- check first)" — checked: NULL was not how they were tagged, they
-- simply had no tag, so 'claude' is the honest backfill, not a guess.

alter table controlplane.events
  add column if not exists runtime text not null default 'claude';

alter table controlplane.events
  add constraint events_runtime_check
  check (runtime in ('claude', 'gemini'));

create index if not exists events_runtime_idx on controlplane.events(runtime, emitted_at desc);

-- Verify after apply:
--   select runtime, count(*) from controlplane.events group by runtime;
--     -- expect: every pre-migration row now runtime='claude', 0 rows runtime='gemini'
--     -- until GeminiWorker's first real write.
--   select conname from pg_constraint where conname = 'events_runtime_check';
