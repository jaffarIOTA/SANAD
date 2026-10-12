-- 0025_business_intake.sql
-- Sanad — SME business intake and KYB/KYC: stages 1 to 4 of direct lending,
-- before the application reaches credit assessment at stage 5 (0016).
--
-- An institution may run stages 1–4 in Sanad (this file) or upstream in its own
-- customer record and hand over at stage 5 (POST /business-applications); both
-- meet at the same hand-over. A completed intake hands over with upstream_ref
-- 'intake:<intake_id>' and its check references as the application's
-- verification references.
--
--   core.business_intake        the intake, one row: entity, request, parties, check results
--   core.business_intake_event  every consent, check, clearance and hand-over — append-only
--   core.consent_record         the consent ledger: a grant or a withdrawal per row — append-only
--
-- Check results are outcomes and the provider's reference only (CLAUDE.md §5,
-- "snapshots, not copies"); no registry file, identity record or screening hit
-- is stored. No identity number: parties are display names and references.
--
-- Portable PostgreSQL. `core`, never `public`.

create table if not exists core.business_intake (
  tenant_id            uuid        not null references core.tenant(id) on delete restrict,
  intake_id            text        not null check (intake_id ~ '^INT-[0-9]{6,10}$'),
  status               text        not null check (status in ('DRAFT', 'HANDED_OVER', 'DECLINED', 'WITHDRAWN')),
  trade_licence        text        not null,
  currency             char(3)     not null check (currency in ('SAR', 'AED')),
  requested_minor      bigint      not null check (requested_minor > 0),
  -- The application this intake handed over to, once it has.
  application_id       text        check (application_id is null or application_id ~ '^[A-Z]{2,4}-[0-9]{6,10}$'),
  -- The whole intake as the domain holds it. Business identity, references and outcomes only.
  record               jsonb       not null,
  sequence             bigint      generated always as identity,
  correlation_id       text        not null,
  created_at           timestamptz not null default now(),
  created_by           text        not null,
  updated_at           timestamptz not null default now(),
  primary key (tenant_id, intake_id),
  constraint business_intake_status_matches check (record->>'status' = status),
  constraint business_intake_handed_over_has_application check ((status = 'HANDED_OVER') = (application_id is not null))
);

create index if not exists business_intake_by_status on core.business_intake (tenant_id, status);

create table if not exists core.business_intake_event (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null,
  intake_id            text        not null,
  event_type           text        not null,
  actor                text        not null,
  detail               jsonb       not null default '{}'::jsonb,
  occurred_at_epoch    bigint      not null,
  correlation_id       text        not null,
  created_at           timestamptz not null default now(),
  foreign key (tenant_id, intake_id) references core.business_intake (tenant_id, intake_id) on delete restrict
);

create index if not exists business_intake_event_by_intake on core.business_intake_event (tenant_id, intake_id, occurred_at_epoch);

-- The consent ledger (core/consent). A grant is a row; a withdrawal is another row naming the
-- consent it withdraws. Nothing is updated or deleted, so what was consented to, when and on
-- what evidence can always be shown (PDPL purpose limitation is a code path, CLAUDE.md §5).
create table if not exists core.consent_record (
  tenant_id            uuid        not null references core.tenant(id) on delete restrict,
  consent_id           text        not null,
  subject_ref          text        not null,
  consent_type         text        not null check (consent_type in (
                         'CREDIT_BUREAU', 'SCREENING', 'DATA_SHARING_WITH_PARTNER', 'NOTIFICATIONS',
                         'IDENTITY_VERIFICATION', 'DOCUMENT_VERIFICATION', 'EMPLOYMENT_VERIFICATION',
                         'ACCOUNT_INFORMATION', 'PAYMENT_INITIATION')),
  purpose              text        not null,
  channel              text        not null,
  evidence_ref         text        not null,
  -- Where the consent was captured (an intake, a consumer journey), by reference.
  context_ref          text        not null,
  granted_at_epoch     bigint      not null,
  expires_at_epoch     bigint,
  withdraws_consent_id text,
  correlation_id       text        not null,
  created_at           timestamptz not null default now(),
  created_by           text        not null,
  primary key (tenant_id, consent_id),
  constraint consent_record_expiry_after_grant check (expires_at_epoch is null or expires_at_epoch > granted_at_epoch)
);

create index if not exists consent_record_by_subject on core.consent_record (tenant_id, subject_ref, consent_type);

