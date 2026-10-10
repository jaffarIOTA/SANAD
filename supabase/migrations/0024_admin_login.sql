-- 0024_admin_login.sql
-- Sanad — Admin's configuration functions belong to Admin's own login (SR-046).
--
-- Until now one login served every app, so `sanad_runtime` — the consumer
-- site's and the workbench's — could propose and decide revisions, licences
-- and the deployment's jurisdiction, and set or revoke integration
-- credentials. Several of those functions were also executable by PUBLIC (a
-- function's default) or by `sanad_app`, which any app's login can assume.
-- Each still enforced four eyes and audit; a compromised app process could
-- nevertheless drive them.
--
--   `sanad_admin`: a LOGIN like `sanad_runtime` (NOBYPASSRLS, owns nothing,
--   inherits nothing, may drop to `sanad_app` per transaction), holding
--   everything the runtime holds plus the configuration functions. Created
--   without a password; an operator sets one and stores Admin's connection
--   string in the vault (deploy/azure/README.md, "Admin database login").
--
--   `sanad_runtime` and `sanad_app` keep only what the other apps use: the
--   effective revision, a credential read, the jurisdiction and licence in
--   force, the licence check-in, spent tokens, the audit chain.
--
-- Portable PostgreSQL. Idempotent.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sanad_admin') then
    create role sanad_admin login nobypassrls nosuperuser nocreatedb nocreaterole noinherit;
  end if;
  grant sanad_app to sanad_admin with set true, inherit false;
end $$;

grant usage on schema core, config, audit to sanad_admin;
grant select on core.tenant to sanad_admin;
drop policy if exists tenant_directory_admin on core.tenant;
create policy tenant_directory_admin on core.tenant for select to sanad_admin using (true);
grant select on config.deployment_profile to sanad_admin;
drop policy if exists deployment_profile_admin on config.deployment_profile;
create policy deployment_profile_admin on config.deployment_profile for select to sanad_admin using (true);

-- What every app's login may execute, Admin's included.
do $$
declare
  f text;
begin
  foreach f in array array[
    'config.effective_revision(uuid, text, timestamptz)',
    'config.get_integration_credential(uuid, text, text, text, uuid)',
    'config.deployment_jurisdiction_locked()',
    'config.effective_deployment_jurisdiction()',
    'config.licence_installation()',
    'config.observe_licence_clock(timestamptz)',
    'config.list_licence_history()',
    'config.record_checked_in_licence(text, uuid, text, text, uuid)',
    'config.spend_token(text, text, timestamptz)',
    'config.token_spent(text, text)',
    'audit.record_event(uuid, text, uuid, text, jsonb, jsonb, text, uuid)',
    'audit.verify_chain(uuid)'
  ] loop
    execute format('grant execute on function %s to sanad_runtime, sanad_admin', f);
  end loop;
end $$;

-- Admin's alone: taken from PUBLIC, `sanad_app` and `sanad_runtime`, given to `sanad_admin`.
do $$
declare
  f text;
begin
  foreach f in array array[
    'config.propose_revision(uuid, text, jsonb, text, timestamptz, text, uuid)',
    'config.decide_revision(uuid, text, boolean, text, uuid)',
    'config.list_revisions(uuid, text)',
    'config.revision_payload(uuid, uuid)',
    'config.list_integration_credentials(uuid)',
    'config.set_integration_credential(uuid, text, text, text, text, text, timestamptz)',
    'config.revoke_integration_credential(uuid)',
    'config.propose_deployment_jurisdiction(char, text, text, uuid)',
    'config.decide_deployment_jurisdiction(uuid, boolean, text, text, uuid)',
    'config.list_deployment_jurisdiction_revisions()',
    'config.propose_licence(text, uuid, text, text, text, uuid)',
    'config.decide_licence(uuid, boolean, text, text, uuid)',
    'config.list_licence_proposals()'
  ] loop
    execute format('revoke execute on function %s from public, sanad_app, sanad_runtime', f);
    execute format('grant execute on function %s to sanad_admin', f);
  end loop;
end $$;

comment on role sanad_admin is
  'Admin''s database login (SR-046). NOBYPASSRLS, owns nothing, inherits nothing; holds the configuration functions no other app''s login may execute.';
