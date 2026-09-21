-- =============================================================================
-- 0004_decisioning_and_limits.sql
-- Sanad — credit decisions, their evidence, and the facility they authorise.
--
-- A decision has to be reproducible years later: the same input snapshot and the
-- same policy version must return the same outcome (BR-C02). That means the
-- snapshot and the policy are stored, not referenced — a policy that has since
-- been superseded must still be readable exactly as it was, or the replay is
-- a different calculation wearing the same name.
--
-- Note again what is absent. A decision assigns capacity. It does not price
-- anything, so there is no column here for a price, and the policy documents
-- these rows point at are refused on load if they contain a pricing section.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The policy, stored as the document it was. Immutable once recorded.
-- -----------------------------------------------------------------------------
create table if not exists config.credit_policy_version (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references core.tenant(id) on delete restrict,
  policy_id            text not null,
  version              text not null,

  effective_from       timestamptz not null,
  effective_to         timestamptz,

  credit_approval_ref  text not null,
  approved_by_role     text not null,
  approved_on          timestamptz not null,

  -- The document itself. Replay reads this, never a current file on disk.
  document             jsonb not null,
  document_hash        text not null,

  created_at           timestamptz not null default now(),
  created_by           text not null default current_user,
  correlation_id       uuid,

  constraint credit_policy_version_unique unique (tenant_id, policy_id, version),
  constraint credit_policy_window_valid
    check (effective_to is null or effective_to > effective_from)
);

comment on table config.credit_policy_version is
  'Versioned, effective-dated credit policy, stored as the document that was '
  'approved. Authored and signed off outside the release cycle (BR-C08).';

-- Two versions of one policy cannot claim the same start; the governing version
-- must never be ambiguous.
create unique index if not exists uq_credit_policy_effective_from
  on config.credit_policy_version (tenant_id, policy_id, effective_from);

drop trigger if exists trg_credit_policy_immutable on config.credit_policy_version;
create trigger trg_credit_policy_immutable
  before delete on config.credit_policy_version
  for each row execute function core.reject_update_and_delete();

-- Only the closing date may be set later; everything else is fixed.
create or replace function config.credit_policy_close_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.document        is distinct from old.document
  or new.document_hash   is distinct from old.document_hash
  or new.version         is distinct from old.version
  or new.policy_id       is distinct from old.policy_id
  or new.effective_from  is distinct from old.effective_from
  or new.credit_approval_ref is distinct from old.credit_approval_ref then
    raise exception
      'credit policy version % is immutable; supersede it with a new version instead', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_credit_policy_close_only on config.credit_policy_version;
create trigger trg_credit_policy_close_only
  before update on config.credit_policy_version
  for each row execute function config.credit_policy_close_only();

-- -----------------------------------------------------------------------------
-- The input snapshot. Frozen at the moment of assessment.
-- -----------------------------------------------------------------------------
create table if not exists core.applicant_snapshot (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenant(id) on delete restrict,
  counterparty_id uuid not null references core.counterparty(id) on delete restrict,
  programme_id   uuid not null references core.programme(id) on delete restrict,

  captured_at    timestamptz not null,
  -- The whole snapshot. Everything the policy was allowed to see, and nothing
  -- it was not. No national identifier, no name, no address: the policy assesses
  -- the business, so a decision can be retained and replayed without retaining
  -- personal data (RC-05).
  facts          jsonb not null,
  facts_hash     text not null,

  created_at     timestamptz not null default now(),
  correlation_id uuid not null
);

create index if not exists idx_applicant_snapshot_counterparty
  on core.applicant_snapshot (tenant_id, counterparty_id, captured_at desc);

drop trigger if exists trg_applicant_snapshot_immutable on core.applicant_snapshot;
create trigger trg_applicant_snapshot_immutable
  before update or delete on core.applicant_snapshot
  for each row execute function core.reject_update_and_delete();

