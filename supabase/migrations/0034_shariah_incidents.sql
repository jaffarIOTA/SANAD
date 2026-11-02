-- 0034 — Shariah incidents (Wasl W6b-1; BR-F03, BR-F04, BR-F07).
--
-- A compliance check that fails on a live transaction, or a Shariah reviewer's
-- observation, raises an incident. It is then triaged (severity and owner),
-- planned, remediated and closed — in that order, each once, and closed by a
-- different reviewer from the one who remediated, with evidence. Decided with
-- the product owner on 26 October 2026: severity is LOW, MEDIUM, HIGH or
-- MATERIAL, and an open MATERIAL incident stops a transaction's commitment to
-- its sale (enforced in the application, which reads these rows).
--
-- The incident row is what was found, written once. Each step is an event row,
-- written once. The lifecycle is linear, so the table can say exactly which
-- step the n-th event is.
--
-- Portable PostgreSQL. Idempotent.

create table if not exists core.shariah_incident (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references core.tenant(id) on delete restrict,
  incident_ref    text        not null check (incident_ref ~ '^SI-[0-9]{6,9}$'),
  subject_ref     text        not null check (length(trim(subject_ref)) between 1 and 40),
  product_code    text        not null,
  check_code      text        not null,
  control         text        not null,
  reason          text        not null,
  -- Codes and references only; never a personal datum.
  context         jsonb       not null default '{}'::jsonb,
  observation     text        check (observation is null or length(observation) <= 2000),
  severity        text        not null check (severity in ('LOW', 'MEDIUM', 'HIGH', 'MATERIAL')),
  -- The same finding on the same subject is raised once, ever.
  fingerprint     text        not null check (length(fingerprint) = 64),
  raised_by       text        not null check (length(trim(raised_by)) > 0),
  raised_at       timestamptz not null,
  created_at      timestamptz not null default now(),
  created_by      text        not null default current_user,
  correlation_id  uuid        not null,

  constraint shariah_incident_ref_unique unique (tenant_id, incident_ref),
  constraint shariah_incident_fingerprint_unique unique (tenant_id, fingerprint),
  -- A reviewer's observation says what was observed.
  constraint shariah_incident_manual_observed check (check_code <> 'MANUAL' or length(trim(coalesce(observation, ''))) >= 3)
);

create index if not exists shariah_incident_by_subject on core.shariah_incident (tenant_id, subject_ref);

comment on table core.shariah_incident is
  'A Shariah incident as raised: by a compliance check or a reviewer, about one transaction, once. '
  'Its triage, plan, remediation and closure are core.shariah_incident_event rows (BR-F04).';

create table if not exists core.shariah_incident_event (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references core.tenant(id) on delete restrict,
  incident_id     uuid        not null references core.shariah_incident(id) on delete restrict,
  seq             integer     not null,
  kind            text        not null,
  detail          jsonb       not null,
  actor           text        not null check (length(trim(actor)) > 0),
  occurred_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  created_by      text        not null default current_user,
  correlation_id  uuid        not null,

  constraint shariah_incident_event_once unique (incident_id, seq),
  -- Linear: the first step is triage, then the plan, the remediation, the closure.
  constraint shariah_incident_event_in_order check (
    (seq = 1 and kind = 'TRIAGE') or (seq = 2 and kind = 'PLAN')
    or (seq = 3 and kind = 'REMEDIATE') or (seq = 4 and kind = 'CLOSE')
  ),
  constraint shariah_incident_event_triage_rated check (
    kind <> 'TRIAGE' or (detail ->> 'severity') in ('LOW', 'MEDIUM', 'HIGH', 'MATERIAL')
  ),
  constraint shariah_incident_event_closure_evidenced check (
    kind <> 'CLOSE' or length(trim(coalesce(detail ->> 'closureEvidence', ''))) >= 3
  )
);

comment on table core.shariah_incident_event is
  'Each step of a Shariah incident, once and in order. Closed by a different reviewer from the one who remediated.';

-- Each step follows the one before it in the same tenant; closing is four eyes; income to purify blocks closing
-- until the purification branch exists (W6b-2).
create or replace function core.shariah_incident_event_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_remediation record;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Shariah incident events are never changed or deleted' using errcode = 'restrict_violation';
  end if;
  if not exists (select 1 from core.shariah_incident where id = new.incident_id and tenant_id = new.tenant_id) then
    raise exception 'incident % is not this tenant''s', new.incident_id using errcode = 'restrict_violation';
  end if;
  if new.seq > 1 and not exists (
    select 1 from core.shariah_incident_event where incident_id = new.incident_id and seq = new.seq - 1
  ) then
    raise exception 'incident % step % comes after step %', new.incident_id, new.seq, new.seq - 1
      using errcode = 'restrict_violation';
  end if;
  if new.kind = 'CLOSE' then
    select actor, detail into v_remediation
      from core.shariah_incident_event where incident_id = new.incident_id and kind = 'REMEDIATE';
    if v_remediation.actor = new.actor then
      raise exception 'incident % is closed by someone other than its remediator', new.incident_id
        using errcode = 'restrict_violation';
    end if;
    if (v_remediation.detail ->> 'purificationRequired')::boolean is true then
      raise exception 'incident % affected income; it closes once the income is purified', new.incident_id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_shariah_incident_event_guard on core.shariah_incident_event;
create trigger trg_shariah_incident_event_guard
  before insert or update or delete on core.shariah_incident_event
  for each row execute function core.shariah_incident_event_guard();

drop trigger if exists trg_shariah_incident_append_only on core.shariah_incident;
create trigger trg_shariah_incident_append_only
  before update or delete on core.shariah_incident
  for each row execute function core.reject_update_and_delete();

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['shariah_incident', 'shariah_incident_event'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('alter table core.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on core.%I', t);
    execute format(
      'create policy tenant_isolation on core.%I using (tenant_id = core.current_tenant_id()) '
      'with check (tenant_id = core.current_tenant_id())', t);
    execute format('revoke all on core.%I from public', t);
    foreach r in array core.hosted_platform_roles() loop
      execute format('revoke all on core.%I from %I', t, r);
    end loop;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'sanad_app') then
    grant select, insert on core.shariah_incident to sanad_app;
    grant select, insert on core.shariah_incident_event to sanad_app;
  end if;
exception
  when insufficient_privilege then
    raise notice 'grants on the Shariah incident tables skipped; apply them with a privileged role';
end;
$$;
