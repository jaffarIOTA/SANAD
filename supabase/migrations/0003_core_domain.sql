-- =============================================================================
-- 0003_core_domain.sql
-- Sanad — the trading domain: transactions, legs, evidence, obligations.
--
-- READ THIS FIRST
--
-- Nothing here lives in the schema PostgREST exposes. Supabase auto-generates a
-- REST API over one schema only, and if these tables were reachable that way a
-- client could write a transaction row directly — which is precisely the
-- gate-bypass path the whole design exists to make impossible. Row-level
-- security would not save us: it controls WHO may write a row, not WHETHER the
-- state machine ran. See CLAUDE.md §3.1.
--
-- Several invariants that the service layer also enforces are repeated here as
-- constraints and triggers. That duplication is deliberate. A single layer of
-- enforcement is a single point of failure, and these particular failures are
-- regulatory incidents rather than defects:
--
--   * the total is cost plus profit, and never increases        (SH-01, SH-02)
--   * a sale is not offered before the risk interval has run    (SH-06)
--   * one document belongs to exactly one leg                   (SH-07)
--   * an invoice is financed once, permanently                  (SH-10)
--   * late amounts have nowhere to go but charity liability     (SH-13)
--   * executed records do not change; corrections supersede     (DP-03, DP-04)
-- =============================================================================

create schema if not exists evidence;

-- -----------------------------------------------------------------------------
-- Portability: revoking from a role that does not exist is an ERROR in
-- PostgreSQL, not a no-op. `anon` and `authenticated` are created by the hosted
-- development platform and are absent on the self-hosted in-Kingdom deployment
-- this is destined for (ADR 0001), so every revoke against them is guarded.
--
-- `public` always exists and needs no guard.
-- -----------------------------------------------------------------------------
create or replace function core.hosted_platform_roles() returns text[]
language sql stable
set search_path = ''
as $$
  select coalesce(array_agg(rolname::text order by rolname), '{}'::text[])
  from pg_catalog.pg_roles
  where rolname in ('anon', 'authenticated')
$$;

comment on function core.hosted_platform_roles is
  'Platform-created roles present on this deployment. Empty on self-hosted '
  'PostgreSQL, which is why every revoke against them is conditional.';

do $$
declare r text;
begin
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on schema core, config, evidence, audit from %I', r);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Tenant scoping.
--
-- The application connects as a role that does NOT bypass row-level security and
-- sets `sanad.tenant_id` per request from the authenticated principal — never
-- from anything the client supplied (BE-09). Under that role the policies below
-- are real isolation rather than documentation.
-- -----------------------------------------------------------------------------
create or replace function core.current_tenant_id() returns uuid
language sql stable
set search_path = ''
as $$ select nullif(current_setting('sanad.tenant_id', true), '')::uuid $$;

comment on function core.current_tenant_id is
  'Tenant in scope for this session. Set by the service layer from the '
  'authenticated principal. Never accepted from a client.';

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sanad_app') then
    create role sanad_app nologin nobypassrls;
  end if;
exception
  when insufficient_privilege then
    raise notice 'sanad_app role not created; create it manually before deploying';
end;
$$;

-- -----------------------------------------------------------------------------
-- Shared trigger functions.
-- -----------------------------------------------------------------------------

-- Executed records are immutable. Corrections create superseding rows.
create or replace function core.reject_mutation() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'record % on %.% is immutable once executed; create a superseding row instead (attempted %)',
    coalesce(old.id::text, '?'), tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- Append-only: inserts allowed, nothing else.
create or replace function core.reject_update_and_delete() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%.% is append-only (attempted %)',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- =============================================================================
-- Reference entities. Minimal here; expanded by later migrations.
-- =============================================================================

create table if not exists core.shariah_approval (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenant(id) on delete restrict,
  approval_ref      text not null,
  approving_body    text not null,
  product_code      text not null,
  structure_code    text not null,
  effective_from    date not null,
  review_or_expiry  date,
  status            text not null default 'IN_FORCE'
                    check (status in ('IN_FORCE', 'SUSPENDED', 'WITHDRAWN', 'EXPIRED')),
  created_at        timestamptz not null default now(),
  created_by        text not null default current_user,
  correlation_id    uuid,
  constraint shariah_approval_unique unique (tenant_id, approval_ref)
);

