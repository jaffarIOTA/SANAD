-- 0018_runtime_row_level_security.sql
-- Sanad — row-level security that binds at runtime (SR-003).
--
-- Until now every tenant table had a policy, but nothing set `sanad.tenant_id`
-- and the apps connected as the owner, which bypasses row-level security, so no
-- policy ever applied. This migration makes them apply:
--
--   1. FORCE row-level security on every table that carries `tenant_id` and a
--      policy, so even the owner is bound unless it holds BYPASSRLS.
--   2. Grant `sanad_app` (NOBYPASSRLS, owns nothing) exactly what the runtime
--      does to each table it touches. The application drops to it per
--      transaction (`set local role sanad_app`) and sets the tenant with
--      `set_config('sanad.tenant_id', …, true)` (services/origination/src/
--      tenant-scope.ts). Evidence and acceptances get no UPDATE; only the
--      idempotency ledger gets DELETE, for releasing an in-flight key.
--   3. `sanad_outbox`: the dispatcher's role. It reads and updates
--      `core.outbox_event` across tenants — claiming due events is the one
--      legitimately cross-tenant read — and nothing else.
--   4. The tenant directory (`core.tenant`) and the deployment profile are
--      readable by `sanad_app`: a tenant's code is resolved to its id before a
--      tenant is set, and the triggers that check a tenant's currency read it.
--   5. `sanad_runtime`: the LOGIN the applications should connect as. Member of
--      `sanad_app` and `sanad_outbox`, NOBYPASSRLS, owns nothing. Created
--      without a password; an operator sets one and stores the connection
--      string in the vault (deploy/azure/README.md, "Runtime database role").
--      Migrations keep running as the owner.
--
-- Portable PostgreSQL. Idempotent: safe to run again.

