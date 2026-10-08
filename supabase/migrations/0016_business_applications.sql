-- 0016_business_applications.sql
-- Sanad — SME (business) applications: stages 5 to 9 of the direct-lending journey.
--
-- Stages 1–4 (application, needs assessment, product application, verification)
-- happen upstream, in the government portal and the core banking platform's
-- customer record; the application is handed over at stage 5 (credit
-- assessment). Sanad then owns credit assessment (5), decisioning (6) and
-- contract & disbursement (7), and records the hand-off to portfolio
-- management (8) and collections (9).
--
--   core.business_application        the application, one row, its current stage
--   core.business_financial_figure   each statement figure as read and as verified — append-only
--   core.business_assessment         each assessment run, with its full trace — append-only
--   core.business_offer_letter       each offer letter version, by content hash — append-only
--   core.business_application_event  every stage transition and send — append-only
--
-- Every amount is in the tenant's base currency (0013). No identity number is
-- stored here: owners and signatories appear by display name and by reference.
--
-- Portable PostgreSQL. `core`, never `public`.

create table if not exists core.business_application (
  tenant_id            uuid        not null references core.tenant(id) on delete restrict,
  application_id       text        not null check (application_id ~ '^[A-Z]{2,4}-[0-9]{6,10}$'),
  -- The upstream system's reference for the same application; the hand-over is idempotent on it.
  upstream_ref         text        not null,
  stage                smallint    not null check (stage between 5 and 9),
  status               text        not null check (status in (
                         'RECEIVED', 'SPREADING', 'SUBMITTED', 'ASSESSED', 'IN_COMMITTEE', 'APPROVED',
                         'DECLINED', 'OFFER_SENT', 'SIGNED', 'DISBURSED', 'WITHDRAWN')),
  product_code         text        not null,
  variant_code         text        not null,
  currency             char(3)     not null check (currency in ('SAR', 'AED')),
  requested_minor      bigint      not null check (requested_minor > 0),
  tenor_months         integer     not null check (tenor_months > 0),
  grace_months         integer     not null default 0 check (grace_months >= 0),
  -- The whole application as the domain holds it. Business identity and references only.
  record               jsonb       not null,
  sequence             bigint      generated always as identity,
  correlation_id       text        not null,
  created_at           timestamptz not null default now(),
  created_by           text        not null,
  updated_at           timestamptz not null default now(),
  primary key (tenant_id, application_id),
  constraint business_application_upstream_once unique (tenant_id, upstream_ref),
  constraint business_application_status_matches check (record->>'status' = status)
);

create index if not exists business_application_by_stage on core.business_application (tenant_id, stage, status);

create table if not exists core.business_financial_figure (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null,
  application_id       text        not null,
  metric               text        not null,
  period               text        not null,
  currency             char(3)     not null check (currency in ('SAR', 'AED')),
  read_minor           bigint,
  verified_minor       bigint,
  source_kind          text        not null check (source_kind in ('OCR', 'RAIL', 'OFFICER_ENTRY')),
  source_ref           text        not null,
  verified_by          text,
  verified_at_epoch    bigint,
  -- A later row for the same metric and period supersedes this one; nothing is edited.
  supersedes           uuid        references core.business_financial_figure(id),
  correlation_id       text        not null,
  created_at           timestamptz not null default now(),
  created_by           text        not null,
  foreign key (tenant_id, application_id) references core.business_application (tenant_id, application_id) on delete restrict,
  constraint business_figure_verified_consistent check ((verified_by is null) = (verified_at_epoch is null))
);

create index if not exists business_figure_by_application on core.business_financial_figure (tenant_id, application_id, metric, created_at);

create table if not exists core.business_assessment (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null,
  application_id       text        not null,
  outcome              text        not null check (outcome in ('STRAIGHT_THROUGH', 'COMMITTEE', 'DECLINE', 'REFER')),
  risk_level           text,
  cumulative_score     integer     check (cumulative_score between 0 and 10000),
  -- Knock-outs, section and criterion scores, route and its reason: the full trace.
  trace                jsonb       not null,
  policy_ref           text        not null,
  assessed_at_epoch    bigint      not null,
  correlation_id       text        not null,
  created_at           timestamptz not null default now(),
  created_by           text        not null,
  foreign key (tenant_id, application_id) references core.business_application (tenant_id, application_id) on delete restrict
);