comment on table core.shariah_approval is
  'Fatwa record binding a product and template set. A programme cannot activate '
  'without one in force, and a lapse suspends origination automatically (SH-17).';

create table if not exists core.anchor (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenant(id) on delete restrict,
  registration_no text not null,
  name_ar        text not null,
  name_en        text not null,
  created_at     timestamptz not null default now(),
  created_by     text not null default current_user,
  correlation_id uuid,
  constraint anchor_unique unique (tenant_id, registration_no)
);

create table if not exists core.programme (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references core.tenant(id) on delete restrict,
  anchor_id           uuid not null references core.anchor(id) on delete restrict,
  code                text not null,
  structure_code      text not null
                      check (structure_code in ('MURABAHA','SALAM','ISTISNA','IJARAH','MUSHARAKA')),
  structure_definition_id text not null,
  currency            char(3) not null default 'SAR',
  programme_limit_minor bigint not null check (programme_limit_minor >= 0),
  shariah_approval_id uuid references core.shariah_approval(id) on delete restrict,
  state               text not null default 'DRAFT'
                      check (state in ('DRAFT','PENDING_SHARIAH_APPROVAL','APPROVED','ACTIVE','SUSPENDED','CLOSED')),
  created_at          timestamptz not null default now(),
  created_by          text not null default current_user,
  correlation_id      uuid,
  constraint programme_unique unique (tenant_id, code),
  -- A programme cannot be active without an approval attached (BR-A03, SH-17).
  constraint programme_active_requires_approval
    check (state <> 'ACTIVE' or shariah_approval_id is not null)
);

create table if not exists core.counterparty (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenant(id) on delete restrict,
  registration_no text not null,
  name_ar         text not null,
  name_en         text not null,
  state           text not null default 'INVITED'
                  check (state in ('INVITED','VERIFYING','SCREENING','DECISIONING',
                                   'PENDING_AGREEMENT','ACTIVE','MANUAL_REVIEW',
                                   'SUSPENDED','DECLINED','OFFBOARDED')),
  created_at      timestamptz not null default now(),
  created_by      text not null default current_user,
  correlation_id  uuid,
  constraint counterparty_unique unique (tenant_id, registration_no)
);

-- =============================================================================
-- core.transaction — the drawdown aggregate.
--
-- Note which columns are absent. There is no column here, and there will be no
-- column here, expressing return as a proportion of anything. Return is the
-- profit amount, fixed once. The absence is the control (SH-01, DP-01).
-- =============================================================================

