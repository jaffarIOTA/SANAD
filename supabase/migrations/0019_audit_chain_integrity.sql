-- 0019_audit_chain_integrity.sql
-- Sanad — the audit chain can be neither bypassed, forked nor left unchecked,
-- and every decision is in it (SR-009, SR-010, SR-011, SR-012).
--
--   1. The chain is computed by the table, not the caller. A BEFORE INSERT
--      trigger takes a per-tenant advisory lock, assigns the row's id after the
--      lock, links it to the tenant's latest row and computes its hash, so a
--      row written by any path, the owner's included, is chained correctly and a
--      forged hash is overwritten (SR-009). Concurrent writers for one tenant
--      queue on the lock and produce one linear chain (SR-010).
--   2. New rows (hash_version 2) hash a canonical UTC epoch in microseconds,
--      not timestamptz text, which depends on the session's TimeZone (SR-010).
--      Rows written before this migration stay version 1 and verify under UTC,
--      the hosted database's setting.
--   3. No runtime role can INSERT, UPDATE, DELETE or TRUNCATE anything in
--      `audit`. Writes go through `audit.record_event()`, which refuses an event
--      for any tenant but the one the transaction is scoped to (SR-009).
--   4. `audit.verify_chain(tenant)` walks a tenant's chain and names the first
--      broken row: a deleted row breaks the next row's link, an altered row its
--      own hash, a reordered pair both (SR-011). A TypeScript verifier
--      (services/origination/src/audit-verify.ts) recomputes the same hashes
--      independently.
--   5. Every decision, approval, acceptance, document, offer letter and
--      checkout state change writes a chained event in the same transaction,
--      by trigger, naming the actor recorded on the row (SR-012).
--
-- Not covered: removing the newest rows of a chain leaves a shorter chain that
-- still verifies. Anchoring the head outside the database is SR-008's work.
--
-- Portable PostgreSQL. Idempotent.

-- -----------------------------------------------------------------------------
-- Helpers.
-- -----------------------------------------------------------------------------
alter table audit.audit_event add column if not exists hash_version smallint not null default 1;
comment on column audit.audit_event.hash_version is
  '1: occurred_at hashed as timestamptz text (session TimeZone; verified under UTC). 2: UTC epoch microseconds.';

-- A text identifier as a stable uuid: the subject of an event is a uuid, most domain ids are text.
create or replace function audit.as_uuid(p_value text) returns uuid
language sql immutable
set search_path = ''
as $$
  select case
    when p_value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_value::uuid
    else md5(coalesce(p_value, ''))::uuid
  end
$$;

create or replace function audit.content_hash(
  p_version smallint, p_prev text, p_tenant uuid, p_subject_type text, p_subject_id uuid, p_event_type text,
  p_before jsonb, p_after jsonb, p_actor text, p_at timestamptz, p_correlation uuid
) returns text
language sql stable
set search_path = ''
as $$
  -- Built-in sha256(bytea): no extension, portable to the in-Kingdom PostgreSQL.
  select encode(sha256(convert_to(
    coalesce(p_prev, '') || '|' || p_tenant::text || '|' || p_subject_type || '|' || p_subject_id::text || '|' ||
    p_event_type || '|' || coalesce(p_before::text, '') || '|' || coalesce(p_after::text, '') || '|' || p_actor || '|' ||
    case p_version
      when 1 then ((p_at at time zone 'UTC')::text || '+00')
      else ((extract(epoch from p_at) * 1000000)::bigint)::text
    end || '|' || p_correlation::text, 'UTF8')), 'hex')
$$;

-- Read one tenant's audit rows whatever the caller's scope, then put the scope back. The owner is bound by
-- FORCE row-level security where it lacks BYPASSRLS; a chain computed on a filtered view would fork.
create or replace function audit.enter_tenant(p_tenant uuid) returns text
language plpgsql
set search_path = ''
as $$
declare
  v_previous text := current_setting('sanad.tenant_id', true);
begin
  perform set_config('sanad.tenant_id', p_tenant::text, true);
  return v_previous;
end
$$;

create or replace function audit.leave_tenant(p_previous text) returns void
language sql
set search_path = ''
as $$ select set_config('sanad.tenant_id', coalesce(p_previous, ''), true); $$;

