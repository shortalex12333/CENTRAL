-- CENTRAL control-plane MVP — G4 roles.
-- Replaces jarvis-runner/sql/002_grants.sql, which is EXPLICITLY NOT PORTED.
--
-- What 002_grants.sql did (the bug): granted `anon` (and authenticated/service_role)
-- `ALL` on every table in the runner schema, INCLUDING runner.pending_writes (the
-- human-approval fence) and runner.token_store (OAuth tokens) — directly contradicted
-- by 014_ai_writer_role.sql in the same directory, which does the opposite for a
-- narrower role. jarvis-runner/sql/014_ai_writer_role.sql is the pattern actually
-- mirrored here: column-level grants, explicit REVOKE of delete/truncate/references/
-- trigger, a fresh role starts with zero privileges and only gets exactly what it needs.
--
-- Two roles, two personas, kept structurally unable to do each other's job:
--   controlplane_ai_writer — the automated worker/agent persona. Can insert/select
--     capabilities/events/items/facts, can advance items through the queue (via
--     claim_batch, SECURITY DEFINER) and log outcomes. Cannot DELETE or TRUNCATE
--     anything. Cannot touch pending_writes AT ALL — no SELECT, no INSERT, no UPDATE.
--   controlplane_approver — the human-in-the-loop persona. The ONLY role that may
--     transition pending_writes.state (pending → confirmed/cancelled/executed/failed).
--     Cannot write to items/events/facts/capabilities at all.
--
-- Unlike 014 (NOLOGIN, reached only via Supabase's `authenticator` PostgREST role
-- switch) these are created LOGIN roles with passwords, because this MVP is tested
-- directly over psql/libpq — there is no PostgREST/authenticator layer here. The
-- privilege SHAPE is what's being ported, not the login mechanism.

-- ── controlplane_ai_writer ──────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'controlplane_ai_writer') then
    create role controlplane_ai_writer login password 'ai_writer_localtest';
  end if;
end$$;

grant usage on schema controlplane to controlplane_ai_writer;

-- SELECT + INSERT on the tables an automated worker legitimately touches.
-- pending_writes is DELIBERATELY ABSENT from this list.
grant select, insert on
  controlplane.capabilities,
  controlplane.events,
  controlplane.items,
  controlplane.facts
to controlplane_ai_writer;

-- Column-scoped UPDATE only — the queue-processing columns, nothing else.
-- facts is append-only by design (mirrors 014's note): no UPDATE grant at all;
-- a correction must INSERT a new row with supersedes_id set.
grant update (status, attempts, last_error, claimed_by, started_at, finished_at)
  on controlplane.items to controlplane_ai_writer;
grant update (enabled)
  on controlplane.capabilities to controlplane_ai_writer;

-- Sequences (bigserial on events.id) feeding INSERTs on grantable tables.
grant usage, select on all sequences in schema controlplane to controlplane_ai_writer;

-- Let the ai_writer execute the atomic claim RPC (SECURITY DEFINER — runs as the
-- function owner regardless, but EXECUTE must still be granted explicitly).
grant execute on function controlplane.claim_batch(int, int, text) to controlplane_ai_writer;

-- Belt-and-braces, mirroring 014_ai_writer_role.sql §6 verbatim in spirit: make
-- sure the role has NOTHING it shouldn't, even if some future ALTER DEFAULT
-- PRIVILEGES tries to hand it something broader.
revoke delete, truncate, references, trigger on all tables in schema controlplane from controlplane_ai_writer;
revoke all on controlplane.pending_writes from controlplane_ai_writer;

-- ── controlplane_approver ───────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'controlplane_approver') then
    create role controlplane_approver login password 'approver_localtest';
  end if;
end$$;

grant usage on schema controlplane to controlplane_approver;

-- Read pending_writes + whatever item it references, to make an informed decision.
grant select on controlplane.pending_writes, controlplane.items to controlplane_approver;

-- The ONLY column-scoped write path onto pending_writes.state and its timestamps.
grant update (state, confirmed_at, cancel_reason, executed_at, side_effect_id)
  on controlplane.pending_writes to controlplane_approver;

revoke delete, truncate, references, trigger on all tables in schema controlplane from controlplane_approver;
-- Approver gets nothing at all on items/events/facts/capabilities beyond the SELECT above.

-- ── Verification (run after apply) ─────────────────────────────────────────
--   select rolname, rolcanlogin from pg_roles where rolname like 'controlplane_%';
--   select grantee, table_name, privilege_type from information_schema.role_table_grants
--     where grantee in ('controlplane_ai_writer','controlplane_approver')
--     order by grantee, table_name;