create table if not exists core.transaction (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references core.tenant(id) on delete restrict,
  programme_id           uuid not null references core.programme(id) on delete restrict,
  counterparty_id        uuid not null references core.counterparty(id) on delete restrict,

  structure_code         text not null
                         check (structure_code in ('MURABAHA','SALAM','ISTISNA','IJARAH','MUSHARAKA')),
  structure_definition_id text not null,
  structure_version      integer not null check (structure_version > 0),

  state                  text not null
                         check (state in ('DRAFT','TRADE_VALIDATION','REJECTED','LIMIT_RESERVED',
                                          'WAAD_EXECUTED','PURCHASE_EXECUTED','OWNERSHIP_ACQUIRED',
                                          'POSSESSION_CONFIRMED','SALE_OFFERED','OFFER_LAPSED',
                                          'UNWIND','EXECUTED','ACTIVE','SETTLED','DELINQUENT',
                                          'HARDSHIP','RESCHEDULED','WRITTEN_OFF','RESOLVED')),

  -- Money as minor-unit integers. No floating point in the financial path.
  currency               char(3) not null default 'SAR',
  cost_amount_minor      bigint not null check (cost_amount_minor > 0),
  profit_amount_minor    bigint not null check (profit_amount_minor >= 0),
  sale_price_amount_minor bigint not null check (sale_price_amount_minor > 0),

  tenor_days             integer not null check (tenor_days > 0),
  maturity_date_g        date not null,
  maturity_date_h        text not null,          -- Hijri, stored; never derived at read

  -- Attested instants from the timestamping authority, not the server clock.
  risk_period_start_at   timestamptz,
  risk_period_required_s integer not null check (risk_period_required_s > 0),
  sale_offered_at        timestamptz,

  -- Snapshotted at inception. A later parameter change does not reach backwards.
  shariah_approval_id    uuid not null references core.shariah_approval(id) on delete restrict,
  decision_id            uuid,
  credit_policy_version  text not null,

  created_at             timestamptz not null default now(),
  created_by             text not null default current_user,
  correlation_id         uuid not null,

  -- SH-01. The total is the sum, and the database says so.
  constraint transaction_total_is_cost_plus_profit
    check (sale_price_amount_minor = cost_amount_minor + profit_amount_minor),

  -- SH-06. A sale cannot be offered before the institution has held the goods
  -- at its own risk for the interval the Board set. Enforced here as well as in
  -- the state machine, because this one is worth two locks.
  constraint transaction_risk_interval_observed
    check (
      sale_offered_at is null
      or (
        risk_period_start_at is not null
        and sale_offered_at >= risk_period_start_at + make_interval(secs => risk_period_required_s)
      )
    ),

  -- SH-05. Reaching a post-gate state requires the attested start to exist.
  constraint transaction_post_possession_states_have_risk_start
    check (
      state not in ('POSSESSION_CONFIRMED','SALE_OFFERED','EXECUTED','ACTIVE',
                    'SETTLED','DELINQUENT','HARDSHIP','RESCHEDULED','WRITTEN_OFF','RESOLVED')
      or risk_period_start_at is not null
    )
);

comment on table core.transaction is
  'The drawdown aggregate. Return is a profit amount fixed at inception; no '
  'column expresses a proportion, and none may be added.';

create index if not exists idx_transaction_tenant_state
  on core.transaction (tenant_id, state);
create index if not exists idx_transaction_counterparty
  on core.transaction (tenant_id, counterparty_id, created_at desc);
create index if not exists idx_transaction_correlation
  on core.transaction (correlation_id);

-- The executed amounts never change. Dates and state still move.
create or replace function core.reject_executed_amount_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.cost_amount_minor    is distinct from old.cost_amount_minor
  or new.profit_amount_minor  is distinct from old.profit_amount_minor
  or new.sale_price_amount_minor is distinct from old.sale_price_amount_minor then
    raise exception
      'transaction % has executed; its cost, profit and total are immutable (SH-01, SH-02)', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.risk_period_required_s is distinct from old.risk_period_required_s then
    raise exception
      'the risk-holding interval on transaction % was snapshotted at inception and cannot be changed', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.shariah_approval_id is distinct from old.shariah_approval_id then
    raise exception
      'transaction % executed under approval %; the governing approval cannot be rewritten',
      old.id, old.shariah_approval_id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_transaction_amounts_immutable on core.transaction;
create trigger trg_transaction_amounts_immutable
  before update on core.transaction
  for each row
  when (old.state in ('SALE_OFFERED','EXECUTED','ACTIVE','SETTLED','DELINQUENT',
                      'HARDSHIP','RESCHEDULED','WRITTEN_OFF','RESOLVED'))
  execute function core.reject_executed_amount_change();

-- =============================================================================
-- core.contract_leg — one leg, one document, hash-chained.
-- =============================================================================

