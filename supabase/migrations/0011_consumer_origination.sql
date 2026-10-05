-- 0011_consumer_origination.sql
-- Sanad — the consumer journey's records: offers, acceptances, checkout
-- sessions and the merchant's idempotency keys.
--
-- These were process memory in the consumer app. An acceptance is the record
-- a regulator asks for — which disclosure was shown, to which verified
-- identity, when — so it is append-only here, and "an offer is accepted
-- once" is a uniqueness constraint rather than a check in application code.
--
-- Platform-specific: nothing. Portable PostgreSQL, in the `core` schema,
-- never `public`.

-- -----------------------------------------------------------------------------
-- Offers. Written once at quotation; the figures the customer was shown.
-- -----------------------------------------------------------------------------
create table if not exists core.offer (
  tenant_id          uuid        not null references core.tenant(id),
  offer_id           text        not null,
  applicant_ref      text        not null,
  product_code       text        not null,
  -- The whole stored offer (quote, disclosure, APR, both maturity dates), as issued.
  body               jsonb       not null,
  disclosure_version text        not null,
  expires_at_epoch   bigint      not null,
  sequence           bigint      generated always as identity,
  correlation_id     text        not null,
  created_at         timestamptz not null default now(),
  created_by         text        not null,
  primary key (tenant_id, offer_id)
);

alter table core.offer enable row level security;
drop policy if exists offer_tenant on core.offer;
create policy offer_tenant on core.offer
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

-- An offer is a snapshot: issued, then never changed. Repricing issues a new offer.
drop trigger if exists trg_offer_immutable on core.offer;
create trigger trg_offer_immutable
  before update or delete on core.offer
  for each row execute function core.reject_update_and_delete();

-- -----------------------------------------------------------------------------
-- Acceptances. Append-only; one per offer.
-- -----------------------------------------------------------------------------
create table if not exists core.offer_acceptance (
  tenant_id             uuid        not null,
  acceptance_id         text        not null,
  offer_id              text        not null,
  disclosure_version    text        not null,
  identity_assertion_id text        not null,
  locale_shown          text        not null check (locale_shown in ('ar-SA', 'en-SA')),
  -- Attested: the authority's time, its token digest and its identity.
  accepted_at_epoch     bigint      not null,
  accepted_tsa_digest   text        not null,
  accepted_tsa_authority text       not null,
  correlation_id        text        not null,
  created_at            timestamptz not null default now(),
  created_by            text        not null,
  primary key (tenant_id, acceptance_id),
  foreign key (tenant_id, offer_id) references core.offer (tenant_id, offer_id),
  -- An offer is accepted once. The second attempt fails here, not in a race.
  constraint offer_acceptance_once unique (tenant_id, offer_id)
);

alter table core.offer_acceptance enable row level security;
drop policy if exists offer_acceptance_tenant on core.offer_acceptance;
create policy offer_acceptance_tenant on core.offer_acceptance
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

drop trigger if exists trg_offer_acceptance_append_only on core.offer_acceptance;
create trigger trg_offer_acceptance_append_only
  before update or delete on core.offer_acceptance
  for each row execute function core.reject_update_and_delete();

-- -----------------------------------------------------------------------------
-- Checkout sessions. A state machine; the row follows the session's state.
-- -----------------------------------------------------------------------------
create table if not exists core.checkout_session (
  tenant_id       uuid        not null references core.tenant(id),
  session_id      text        not null,
  merchant_id     text        not null,
  state           text        not null,
  session         jsonb       not null,
  sequence        bigint      generated always as identity,
  correlation_id  text        not null,
  created_at      timestamptz not null default now(),
  created_by      text        not null,
  updated_at      timestamptz not null default now(),
  primary key (tenant_id, session_id),
  constraint checkout_session_state_matches check (session->>'state' = state)
);

create index if not exists checkout_session_merchant_feed
  on core.checkout_session (tenant_id, merchant_id, sequence desc);

alter table core.checkout_session enable row level security;
drop policy if exists checkout_session_tenant on core.checkout_session;
create policy checkout_session_tenant on core.checkout_session
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

-- -----------------------------------------------------------------------------
-- The merchant's idempotency keys for session creation: one key, one session.
-- -----------------------------------------------------------------------------
create table if not exists core.checkout_idempotency (
  tenant_id       uuid        not null,
  merchant_id     text        not null,
  idempotency_key text        not null,
  session_id      text        not null,
  correlation_id  text        not null,
  created_at      timestamptz not null default now(),
  created_by      text        not null,
  primary key (tenant_id, merchant_id, idempotency_key),
  foreign key (tenant_id, session_id) references core.checkout_session (tenant_id, session_id)
);

alter table core.checkout_idempotency enable row level security;
drop policy if exists checkout_idempotency_tenant on core.checkout_idempotency;
create policy checkout_idempotency_tenant on core.checkout_idempotency
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

-- Nothing here is reachable by a platform role: the application connects as
-- its own role and the tables sit outside the exposed schema.
do $$
declare
  r text;
  t text;
begin
  foreach t in array array['core.offer', 'core.offer_acceptance', 'core.checkout_session', 'core.checkout_idempotency'] loop
    execute format('revoke all on %s from public', t);
    foreach r in array core.hosted_platform_roles() loop
      execute format('revoke all on %s from %I', t, r);
    end loop;
  end loop;
end;
$$;