-- -----------------------------------------------------------------------------
-- 1, 2. The chain, computed by the table.
-- -----------------------------------------------------------------------------
create or replace function audit.chain_event() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text;
begin
  -- One writer per tenant at a time, until its transaction ends.
  perform pg_advisory_xact_lock(hashtextextended('sanad.audit:' || new.tenant_id::text, 0));
  v_scope := audit.enter_tenant(new.tenant_id);
  -- The id is taken after the lock, so id order is chain order.
  new.id := nextval(pg_get_serial_sequence('audit.audit_event', 'id'));
  select e.content_hash into new.prev_hash
    from audit.audit_event e
   where e.tenant_id = new.tenant_id
   order by e.id desc
   limit 1;
  perform audit.leave_tenant(v_scope);
  new.occurred_at := clock_timestamp();
  new.hash_version := 2;
  new.content_hash := audit.content_hash(
    2::smallint, new.prev_hash, new.tenant_id, new.subject_type, new.subject_id, new.event_type,
    new.before_state, new.after_state, new.actor, new.occurred_at, new.correlation_id);
  return new;
end
$$;

drop trigger if exists trg_audit_event_chain on audit.audit_event;
create trigger trg_audit_event_chain
  before insert on audit.audit_event
  for each row execute function audit.chain_event();

-- The writer every path uses. The table computes the chain; this refuses another tenant's event.
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
set search_path = ''
as $$
declare
  v_scope text := nullif(current_setting('sanad.tenant_id', true), '');
  v_id    bigint;
begin
  if v_scope is not null and v_scope::uuid <> p_tenant then
    raise exception 'an audit event for another tenant cannot be recorded from this tenant''s scope'
      using errcode = 'insufficient_privilege';
  end if;
  insert into audit.audit_event (tenant_id, subject_type, subject_id, event_type, before_state, after_state, actor,
                                 correlation_id, content_hash)
  values (p_tenant, p_subject_type, p_subject_id, p_event_type, p_before, p_after, p_actor, p_correlation, '')
  returning id into v_id;
  return v_id;
end
$$;

-- -----------------------------------------------------------------------------
-- 3. No runtime role writes the audit schema directly.
-- -----------------------------------------------------------------------------
do $$
declare
  r text;
begin
  foreach r in array array['sanad_app', 'sanad_outbox', 'sanad_runtime'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke insert, update, delete, truncate on all tables in schema audit from %I', r);
      execute format('revoke usage on all sequences in schema audit from %I', r);
    end if;
  end loop;
end $$;
revoke insert, update, delete, truncate on all tables in schema audit from public;

revoke execute on function audit.record_event(uuid, text, uuid, text, jsonb, jsonb, text, uuid) from public;
grant execute on function audit.record_event(uuid, text, uuid, text, jsonb, jsonb, text, uuid) to sanad_app, sanad_runtime;
grant execute on function audit.as_uuid(text) to sanad_app;

-- -----------------------------------------------------------------------------
-- 4. The verifier.
-- -----------------------------------------------------------------------------
create or replace function audit.verify_chain(p_tenant uuid)
returns table (checked bigint, first_broken_id bigint, reason text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text;
  v_prev  text := null;
  v_n     bigint := 0;
  e       record;
begin
  v_scope := audit.enter_tenant(p_tenant);
  for e in select * from audit.audit_event a where a.tenant_id = p_tenant order by a.id loop
    v_n := v_n + 1;
    if e.prev_hash is distinct from v_prev then
      perform audit.leave_tenant(v_scope);
      return query select v_n, e.id, 'PREV_HASH_MISMATCH'::text;
      return;
    end if;
    if e.content_hash <> audit.content_hash(e.hash_version, e.prev_hash, e.tenant_id, e.subject_type, e.subject_id,
                                            e.event_type, e.before_state, e.after_state, e.actor, e.occurred_at,
                                            e.correlation_id) then
      perform audit.leave_tenant(v_scope);
      return query select v_n, e.id, 'CONTENT_HASH_MISMATCH'::text;
      return;
    end if;
    v_prev := e.content_hash;
  end loop;
  perform audit.leave_tenant(v_scope);
  return query select v_n, null::bigint, null::text;
end
$$;

revoke execute on function audit.verify_chain(uuid) from public;
grant execute on function audit.verify_chain(uuid) to sanad_runtime;

-- -----------------------------------------------------------------------------
-- 5. Every decision in the chain, in the same transaction.
-- -----------------------------------------------------------------------------
-- The actor on an origination request is the person whose act moved it: checker, then reviewer, then maker.
create or replace function audit.on_origination_request() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.origination_request', audit.as_uuid(new.request_id),
    'ORIGINATION_REQUEST_' || new.state,
    case when tg_op = 'UPDATE' then jsonb_build_object('state', old.state) end,
    jsonb_build_object('requestId', new.request_id, 'state', new.state),
    coalesce(new.request -> 'checker' ->> 'principalId', new.request -> 'reviewer' ->> 'principalId',
             new.request -> 'maker' ->> 'principalId', new.created_by),
    audit.as_uuid(new.correlation_id));
  return null;
end
$$;

create or replace function audit.on_checkout_session() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.checkout_session', audit.as_uuid(new.session_id), 'CHECKOUT_' || new.state,
    case when tg_op = 'UPDATE' then jsonb_build_object('state', old.state) end,
    jsonb_build_object('sessionId', new.session_id, 'merchantId', new.merchant_id, 'state', new.state),
    new.created_by, audit.as_uuid(new.correlation_id));
  return null;
