-- =============================================================================
-- 0005_vault_extension_guard.sql
-- Sanad — make the secret-store dependency explicit, and record which backend
-- this deployment is using.
--
-- Migration 0001 calls vault.create_secret, vault.update_secret and reads
-- vault.decrypted_secrets, but never asserts that the extension providing them
-- exists. On the hosted development platform it is pre-installed, so the gap is
-- invisible there and only surfaces on a self-hosted deployment — which, per
-- ADR 0001, is where this will actually run.
--
-- A dependency that only fails in the environment you care about is worse than
-- one that fails everywhere. This makes it fail immediately and say why.
--
-- See docs/adr/0001-data-residency-and-datastore.md.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    begin
      create extension supabase_vault;
      raise notice 'enabled the vault extension';
    exception
      when others then
        raise exception using
          errcode = 'feature_not_supported',
          message = 'no secret store is available on this deployment',
          detail  = 'Migration 0001 stores integration credentials through vault.create_secret '
                    'and vault.decrypted_secrets, which this PostgreSQL instance does not provide.',
          hint    = 'This is expected on a self-hosted in-Kingdom deployment. Implement the bodies '
                    'of config.set_integration_credential and config.get_integration_credential '
                    'against the secret backend chosen in ADR 0001 — their signatures do not '
                    'mention the backend, so no caller changes. Then re-run this migration.';
    end;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Which backend is in use, recorded rather than inferred.
--
-- The continuous residency control (SDD §5.9) needs to be able to answer "where
-- is the key material for this deployment" without someone reading migrations.
-- -----------------------------------------------------------------------------
create table if not exists config.deployment_profile (
  id                    boolean primary key default true check (id),  -- single row
  secret_backend        text not null
                        check (secret_backend in ('HOSTED_PLATFORM_VAULT',
                                                  'EXTERNAL_SECRETS_MANAGER',
                                                  'DATABASE_ENCRYPTED_CUSTOMER_KEY')),
  key_custody           text not null
                        check (key_custody in ('PLATFORM_MANAGED', 'CUSTOMER_MANAGED_HSM')),
  data_region           text not null,
  /** False for any environment not cleared to hold production data. */
  production_data_permitted boolean not null default false,
  recorded_at           timestamptz not null default now(),
  recorded_by           text not null default current_user
);

comment on table config.deployment_profile is
  'Where this deployment keeps its key material and its data. One row. Read by the '
  'residency control and by the deployment checklist; see ADR 0001.';

-- Development default. A production deployment overwrites this row, and the
-- check constraint below refuses the combination that ADR 0001 rules out.
insert into config.deployment_profile
  (secret_backend, key_custody, data_region, production_data_permitted)
values
  ('HOSTED_PLATFORM_VAULT', 'PLATFORM_MANAGED', 'non-kingdom-development', false)
on conflict (id) do nothing;

-- Production data never sits behind a platform-managed key, and never outside
-- the Kingdom. Stated as a constraint so it is refused rather than reviewed.
alter table config.deployment_profile
  drop constraint if exists deployment_profile_production_requires_kingdom_and_hsm;

alter table config.deployment_profile
  add constraint deployment_profile_production_requires_kingdom_and_hsm
  check (
    production_data_permitted = false
    or (key_custody = 'CUSTOMER_MANAGED_HSM' and data_region like 'kingdom-%')
  );

alter table config.deployment_profile enable row level security;
revoke all on config.deployment_profile from anon, authenticated, public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'sanad_app') then
    grant select on config.deployment_profile to sanad_app;
  end if;
exception
  when insufficient_privilege then
    raise notice 'grant to sanad_app skipped; apply it with a privileged role';
end;
$$;
