-- 0014_deployment_jurisdiction.sql
-- Sanad — the deployment's jurisdiction, chosen by administrators (ADR 0005).
--
-- The whole application behaves as one jurisdiction at a time — Saudi Arabia
-- in riyals or the UAE in dirhams — and administrators choose which, in the
-- Admin app, under four eyes. Not per request, not per screen, not per anchor
-- customer. In production one deployment serves one jurisdiction: customer
-- data residency (the Kingdom's rules for SA, the UAE's for AE) means a single
-- database never mixes the two.
--
-- Three safeguards:
--   1. Four eyes — one administrator proposes, a different one decides.
--   2. Locked in production once there is business: a deployment cleared for
--      production data cannot change jurisdiction after any tenant of the
--      current jurisdiction has recorded business, because every amount it
--      holds is in that jurisdiction's currency.
--   3. Tenants keep their own jurisdiction (0013). The deployment setting
--      decides which tenants are active, never rewrites one's currency.
--
-- Residency follows the jurisdiction: production data sits in the Kingdom for
-- SA and in the UAE for AE, behind a customer-managed HSM.
--
-- Portable PostgreSQL. `config`, never `public`.

-- -----------------------------------------------------------------------------
-- The jurisdiction in force, on the single-row deployment profile.
-- Written only by config.decide_deployment_jurisdiction().
-- -----------------------------------------------------------------------------
alter table config.deployment_profile add column if not exists jurisdiction char(2) not null default 'SA';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'deployment_profile_jurisdiction_known') then
    alter table config.deployment_profile add constraint deployment_profile_jurisdiction_known check (jurisdiction in ('SA', 'AE'));
  end if;
end;
$$;

-- Residency, now by jurisdiction: production data in the deployment's own jurisdiction, behind a customer HSM.
alter table config.deployment_profile drop constraint if exists deployment_profile_production_requires_kingdom_and_hsm;
alter table config.deployment_profile drop constraint if exists deployment_profile_production_residency;
alter table config.deployment_profile
  add constraint deployment_profile_production_residency
  check (
    production_data_permitted = false
    or (
      key_custody = 'CUSTOMER_MANAGED_HSM'
      and ((jurisdiction = 'SA' and data_region like 'kingdom-%') or (jurisdiction = 'AE' and data_region like 'uae-%'))
    )
  );

comment on column config.deployment_profile.jurisdiction is
  'The jurisdiction the whole application behaves as (ADR 0005). Changed only by an approved deployment-jurisdiction revision.';

-- -----------------------------------------------------------------------------
-- Proposals to change it, decided by a different administrator.
-- Deployment-wide, so no tenant_id: like config.deployment_profile, it scopes
-- the deployment, not a tenant. Read and written only through the functions.
-- -----------------------------------------------------------------------------
create table if not exists config.deployment_jurisdiction_revision (
  id               uuid        primary key default gen_random_uuid(),
  jurisdiction     char(2)     not null check (jurisdiction in ('SA', 'AE')),
  summary          text        not null check (length(summary) between 3 and 400),
  status           text        not null default 'PROPOSED' check (status in ('PROPOSED', 'APPROVED', 'REJECTED')),
  proposed_by      text        not null,
  proposed_at      timestamptz not null default now(),
  decided_by       text,
  decided_at       timestamptz,
  rejection_reason text,
  correlation_id   uuid        not null,
  created_at       timestamptz not null default now(),
  created_by       text        not null default current_user,
  constraint deployment_jurisdiction_decision_consistent check (
    (status = 'PROPOSED' and decided_by is null and decided_at is null)
    or (status <> 'PROPOSED' and decided_by is not null and decided_at is not null)
  ),
  constraint deployment_jurisdiction_four_eyes check (decided_by is null or decided_by <> proposed_by),
  constraint deployment_jurisdiction_rejection_reason check (status <> 'REJECTED' or length(coalesce(rejection_reason, '')) >= 3)
);

alter table config.deployment_jurisdiction_revision enable row level security;

-- A decided revision is history: it never changes again, and nothing is deleted.
create or replace function config.deployment_jurisdiction_revision_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'deployment jurisdiction revisions are history and are never deleted' using errcode = 'restrict_violation';
  end if;
  if old.status <> 'PROPOSED' then
    raise exception 'revision % is already %', old.id, old.status using errcode = 'restrict_violation';
  end if;
  if new.jurisdiction <> old.jurisdiction or new.proposed_by <> old.proposed_by or new.summary <> old.summary then
    raise exception 'a proposal is decided as proposed; propose again to change it' using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_deployment_jurisdiction_revision_guard on config.deployment_jurisdiction_revision;
