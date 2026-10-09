-- 0017_installation_licence.sql
-- Sanad — installation licensing (ADR 0006).
--
-- An installation is licensed by a signed file the issuer produces: ANNUAL, or
-- POC one calendar month at a time. The file is verified in the application
-- against public keys compiled into the build (core/licensing/verify.ts); this
-- database cannot check an ES256 signature and does not try. What it keeps:
--
--   1. The installation's identity and its clock high-water mark, on the
--      single-row deployment profile. `installation_id` is generated once,
--      when this migration runs, and never changes. The high-water mark is the
--      highest server time the installation has seen; a clock behind it by
--      more than a day is treated as NEW_BUSINESS_BLOCKED (CLOCK_ROLLBACK).
--   2. `config.licence_proposal`: an administrator proposes installing a
--      licence; a DIFFERENT administrator approves or rejects it. Four eyes,
--      exactly as the deployment jurisdiction (0014).
--   3. `config.licence`: the append-only history of installed licences and
--      revocations — the signed document as received, its signature, who
--      installed it and who approved it. Never updated, never deleted. A POC's
--      whole length is this table's supersession chain.
--
-- Deployment-wide, so no tenant_id — like config.deployment_profile and
-- config.deployment_jurisdiction_revision (0014): a licence binds the
-- installation, not a tenant. Every change is recorded in every tenant's
-- audit chain, as 0014 does.
--
-- Row-level security is enabled AND forced on both tables, with one policy:
-- only the table owner — that is, the SECURITY DEFINER functions below — reads
-- or writes. No role is granted anything on the tables; no role has UPDATE or
-- DELETE on the history, and a trigger refuses both even for the owner.
--
-- Portable PostgreSQL. `config`, never `public`.

-- -----------------------------------------------------------------------------
-- 1. Installation identity and clock high-water mark.
-- -----------------------------------------------------------------------------
alter table config.deployment_profile add column if not exists installation_id uuid not null default gen_random_uuid();
alter table config.deployment_profile add column if not exists clock_high_water_mark timestamptz;

comment on column config.deployment_profile.installation_id is
  'The installation a licence is bound to (ADR 0006). Generated once; never changes.';
comment on column config.deployment_profile.clock_high_water_mark is
  'The highest server time this installation has seen. A clock behind it by more than a day blocks new business (ADR 0006 §5).';

create or replace function config.deployment_profile_installation_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.installation_id is distinct from old.installation_id then
    raise exception 'the installation id is generated once and never changes' using errcode = 'restrict_violation';
  end if;
  if old.clock_high_water_mark is not null
     and (new.clock_high_water_mark is null or new.clock_high_water_mark < old.clock_high_water_mark) then
    raise exception 'the clock high-water mark only rises' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_deployment_profile_installation_guard on config.deployment_profile;
create trigger trg_deployment_profile_installation_guard
  before update on config.deployment_profile
  for each row execute function config.deployment_profile_installation_guard();

-- -----------------------------------------------------------------------------
-- 2. Proposals, decided by a different administrator.
-- -----------------------------------------------------------------------------
create table if not exists config.licence_proposal (
  id               uuid        primary key default gen_random_uuid(),
  kind             text        not null check (kind in ('LICENCE', 'REVOCATION')),
  subject_id       uuid        not null,
  document         text        not null check (length(document) between 2 and 16384),
  signature        text        not null check (signature ~ '^[A-Za-z0-9_-]{86}$'),
  status           text        not null default 'PROPOSED' check (status in ('PROPOSED', 'APPROVED', 'REJECTED')),
  proposed_by      text        not null,
  proposed_at      timestamptz not null default now(),
  decided_by       text,
  decided_at       timestamptz,
  rejection_reason text,
  correlation_id   uuid        not null,
  created_at       timestamptz not null default now(),
  created_by       text        not null default current_user,
  constraint licence_proposal_decision_consistent check (
    (status = 'PROPOSED' and decided_by is null and decided_at is null)
    or (status <> 'PROPOSED' and decided_by is not null and decided_at is not null)
  ),
  constraint licence_proposal_four_eyes check (decided_by is null or decided_by <> proposed_by),
  constraint licence_proposal_rejection_reason check (status <> 'REJECTED' or length(coalesce(rejection_reason, '')) >= 3)
);

-- One pending proposal at a time: a second administrator decides one licence, not a queue of them.
create unique index if not exists licence_proposal_one_pending on config.licence_proposal ((true)) where status = 'PROPOSED';

-- A decided proposal is history: it never changes again, and nothing is deleted.
create or replace function config.licence_proposal_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'licence proposals are history and are never deleted' using errcode = 'restrict_violation';
  end if;
  if old.status <> 'PROPOSED' then
    raise exception 'proposal % is already %', old.id, old.status using errcode = 'restrict_violation';
  end if;
  if new.document <> old.document or new.signature <> old.signature or new.proposed_by <> old.proposed_by
     or new.subject_id <> old.subject_id or new.kind <> old.kind then
    raise exception 'a proposal is decided as proposed; propose again to change it' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_licence_proposal_guard on config.licence_proposal;
