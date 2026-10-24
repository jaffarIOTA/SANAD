-- 0031 — distributor facilities under four eyes, and concentration as configuration (Wasl W5a).
--
-- A distributor draws under a programme only within a facility: a limit for
-- that distributor in that programme, proposed by one person and approved by a
-- different one. core.facility (0004) was built for limits a credit decision
-- assigns, and requires a scored decision (core.decision) that a limit set by
-- a credit officer does not have; inventing one would make the decision log
-- lie. So a facility may instead be authorised by an approval, recorded here,
-- and the facility says which authorised it.
--
-- Concentration rules (a distributor's share of its programme, an anchor's
-- share of the book, a cap on a single trade) are chosen by each institution:
-- a configuration revision area, CONCENTRATION, under the same four eyes as
-- every other (config.revision_four_eyes, unchanged).
--
-- Portable PostgreSQL. Idempotent.

alter table config.revision drop constraint if exists revision_area_check;
alter table config.revision add constraint revision_area_check check (area in (
  'PRODUCTS', 'RAILS', 'STAFF_IDENTITY', 'PARTNERS', 'CREDIT_POLICY', 'ORIGINATION_POLICY',
  'STRUCTURES', 'BOARD_POSITIONS', 'CONCENTRATION'
));

-- -----------------------------------------------------------------------------
-- core.facility_approval — a proposed limit and its decision, once.
-- -----------------------------------------------------------------------------
create table if not exists core.facility_approval (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references core.tenant(id) on delete restrict,
  counterparty_id uuid        not null references core.counterparty(id) on delete restrict,
  programme_id    uuid        not null references core.programme(id) on delete restrict,
  currency        char(3)     not null default 'SAR',
  limit_minor     bigint      not null check (limit_minor >= 0),
  rationale       text        not null check (length(trim(rationale)) between 3 and 1000),
  state           text        not null default 'PROPOSED' check (state in ('PROPOSED', 'APPROVED', 'REJECTED')),
  proposed_by     text        not null check (length(trim(proposed_by)) > 0),
  proposed_at     timestamptz not null,
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text        check (decision_note is null or length(decision_note) <= 1000),
  created_at      timestamptz not null default now(),
  created_by      text        not null default current_user,
  correlation_id  uuid        not null,

  -- The person who proposed a limit never decides it.
  constraint facility_approval_four_eyes check (decided_by is null or decided_by <> proposed_by),
  constraint facility_approval_decision_complete check (
    (state = 'PROPOSED' and decided_by is null and decided_at is null)
    or (state <> 'PROPOSED' and decided_by is not null and decided_at is not null and decided_at >= proposed_at)
  ),
  -- A rejection says why.
  constraint facility_approval_rejection_reasoned check (
    state <> 'REJECTED' or length(trim(coalesce(decision_note, ''))) >= 3
  )
);

create index if not exists facility_approval_by_party
  on core.facility_approval (tenant_id, counterparty_id, programme_id, proposed_at desc);

comment on table core.facility_approval is
  'A distributor''s limit in a programme as proposed and decided: by two different people, once. '
  'An approved row authorises core.facility; a later approval supersedes it.';

-- Decided once: only the decision fields, only from PROPOSED. Never deleted.
create or replace function core.facility_approval_decide_once() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'facility approvals are never deleted' using errcode = 'restrict_violation';
  end if;
  if old.state <> 'PROPOSED' then
    raise exception 'facility approval % is already %', old.id, old.state using errcode = 'restrict_violation';
  end if;
  if new.tenant_id       is distinct from old.tenant_id
  or new.counterparty_id is distinct from old.counterparty_id
  or new.programme_id    is distinct from old.programme_id
  or new.currency        is distinct from old.currency
  or new.limit_minor     is distinct from old.limit_minor
  or new.rationale       is distinct from old.rationale
  or new.proposed_by     is distinct from old.proposed_by
  or new.proposed_at     is distinct from old.proposed_at then
    raise exception 'facility approval % is immutable; only its decision may be recorded', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_facility_approval_decide_once on core.facility_approval;
create trigger trg_facility_approval_decide_once
  before update or delete on core.facility_approval
  for each row execute function core.facility_approval_decide_once();

alter table core.facility_approval enable row level security;
alter table core.facility_approval force row level security;
drop policy if exists tenant_isolation on core.facility_approval;
create policy tenant_isolation on core.facility_approval
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

do $$
declare
  r text;
begin
  revoke all on core.facility_approval from public;
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on core.facility_approval from %I', r);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'sanad_app') then
    grant select, insert, update on core.facility_approval to sanad_app;
  end if;
exception
  when insufficient_privilege then
    raise notice 'grants on core.facility_approval skipped; apply them with a privileged role';
end;
$$;

-- -----------------------------------------------------------------------------
-- core.facility — authorised by a scored decision or by an approval.
-- -----------------------------------------------------------------------------
alter table core.facility alter column decision_id drop not null;
alter table core.facility add column if not exists approval_id uuid
  references core.facility_approval(id) on delete restrict;
alter table core.facility drop constraint if exists facility_authorised;
alter table core.facility add constraint facility_authorised
  check (decision_id is not null or approval_id is not null);

-- A facility's limit is never set below what it already carries: utilised plus held. Checked at commit, as the
-- reservation's own capacity trigger is (0004), so a lower limit and a concurrent hold cannot both pass.
create or replace function core.enforce_facility_limit_covers() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_held bigint;
begin
  select coalesce(sum(amount_minor), 0) into v_held
    from core.limit_reservation where facility_id = new.id and state = 'HELD';
  if new.utilised_minor + v_held > new.limit_minor then
    raise exception 'facility % limit % is below utilised % plus held %',
      new.id, new.limit_minor, new.utilised_minor, v_held
      using errcode = 'restrict_violation';
  end if;
  return null;
end;
$$;

drop trigger if exists trg_facility_limit_covers on core.facility;
create constraint trigger trg_facility_limit_covers
  after insert or update on core.facility
  deferrable initially deferred
  for each row execute function core.enforce_facility_limit_covers();
