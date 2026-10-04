-- 0009_config_revisions.sql
-- Sanad — effective-dated configuration revisions under maker-checker.
--
-- Every institution-specific ruling is configuration (CLAUDE.md §1). A change
-- to it is a revision: proposed by one person, approved by a different one,
-- effective from a stated time, never edited afterwards. Reading configuration
-- means asking which approved revision was in force at a moment, so a past
-- decision can be reproduced against the configuration it was taken under.
--
-- Also here: audit.record_event(), the hash-chained writer the audit table
-- was created for in 0003 and that nothing had yet supplied.

-- -----------------------------------------------------------------------------
-- audit.record_event — one chained row. prev_hash is the tenant's last
-- content_hash; content_hash covers the row and its predecessor, so a removed
-- or altered row breaks the chain for everything after it.
-- -----------------------------------------------------------------------------
create or replace function audit.record_event(
  p_tenant        uuid,
  p_subject_type  text,
  p_subject_id    uuid,
  p_event_type    text,
  p_before        jsonb,
  p_after         jsonb,
  p_actor         text,
  p_correlation   uuid
) returns bigint
language plpgsql
security definer
set search_path = audit, public
as $$
declare
  v_prev    text;
  v_hash    text;
  v_id      bigint;
  v_at      timestamptz := now();
begin
  select content_hash into v_prev
  from audit.audit_event
  where tenant_id = p_tenant
  order by id desc
  limit 1
  for update;

  -- Built-in sha256(bytea): no extension, so the chain is portable to the in-Kingdom PostgreSQL.
  v_hash := encode(sha256(convert_to(
    coalesce(v_prev, '') || '|' || p_tenant::text || '|' || p_subject_type || '|' || p_subject_id::text || '|' ||
    p_event_type || '|' || coalesce(p_before::text, '') || '|' || coalesce(p_after::text, '') || '|' || p_actor || '|' ||
    v_at::text || '|' || p_correlation::text, 'UTF8')), 'hex');

  insert into audit.audit_event (tenant_id, subject_type, subject_id, event_type, before_state, after_state, actor, occurred_at, correlation_id, prev_hash, content_hash)
  values (p_tenant, p_subject_type, p_subject_id, p_event_type, p_before, p_after, p_actor, v_at, p_correlation, v_prev, v_hash)
  returning id into v_id;
  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- config.revision
-- -----------------------------------------------------------------------------
create table if not exists config.revision (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid        not null references core.tenant(id),
  area            text        not null check (area in ('PRODUCTS', 'RAILS', 'STAFF_IDENTITY', 'PARTNERS', 'CREDIT_POLICY', 'ORIGINATION_POLICY')),
  payload         jsonb       not null,
  summary         text        not null check (length(summary) between 3 and 400),
  effective_from  timestamptz not null,
  status          text        not null default 'PROPOSED' check (status in ('PROPOSED', 'APPROVED', 'REJECTED')),
  proposed_by     text        not null,
  proposed_at     timestamptz not null default now(),
  decided_by      text,
  decided_at      timestamptz,
  rejection_reason text,
  correlation_id  uuid        not null,
  created_at      timestamptz not null default now(),
  created_by      text        not null,
  constraint revision_decision_consistent check (
    (status = 'PROPOSED' and decided_by is null and decided_at is null)
    or (status <> 'PROPOSED' and decided_by is not null and decided_at is not null)
  ),
  constraint revision_four_eyes check (decided_by is null or decided_by <> proposed_by),
  constraint revision_rejection_reason check (status <> 'REJECTED' or length(coalesce(rejection_reason, '')) >= 3)
);

create index if not exists revision_effective
  on config.revision (tenant_id, area, status, effective_from desc, decided_at desc);

alter table config.revision enable row level security;
drop policy if exists revision_tenant on config.revision;
create policy revision_tenant on config.revision
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

-- A revision is written once. The only permitted update is the decision on a
-- PROPOSED row, and that update may touch nothing but the decision columns.
create or replace function config.revision_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'revision % is never deleted', old.id using errcode = 'restrict_violation';
  end if;
  if old.status <> 'PROPOSED' then
    raise exception 'revision % is decided (%) and immutable; propose a new revision', old.id, old.status using errcode = 'restrict_violation';
  end if;
  if new.tenant_id <> old.tenant_id or new.area <> old.area or new.payload <> old.payload or new.summary <> old.summary
     or new.effective_from <> old.effective_from or new.proposed_by <> old.proposed_by or new.proposed_at <> old.proposed_at
     or new.correlation_id <> old.correlation_id or new.created_at <> old.created_at or new.created_by <> old.created_by then
    raise exception 'revision % may only be decided, not changed; propose a new revision', old.id using errcode = 'restrict_violation';
  end if;
  if new.status = 'PROPOSED' then
    raise exception 'revision % is already proposed', old.id using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_revision_guard on config.revision;
create trigger trg_revision_guard
  before update or delete on config.revision
  for each row execute function config.revision_guard();

