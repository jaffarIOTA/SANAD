-- 0020_consumed_assertion.sql
-- Sanad — an identity assertion is accepted once (SR-007).
--
-- Every Nafath or UAE Pass assertion a tenant accepts is recorded here. The
-- primary key on (tenant, assertion) is the control: a second presentation of
-- the same assertion, or two at once, cannot both insert, so a captured
-- assertion signs no one in twice. Append-only; nothing is updated or deleted.
-- No personal data: the provider's assertion id and its completion time only.
--
-- Portable PostgreSQL. Idempotent.

create table if not exists core.consumed_assertion (
  tenant_id        uuid        not null references core.tenant(id) on delete restrict,
  assertion_id     text        not null check (length(assertion_id) between 1 and 200),
  authenticated_at timestamptz not null,
  consumed_at      timestamptz not null default now(),
  created_by       text        not null default current_user,
  correlation_id   uuid        not null default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  primary key (tenant_id, assertion_id)
);

comment on table core.consumed_assertion is
  'Identity assertions already accepted, per tenant. The primary key refuses a replay (SR-007). Append-only.';

drop trigger if exists trg_consumed_assertion_append_only on core.consumed_assertion;
create trigger trg_consumed_assertion_append_only
  before update or delete on core.consumed_assertion
  for each row execute function core.reject_update_and_delete();

alter table core.consumed_assertion enable row level security;
alter table core.consumed_assertion force row level security;
drop policy if exists consumed_assertion_tenant on core.consumed_assertion;
create policy consumed_assertion_tenant on core.consumed_assertion
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

do $$
declare
  r text;
begin
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on core.consumed_assertion from %I', r);
  end loop;
end $$;
revoke all on core.consumed_assertion from public;
grant select, insert on core.consumed_assertion to sanad_app;
