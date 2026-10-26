-- 0033 — the Shariah approvals register (Wasl W6a; BR-F01, BR-F02, SH-17).
--
-- A Shariah approval is recorded by a Shariah reviewer in the workbench and
-- confirmed by a different one, as are its suspension, reinstatement,
-- withdrawal and renewal (decided with the product owner on 26 October 2026).
-- Each is a row here, proposed once and decided once. The register is folded
-- from the confirmed rows, in the order they were confirmed; nothing else is
-- read to decide whether an approval is in force.
--
-- core.shariah_approval (0003) stays what transactions, programmes and the
-- charity ledger refer to. A confirmed change fills it in or moves its status,
-- so the row a transaction was executed under says what the board approved.
-- Rows made before the register (implied by a Wasl transaction's reference,
-- persistence.ts) carry no confirmation and are in force for nothing until the
-- approval is recorded.
--
-- Portable PostgreSQL. Idempotent.

-- -----------------------------------------------------------------------------
-- core.shariah_approval — what the board approved, once confirmed.
-- -----------------------------------------------------------------------------
alter table core.shariah_approval alter column product_code drop not null;
alter table core.shariah_approval alter column structure_code drop not null;
alter table core.shariah_approval add column if not exists approving_members text[];
alter table core.shariah_approval add column if not exists product_codes text[];
alter table core.shariah_approval add column if not exists template_version_ids text[];
alter table core.shariah_approval add column if not exists recorded_by text;
alter table core.shariah_approval add column if not exists confirmed_by text;
alter table core.shariah_approval add column if not exists confirmed_at timestamptz;

alter table core.shariah_approval drop constraint if exists shariah_approval_recorded_complete;
alter table core.shariah_approval add constraint shariah_approval_recorded_complete check (
  confirmed_by is null
  or (recorded_by is not null and confirmed_by <> recorded_by and confirmed_at is not null
      and cardinality(approving_members) > 0 and cardinality(product_codes) > 0
      and template_version_ids is not null)
);

comment on column core.shariah_approval.confirmed_by is
  'The second Shariah reviewer who confirmed the recording (0033). A row without one was implied by a reference '
  'before the register existed, and is in force for nothing.';

-- Once confirmed, what the board approved does not change: only its status and its review date move, each by a
-- confirmed change, and a withdrawn approval stays withdrawn. Never deleted.
create or replace function core.shariah_approval_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Shariah approvals are never deleted' using errcode = 'restrict_violation';
  end if;
  if old.confirmed_by is null then
    return new;
  end if;
  if new.tenant_id            is distinct from old.tenant_id
  or new.approval_ref         is distinct from old.approval_ref
  or new.approving_body       is distinct from old.approving_body
  or new.approving_members    is distinct from old.approving_members
  or new.product_codes        is distinct from old.product_codes
  or new.template_version_ids is distinct from old.template_version_ids
  or new.effective_from       is distinct from old.effective_from
  or new.recorded_by          is distinct from old.recorded_by
  or new.confirmed_by         is distinct from old.confirmed_by
  or new.confirmed_at         is distinct from old.confirmed_at then
    raise exception 'Shariah approval % is recorded; only its status and review date move', old.approval_ref
      using errcode = 'restrict_violation';
  end if;
  if old.status = 'WITHDRAWN' and new.status is distinct from old.status then
    raise exception 'Shariah approval % is withdrawn', old.approval_ref using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_shariah_approval_guard on core.shariah_approval;
create trigger trg_shariah_approval_guard
  before update or delete on core.shariah_approval
  for each row execute function core.shariah_approval_guard();

-- -----------------------------------------------------------------------------
-- core.shariah_approval_change — a change to the register, proposed and decided once.
-- -----------------------------------------------------------------------------
create table if not exists core.shariah_approval_change (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references core.tenant(id) on delete restrict,
  approval_ref    text        not null check (length(trim(approval_ref)) between 2 and 80),
  kind            text        not null check (kind in ('RECORD', 'SUSPEND', 'REINSTATE', 'WITHDRAW', 'RENEW')),
  -- The change as proposed: for RECORD the board's terms, for RENEW the new date.
  change          jsonb       not null,
  reason          text        not null check (length(trim(reason)) between 3 and 1000),
  state           text        not null default 'PROPOSED' check (state in ('PROPOSED', 'CONFIRMED', 'REJECTED')),
  proposed_by     text        not null check (length(trim(proposed_by)) > 0),
  proposed_at     timestamptz not null,
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text        check (decision_note is null or length(decision_note) <= 1000),
  created_at      timestamptz not null default now(),
  created_by      text        not null default current_user,
  correlation_id  uuid        not null,

  -- The person who proposed a change never decides it.
  constraint shariah_approval_change_four_eyes check (decided_by is null or decided_by <> proposed_by),
  constraint shariah_approval_change_decision_complete check (
    (state = 'PROPOSED' and decided_by is null and decided_at is null)
    or (state <> 'PROPOSED' and decided_by is not null and decided_at is not null and decided_at >= proposed_at)
  ),
  constraint shariah_approval_change_rejection_reasoned check (
    state <> 'REJECTED' or length(trim(coalesce(decision_note, ''))) >= 3
  )
);

-- One open proposal per approval at a time.
create unique index if not exists shariah_approval_change_one_open
  on core.shariah_approval_change (tenant_id, approval_ref) where state = 'PROPOSED';
create index if not exists shariah_approval_change_by_ref
  on core.shariah_approval_change (tenant_id, approval_ref, proposed_at);

comment on table core.shariah_approval_change is
  'Changes to the Shariah approvals register: recorded, suspended, reinstated, withdrawn or renewed, each proposed '
  'by one Shariah reviewer and decided by another, once. The register is folded from the confirmed rows (SH-17).';

create or replace function core.shariah_approval_change_decide_once() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Shariah approval changes are never deleted' using errcode = 'restrict_violation';
  end if;
  if old.state <> 'PROPOSED' then
    raise exception 'Shariah approval change % is already %', old.id, old.state using errcode = 'restrict_violation';
  end if;
  if new.tenant_id    is distinct from old.tenant_id
  or new.approval_ref is distinct from old.approval_ref
  or new.kind         is distinct from old.kind
  or new.change       is distinct from old.change
  or new.reason       is distinct from old.reason
  or new.proposed_by  is distinct from old.proposed_by
  or new.proposed_at  is distinct from old.proposed_at then
    raise exception 'Shariah approval change % is immutable; only its decision may be recorded', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_shariah_approval_change_decide_once on core.shariah_approval_change;
create trigger trg_shariah_approval_change_decide_once
  before update or delete on core.shariah_approval_change
  for each row execute function core.shariah_approval_change_decide_once();

alter table core.shariah_approval_change enable row level security;
alter table core.shariah_approval_change force row level security;
drop policy if exists tenant_isolation on core.shariah_approval_change;
create policy tenant_isolation on core.shariah_approval_change
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

do $$
declare
  r text;
begin
  revoke all on core.shariah_approval_change from public;
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on core.shariah_approval_change from %I', r);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'sanad_app') then
    grant select, insert, update on core.shariah_approval_change to sanad_app;
    grant select, insert, update on core.shariah_approval to sanad_app;
  end if;
exception
  when insufficient_privilege then
    raise notice 'grants on core.shariah_approval_change skipped; apply them with a privileged role';
end;
$$;
