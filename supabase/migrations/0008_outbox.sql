-- =============================================================================
-- 0008_outbox.sql
-- Sanad — the transactional outbox (CLAUDE.md §2, §5, §11).
--
-- An external side effect is a row written in the same transaction as the
-- state change that caused it. A worker claims due rows under a lease, calls
-- the port, and marks the row delivered, due again, or dead. The uniqueness
-- on (tenant_id, kind, idempotency_key) is what makes a second enqueue of the
-- same effect a no-op rather than a duplicate payment.
-- =============================================================================

create table if not exists core.outbox_event (
  tenant_id         uuid        not null,
  event_id          text        not null,
  kind              text        not null check (kind in ('PAYMENT_DISBURSE','PAYMENT_COLLECT','BUREAU_REPORT','PARTNER_CALLBACK','NOTIFICATION','BILL_PRESENT')),
  subject_ref       text        not null,
  idempotency_key   text        not null,
  payload           jsonb       not null,
  state             text        not null default 'PENDING' check (state in ('PENDING','DELIVERED','DEAD')),
  attempts          integer     not null default 0,
  next_attempt_at   timestamptz not null default now(),
  leased_until      timestamptz,
  last_error        text,
  delivery_ref      text,
  correlation_id    text        not null,
  created_at        timestamptz not null default now(),
  created_by        text        not null default 'platform',
  primary key (tenant_id, event_id),
  unique (tenant_id, kind, idempotency_key)
);

create index if not exists outbox_event_due on core.outbox_event (state, next_attempt_at) where state = 'PENDING';

alter table core.outbox_event enable row level security;
drop policy if exists outbox_event_tenant on core.outbox_event;
create policy outbox_event_tenant on core.outbox_event
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

-- Rows are never deleted by application code. A dead row is an exception for a person.