-- -----------------------------------------------------------------------------
-- The decision.
-- -----------------------------------------------------------------------------
create table if not exists core.decision (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references core.tenant(id) on delete restrict,
  counterparty_id     uuid not null references core.counterparty(id) on delete restrict,
  programme_id        uuid not null references core.programme(id) on delete restrict,

  snapshot_id         uuid not null references core.applicant_snapshot(id) on delete restrict,
  policy_version_id   uuid not null references config.credit_policy_version(id) on delete restrict,

  outcome             text not null check (outcome in ('APPROVE','REFER','DECLINE')),
  grade               text,
  score               integer not null,

  currency            char(3) not null default 'SAR',
  assigned_limit_minor bigint not null check (assigned_limit_minor >= 0),
  binding_cap_code    text,

  -- Champion or challenger. A challenger row is recorded and never applied.
  role_in_evaluation  text not null default 'CHAMPION'
                      check (role_in_evaluation in ('CHAMPION','CHALLENGER')),

  decided_at          timestamptz not null default now(),
  created_by          text not null default current_user,
  correlation_id      uuid not null,

  -- A refusal or a referral assigns nothing.
  constraint decision_limit_only_on_approval
    check (outcome = 'APPROVE' or assigned_limit_minor = 0)
);

comment on table core.decision is
  'A reproducible decision. Together with its snapshot and its stored policy '
  'version it can be replayed to the same outcome indefinitely.';

create index if not exists idx_decision_counterparty
  on core.decision (tenant_id, counterparty_id, decided_at desc);

drop trigger if exists trg_decision_immutable on core.decision;
create trigger trg_decision_immutable
  before update or delete on core.decision
  for each row execute function core.reject_update_and_delete();

-- -----------------------------------------------------------------------------
-- The trace. Every rule that ran, what it consumed, what it concluded.
-- This is the audit defence and the source of the customer-facing reason.
-- -----------------------------------------------------------------------------
create table if not exists core.decision_rule_trace (
  id             bigserial primary key,
  tenant_id      uuid not null references core.tenant(id) on delete restrict,
  decision_id    uuid not null references core.decision(id) on delete restrict,
  sequence_no    integer not null,
  stage          text not null
                 check (stage in ('DATA_SUFFICIENCY','KNOCKOUT','SCORECARD','GRADE',
                                  'LIMIT_BASIS','CAP','FAULT')),
  code           text not null,
  inputs         jsonb not null default '{}'::jsonb,
  result         text not null,
  points_awarded integer,
  reason_code    text,
  constraint decision_trace_unique unique (decision_id, sequence_no)
);

drop trigger if exists trg_decision_trace_append_only on core.decision_rule_trace;
create trigger trg_decision_trace_append_only
  before update or delete on core.decision_rule_trace
  for each row execute function core.reject_update_and_delete();

-- The reasons actually issued, with the wording that was issued. Stored rather
-- than re-derived, because the policy's wording may change and what the
-- counterparty was told must not (RC-11).
create table if not exists core.decision_reason (
  id           bigserial primary key,
  tenant_id    uuid not null references core.tenant(id) on delete restrict,
  decision_id  uuid not null references core.decision(id) on delete restrict,
  ordinal      integer not null,
  reason_code  text not null,
  text_ar      text not null check (length(trim(text_ar)) > 0),
  text_en      text not null check (length(trim(text_en)) > 0),
  constraint decision_reason_unique unique (decision_id, ordinal)
);

drop trigger if exists trg_decision_reason_append_only on core.decision_reason;
create trigger trg_decision_reason_append_only
  before update or delete on core.decision_reason
  for each row execute function core.reject_update_and_delete();

-- -----------------------------------------------------------------------------
-- Facility and reservation.
--
-- The highest-concurrency component, and the one where a correctness failure is
-- most expensive. Reservation happens before any external side effect, is
-- time-bounded, and expires automatically so an abandoned journey cannot strand
-- capacity (SDD §6.7).
-- -----------------------------------------------------------------------------
create table if not exists core.facility (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references core.tenant(id) on delete restrict,
  counterparty_id   uuid not null references core.counterparty(id) on delete restrict,
  programme_id      uuid not null references core.programme(id) on delete restrict,
  decision_id       uuid not null references core.decision(id) on delete restrict,

  currency          char(3) not null default 'SAR',
  limit_minor       bigint not null check (limit_minor >= 0),
  utilised_minor    bigint not null default 0 check (utilised_minor >= 0),

  state             text not null default 'ACTIVE'
                    check (state in ('ACTIVE','SUSPENDED','WITHDRAWN')),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  correlation_id    uuid not null,

  constraint facility_unique unique (tenant_id, counterparty_id, programme_id),
  constraint facility_utilisation_within_limit check (utilised_minor <= limit_minor)
);