create trigger trg_licence_proposal_guard
  before update or delete on config.licence_proposal
  for each row execute function config.licence_proposal_guard();

-- -----------------------------------------------------------------------------
-- 3. The append-only history of installed licences and revocations.
-- -----------------------------------------------------------------------------
create table if not exists config.licence (
  id              uuid        primary key default gen_random_uuid(),
  kind            text        not null check (kind in ('LICENCE', 'REVOCATION')),
  -- The licenceId of a licence, the revocationId of a revocation, from the signed document.
  subject_id      uuid        not null unique,
  -- The signed inner object as received, and its detached ES256 signature (base64url, IEEE P1363).
  document        text        not null check (length(document) between 2 and 16384),
  signature       text        not null check (signature ~ '^[A-Za-z0-9_-]{86}$'),
  source          text        not null check (source in ('ADMIN_INSTALL', 'CHECK_IN')),
  installed_by    text        not null,
  approved_by     text,
  installed_at    timestamptz not null default now(),
  proposal_id     uuid        references config.licence_proposal (id),
  correlation_id  uuid        not null,
  created_at      timestamptz not null default now(),
  created_by      text        not null default current_user,
  -- Four eyes for an administrator's install; a check-in is the issuer's own signed act.
  constraint licence_install_four_eyes check (
    (source = 'ADMIN_INSTALL' and approved_by is not null and approved_by <> installed_by and proposal_id is not null)
    or (source = 'CHECK_IN' and approved_by is null)
  )
);

create or replace function config.licence_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'the licence history is append-only: % is refused', tg_op using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists trg_licence_append_only on config.licence;
create trigger trg_licence_append_only
  before update or delete on config.licence
  for each row execute function config.licence_append_only();

drop trigger if exists trg_licence_no_truncate on config.licence;
create trigger trg_licence_no_truncate
  before truncate on config.licence
  for each statement execute function config.licence_append_only();

-- -----------------------------------------------------------------------------
-- Row-level security: enabled, forced, and open only to the owner (the functions).
-- -----------------------------------------------------------------------------
alter table config.licence enable row level security;
alter table config.licence force row level security;
alter table config.licence_proposal enable row level security;
alter table config.licence_proposal force row level security;

drop policy if exists licence_owner_only on config.licence;
create policy licence_owner_only on config.licence
  using (current_user = (select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c where c.oid = 'config.licence'::regclass))
  with check (current_user = (select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c where c.oid = 'config.licence'::regclass));

drop policy if exists licence_proposal_owner_only on config.licence_proposal;
create policy licence_proposal_owner_only on config.licence_proposal
  using (current_user = (select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c where c.oid = 'config.licence_proposal'::regclass))
  with check (current_user = (select pg_catalog.pg_get_userbyid(c.relowner) from pg_catalog.pg_class c where c.oid = 'config.licence_proposal'::regclass));