-- -----------------------------------------------------------------------------
-- Functions. Security definer, service role only; the application never
-- writes the table directly.
-- -----------------------------------------------------------------------------
create or replace function config.propose_revision(
  p_tenant         uuid,
  p_area           text,
  p_payload        jsonb,
  p_summary        text,
  p_effective_from timestamptz,
  p_proposed_by    text,
  p_correlation    uuid
) returns uuid
language plpgsql
security definer
set search_path = config, core, audit, public
as $$
declare
  v_id uuid;
begin
  if p_proposed_by is null or length(trim(p_proposed_by)) = 0 then
    raise exception 'a revision names its proposer';
  end if;
  insert into config.revision (tenant_id, area, payload, summary, effective_from, proposed_by, correlation_id, created_by)
  values (p_tenant, p_area, p_payload, p_summary, p_effective_from, p_proposed_by, p_correlation, p_proposed_by)
  returning id into v_id;
  perform audit.record_event(p_tenant, 'config.revision', v_id, 'REVISION_PROPOSED', null,
    jsonb_build_object('area', p_area, 'summary', p_summary, 'effectiveFrom', p_effective_from), p_proposed_by, p_correlation);
  return v_id;
end;
$$;

create or replace function config.decide_revision(
  p_id           uuid,
  p_decided_by   text,
  p_approve      boolean,
  p_reason       text,
  p_correlation  uuid
) returns void
language plpgsql
security definer
set search_path = config, core, audit, public
as $$
declare
  v_rev config.revision;
begin
  select * into v_rev from config.revision where id = p_id for update;
  if not found then
    raise exception 'no revision %', p_id;
  end if;
  if v_rev.status <> 'PROPOSED' then
    raise exception 'revision % is already %', p_id, v_rev.status;
  end if;
  if p_decided_by is null or length(trim(p_decided_by)) = 0 then
    raise exception 'a decision names who took it';
  end if;
  if p_decided_by = v_rev.proposed_by then
    -- Four eyes: the constraint also refuses this; the message here is the one a person reads.
    raise exception 'FOUR_EYES: % proposed revision % and may not decide it', p_decided_by, p_id using errcode = 'check_violation';
  end if;
  update config.revision
     set status = case when p_approve then 'APPROVED' else 'REJECTED' end,
         decided_by = p_decided_by,
         decided_at = now(),
         rejection_reason = case when p_approve then null else p_reason end
   where id = p_id;
  perform audit.record_event(v_rev.tenant_id, 'config.revision', p_id,
    case when p_approve then 'REVISION_APPROVED' else 'REVISION_REJECTED' end,
    jsonb_build_object('status', v_rev.status),
    jsonb_build_object('status', case when p_approve then 'APPROVED' else 'REJECTED' end, 'reason', p_reason),
    p_decided_by, p_correlation);
end;
$$;

-- The revision in force for an area at a moment: the latest effective among
-- approved ones; ties on effective_from go to the later approval.
create or replace function config.effective_revision(
  p_tenant uuid,
  p_area   text,
  p_as_of  timestamptz
) returns table (id uuid, payload jsonb, effective_from timestamptz, decided_at timestamptz, summary text)
language sql
security definer
set search_path = config, public
as $$
  select id, payload, effective_from, decided_at, summary
  from config.revision
  where tenant_id = p_tenant and area = p_area and status = 'APPROVED' and effective_from <= p_as_of
  order by effective_from desc, decided_at desc
  limit 1
$$;

create or replace function config.list_revisions(p_tenant uuid, p_area text)
returns table (id uuid, summary text, effective_from timestamptz, status text, proposed_by text, proposed_at timestamptz, decided_by text, decided_at timestamptz, rejection_reason text)
language sql
security definer
set search_path = config, public
as $$
  select id, summary, effective_from, status, proposed_by, proposed_at, decided_by, decided_at, rejection_reason
  from config.revision
  where tenant_id = p_tenant and area = p_area
  order by proposed_at desc
$$;

create or replace function config.revision_payload(p_id uuid) returns jsonb
language sql
security definer
set search_path = config, public
as $$ select payload from config.revision where id = p_id $$;

revoke all on function audit.record_event(uuid,text,uuid,text,jsonb,jsonb,text,uuid) from anon, authenticated, public;
revoke all on function config.propose_revision(uuid,text,jsonb,text,timestamptz,text,uuid) from anon, authenticated, public;
revoke all on function config.decide_revision(uuid,text,boolean,text,uuid) from anon, authenticated, public;
revoke all on function config.effective_revision(uuid,text,timestamptz) from anon, authenticated, public;
revoke all on function config.list_revisions(uuid,text) from anon, authenticated, public;
revoke all on function config.revision_payload(uuid) from anon, authenticated, public;
grant execute on function audit.record_event(uuid,text,uuid,text,jsonb,jsonb,text,uuid) to service_role;
grant execute on function config.propose_revision(uuid,text,jsonb,text,timestamptz,text,uuid) to service_role;
grant execute on function config.decide_revision(uuid,text,boolean,text,uuid) to service_role;
grant execute on function config.effective_revision(uuid,text,timestamptz) to service_role;
grant execute on function config.list_revisions(uuid,text) to service_role;
grant execute on function config.revision_payload(uuid) to service_role;