create table if not exists core.limit_reservation (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references core.tenant(id) on delete restrict,
  facility_id    uuid not null references core.facility(id) on delete restrict,
  transaction_id uuid references core.transaction(id) on delete restrict,

  amount_minor   bigint not null check (amount_minor > 0),
  state          text not null default 'HELD'
                 check (state in ('HELD','CONSUMED','RELEASED','EXPIRED')),

  held_at        timestamptz not null default now(),
  expires_at     timestamptz not null,
  settled_at     timestamptz,

  correlation_id uuid not null,

  constraint reservation_expiry_after_hold check (expires_at > held_at),
  constraint reservation_settled_when_terminal
    check ((state = 'HELD' and settled_at is null) or (state <> 'HELD' and settled_at is not null))
);

create index if not exists idx_reservation_live
  on core.limit_reservation (facility_id, state, expires_at);

-- Held reservations plus recorded utilisation never exceed the facility. Checked
-- at commit, so a concurrent pair of drawdowns cannot both take the last of it.
create or replace function core.enforce_facility_capacity() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_facility_id uuid := coalesce(new.facility_id, old.facility_id);
  v_limit    bigint;
  v_utilised bigint;
  v_held     bigint;
begin
  select limit_minor, utilised_minor
    into v_limit, v_utilised
    from core.facility
   where id = v_facility_id
   for update;

  if not found then
    return null;
  end if;

  select coalesce(sum(amount_minor), 0)
    into v_held
    from core.limit_reservation
   where facility_id = v_facility_id
     and state = 'HELD';

  if v_utilised + v_held > v_limit then
    raise exception
      'facility % would be over-committed: utilised % plus held % exceeds limit %',
      v_facility_id, v_utilised, v_held, v_limit
      using errcode = 'restrict_violation';
  end if;

  return null;
end;
$$;

drop trigger if exists trg_reservation_capacity on core.limit_reservation;
create constraint trigger trg_reservation_capacity
  after insert or update on core.limit_reservation
  deferrable initially deferred
  for each row execute function core.enforce_facility_capacity();

-- -----------------------------------------------------------------------------
-- Row-level security for everything added here.
-- -----------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in
    select schemaname, tablename
      from pg_tables
     where (schemaname = 'core'
            and tablename in ('applicant_snapshot','decision','decision_rule_trace',
                              'decision_reason','facility','limit_reservation'))
        or (schemaname = 'config' and tablename = 'credit_policy_version')
  loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
    execute format('alter table %I.%I force row level security', t.schemaname, t.tablename);
    execute format('revoke all on %I.%I from anon, authenticated, public',
                   t.schemaname, t.tablename);
    execute format('drop policy if exists tenant_isolation on %I.%I', t.schemaname, t.tablename);
    execute format(
      'create policy tenant_isolation on %I.%I using (tenant_id = core.current_tenant_id()) '
      'with check (tenant_id = core.current_tenant_id())',
      t.schemaname, t.tablename);
  end loop;
end;
$$;

do $$
declare
  t record;
begin
  if exists (select 1 from pg_roles where rolname = 'sanad_app') then
    for t in
      select schemaname, tablename
        from pg_tables
       where (schemaname = 'core'
              and tablename in ('applicant_snapshot','decision','decision_rule_trace',
                                'decision_reason','facility','limit_reservation'))
          or (schemaname = 'config' and tablename = 'credit_policy_version')
    loop
      execute format('grant select, insert, update on %I.%I to sanad_app',
                     t.schemaname, t.tablename);
    end loop;
    grant usage, select on all sequences in schema core to sanad_app;
  end if;
exception
  when insufficient_privilege then
    raise notice 'grants to sanad_app skipped; apply them with a privileged role';
end;
$$;