end
$$;

create or replace function audit.on_offer_acceptance() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.offer', audit.as_uuid(new.offer_id), 'OFFER_ACCEPTED', null,
    jsonb_build_object('acceptanceId', new.acceptance_id, 'offerId', new.offer_id,
                       'disclosureVersion', new.disclosure_version),
    new.created_by, audit.as_uuid(new.correlation_id));
  return null;
end
$$;

-- The SME event log names its actor; its detail is not copied, only the event's identity.
create or replace function audit.on_business_event() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.business_application', audit.as_uuid(new.application_id), 'BUSINESS_' || new.event_type, null,
    jsonb_build_object('eventId', new.id, 'applicationId', new.application_id,
                       'fromStage', new.from_stage, 'toStage', new.to_stage),
    new.actor, audit.as_uuid(new.correlation_id));
  return null;
end
$$;

create or replace function audit.on_offer_letter() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.business_application', audit.as_uuid(new.application_id), 'OFFER_LETTER_ISSUED', null,
    jsonb_build_object('applicationId', new.application_id, 'letterVersion', new.letter_version,
                       'facilityMinor', new.facility_minor::text, 'currency', new.currency),
    new.created_by, audit.as_uuid(new.correlation_id));
  return null;
end
$$;

create or replace function audit.on_presented_document() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform audit.record_event(
    new.tenant_id, 'core.origination_request', audit.as_uuid(new.request_id), 'DOCUMENT_PRESENTED', null,
    jsonb_build_object('requestId', new.request_id, 'documentType', new.document_type,
                       'validationStatus', new.validation_status, 'position', new.position),
    new.created_by, audit.as_uuid(new.correlation_id));
  return null;
end
$$;

drop trigger if exists trg_audit_origination_request_insert on core.origination_request;
create trigger trg_audit_origination_request_insert after insert on core.origination_request
  for each row execute function audit.on_origination_request();
drop trigger if exists trg_audit_origination_request_state on core.origination_request;
create trigger trg_audit_origination_request_state after update of state on core.origination_request
  for each row when (old.state is distinct from new.state) execute function audit.on_origination_request();

drop trigger if exists trg_audit_checkout_session_insert on core.checkout_session;
create trigger trg_audit_checkout_session_insert after insert on core.checkout_session
  for each row execute function audit.on_checkout_session();
drop trigger if exists trg_audit_checkout_session_state on core.checkout_session;
create trigger trg_audit_checkout_session_state after update of state on core.checkout_session
  for each row when (old.state is distinct from new.state) execute function audit.on_checkout_session();

drop trigger if exists trg_audit_offer_acceptance on core.offer_acceptance;
create trigger trg_audit_offer_acceptance after insert on core.offer_acceptance
  for each row execute function audit.on_offer_acceptance();

drop trigger if exists trg_audit_business_event on core.business_application_event;
create trigger trg_audit_business_event after insert on core.business_application_event
  for each row execute function audit.on_business_event();

drop trigger if exists trg_audit_offer_letter on core.business_offer_letter;
create trigger trg_audit_offer_letter after insert on core.business_offer_letter
  for each row execute function audit.on_offer_letter();

drop trigger if exists trg_audit_presented_document on evidence.presented_document;
create trigger trg_audit_presented_document after insert on evidence.presented_document
  for each row execute function audit.on_presented_document();
