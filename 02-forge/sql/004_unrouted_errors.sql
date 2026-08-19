-- CENTRAL control-plane MVP — G5 addition: unrouted_errors, the human-review fallback queue.
--
-- Design choice (documented per task instruction "your call, document which"): a
-- purpose-built table, NOT a reuse of `controlplane.pending_writes`. `pending_writes` models
-- a STAGED WRITE awaiting human confirm/cancel before a side effect executes (route,
-- action_class, resolved_fields, confirmed_at, executed_at, side_effect_id) — it assumes a
-- concrete action is already known and just needs a human gate before executing. An unrouted
-- error is the opposite case: the dispatcher does NOT know what action to take or who owns
-- it at all. Forcing it into pending_writes' shape would mean inventing a fake `route` and
-- `action_class` for a decision that was never made — exactly the kind of "hallucinate an
-- owner" failure mode this gate exists to prevent. A dedicated table keeps the fallback
-- queue's own shape honest: what came in, why it couldn't be routed, and its review status.
--
-- Same daemon/service-role staging precedent as G4's pending_writes: neither ai_writer nor
-- approver gets INSERT here. The dispatcher itself (running as the postgres/service persona,
-- see G5_RESULTS.md) writes the row; a human (via controlplane_approver, SELECT + status
-- UPDATE only) reviews and dispositions it. This mirrors G4 §3's "staging is the daemon/
-- service-role's job" design, not a new pattern.

create table if not exists controlplane.unrouted_errors (
  id                uuid primary key default gen_random_uuid(),
  received_at       timestamptz not null default now(),
  project_id        text,                          -- whatever the payload claimed, possibly bogus/unknown
  culprit           text,
  exception_type    text,
  exception_value   text,
  stack_frames      jsonb not null default '[]'::jsonb,
  raw_payload       jsonb not null default '{}'::jsonb,
  reason            text not null,                 -- e.g. 'no_ownership_match', 'confidence_below_threshold'
  matched_confidence numeric,                       -- confidence score computed, if any (null = no match at all)
  status            text not null default 'needs_human_review'
                     check (status in ('needs_human_review','reviewed_assigned','reviewed_discarded')),
  reviewed_at       timestamptz,
  reviewer          text,
  review_notes      text
);

create index unrouted_errors_status_idx on controlplane.unrouted_errors(status, received_at desc);

-- controlplane_approver: the human-review persona. Can see the queue and disposition it
-- (status/reviewed_at/reviewer/review_notes only) — cannot touch the original error fields.
grant select on controlplane.unrouted_errors to controlplane_approver;
grant update (status, reviewed_at, reviewer, review_notes) on controlplane.unrouted_errors to controlplane_approver;

-- controlplane_ai_writer: explicitly ZERO access. The whole point of this table is that the
-- automated persona could NOT make a routing decision — it must not be able to read or
-- silently clear its own overflow queue either.
revoke all on controlplane.unrouted_errors from controlplane_ai_writer;

-- Verify after apply:
--   select to_regclass('controlplane.unrouted_errors');  -- expect: controlplane.unrouted_errors