-- -----------------------------------------------------------------------------
-- Functions. Every write is recorded in every tenant's audit chain.
-- -----------------------------------------------------------------------------
create or replace function config.licence_installation(out installation_id uuid, out clock_high_water_mark timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select d.installation_id, d.clock_high_water_mark from config.deployment_profile d;
$$;

-- Raise the high-water mark to p_now if it is higher; return the mark as it stood before.
create or replace function config.observe_licence_clock(p_now timestamptz) returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before timestamptz;
begin
  select clock_high_water_mark into v_before from config.deployment_profile for update;
  if v_before is null or p_now > v_before then
    update config.deployment_profile set clock_high_water_mark = p_now;
  end if;
  return v_before;
end;
$$;

create or replace function config.propose_licence(
  p_kind text, p_subject uuid, p_document text, p_signature text, p_proposed_by text, p_correlation uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from config.licence where subject_id = p_subject) then
    raise exception 'that licence is already installed' using errcode = 'unique_violation';
  end if;
  if exists (select 1 from config.licence_proposal where status = 'PROPOSED') then
    raise exception 'another licence is awaiting a decision' using errcode = 'check_violation';
  end if;
  insert into config.licence_proposal (kind, subject_id, document, signature, proposed_by, correlation_id)
  values (p_kind, p_subject, p_document, p_signature, p_proposed_by, p_correlation)
  returning id into v_id;
  perform audit.record_event(t.id, 'INSTALLATION_LICENCE', v_id, 'PROPOSED',
    null, jsonb_build_object('kind', p_kind, 'subjectId', p_subject), p_proposed_by, p_correlation)
  from core.tenant t;
  return v_id;
end;
$$;

create or replace function config.decide_licence(
  p_proposal uuid, p_approve boolean, p_decided_by text, p_reason text, p_correlation uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p config.licence_proposal;
begin
  select * into v_p from config.licence_proposal where id = p_proposal for update;
  if not found then
    raise exception 'no licence proposal %', p_proposal using errcode = 'no_data_found';
  end if;
  if v_p.status <> 'PROPOSED' then
    raise exception 'proposal % is already %', p_proposal, v_p.status using errcode = 'restrict_violation';
  end if;
  if v_p.proposed_by = p_decided_by then
    raise exception 'four eyes: the proposer may not decide their own proposal' using errcode = 'check_violation';
  end if;
  if p_approve then
    update config.licence_proposal set status = 'APPROVED', decided_by = p_decided_by, decided_at = now() where id = p_proposal;
    insert into config.licence (kind, subject_id, document, signature, source, installed_by, approved_by, proposal_id, correlation_id)
    values (v_p.kind, v_p.subject_id, v_p.document, v_p.signature, 'ADMIN_INSTALL', v_p.proposed_by, p_decided_by, p_proposal, p_correlation);
  else
    update config.licence_proposal set status = 'REJECTED', decided_by = p_decided_by, decided_at = now(), rejection_reason = p_reason where id = p_proposal;
  end if;
  perform audit.record_event(t.id, 'INSTALLATION_LICENCE', p_proposal, case when p_approve then 'INSTALLED' else 'REJECTED' end,
    null, jsonb_build_object('kind', v_p.kind, 'subjectId', v_p.subject_id, 'reason', p_reason), p_decided_by, p_correlation)
  from core.tenant t;
end;
$$;

-- A newer licence or a revocation returned by the online check-in, verified by the application first.
create or replace function config.record_checked_in_licence(
  p_kind text, p_subject uuid, p_document text, p_signature text, p_correlation uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from config.licence where subject_id = p_subject) then
    return;
  end if;
  insert into config.licence (kind, subject_id, document, signature, source, installed_by, correlation_id)
  values (p_kind, p_subject, p_document, p_signature, 'CHECK_IN', 'licence-check-in', p_correlation)
  returning id into v_id;
  perform audit.record_event(t.id, 'INSTALLATION_LICENCE', v_id, 'CHECKED_IN',
    null, jsonb_build_object('kind', p_kind, 'subjectId', p_subject), 'licence-check-in', p_correlation)
  from core.tenant t;
end;
$$;

create or replace function config.list_licence_history()
returns setof config.licence
language sql
stable
security definer
set search_path = ''
as $$
  select * from config.licence order by installed_at, id;
$$;

create or replace function config.list_licence_proposals()
returns setof config.licence_proposal
language sql
stable
security definer
set search_path = ''
as $$
  select * from config.licence_proposal order by proposed_at desc limit 50;
$$;

-- -----------------------------------------------------------------------------
-- Grants: nothing on the tables to anyone; the functions to the application role.
-- -----------------------------------------------------------------------------
revoke all on config.licence from public;
revoke all on config.licence_proposal from public;
revoke all on function config.licence_installation() from public;
revoke all on function config.observe_licence_clock(timestamptz) from public;
revoke all on function config.propose_licence(text, uuid, text, text, text, uuid) from public;
revoke all on function config.decide_licence(uuid, boolean, text, text, uuid) from public;
revoke all on function config.record_checked_in_licence(text, uuid, text, text, uuid) from public;
revoke all on function config.list_licence_history() from public;
revoke all on function config.list_licence_proposals() from public;

do $$
declare
  r text;
begin
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on config.licence from %I', r);
    execute format('revoke all on config.licence_proposal from %I', r);
    execute format('revoke all on function config.licence_installation() from %I', r);
    execute format('revoke all on function config.observe_licence_clock(timestamptz) from %I', r);
    execute format('revoke all on function config.propose_licence(text, uuid, text, text, text, uuid) from %I', r);
    execute format('revoke all on function config.decide_licence(uuid, boolean, text, text, uuid) from %I', r);
    execute format('revoke all on function config.record_checked_in_licence(text, uuid, text, text, uuid) from %I', r);
    execute format('revoke all on function config.list_licence_history() from %I', r);
    execute format('revoke all on function config.list_licence_proposals() from %I', r);
  end loop;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'sanad_app') then
    grant execute on function config.licence_installation() to sanad_app;
    grant execute on function config.observe_licence_clock(timestamptz) to sanad_app;
    grant execute on function config.propose_licence(text, uuid, text, text, text, uuid) to sanad_app;
    grant execute on function config.decide_licence(uuid, boolean, text, text, uuid) to sanad_app;
    grant execute on function config.record_checked_in_licence(text, uuid, text, text, uuid) to sanad_app;
    grant execute on function config.list_licence_history() to sanad_app;
    grant execute on function config.list_licence_proposals() to sanad_app;
  end if;
exception
  when insufficient_privilege then
    raise notice 'grant to sanad_app skipped; apply it with a privileged role';
end;
$$;