create trigger trg_deployment_jurisdiction_revision_guard
  before update or delete on config.deployment_jurisdiction_revision
  for each row execute function config.deployment_jurisdiction_revision_guard();

-- -----------------------------------------------------------------------------
-- Is the jurisdiction locked? Only in a deployment cleared for production data,
-- and only once a tenant of the current jurisdiction has recorded business.
-- -----------------------------------------------------------------------------
create or replace function config.deployment_jurisdiction_locked() returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select d.production_data_permitted
            and exists (select 1 from core.tenant t where t.jurisdiction = d.jurisdiction and core.tenant_has_business(t.id))
       from config.deployment_profile d),
    false);
$$;

create or replace function config.effective_deployment_jurisdiction() returns char(2)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select jurisdiction from config.deployment_profile), 'SA');
$$;

create or replace function config.propose_deployment_jurisdiction(
  p_jurisdiction char(2), p_summary text, p_proposed_by text, p_correlation uuid
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_current char(2);
begin
  select jurisdiction into v_current from config.deployment_profile;
  if p_jurisdiction = v_current then
    raise exception 'the deployment already behaves as %', p_jurisdiction using errcode = 'check_violation';
  end if;
  if config.deployment_jurisdiction_locked() then
    raise exception 'this production deployment has recorded business in %; its jurisdiction does not change', v_current using errcode = 'restrict_violation';
  end if;
  insert into config.deployment_jurisdiction_revision (jurisdiction, summary, proposed_by, correlation_id)
  values (p_jurisdiction, p_summary, p_proposed_by, p_correlation)
  returning id into v_id;
  -- A deployment-wide change touches every tenant, so it is recorded in every tenant's audit chain.
  perform audit.record_event(t.id, 'DEPLOYMENT_JURISDICTION', v_id, 'PROPOSED',
    jsonb_build_object('jurisdiction', v_current), jsonb_build_object('jurisdiction', p_jurisdiction), p_proposed_by, p_correlation)
  from core.tenant t;
  return v_id;
end;
$$;

create or replace function config.decide_deployment_jurisdiction(
  p_revision uuid, p_approve boolean, p_decided_by text, p_reason text, p_correlation uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rev config.deployment_jurisdiction_revision;
begin
  select * into v_rev from config.deployment_jurisdiction_revision where id = p_revision for update;
  if not found then
    raise exception 'no deployment jurisdiction revision %', p_revision using errcode = 'no_data_found';
  end if;
  if v_rev.proposed_by = p_decided_by then
    raise exception 'four eyes: the proposer may not decide their own proposal' using errcode = 'check_violation';
  end if;
  if p_approve then
    if config.deployment_jurisdiction_locked() then
      raise exception 'this production deployment has recorded business; its jurisdiction does not change' using errcode = 'restrict_violation';
    end if;
    update config.deployment_jurisdiction_revision set status = 'APPROVED', decided_by = p_decided_by, decided_at = now() where id = p_revision;
    -- The residency constraint on deployment_profile refuses a production deployment whose region is not the new jurisdiction's.
    update config.deployment_profile set jurisdiction = v_rev.jurisdiction;
  else
    update config.deployment_jurisdiction_revision set status = 'REJECTED', decided_by = p_decided_by, decided_at = now(), rejection_reason = p_reason where id = p_revision;
  end if;
  perform audit.record_event(t.id, 'DEPLOYMENT_JURISDICTION', p_revision, case when p_approve then 'APPROVED' else 'REJECTED' end,
    null, jsonb_build_object('jurisdiction', v_rev.jurisdiction, 'reason', p_reason), p_decided_by, p_correlation)
  from core.tenant t;
end;
$$;

create or replace function config.list_deployment_jurisdiction_revisions()
returns setof config.deployment_jurisdiction_revision
language sql
stable
security definer
set search_path = ''
as $$
  select * from config.deployment_jurisdiction_revision order by proposed_at desc limit 50;
$$;

do $$
declare
  r text;
begin
  execute 'revoke all on config.deployment_jurisdiction_revision from public';
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on config.deployment_jurisdiction_revision from %I', r);
    execute format('revoke all on function config.propose_deployment_jurisdiction(char, text, text, uuid) from %I', r);
    execute format('revoke all on function config.decide_deployment_jurisdiction(uuid, boolean, text, text, uuid) from %I', r);
    execute format('revoke all on function config.list_deployment_jurisdiction_revisions() from %I', r);
    execute format('revoke all on function config.deployment_jurisdiction_locked() from %I', r);
  end loop;
end;
$$;
