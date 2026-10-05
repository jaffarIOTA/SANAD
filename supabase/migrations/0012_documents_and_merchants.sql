-- 0012_documents_and_merchants.sql
-- Sanad — documents presented against an origination request, and merchants.
--
-- Both were process memory. A presented document is evidence that something
-- was shown, when, and whether it validated; it is appended, never edited,
-- and a replacement supersedes rather than overwrites. A merchant is a
-- business the institution settles to; its row follows its onboarding state
-- and every change of state is in the audit chain.
--
-- Portable PostgreSQL. `evidence` and `core`, never `public`.

-- -----------------------------------------------------------------------------
-- Documents presented against a request, for the tenant's checklist.
-- `evidence.evidence` (0003) is the gate evidence of an executed transaction
-- and requires one; a request is not a transaction yet, so this is its own
-- table with the same append-only discipline.
-- -----------------------------------------------------------------------------
create table if not exists evidence.presented_document (
  id                     uuid        primary key default gen_random_uuid(),
  tenant_id              uuid        not null references core.tenant(id) on delete restrict,
  request_id             text        not null,
  document_type          text        not null,
  validation_status      text        not null check (validation_status in ('VALID', 'INVALID', 'PENDING')),
  -- When the document was captured, attested. Not when the row was written.
  captured_at_epoch      bigint      not null,
  captured_tsa_digest    text        not null,
  captured_tsa_authority text        not null,
  -- Where the artefact lives and its hash, once the document platform stores one.
  artefact_uri           text,
  artefact_hash          text,
  -- Position among the request's documents, so a reload returns them in the order presented.
  position               integer     not null check (position >= 0),
  correlation_id         text        not null,
  created_at             timestamptz not null default now(),
  created_by             text        not null,
  foreign key (tenant_id, request_id) references core.origination_request (tenant_id, request_id) on delete restrict,
  constraint presented_document_position_once unique (tenant_id, request_id, position)
);

create index if not exists presented_document_by_request
  on evidence.presented_document (tenant_id, request_id, position);

alter table evidence.presented_document enable row level security;
drop policy if exists presented_document_tenant on evidence.presented_document;
create policy presented_document_tenant on evidence.presented_document
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

drop trigger if exists trg_presented_document_append_only on evidence.presented_document;
create trigger trg_presented_document_append_only
  before update or delete on evidence.presented_document
  for each row execute function core.reject_update_and_delete();

-- -----------------------------------------------------------------------------
-- Merchants.
-- -----------------------------------------------------------------------------
create table if not exists core.merchant (
  tenant_id                uuid        not null references core.tenant(id) on delete restrict,
  merchant_id              text        not null,
  commercial_registration  text        not null check (commercial_registration ~ '^[0-9]{10}$'),
  status                   text        not null check (status in ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'CLOSED')),
  -- The whole merchant record as the domain holds it. References only: no account number, no personal datum.
  merchant                 jsonb       not null,
  sequence                 bigint      generated always as identity,
  correlation_id           text        not null,
  created_at               timestamptz not null default now(),
  created_by               text        not null,
  updated_at               timestamptz not null default now(),
  primary key (tenant_id, merchant_id),
  constraint merchant_status_matches check (merchant->>'status' = status),
  -- One registration, one merchant, per tenant.
  constraint merchant_registration_once unique (tenant_id, commercial_registration)
);

alter table core.merchant enable row level security;
drop policy if exists merchant_tenant on core.merchant;
create policy merchant_tenant on core.merchant
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

-- A closed merchant stays closed, and a merchant is never deleted: the
-- sessions and settlements that refer to it must keep referring to something.
create or replace function core.merchant_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'merchant % is never deleted; close it', old.merchant_id using errcode = 'restrict_violation';
  end if;
  if old.status = 'CLOSED' then
    raise exception 'merchant % is closed and does not change', old.merchant_id using errcode = 'restrict_violation';
  end if;
  if new.tenant_id <> old.tenant_id or new.merchant_id <> old.merchant_id or new.commercial_registration <> old.commercial_registration then
    raise exception 'merchant % keeps its identity; onboard a new merchant instead', old.merchant_id using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_merchant_guard on core.merchant;
create trigger trg_merchant_guard
  before update or delete on core.merchant
  for each row execute function core.merchant_guard();

do $$
declare
  r text;
  t text;
begin
  foreach t in array array['evidence.presented_document', 'core.merchant'] loop
    execute format('revoke all on %s from public', t);
    foreach r in array core.hosted_platform_roles() loop
      execute format('revoke all on %s from %I', t, r);
    end loop;
  end loop;
end;
$$;