-- -----------------------------------------------------------------------------
-- Tenancy, immutability, currency.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['core.business_intake', 'core.business_intake_event', 'core.consent_record'] loop
    execute format('alter table %s enable row level security', t);
    -- Forced, so the owner is held to the policy too (0018, SR-003).
    execute format('alter table %s force row level security', t);
    execute format('drop policy if exists tenant_scope on %s', t);
    execute format('create policy tenant_scope on %s using (tenant_id = core.current_tenant_id()) with check (tenant_id = core.current_tenant_id())', t);
  end loop;
  foreach t in array array['core.business_intake_event', 'core.consent_record'] loop
    execute format('drop trigger if exists trg_append_only on %s', t);
    execute format('create trigger trg_append_only before update or delete on %s for each row execute function core.reject_update_and_delete()', t);
  end loop;
  execute 'drop trigger if exists trg_tenant_currency on core.business_intake';
  execute 'create trigger trg_tenant_currency before insert or update on core.business_intake for each row execute function core.assert_tenant_currency()';
end;
$$;

-- An intake keeps its identity, is never deleted, and is closed once handed over, declined or withdrawn.
create or replace function core.business_intake_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'intake % is never deleted; withdraw it', old.intake_id using errcode = 'restrict_violation';
  end if;
  if new.tenant_id <> old.tenant_id or new.intake_id <> old.intake_id or new.currency <> old.currency then
    raise exception 'intake % keeps its identity and currency', old.intake_id using errcode = 'restrict_violation';
  end if;
  if old.status in ('HANDED_OVER', 'DECLINED', 'WITHDRAWN') then
    raise exception 'intake % is closed (%)', old.intake_id, old.status using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_business_intake_guard on core.business_intake;
create trigger trg_business_intake_guard
  before update or delete on core.business_intake
  for each row execute function core.business_intake_guard();

-- An intake is business: it freezes a tenant's jurisdiction (0013) and locks a production
-- deployment's jurisdiction (0014) like every other piece of business.
create or replace function core.tenant_has_business(p_tenant uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from core.origination_request where tenant_id = p_tenant)
      or exists (select 1 from core.transaction where tenant_id = p_tenant)
      or exists (select 1 from core.offer where tenant_id = p_tenant)
      or exists (select 1 from core.business_application where tenant_id = p_tenant)
      or exists (select 1 from core.business_intake where tenant_id = p_tenant);
$$;

-- -----------------------------------------------------------------------------
-- Who may touch them: the runtime role only (0018), never a hosted platform role.
-- -----------------------------------------------------------------------------
do $$
declare
  r text;
  t text;
begin
  foreach t in array array['core.business_intake', 'core.business_intake_event', 'core.consent_record'] loop
    execute format('revoke all on %s from public', t);
    foreach r in array core.hosted_platform_roles() loop
      execute format('revoke all on %s from %I', t, r);
    end loop;
  end loop;
end;
$$;

grant select, insert, update on core.business_intake to sanad_app;
grant select, insert on core.business_intake_event to sanad_app;
grant select, insert on core.consent_record to sanad_app;
grant usage on sequence core.business_intake_sequence_seq to sanad_app;

-- -----------------------------------------------------------------------------
-- The audit chain (0019): every intake event and every consent, by identity only.
-- -----------------------------------------------------------------------------
create or replace function audit.on_business_intake_event() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.business_intake', audit.as_uuid(new.intake_id), 'INTAKE_' || new.event_type, null,
    jsonb_build_object('eventId', new.id, 'intakeId', new.intake_id),
    new.actor, audit.as_uuid(new.correlation_id));
  return null;
end
$$;

create or replace function audit.on_consent_record() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.consent_record', audit.as_uuid(new.consent_id),
    case when new.withdraws_consent_id is null then 'CONSENT_GRANTED' else 'CONSENT_WITHDRAWN' end, null,
    jsonb_build_object('consentId', new.consent_id, 'consentType', new.consent_type, 'contextRef', new.context_ref),
    new.created_by, audit.as_uuid(new.correlation_id));
  return null;
end
$$;

drop trigger if exists trg_audit_business_intake_event on core.business_intake_event;
create trigger trg_audit_business_intake_event after insert on core.business_intake_event
  for each row execute function audit.on_business_intake_event();

drop trigger if exists trg_audit_consent_record on core.consent_record;
create trigger trg_audit_consent_record after insert on core.consent_record
  for each row execute function audit.on_consent_record();
