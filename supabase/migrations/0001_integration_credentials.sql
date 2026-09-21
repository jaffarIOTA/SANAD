-- =============================================================================
-- 0001_integration_credentials.sql
-- Sanad — integration credential storage for Tuum, Nutrient and other providers.
--
-- DESIGN NOTE
-- The credential VALUE is never stored in this table. It lives in Supabase Vault
-- (encrypted at rest, key held outside the database). This table stores metadata
-- plus a reference to the vault secret.
--
-- Nothing in this file is reachable from PostgREST: the schemas are not exposed,
-- and anon/authenticated hold no grants. All access is service-role, server-side.
-- =============================================================================

create schema if not exists core;
create schema if not exists config;
create schema if not exists audit;

-- Keep these schemas OUT of Supabase's exposed-schema setting. See CLAUDE.md §3.1.
revoke all on schema core, config, audit from anon, authenticated;

-- -----------------------------------------------------------------------------
-- Minimal tenant anchor. Expanded by a later migration.
-- -----------------------------------------------------------------------------
create table if not exists core.tenant (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,          -- e.g. 'bank-a', 'fintech-b'
  name_en      text not null,
  name_ar      text not null,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

comment on table core.tenant is
  'Deploying institution. Root of every scope. Every domain row carries tenant_id.';

-- -----------------------------------------------------------------------------
-- Integration credentials — metadata only. Value lives in vault.secrets.
-- -----------------------------------------------------------------------------
create table if not exists config.integration_credential (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references core.tenant(id) on delete restrict,

  provider        text not null
                  check (provider in (
                    'TUUM',          -- core banking
                    'NUTRIENT',      -- document engine & signature
                    'ZATCA',         -- e-invoicing authority
                    'NAFATH',        -- identity
                    'WATHQ',         -- business registry
                    'SIMAH',         -- credit bureau
                    'SCREENING',     -- sanctions / PEP
                    'CSP',           -- certification service provider (signing)
                    'TSA'            -- timestamping authority
                  )),

  environment     text not null
                  check (environment in ('sandbox', 'uat', 'production')),

  key_name        text not null,     -- 'api_key', 'client_id', 'client_secret',
                                     -- 'webhook_secret', 'base_url', ...

  -- The value. Never stored here.
  vault_secret_id uuid not null,

  -- Operational metadata. Safe to read; contains no secret material.
  label           text,
  status          text not null default 'ACTIVE'
                  check (status in ('ACTIVE', 'ROTATING', 'REVOKED')),
  expires_at      timestamptz,
  last_rotated_at timestamptz,
  last_accessed_at timestamptz,

  created_at      timestamptz not null default now(),
  created_by      text not null default current_user,
  updated_at      timestamptz not null default now(),

  constraint integration_credential_unique
    unique (tenant_id, provider, environment, key_name)
);

comment on table config.integration_credential is
  'Metadata for external provider credentials. The secret value is held in Supabase '
  'Vault and referenced by vault_secret_id. Never add a plaintext value column.';

create index if not exists idx_integration_credential_lookup
  on config.integration_credential (tenant_id, provider, environment, status);

-- -----------------------------------------------------------------------------
-- Access audit. Append-only.
-- -----------------------------------------------------------------------------
create table if not exists audit.credential_access (
  id             bigserial primary key,
  credential_id  uuid not null,
  tenant_id      uuid not null,
  provider       text not null,
  environment    text not null,
  key_name       text not null,
  action         text not null check (action in ('READ', 'WRITE', 'ROTATE', 'REVOKE')),
  accessed_by    text not null,
  accessed_at    timestamptz not null default now(),
  correlation_id uuid
);

comment on table audit.credential_access is
  'Append-only record of every credential read or change. No UPDATE or DELETE grant.';

create index if not exists idx_credential_access_cred
  on audit.credential_access (credential_id, accessed_at desc);

create or replace function audit.no_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit.credential_access is append-only (attempted %)', tg_op;
end;
$$;

drop trigger if exists trg_credential_access_immutable on audit.credential_access;
create trigger trg_credential_access_immutable
  before update or delete on audit.credential_access
  for each row execute function audit.no_mutation();

-- -----------------------------------------------------------------------------
-- WRITE: create or rotate a credential.
-- -----------------------------------------------------------------------------
create or replace function config.set_integration_credential(
  p_tenant      uuid,
  p_provider    text,
  p_environment text,
  p_key_name    text,
  p_secret      text,
  p_label       text default null,
  p_expires_at  timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path = config, core, audit, vault, public
as $$
declare
  v_existing  config.integration_credential;
  v_secret_id uuid;
  v_vault_name text;
  v_action    text;
begin
  if p_secret is null or length(trim(p_secret)) = 0 then
    raise exception 'refusing to store an empty secret';
  end if;

  v_vault_name := format('sanad/%s/%s/%s/%s',
                         p_tenant, p_provider, p_environment, p_key_name);

  select * into v_existing
  from config.integration_credential
  where tenant_id = p_tenant
    and provider = p_provider
    and environment = p_environment
    and key_name = p_key_name;

  if found then
    -- Rotation: replace the value in place, keep the reference stable.
    perform vault.update_secret(v_existing.vault_secret_id, p_secret);
    update config.integration_credential
       set status          = 'ACTIVE',
           label           = coalesce(p_label, label),
           expires_at      = p_expires_at,
           last_rotated_at = now(),
           updated_at      = now()
     where id = v_existing.id;
    v_secret_id := v_existing.vault_secret_id;
    v_action := 'ROTATE';
  else
    v_secret_id := vault.create_secret(
      p_secret,
      v_vault_name,
      format('Sanad %s credential (%s)', p_provider, p_environment)
    );
    insert into config.integration_credential
      (tenant_id, provider, environment, key_name, vault_secret_id, label, expires_at)
    values
      (p_tenant, p_provider, p_environment, p_key_name, v_secret_id, p_label, p_expires_at)
    returning id into v_existing.id;
    v_action := 'WRITE';
  end if;

  insert into audit.credential_access
    (credential_id, tenant_id, provider, environment, key_name, action, accessed_by)
  values
    (v_existing.id, p_tenant, p_provider, p_environment, p_key_name, v_action, current_user);

  -- Returns the credential row id, NOT the secret.
  return v_existing.id;
end;
$$;

comment on function config.set_integration_credential is
  'Store or rotate a provider credential. The value goes to Vault; only a reference '
  'is kept in config.integration_credential. Returns the credential id, never the secret.';

-- -----------------------------------------------------------------------------
-- READ: server-side only. Every call is audited.
-- -----------------------------------------------------------------------------
create or replace function config.get_integration_credential(
  p_tenant         uuid,
  p_provider       text,
  p_environment    text,
  p_key_name       text,
  p_correlation_id uuid default null
) returns text
language plpgsql
security definer
set search_path = config, core, audit, vault, public
as $$
declare
  v_cred   config.integration_credential;
  v_secret text;
begin
  select * into v_cred
  from config.integration_credential
  where tenant_id = p_tenant
    and provider = p_provider
    and environment = p_environment
    and key_name = p_key_name;

  if not found then
    raise exception 'no credential: % / % / %', p_provider, p_environment, p_key_name;
  end if;

  if v_cred.status <> 'ACTIVE' then
    raise exception 'credential % is %', v_cred.id, v_cred.status;
  end if;

  if v_cred.expires_at is not null and v_cred.expires_at <= now() then
    raise exception 'credential % expired at %', v_cred.id, v_cred.expires_at;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where id = v_cred.vault_secret_id;

  if v_secret is null then
    raise exception 'vault secret missing for credential %', v_cred.id;
  end if;

  insert into audit.credential_access
    (credential_id, tenant_id, provider, environment, key_name,
     action, accessed_by, correlation_id)
  values
    (v_cred.id, p_tenant, p_provider, p_environment, p_key_name,
     'READ', current_user, p_correlation_id);

  update config.integration_credential
     set last_accessed_at = now()
   where id = v_cred.id;

  return v_secret;
end;
$$;

-- -----------------------------------------------------------------------------
-- LIST: metadata only. Safe for an admin UI. Returns no secret material.
-- -----------------------------------------------------------------------------
create or replace function config.list_integration_credentials(p_tenant uuid)
returns table (
  id uuid, provider text, environment text, key_name text, label text,
  status text, expires_at timestamptz, last_rotated_at timestamptz,
  last_accessed_at timestamptz, created_at timestamptz
)
language sql
security definer
set search_path = config, public
as $$
  select id, provider, environment, key_name, label, status,
         expires_at, last_rotated_at, last_accessed_at, created_at
  from config.integration_credential
  where tenant_id = p_tenant
  order by provider, environment, key_name;
$$;

create or replace function config.revoke_integration_credential(p_credential_id uuid)
returns void
language plpgsql
security definer
set search_path = config, audit, public
as $$
declare v_cred config.integration_credential;
begin
  update config.integration_credential
     set status = 'REVOKED', updated_at = now()
   where id = p_credential_id
  returning * into v_cred;

  if not found then raise exception 'no credential %', p_credential_id; end if;

  insert into audit.credential_access
    (credential_id, tenant_id, provider, environment, key_name, action, accessed_by)
  values
    (v_cred.id, v_cred.tenant_id, v_cred.provider, v_cred.environment,
     v_cred.key_name, 'REVOKE', current_user);
end;
$$;

-- -----------------------------------------------------------------------------
-- Lockdown. RLS on with no permissive policy denies everything except roles
-- that bypass RLS (service_role / table owner).
-- -----------------------------------------------------------------------------
alter table config.integration_credential enable row level security;
alter table audit.credential_access       enable row level security;
alter table core.tenant                   enable row level security;

revoke all on config.integration_credential from anon, authenticated, public;
revoke all on audit.credential_access       from anon, authenticated, public;
revoke all on core.tenant                   from anon, authenticated;

revoke all on function config.set_integration_credential(uuid,text,text,text,text,text,timestamptz)
  from anon, authenticated, public;
revoke all on function config.get_integration_credential(uuid,text,text,text,uuid)
  from anon, authenticated, public;
revoke all on function config.list_integration_credentials(uuid)
  from anon, authenticated, public;
revoke all on function config.revoke_integration_credential(uuid)
  from anon, authenticated, public;

grant execute on function config.set_integration_credential(uuid,text,text,text,text,text,timestamptz) to service_role;
grant execute on function config.get_integration_credential(uuid,text,text,text,uuid)                  to service_role;
grant execute on function config.list_integration_credentials(uuid)                                    to service_role;
grant execute on function config.revoke_integration_credential(uuid)                                   to service_role;
