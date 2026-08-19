-- CENTRAL control-plane MVP — G4 schema.
-- Adapted from the JARVIS legacy audit (EXTRACTION_MANIFEST.md §B3/B4). Ported onto a
-- NEW schema (`controlplane`) rather than reusing JARVIS's `runner` schema name, so this
-- can sit alongside any other local stack without collision. Target: local throwaway
-- postgres:15-alpine (docker: central-mvp-pg, port 5433). NOT applied to Hetzner — see
-- 01-audit/EXTRACTION_MANIFEST.md §B3 and 02-forge/BUILD_AND_TEST_BLUEPRINT.md G4/G8.
--
-- Source files read (read-only, unmodified):
--   JARVIS/jarvis-runner/sql/001_init.sql        → capabilities, events (table shapes)
--   JARVIS/jarvis-runner/sql/006_stage_3_4.sql    → pending_writes (table shape)
--   JARVIS/jarvis-runner/sql/007_facts.sql        → facts (append-only S/P/O + supersedes)
--   JARVIS/kenoki-worker/migrations/001_enrichment_schema.sql → enrichment_queue shape
--     (status enum values, attempts/queued_at/started_at/finished_at columns) — items
--     below generalizes this rather than JARVIS's items (which had no attempts/claim cols).
--   JARVIS/kenoki-worker/migrations/003_atomic_claim_rpc.sql  → claim_batch() pattern
--
-- EXPLICITLY NOT PORTED: jarvis-runner/sql/002_grants.sql (grants `anon` full write on
-- every table including pending_writes — flagged bug 1 in the audit). See 002_roles.sql
-- for the least-privilege replacement.
--
-- Ordering note: tables are created in the exact order the task specifies
-- (capabilities → events → items → pending_writes → facts → claim_batch). Because
-- `events` logically references `items` and `capabilities` but is created BEFORE `items`
-- in that ordering, its two FK columns are declared plain here and the FK constraints are
-- added via ALTER TABLE in a "deferred constraints" section right before items exists to
-- reference forward without reordering the table list.

create schema if not exists controlplane;

-- ────────────────────────────────────────────────────────────────────────────
-- (a) CAPABILITIES — self-describing tool registry. Mirrors jarvis-runner
-- sql/001_init.sql:40-57 (runner.capabilities), adapted onto controlplane schema.
-- The namespacing CHECK is the load-bearing bit: '{provider}.{verb}' or
-- '{provider}.{resource}.{verb}', enforced by regex, not convention.
-- ────────────────────────────────────────────────────────────────────────────
create table controlplane.capabilities (
  id              text primary key,                    -- '{provider}.{resource}.{verb}' OR '{provider}.{verb}'
  kind            text not null check (kind in ('mcp','direct_http','python')),
  auth_ref        text,                                 -- pointer to secret store; never the raw secret
  endpoint        jsonb,                                -- {mcp_id, tool} OR {method, url_template}
  input_schema    jsonb not null default '{}'::jsonb,
  output_schema   jsonb not null default '{}'::jsonb,
  scopes          text[] not null default '{}',
  description     text,
  created_at      timestamptz not null default now(),
  enabled         boolean not null default true
);