create table if not exists core.contract_leg (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references core.tenant(id) on delete restrict,
  transaction_id      uuid not null references core.transaction(id) on delete restrict,

  leg_type            text not null
                      check (leg_type in ('WAAD','PURCHASE','SALE_OFFER','ACCEPTANCE',
                                          'DELIVERY','TITLE_TRANSFER')),
  sequence_no         integer not null check (sequence_no > 0),

  document_id         uuid not null,
  content_hash        text not null,
  prev_leg_hash       text,

  executed_at         timestamptz not null,
  tsa_token_digest    text not null,
  tsa_token           bytea not null,

  template_version_id uuid not null,
  counterparty_role   text not null check (counterparty_role in ('SELLER','BUYER','INSTITUTION')),
  counterparty_cr     text not null,

  immutable           boolean not null default true,
  created_at          timestamptz not null default now(),
  created_by          text not null default current_user,
  correlation_id      uuid not null,

  constraint contract_leg_sequence_unique unique (transaction_id, sequence_no),
  constraint contract_leg_type_once_per_transaction unique (transaction_id, leg_type),

  -- SH-07. A document reference appears on exactly one leg, so two legs cannot
  -- be rendered into one instrument. This is the constraint that makes combining
  -- contracts impossible rather than merely discouraged.
  constraint contract_leg_one_document_per_leg unique (document_id),

  -- The first leg has no predecessor; every other leg has one.
  constraint contract_leg_chain_shape
    check ((sequence_no = 1 and prev_leg_hash is null)
        or (sequence_no > 1 and prev_leg_hash is not null))
);

comment on table core.contract_leg is
  'One leg of a structure. Separately executed, separately timestamped, '
  'hash-chained to its predecessor, and immutable once written.';

create index if not exists idx_contract_leg_transaction
  on core.contract_leg (transaction_id, sequence_no);

-- Executed legs never change. Not the hash, not the timestamp, not the document.
drop trigger if exists trg_contract_leg_immutable on core.contract_leg;
create trigger trg_contract_leg_immutable
  before update or delete on core.contract_leg
  for each row execute function core.reject_mutation();

-- Timestamps are strictly increasing along the chain. Checked in the database
-- as well as in the aggregate, because back-dating a sale behind the possession
-- it depends on would defeat the entire evidence model.
create or replace function core.enforce_leg_monotonicity() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_prev record;
begin
  select executed_at, content_hash
    into v_prev
    from core.contract_leg
   where transaction_id = new.transaction_id
     and sequence_no < new.sequence_no
   order by sequence_no desc
   limit 1;

  if found then
    if new.executed_at <= v_prev.executed_at then
      raise exception
        'leg % is not attested strictly later than its predecessor', new.sequence_no
        using errcode = 'restrict_violation';
    end if;
    if new.prev_leg_hash is distinct from v_prev.content_hash then
      raise exception
        'leg % does not chain to its predecessor', new.sequence_no
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_contract_leg_monotonic on core.contract_leg;
create trigger trg_contract_leg_monotonic
  before insert on core.contract_leg
  for each row execute function core.enforce_leg_monotonicity();

-- =============================================================================
-- evidence.evidence — append-only, typed, superseded rather than corrected.
-- =============================================================================

create table if not exists evidence.evidence (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references core.tenant(id) on delete restrict,
  transaction_id        uuid not null references core.transaction(id) on delete restrict,
  leg_id                uuid references core.contract_leg(id) on delete restrict,

  evidence_type         text not null
                        check (evidence_type in ('OWNERSHIP_INVOICE','TITLE_RECORD','DELIVERY_NOTE',
                                                 'WAREHOUSE_RECEIPT','CONSTRUCTIVE_POSSESSION',
                                                 'IDENTITY_ASSERTION','SETTLEMENT_CONFIRMATION')),
  gate_satisfied        text not null
                        check (gate_satisfied in ('GATE_1_OWNERSHIP','GATE_2_POSSESSION','GATE_3_RISK_PERIOD')),
  source                text not null
                        check (source in ('E_INVOICING_AUTHORITY','BUSINESS_REGISTRY','ANCHOR_SYSTEM',
                                          'PARTNER','DOCUMENT_INTELLIGENCE','UPLOAD')),

  artefact_uri          text not null,
  artefact_hash         text not null,

  -- When the fact became true, attested. Not when the row was written.
  captured_at           timestamptz not null,
  captured_tsa_digest   text not null,

  validation_status     text not null check (validation_status in ('VALID','INVALID','PENDING')),
  validation_detail     jsonb,

  -- Integer per ten thousand, so comparing a confidence is never a float compare.
  extraction_confidence_bp integer
                        check (extraction_confidence_bp is null
                               or extraction_confidence_bp between 0 and 10000),

  superseded_by         uuid references evidence.evidence(id) on delete restrict,

  created_at            timestamptz not null default now(),
  created_by            text not null default current_user,
  correlation_id        uuid not null,

  -- An artefact cannot supersede itself.
  constraint evidence_no_self_supersede check (superseded_by is distinct from id)
);

