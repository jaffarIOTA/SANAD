-- =============================================================================
-- 0006_origination_store.sql
-- Sanad — the origination request store and the idempotency ledger.
--
-- Replaces the in-memory stores in services/origination (CLAUDE.md §6: "to be
-- replaced now, not later"). Portable PostgreSQL, nothing platform-specific
-- (ADR 0001). Nothing here lives in the schema PostgREST exposes.
--
-- The request itself is stored as the engine's own state document (jsonb):
-- the state machine is the authority on its shape, and a relational
-- projection of a discriminated union would have to change every time the
-- union does. What is relational is what the service queries by: tenant,
-- partner, request id, state, sequence.
-- =============================================================================

create schema if not exists core;

-- -----------------------------------------------------------------------------
-- Origination requests
-- -----------------------------------------------------------------------------
create table if not exists core.origination_request (
  tenant_id          uuid        not null,
  request_id         text        not null,
  partner_id         text        not null,
  state              text        not null,
  request            jsonb       not null,
  partner_reference  text,
  sequence           bigint      generated always as identity,
  correlation_id     text        not null,
  created_at         timestamptz not null default now(),
  created_by         text        not null,
  updated_at         timestamptz not null default now(),
  primary key (tenant_id, request_id),
  constraint origination_request_state_matches check (request->>'state' = state)
);

create index if not exists origination_request_partner_feed
  on core.origination_request (tenant_id, partner_id, sequence desc);

create index if not exists origination_request_by_state
  on core.origination_request (tenant_id, state);

alter table core.origination_request enable row level security;

drop policy if exists origination_request_tenant on core.origination_request;
create policy origination_request_tenant on core.origination_request
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

-- -----------------------------------------------------------------------------
-- Idempotency ledger. `reserve` is one atomic insert; the port offers no
-- check-then-write, and neither does this table.
-- -----------------------------------------------------------------------------
create table if not exists core.idempotency_key (
  tenant_id      uuid        not null,
  partner_id     text        not null,
  key            text        not null,
  fingerprint    text        not null,
  status         text        not null check (status in ('IN_FLIGHT', 'COMPLETE')),
  response       jsonb,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  primary key (tenant_id, partner_id, key),
  constraint idempotency_complete_has_response check (status <> 'COMPLETE' or response is not null)
);

alter table core.idempotency_key enable row level security;

drop policy if exists idempotency_key_tenant on core.idempotency_key;
create policy idempotency_key_tenant on core.idempotency_key
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

-- Keys are never updated except to complete; never deleted by application code.
-- A retention job may purge keys older than the contract's replay window.
