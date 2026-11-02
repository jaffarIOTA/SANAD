-- 0037_party_contact.sql
-- Sanad — how a party is reached: the email address and mobile number an officer keys at
-- intake (journey gap B1, OFFER_NOTICE_NO_CHANNEL).
--
-- The domain carries a contact masked only (core/notifications/contact.ts): the intake, the
-- application, their events and every screen. The address and number themselves are personal
-- data and live here, once, under a contact reference that is unique in the tenant
-- (`contactRefOf`: the intake and the party). Only the delivery adapter reads them back
-- (core/ports/party-contacts.ts).
--
--   core.party_contact   one row per recording — append-only; the latest for a reference is current
--
-- Nothing is updated or deleted, so which address a notice went to can always be shown. The
-- audit chain records that a contact was recorded and on which channels, never the address.
--
-- Portable PostgreSQL. `core`, never `public`.

create table if not exists core.party_contact (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            uuid        not null references core.tenant(id) on delete restrict,
  contact_ref          text        not null check (contact_ref ~ '^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$'),
  -- Normalised by core/notifications/contact.ts: the domain lower-cased; E.164.
  email                text        check (email is null or (length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$')),
  mobile               text        check (mobile is null or mobile ~ '^\+[1-9][0-9]{7,14}$'),
  -- Where it was captured (an intake, a consumer journey), by reference.
  context_ref          text        not null,
  sequence             bigint      generated always as identity,
  correlation_id       text        not null,
  created_at           timestamptz not null default now(),
  created_by           text        not null,
  constraint party_contact_has_channel check (email is not null or mobile is not null)
);

create index if not exists party_contact_current on core.party_contact (tenant_id, contact_ref, sequence desc);

-- -----------------------------------------------------------------------------
-- Tenancy and immutability.
-- -----------------------------------------------------------------------------
alter table core.party_contact enable row level security;
-- Forced, so the owner is held to the policy too (0018, SR-003).
alter table core.party_contact force row level security;
drop policy if exists tenant_scope on core.party_contact;
create policy tenant_scope on core.party_contact
  using (tenant_id = core.current_tenant_id()) with check (tenant_id = core.current_tenant_id());

drop trigger if exists trg_append_only on core.party_contact;
create trigger trg_append_only before update or delete on core.party_contact
  for each row execute function core.reject_update_and_delete();

-- -----------------------------------------------------------------------------
-- Who may touch it: the runtime role only (0018), never a hosted platform role.
-- -----------------------------------------------------------------------------
do $$
declare
  r text;
begin
  execute 'revoke all on core.party_contact from public';
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on core.party_contact from %I', r);
  end loop;
end;
$$;

grant select, insert on core.party_contact to sanad_app;
grant usage on sequence core.party_contact_sequence_seq to sanad_app;

-- -----------------------------------------------------------------------------
-- The audit chain (0019): that a contact was recorded, and on which channels. Never the address.
-- -----------------------------------------------------------------------------
create or replace function audit.on_party_contact() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.party_contact', new.id, 'CONTACT_RECORDED', null,
    jsonb_build_object(
      'contactRef', new.contact_ref,
      'contextRef', new.context_ref,
      'email', new.email is not null,
      'mobile', new.mobile is not null),
    new.created_by, audit.as_uuid(new.correlation_id));
  return null;
end
$$;

drop trigger if exists trg_audit_party_contact on core.party_contact;
create trigger trg_audit_party_contact
  after insert on core.party_contact
  for each row execute function audit.on_party_contact();