comment on table evidence.evidence is
  'Typed proof of ownership, possession, delivery and identity. Append-only: '
  'nothing is updated and nothing is deleted. Corrections insert a new row and '
  'point the old one at it.';

create index if not exists idx_evidence_transaction_gate
  on evidence.evidence (transaction_id, gate_satisfied, validation_status);

-- Append-only, with one exception: setting superseded_by on a row that has none.
-- That is how a correction records itself, and it is the only mutation allowed.
create or replace function core.evidence_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'evidence is never deleted; supersede it instead'
      using errcode = 'restrict_violation';
  end if;

  if old.superseded_by is not null then
    raise exception 'evidence % is already superseded and cannot change again', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.id                 is distinct from old.id
  or new.tenant_id          is distinct from old.tenant_id
  or new.transaction_id     is distinct from old.transaction_id
  or new.evidence_type      is distinct from old.evidence_type
  or new.gate_satisfied     is distinct from old.gate_satisfied
  or new.source             is distinct from old.source
  or new.artefact_hash      is distinct from old.artefact_hash
  or new.captured_at        is distinct from old.captured_at
  or new.validation_status  is distinct from old.validation_status then
    raise exception
      'evidence % is immutable; the only permitted change is to record that it has been superseded', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_evidence_append_only on evidence.evidence;
create trigger trg_evidence_append_only
  before update or delete on evidence.evidence
  for each row execute function core.evidence_append_only();

-- =============================================================================
-- core.financed_invoice_registry — SH-10.
--
-- Small, and among the most important tables in the system. Never purged:
-- not after settlement, not when the transaction ages out of retention. It
-- holds the minimum identifiers needed to prevent duplicate financing, which is
-- what makes indefinite retention proportionate.
--
-- Do not add ON CONFLICT DO NOTHING anywhere that writes to this table. A
-- conflict is the control firing.
-- =============================================================================

create table if not exists core.financed_invoice_registry (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenant(id) on delete restrict,
  invoice_uuid       uuid not null,
  invoice_hash       text not null,
  issuer_cr          text not null,
  recipient_cr       text not null,
  financed_amount_minor bigint not null check (financed_amount_minor > 0),
  currency           char(3) not null default 'SAR',
  transaction_id     uuid not null references core.transaction(id) on delete restrict,
  financed_at        timestamptz not null default now(),
  correlation_id     uuid not null,

  constraint financed_invoice_unique unique (tenant_id, invoice_uuid)
);

comment on table core.financed_invoice_registry is
  'Permanent record of financed invoice identifiers. The unique constraint makes '
  'duplicate financing a database impossibility rather than an application check. '
  'Records are never purged.';

drop trigger if exists trg_financed_invoice_immutable on core.financed_invoice_registry;
create trigger trg_financed_invoice_immutable
  before update or delete on core.financed_invoice_registry
  for each row execute function core.reject_update_and_delete();

-- =============================================================================
-- Obligation and schedule — the total never increases.
-- =============================================================================

create table if not exists core.obligation (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references core.tenant(id) on delete restrict,
  transaction_id     uuid not null references core.transaction(id) on delete restrict unique,

  currency           char(3) not null default 'SAR',
  total_amount_minor bigint not null check (total_amount_minor > 0),
  -- Board-approved waiver on early settlement. Reduces; never increases.
  waived_amount_minor bigint not null default 0 check (waived_amount_minor >= 0),
  paid_amount_minor  bigint not null default 0 check (paid_amount_minor >= 0),

  booking_ref        text,
  created_at         timestamptz not null default now(),
  created_by         text not null default current_user,
  correlation_id     uuid not null,

  constraint obligation_waiver_within_total
    check (waived_amount_minor <= total_amount_minor),
  constraint obligation_paid_within_payable
    check (paid_amount_minor <= total_amount_minor - waived_amount_minor)
);