-- -----------------------------------------------------------------------------
-- 1. FORCE on every tenant table that has a policy.
-- -----------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in
    select n.nspname as s, c.relname as r
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and n.nspname in ('core', 'config', 'evidence', 'audit', 'products')
       and exists (select 1 from pg_catalog.pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
       and exists (select 1 from pg_catalog.pg_policy p where p.polrelid = c.oid)
  loop
    execute format('alter table %I.%I enable row level security', t.s, t.r);
    execute format('alter table %I.%I force row level security', t.s, t.r);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 2. What the runtime does, table by table.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sanad_app') then
    create role sanad_app nologin nobypassrls;
  end if;
  -- Whoever runs migrations (the owner) can drop to the runtime role for a transaction.
  execute format('grant sanad_app to %I with set true, inherit false', current_user);
end $$;

grant usage on schema core, config, evidence, audit to sanad_app;

grant select, insert, update on core.origination_request to sanad_app;
grant select, insert, update, delete on core.idempotency_key to sanad_app;
grant select, insert on core.outbox_event to sanad_app;
grant select, insert, update on core.offer to sanad_app;
grant select, insert on core.offer_acceptance to sanad_app;
grant select, insert, update on core.checkout_session to sanad_app;
grant select, insert on core.checkout_idempotency to sanad_app;
grant select, insert, update on core.merchant to sanad_app;
grant select, insert on evidence.presented_document to sanad_app;
grant select, insert, update on core.business_application to sanad_app;
grant select, insert, update on core.business_financial_figure to sanad_app;
grant select, insert, update on core.business_assessment to sanad_app;
grant select, insert, update on core.business_offer_letter to sanad_app;
grant select, insert on core.business_application_event to sanad_app;

grant usage on sequence core.origination_request_sequence_seq, core.offer_sequence_seq,
  core.checkout_session_sequence_seq, core.business_application_sequence_seq, core.merchant_sequence_seq
  to sanad_app;

-- The vault's tables are reached only through their SECURITY DEFINER functions, which also write the
-- access log; 0003's blanket audit-schema grant gave the runtime role this log too. It has no policy,
-- so RLS already refused every row; the grant goes as well.
revoke all on audit.credential_access, config.integration_credential from sanad_app;

-- The chained audit: its own SECURITY DEFINER function computes the hashes.
grant execute on function audit.record_event(uuid, text, uuid, text, jsonb, jsonb, text, uuid) to sanad_app;

-- -----------------------------------------------------------------------------
-- 3. The outbox dispatcher.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sanad_outbox') then
    create role sanad_outbox nologin nobypassrls;
  end if;
  execute format('grant sanad_outbox to %I with set true, inherit false', current_user);
end $$;

grant usage on schema core to sanad_outbox;
grant select, update on core.outbox_event to sanad_outbox;

drop policy if exists outbox_event_dispatch on core.outbox_event;
create policy outbox_event_dispatch on core.outbox_event
  to sanad_outbox
  using (true)
  with check (true);

-- -----------------------------------------------------------------------------
-- 4. Platform rows the runtime reads.
-- -----------------------------------------------------------------------------
grant select on core.tenant to sanad_app;
drop policy if exists tenant_directory_read on core.tenant;
create policy tenant_directory_read on core.tenant for select to sanad_app using (true);

grant select on config.deployment_profile to sanad_app;
drop policy if exists deployment_profile_read on config.deployment_profile;
create policy deployment_profile_read on config.deployment_profile for select to sanad_app using (true);

-- -----------------------------------------------------------------------------
-- 5. The login the applications connect as.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sanad_runtime') then
    create role sanad_runtime login nobypassrls nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  -- NOINHERIT: the login holds nothing until a transaction sets a role, exactly as the owner does.
  grant sanad_app to sanad_runtime with set true, inherit false;
  grant sanad_outbox to sanad_runtime with set true, inherit false;
end $$;

grant usage on schema core, config, audit to sanad_runtime;
grant select on core.tenant to sanad_runtime;
drop policy if exists tenant_directory_runtime on core.tenant;
create policy tenant_directory_runtime on core.tenant for select to sanad_runtime using (true);
grant select on config.deployment_profile to sanad_runtime;
drop policy if exists deployment_profile_runtime on config.deployment_profile;
create policy deployment_profile_runtime on config.deployment_profile for select to sanad_runtime using (true);

-- Platform configuration, reached only through its SECURITY DEFINER functions, outside any tenant scope.
-- Each enforces its own four eyes and audit. The proposing and deciding functions serve Admin; one login
-- serves every app today, and a separate Admin login is SR-046.
grant execute on function config.effective_revision(uuid, text, timestamptz) to sanad_runtime;
grant execute on function config.list_revisions(uuid, text) to sanad_runtime;
grant execute on function config.revision_payload(uuid) to sanad_runtime;
grant execute on function config.propose_revision(uuid, text, jsonb, text, timestamptz, text, uuid) to sanad_runtime;
grant execute on function config.decide_revision(uuid, text, boolean, text, uuid) to sanad_runtime;
grant execute on function config.get_integration_credential(uuid, text, text, text, uuid) to sanad_runtime;
grant execute on function config.list_integration_credentials(uuid) to sanad_runtime;
grant execute on function config.set_integration_credential(uuid, text, text, text, text, text, timestamptz) to sanad_runtime;
grant execute on function config.revoke_integration_credential(uuid) to sanad_runtime;
grant execute on function config.licence_installation() to sanad_runtime;
grant execute on function config.observe_licence_clock(timestamptz) to sanad_runtime;
grant execute on function config.list_licence_history() to sanad_runtime;
grant execute on function config.list_licence_proposals() to sanad_runtime;
grant execute on function config.propose_licence(text, uuid, text, text, text, uuid) to sanad_runtime;
grant execute on function config.decide_licence(uuid, boolean, text, text, uuid) to sanad_runtime;
grant execute on function config.record_checked_in_licence(text, uuid, text, text, uuid) to sanad_runtime;

comment on role sanad_runtime is
  'The applications'' database login (SR-003). NOBYPASSRLS, owns nothing, inherits nothing: every statement runs under SET LOCAL ROLE sanad_app with sanad.tenant_id set, or sanad_outbox for the dispatcher.';
