-- 0022_definer_search_path.sql
-- Sanad — no SECURITY DEFINER function resolves names through `public` (SR-029).
--
-- A definer function runs with its owner's rights. With `public` on its
-- search_path, an object planted in `public` under a name the body uses
-- unqualified would run with those rights. Each function below keeps exactly
-- the schemas its body uses, with pg_catalog first and pg_temp last; every
-- function it calls is a built-in or already schema-qualified, so behaviour is
-- unchanged.
--
-- And `config.revision_payload(id)` returned any tenant's revision payload. It
-- is replaced by `config.revision_payload(tenant, id)`, which returns only that
-- tenant's.
--
-- Portable PostgreSQL. Idempotent.

alter function config.set_integration_credential(uuid, text, text, text, text, text, timestamptz)
  set search_path = pg_catalog, config, core, audit, vault, pg_temp;
alter function config.get_integration_credential(uuid, text, text, text, uuid)
  set search_path = pg_catalog, config, core, audit, vault, pg_temp;
alter function config.list_integration_credentials(uuid)
  set search_path = pg_catalog, config, pg_temp;
alter function config.revoke_integration_credential(uuid)
  set search_path = pg_catalog, config, audit, pg_temp;
alter function config.propose_revision(uuid, text, jsonb, text, timestamptz, text, uuid)
  set search_path = pg_catalog, config, core, audit, pg_temp;
alter function config.decide_revision(uuid, text, boolean, text, uuid)
  set search_path = pg_catalog, config, core, audit, pg_temp;
alter function config.effective_revision(uuid, text, timestamptz)
  set search_path = pg_catalog, config, pg_temp;
alter function config.list_revisions(uuid, text)
  set search_path = pg_catalog, config, pg_temp;

drop function if exists config.revision_payload(uuid);
create or replace function config.revision_payload(p_tenant uuid, p_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$ select r.payload from config.revision r where r.tenant_id = p_tenant and r.id = p_id $$;

revoke execute on function config.revision_payload(uuid, uuid) from public;
do $$
declare
  r text;
begin
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke execute on function config.revision_payload(uuid, uuid) from %I', r);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'sanad_runtime') then
    grant execute on function config.revision_payload(uuid, uuid) to sanad_runtime;
  end if;
end $$;
