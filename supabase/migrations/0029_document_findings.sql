-- 0029 — document findings (document intelligence D1, docs/DOCUMENT-INTELLIGENCE-PLAN.md).
--
-- For each document presented on an application, what the reading engine
-- found: the kind of document it recognised (or that it could not), the
-- dates it declares, and the checks run on it. The checker sees these beside
-- the document; they never accept or refuse a document on their own — a
-- person other than the presenter still validates every one.
--
-- Snapshots, not copies (CLAUDE.md §5): classification, dates and check
-- outcomes only. No name, identity number or address read off a page is
-- stored here; those stay inside the document, in the object store, which is
-- referenced by the document's hash.
--
-- Append-only: a document read again (another engine, another catalogue
-- version) is a new row; the latest per document is the one shown. Every
-- row says which engine and catalogue version produced it, so a finding can
-- be reproduced and two engines compared on the same documents.
--
-- Portable PostgreSQL. Idempotent.

create table if not exists evidence.document_finding (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references core.tenant(id) on delete restrict,
  subject_kind       text        not null check (subject_kind in ('BUSINESS_APPLICATION', 'WASL_REQUEST')),
  subject_ref        text        not null check (subject_ref ~ '^[A-Za-z0-9_:-]{1,64}$'),
  document_ref       text        not null check (length(document_ref) between 1 and 200),
  content_sha256     text        not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  declared_type      text        not null check (declared_type ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  -- {status, kind?, confidencePerTenThousand?, candidates?, reason?}
  classification     jsonb       not null,
  -- [{fact, status, value?|from?,to?}] — dates only
  facts              jsonb       not null default '[]'::jsonb,
  -- [{check, outcome}]
  checks             jsonb       not null default '[]'::jsonb,
  engine             text        not null check (engine ~ '^[a-z0-9_.-]{1,40}@[0-9A-Za-z_.-]{1,40}$'),
  catalogue_version  text        not null check (length(catalogue_version) between 1 and 40),
  source             text        not null check (source in ('LIVE', 'FIXTURE')),
  created_at         timestamptz not null default now(),
  created_by         text        not null default current_user,
  correlation_id     uuid        not null
);

create index if not exists document_finding_by_subject
  on evidence.document_finding (tenant_id, subject_kind, subject_ref, created_at);

alter table evidence.document_finding enable row level security;
alter table evidence.document_finding force row level security;
drop policy if exists tenant_scope on evidence.document_finding;
create policy tenant_scope on evidence.document_finding
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

drop trigger if exists trg_append_only on evidence.document_finding;
create trigger trg_append_only before update or delete on evidence.document_finding
  for each row execute function core.reject_update_and_delete();

do $$
declare
  r text;
begin
  revoke all on evidence.document_finding from public;
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on evidence.document_finding from %I', r);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'sanad_app') then
    grant select, insert on evidence.document_finding to sanad_app;
  end if;
exception
  when insufficient_privilege then
    raise notice 'grants on evidence.document_finding skipped; apply them with a privileged role';
end;
$$;