create table if not exists core.business_offer_letter (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null,
  application_id       text        not null,
  -- sha256 of the canonical letter: what an acceptance records it was shown.
  letter_version       text        not null check (letter_version ~ '^[0-9a-f]{64}$'),
  letter               jsonb       not null,
  schedule             jsonb       not null,
  currency             char(3)     not null check (currency in ('SAR', 'AED')),
  facility_minor       bigint      not null check (facility_minor > 0),
  correlation_id       text        not null,
  created_at           timestamptz not null default now(),
  created_by           text        not null,
  foreign key (tenant_id, application_id) references core.business_application (tenant_id, application_id) on delete restrict,
  constraint business_offer_letter_version_once unique (tenant_id, application_id, letter_version)
);

create table if not exists core.business_application_event (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null,
  application_id       text        not null,
  event_type           text        not null,
  from_stage           smallint,
  to_stage             smallint,
  actor                text        not null,
  detail               jsonb       not null default '{}'::jsonb,
  occurred_at_epoch    bigint      not null,
  correlation_id       text        not null,
  created_at           timestamptz not null default now(),
  foreign key (tenant_id, application_id) references core.business_application (tenant_id, application_id) on delete restrict
);

create index if not exists business_event_by_application on core.business_application_event (tenant_id, application_id, occurred_at_epoch);

-- -----------------------------------------------------------------------------
-- Tenancy, immutability, currency.
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['core.business_application', 'core.business_financial_figure', 'core.business_assessment', 'core.business_offer_letter', 'core.business_application_event'] loop
    execute format('alter table %s enable row level security', t);
    execute format('drop policy if exists tenant_scope on %s', t);
    execute format('create policy tenant_scope on %s using (tenant_id = core.current_tenant_id()) with check (tenant_id = core.current_tenant_id())', t);
  end loop;
  foreach t in array array['core.business_financial_figure', 'core.business_assessment', 'core.business_offer_letter', 'core.business_application_event'] loop
    execute format('drop trigger if exists trg_append_only on %s', t);
    execute format('create trigger trg_append_only before update or delete on %s for each row execute function core.reject_update_and_delete()', t);
  end loop;
  foreach t in array array['core.business_application', 'core.business_financial_figure', 'core.business_offer_letter'] loop
    execute format('drop trigger if exists trg_tenant_currency on %s', t);
    execute format('create trigger trg_tenant_currency before insert or update on %s for each row execute function core.assert_tenant_currency()', t);
  end loop;
end;
$$;

-- An application keeps its identity, is never deleted, and does not move backwards
-- past a decision: once DECLINED, DISBURSED or WITHDRAWN it is closed.
create or replace function core.business_application_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'application % is never deleted; withdraw it', old.application_id using errcode = 'restrict_violation';
  end if;
  if new.tenant_id <> old.tenant_id or new.application_id <> old.application_id or new.upstream_ref <> old.upstream_ref or new.currency <> old.currency then
    raise exception 'application % keeps its identity and currency', old.application_id using errcode = 'restrict_violation';
  end if;
  if old.status in ('DECLINED', 'DISBURSED', 'WITHDRAWN') then
    raise exception 'application % is closed (%)', old.application_id, old.status using errcode = 'restrict_violation';
  end if;
  if new.stage < old.stage then
    raise exception 'application % does not move back a stage (% to %)', old.application_id, old.stage, new.stage using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_business_application_guard on core.business_application;
create trigger trg_business_application_guard
  before update or delete on core.business_application
  for each row execute function core.business_application_guard();

-- Business applications are business: they freeze a tenant's jurisdiction (0013) and lock a
-- production deployment's jurisdiction (0014) exactly as origination requests and transactions do.
create or replace function core.tenant_has_business(p_tenant uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from core.origination_request where tenant_id = p_tenant)
      or exists (select 1 from core.transaction where tenant_id = p_tenant)
      or exists (select 1 from core.offer where tenant_id = p_tenant)
      or exists (select 1 from core.business_application where tenant_id = p_tenant);
$$;

do $$
declare
  r text;
  t text;
begin
  foreach t in array array['core.business_application', 'core.business_financial_figure', 'core.business_assessment', 'core.business_offer_letter', 'core.business_application_event'] loop
    execute format('revoke all on %s from public', t);
    foreach r in array core.hosted_platform_roles() loop
      execute format('revoke all on %s from %I', t, r);
    end loop;
  end loop;
end;
$$;
