-- 0038_consumer_loan.sql
-- Sanad — a consumer loan booked in the institution's loan system, and its servicing
-- (BNPL first): how its instalments are collected, and what happened to each.
--
-- The loan system is the system of record for the schedule (core/ports/loan-servicing.ts):
-- Sanad keeps no instalment table for these loans. What Sanad keeps is what only it knows:
--
--   core.consumer_loan        one row per loan — the terms disclosed and accepted, the collection
--                             channel the customer chose and the reference of its mandate.
--                             Immutable: a loan is never edited.
--   core.consumer_loan_event  what happened since, in order — booked in the loan system (and
--                             where), a collection queued, settled or returned, a repayment posted
--                             into the loan system, an instalment reported overdue, the loan
--                             closed. Append-only; the latest events give the current state.
--
-- The mandate reference points at the rail's own record (a bill account, a direct-debit
-- mandate, a card token, a payment-initiation consent, the customer's own account): never an
-- account number, a card number or a national identifier. The audit chain records each row
-- without amounts or references to the person.
--
-- Portable PostgreSQL. `core`, never `public`.

create table if not exists core.consumer_loan (
  id                     uuid        primary key default gen_random_uuid(),
  tenant_id              uuid        not null references core.tenant(id) on delete restrict,
  -- Sanad's transaction id, e.g. txn_00007: the loan system's external reference.
  loan_ref               text        not null check (loan_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'),
  product_code           text        not null check (product_code ~ '^[a-z][a-z0-9-]{1,63}$'),
  applicant_ref          text        not null check (applicant_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'),
  -- Where it was originated: the checkout session or the offer.
  origin_ref             text        not null,
  merchant_ref           text,
  principal_minor_units  bigint      not null check (principal_minor_units > 0),
  currency               char(3)     not null,
  -- As disclosed and accepted: the nominal rate and the APR core/pricing/apr.ts computed, basis points.
  rate_bp                bigint      not null check (rate_bp >= 0),
  apr_bp                 bigint      not null check (apr_bp >= 0),
  number_of_instalments  integer     not null check (number_of_instalments between 1 and 60),
  interval_days          integer     not null check (interval_days between 1 and 366),
  first_due_date         date        not null,
  -- core/jurisdiction/profile.ts CollectionChannel; the jurisdiction profile decides which are offered.
  collection_channel     text        not null
                         check (collection_channel in ('BILL_PRESENTMENT','DIRECT_DEBIT','CARD','PAYMENT_INITIATION','OWN_ACCOUNT')),
  collection_mandate_ref text        not null check (collection_mandate_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$'),
  correlation_id         text        not null,
  created_at             timestamptz not null default now(),
  created_by             text        not null,
  constraint consumer_loan_ref_unique unique (tenant_id, loan_ref)
);

create table if not exists core.consumer_loan_event (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references core.tenant(id) on delete restrict,
  loan_ref          text        not null,
  kind              text        not null check (kind in (
                      'BOOKED_IN_LOAN_SYSTEM',
                      'COLLECTION_QUEUED',
                      'COLLECTION_SETTLED',
                      'COLLECTION_RETURNED',
                      'REPAYMENT_POSTED',
                      'INSTALMENT_OVERDUE',
                      'LOAN_CLOSED')),
  -- The instalment the event is about, by its place in the schedule; null for the loan as a whole.
  schedule_number   integer     check (schedule_number is null or schedule_number >= 1),
  -- References and figures, never a personal datum: contract and account references, settlement
  -- references, minor-unit amounts as strings, days past due, the source (LIVE or FIXTURE).
  detail            jsonb       not null default '{}'::jsonb,
  -- Exactly-once: a collection or a posting is recorded once for its idempotency key.
  idempotency_key   text        not null,
  sequence          bigint      generated always as identity,
  correlation_id    text        not null,
  created_at        timestamptz not null default now(),
  created_by        text        not null,
  constraint consumer_loan_event_once unique (tenant_id, idempotency_key),
  constraint consumer_loan_event_loan foreign key (tenant_id, loan_ref)
    references core.consumer_loan (tenant_id, loan_ref) on delete restrict
);

create index if not exists consumer_loan_event_by_loan on core.consumer_loan_event (tenant_id, loan_ref, sequence);

-- -----------------------------------------------------------------------------
-- Tenancy, currency and immutability.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['core.consumer_loan', 'core.consumer_loan_event'] loop
    execute format('alter table %s enable row level security', t);
    -- Forced, so the owner is held to the policy too (0018, SR-003).
    execute format('alter table %s force row level security', t);
    execute format('drop policy if exists tenant_scope on %s', t);
    execute format(
      'create policy tenant_scope on %s using (tenant_id = core.current_tenant_id()) with check (tenant_id = core.current_tenant_id())',
      t);
    execute format('drop trigger if exists trg_append_only on %s', t);
    execute format(
      'create trigger trg_append_only before update or delete on %s for each row execute function core.reject_update_and_delete()',
      t);
  end loop;
end;
$$;

-- A loan is in its tenant's base currency (0013): an AED loan cannot sit on a riyal book.
drop trigger if exists trg_tenant_currency on core.consumer_loan;
create trigger trg_tenant_currency before insert or update on core.consumer_loan
  for each row execute function core.assert_tenant_currency();

-- -----------------------------------------------------------------------------
-- Who may touch them: the runtime role only (0018), never a hosted platform role.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
  r text;
begin
  foreach t in array array['core.consumer_loan', 'core.consumer_loan_event'] loop
    execute format('revoke all on %s from public', t);
    foreach r in array core.hosted_platform_roles() loop
      execute format('revoke all on %s from %I', t, r);
    end loop;
    execute format('grant select, insert on %s to sanad_app', t);
  end loop;
end;
$$;

grant usage on sequence core.consumer_loan_event_sequence_seq to sanad_app;

-- -----------------------------------------------------------------------------
-- The audit chain (0019): that a loan was recorded and what happened to it. No amounts, no
-- mandate reference, nothing about the person.
-- -----------------------------------------------------------------------------
create or replace function audit.on_consumer_loan() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.consumer_loan', new.id, 'CONSUMER_LOAN_RECORDED', null,
    jsonb_build_object(
      'loanRef', new.loan_ref,
      'productCode', new.product_code,
      'collectionChannel', new.collection_channel),
    new.created_by, audit.as_uuid(new.correlation_id));
  return null;
end
$$;

create or replace function audit.on_consumer_loan_event() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.consumer_loan_event', new.id, new.kind, null,
    jsonb_build_object('loanRef', new.loan_ref, 'scheduleNumber', new.schedule_number),
    new.created_by, audit.as_uuid(new.correlation_id));
  return null;
end
$$;

drop trigger if exists trg_audit_consumer_loan on core.consumer_loan;
create trigger trg_audit_consumer_loan
  after insert on core.consumer_loan
  for each row execute function audit.on_consumer_loan();

drop trigger if exists trg_audit_consumer_loan_event on core.consumer_loan_event;
create trigger trg_audit_consumer_loan_event
  after insert on core.consumer_loan_event
  for each row execute function audit.on_consumer_loan_event();

-- -----------------------------------------------------------------------------
-- The outbox learns payment initiation (a consented pull from the customer's bank, open banking in
-- the Kingdom, open finance in the UAE), the fourth way a consumer instalment is collected.
-- -----------------------------------------------------------------------------
alter table core.outbox_event drop constraint if exists outbox_event_kind_check;
alter table core.outbox_event add constraint outbox_event_kind_check
  check (kind in ('PAYMENT_DISBURSE','PAYMENT_COLLECT','PAYMENT_INITIATE','BUREAU_REPORT','PARTNER_CALLBACK','NOTIFICATION','BILL_PRESENT'));

-- -----------------------------------------------------------------------------
-- The UAE's open-banking rail is Open Finance under the CBUAE: its own adapter code, so a UAE
-- tenant's payment-initiation credential is never read from the Saudi Open Banking row.
-- -----------------------------------------------------------------------------
alter table config.integration_credential
  drop constraint if exists integration_credential_provider_check;

alter table config.integration_credential
  add constraint integration_credential_provider_check check (provider in (
    -- Platform and Saudi rails (migration 0007)
    'TUUM', 'NUTRIENT', 'ZATCA', 'NAFATH', 'YAKEEN', 'TAHAQOQ', 'WATHQ', 'SIMAH', 'BAYAN', 'GOSI',
    'OPEN_BANKING', 'SADAD', 'PAYMENTS_HUB', 'RATE_PUBLISHER', 'COMMODITY_BROKER', 'WORKFLOW_ENGINE',
    'SCREENING', 'CSP', 'TSA',
    -- UAE rails (migration 0015, ADR 0005)
    'AECB', 'UAE_PASS', 'ICP', 'NER', 'MOHRE', 'FTA', 'PARTNER_BANK',
    'OPEN_FINANCE',    -- Open Finance under the CBUAE (this migration)
    -- Document object store (migration 0026)
    'S3_STORAGE'
  ));