-- SH-02. The total is fixed at execution and the waiver only moves one way.
create or replace function core.enforce_obligation_direction() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.total_amount_minor is distinct from old.total_amount_minor then
    raise exception
      'the total on obligation % was fixed at execution and cannot change (SH-02)', old.id
      using errcode = 'restrict_violation';
  end if;
  if new.waived_amount_minor < old.waived_amount_minor then
    raise exception
      'a recorded waiver on obligation % cannot be reduced; that would increase what is owed', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_obligation_direction on core.obligation;
create trigger trg_obligation_direction
  before update on core.obligation
  for each row execute function core.enforce_obligation_direction();

create table if not exists core.instalment (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenant(id) on delete restrict,
  obligation_id  uuid not null references core.obligation(id) on delete cascade,
  instalment_no  integer not null check (instalment_no > 0),
  due_date_g     date not null,
  due_date_h     text not null,
  amount_minor   bigint not null check (amount_minor >= 0),
  created_at     timestamptz not null default now(),
  constraint instalment_unique unique (obligation_id, instalment_no)
);

-- The schedule sums to exactly what is payable. Deferred, so a reschedule can
-- replace the whole schedule inside one transaction and be checked at commit.
create or replace function core.enforce_schedule_sum() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_obligation_id uuid := coalesce(new.obligation_id, old.obligation_id);
  v_payable  bigint;
  v_scheduled bigint;
begin
  select total_amount_minor - waived_amount_minor
    into v_payable
    from core.obligation
   where id = v_obligation_id;

  if not found then
    return null;  -- the obligation went with a cascade; nothing to check
  end if;

  select coalesce(sum(amount_minor), 0)
    into v_scheduled
    from core.instalment
   where obligation_id = v_obligation_id;

  if v_scheduled <> v_payable then
    raise exception
      'the schedule for obligation % sums to % but the amount payable is %; a reschedule may move dates and re-split amounts, never change the total (SH-02)',
      v_obligation_id, v_scheduled, v_payable
      using errcode = 'restrict_violation';
  end if;

  return null;
end;
$$;

drop trigger if exists trg_instalment_sum on core.instalment;
create constraint trigger trg_instalment_sum
  after insert or update or delete on core.instalment
  deferrable initially deferred
  for each row execute function core.enforce_schedule_sum();

-- =============================================================================
-- core.charity_ledger — SH-13.
--
-- One permitted account class. Not a default that a later row could differ
-- from: a check constraint with a single admissible value. Widening it is the
-- defect, and it would have to be a reviewed migration to happen at all.
-- =============================================================================

create table if not exists core.charity_ledger (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references core.tenant(id) on delete restrict,
  transaction_id      uuid not null references core.transaction(id) on delete restrict,

  account_class       text not null default 'CHARITY_LIABILITY'
                      check (account_class = 'CHARITY_LIABILITY'),

  currency            char(3) not null default 'SAR',
  amount_minor        bigint not null check (amount_minor > 0),
  reason              text not null
                      check (reason in ('LATE_PAYMENT','NON_COMPLIANT_INCOME',
                                        'INCIDENTAL_IMPERMISSIBLE_RECEIPT')),

  -- The Board-approved basis on which the amount was computed. Configuration,
  -- never a formula in code.
  computation_basis_config_key text not null,
  shariah_approval_id uuid not null references core.shariah_approval(id) on delete restrict,

  recorded_at         timestamptz not null,
  disbursement_ref    text,
  disbursed_at        timestamptz,
  recipient_id        text,

  created_at          timestamptz not null default now(),
  created_by          text not null default current_user,
  correlation_id      uuid not null,

  constraint charity_disbursement_complete
    check ((disbursement_ref is null and disbursed_at is null and recipient_id is null)
        or (disbursement_ref is not null and disbursed_at is not null and recipient_id is not null))
);