alter table controlplane.capabilities
  add constraint capabilities_id_namespaced
  check (id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$');

-- ────────────────────────────────────────────────────────────────────────────
-- (b) EVENTS — append-only audit/observability log. Mirrors jarvis-runner
-- sql/001_init.sql:110-119 (runner.events). item_id/capability_id FKs are added
-- below in the deferred-constraints section since `items` doesn't exist yet at
-- this point in the requested table order.
-- ────────────────────────────────────────────────────────────────────────────
create table controlplane.events (
  id              bigserial primary key,
  emitted_at      timestamptz not null default now(),
  kind            text not null,                        -- 'capability_call' | 'stage_transition' | 'claim' | 'error' | ...
  severity        text not null default 'info' check (severity in ('debug','info','warn','error','crit')),
  item_id         uuid,                                  -- FK added below (deferred — items created after events)
  capability_id   text,                                  -- FK added below (deferred)
  duration_ms     int,
  body            jsonb not null default '{}'::jsonb
);
create index events_recent_idx on controlplane.events(emitted_at desc);
create index events_kind_idx   on controlplane.events(kind, emitted_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- (c) ITEMS — durable work queue with a status enum. Table shape generalizes
-- kenoki-worker/migrations/001_enrichment_schema.sql:42-54 (enrichment_queue) —
-- that table (not JARVIS's runner.items) is the one with the attempts/queued_at/
-- started_at/finished_at columns claim_batch() actually needs. JARVIS's own
-- runner.items (sql/001_init.sql:13-30) has no claim-related columns at all.
-- ────────────────────────────────────────────────────────────────────────────
create type controlplane.item_status as enum ('pending','processing','done','failed','cancelled');

create table controlplane.items (
  id              uuid primary key default gen_random_uuid(),
  payload         jsonb not null default '{}'::jsonb,
  source          text not null,                         -- 'http' | 'file' | 'voice' | 'test' | etc.
  status          controlplane.item_status not null default 'pending',
  attempts        int not null default 0,
  max_attempts    int not null default 3,
  last_error      text,
  claimed_by      text,                                  -- worker/process identifier, set on claim
  queued_at       timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- Worker poll path — mirrors enrichment_schema.sql's idx_enrichment_queue_pending shape.
create index items_pending_idx on controlplane.items(queued_at) where status = 'pending';
create index items_status_idx  on controlplane.items(status, queued_at);

-- Deferred FKs from events → items/capabilities, now that items exists.
alter table controlplane.events
  add constraint events_item_id_fkey
  foreign key (item_id) references controlplane.items(id) on delete set null;
alter table controlplane.events
  add constraint events_capability_id_fkey
  foreign key (capability_id) references controlplane.capabilities(id) on delete set null;

-- ────────────────────────────────────────────────────────────────────────────
-- (d) PENDING_WRITES — human-approval staging. Mirrors jarvis-runner
-- sql/006_stage_3_4.sql:17-33 (runner.pending_writes) near-verbatim; this is
-- THE approval fence bug 1 (002_grants.sql) put a hole in. See 002_roles.sql —
-- only the approver role may transition `state`; the ai_writer role gets zero
-- grants on this table at all.
-- ────────────────────────────────────────────────────────────────────────────
create table controlplane.pending_writes (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null,
  item_id         uuid references controlplane.items(id) on delete cascade,
  route           text not null,                         -- e.g. 'calendar.create', 'linkedin.draft'
  action_class    text not null check (action_class in ('read','write_owned','write_external')),
  resolved_fields jsonb not null default '{}'::jsonb,
  confidence      real,
  state           text not null default 'pending'
                  check (state in ('pending','confirmed','cancelled','executed','failed')),
  cancel_reason   text,
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz,
  executed_at     timestamptz,
  side_effect_id  text
);

create index pending_writes_session_pending_idx
  on controlplane.pending_writes(session_id, created_at)
  where state = 'pending';
create index pending_writes_route_idx
  on controlplane.pending_writes(route, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- (e) FACTS — append-only S/P/O triple store with a `supersedes` self-reference.
-- Mirrors jarvis-runner sql/007_facts.sql:16-25 (runner.facts) near-verbatim.
-- A correction never UPDATEs — it INSERTs a new row whose supersedes_id points
-- at the row it replaces. "Current" = every row nothing else supersedes.
-- ────────────────────────────────────────────────────────────────────────────
create table controlplane.facts (
  id              uuid primary key default gen_random_uuid(),
  subject         text not null,
  predicate       text not null,
  object          text not null,
  source_item_id  uuid references controlplane.items(id) on delete set null,
  confidence      real,
  supersedes_id   uuid references controlplane.facts(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index facts_subject_idx on controlplane.facts(subject, created_at desc);
create index facts_supersedes_idx on controlplane.facts(supersedes_id) where supersedes_id is not null;

-- ────────────────────────────────────────────────────────────────────────────
-- (f) CLAIM_BATCH — atomic queue-claim RPC, FOR UPDATE SKIP LOCKED. Generalizes
-- kenoki-worker/migrations/003_atomic_claim_rpc.sql:15-49 (claim_enrichment_batch,
-- which claims from the people-specific `enrichment_queue`) onto the generic
-- `controlplane.items` queue defined above. Same locking pattern, copied
-- deliberately rather than re-derived — this is the primitive every future
-- worker depends on for safety against N concurrent claimants on one Postgres.
-- SECURITY DEFINER so a restricted caller (controlplane_ai_writer, see
-- 002_roles.sql) can still execute the claim transition even though it only
-- holds column-scoped UPDATE grants directly on items.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function controlplane.claim_batch(
  p_batch_size   int  default 5,
  p_max_attempts int  default 3,
  p_worker_id    text default null
)
returns setof controlplane.items
language plpgsql
security definer
set search_path = controlplane, pg_temp
as $$
begin
  return query
  with claimed as (
    select i.id
    from controlplane.items i
    where i.status = 'pending'
      and i.attempts < p_max_attempts
    order by i.queued_at asc
    limit p_batch_size
    for update skip locked
  )
  update controlplane.items i
  set status     = 'processing',
      started_at = now(),
      claimed_by = p_worker_id
  from claimed c
  where i.id = c.id
  returning i.*;
end;
$$;

-- Verify after apply:
--   select to_regclass('controlplane.items');              -- expect: controlplane.items
--   select proname, prosecdef from pg_proc where proname = 'claim_batch';  -- prosecdef = true