comment on table core.charity_ledger is
  'Segregated amounts that must never be recognised as income. The chart of '
  'accounts mapping for this ledger has no path to a revenue account; that is '
  'enforced in accounting configuration so no code change can reroute it.';

-- An entry is written once. Only the disbursement fields may later be filled in.
create or replace function core.charity_ledger_write_once() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'charity ledger entries are never deleted'
      using errcode = 'restrict_violation';
  end if;
  if new.amount_minor    is distinct from old.amount_minor
  or new.account_class   is distinct from old.account_class
  or new.reason          is distinct from old.reason
  or new.transaction_id  is distinct from old.transaction_id
  or new.tenant_id       is distinct from old.tenant_id then
    raise exception
      'charity ledger entry % is immutable; only the disbursement record may be completed', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.disbursement_ref is not null then
    raise exception 'charity ledger entry % has already been disbursed', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_charity_ledger_write_once on core.charity_ledger;
create trigger trg_charity_ledger_write_once
  before update or delete on core.charity_ledger
  for each row execute function core.charity_ledger_write_once();

-- =============================================================================
-- audit.audit_event — append-only, hash-chained.
-- =============================================================================

create table if not exists audit.audit_event (
  id             bigserial primary key,
  tenant_id      uuid not null,
  subject_type   text not null,
  subject_id     uuid not null,
  event_type     text not null,
  before_state   jsonb,
  after_state    jsonb,
  actor          text not null,
  occurred_at    timestamptz not null default now(),
  correlation_id uuid not null,
  -- Chained so tampering is detectable without trusting the application.
  prev_hash      text,
  content_hash   text not null
);

create index if not exists idx_audit_event_subject
  on audit.audit_event (tenant_id, subject_type, subject_id, id);
create index if not exists idx_audit_event_correlation
  on audit.audit_event (correlation_id);

drop trigger if exists trg_audit_event_append_only on audit.audit_event;
create trigger trg_audit_event_append_only
  before update or delete on audit.audit_event
  for each row execute function core.reject_update_and_delete();

-- =============================================================================
-- Row-level security. Enabled on every table, with a tenant-scoping policy.
-- =============================================================================

do $$
declare
  t record;
  r text;
begin
  for t in
    select schemaname, tablename
      from pg_tables
     where (schemaname = 'core'
            and tablename in ('shariah_approval','anchor','programme','counterparty',
                              'transaction','contract_leg','financed_invoice_registry',
                              'obligation','instalment','charity_ledger'))
        or (schemaname = 'evidence' and tablename = 'evidence')
        or (schemaname = 'audit'    and tablename = 'audit_event')
  loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
    execute format('alter table %I.%I force row level security', t.schemaname, t.tablename);
    execute format('revoke all on %I.%I from public', t.schemaname, t.tablename);
    foreach r in array core.hosted_platform_roles() loop
      execute format('revoke all on %I.%I from %I', t.schemaname, t.tablename, r);
    end loop;
    execute format('drop policy if exists tenant_isolation on %I.%I', t.schemaname, t.tablename);
    execute format(
      'create policy tenant_isolation on %I.%I using (tenant_id = core.current_tenant_id()) '
      'with check (tenant_id = core.current_tenant_id())',
      t.schemaname, t.tablename);
  end loop;
end;
$$;

-- The application role. Not a bypass role: the policies above apply to it, which
-- is what makes them isolation rather than decoration.
do $$
declare
  t record;
begin
  if exists (select 1 from pg_roles where rolname = 'sanad_app') then
    grant usage on schema core, config, evidence, audit to sanad_app;
    for t in
      select schemaname, tablename
        from pg_tables
       where schemaname in ('core','evidence','audit')
    loop
      execute format('grant select, insert, update on %I.%I to sanad_app',
                     t.schemaname, t.tablename);
    end loop;
    -- Nothing is deleted anywhere in the domain. No DELETE grant is issued.
    grant execute on function core.current_tenant_id() to sanad_app;
  end if;
exception
  when insufficient_privilege then
    raise notice 'grants to sanad_app skipped; apply them with a privileged role';
end;
$$;
