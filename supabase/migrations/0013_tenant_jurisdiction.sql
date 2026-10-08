-- 0013_tenant_jurisdiction.sql
-- Sanad — the institution's jurisdiction, recorded at onboarding (ADR 0005).
--
-- Sanad serves institutions in Saudi Arabia (SAR) and the UAE (AED). Which
-- rules, currency, calendars and rails apply is decided by one fact recorded
-- on the tenant when it is onboarded, never by a request. This migration:
--
--   1. records the onboarding facts on core.tenant — jurisdiction, licence
--      type, product window, base currency — with the currency bound to the
--      jurisdiction by a constraint;
--   2. freezes the jurisdiction and currency once the tenant has done any
--      business, because every amount it has recorded is in that currency;
--   3. makes every money-bearing table refuse a row whose currency is not
--      its tenant's base currency, so an AED amount cannot enter a SAR book;
--   4. onboards the illustrative UAE tenant.
--
-- Portable PostgreSQL. `core`, never `public`.

-- -----------------------------------------------------------------------------
-- 1. Onboarding facts on the tenant.
-- -----------------------------------------------------------------------------
alter table core.tenant add column if not exists jurisdiction   char(2) not null default 'SA';
alter table core.tenant add column if not exists base_currency  char(3) not null default 'SAR';
alter table core.tenant add column if not exists licence_type   text    not null default 'BANK';
alter table core.tenant add column if not exists product_window text    not null default 'BOTH';
alter table core.tenant add column if not exists onboarded_at   timestamptz not null default now();
alter table core.tenant add column if not exists onboarded_by   text    not null default 'migration-0013';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenant_jurisdiction_known') then
    alter table core.tenant add constraint tenant_jurisdiction_known check (jurisdiction in ('SA', 'AE'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenant_currency_is_jurisdictions') then
    -- The base currency is the jurisdiction's. An institution onboarded in Abu Dhabi has dirham books.
    alter table core.tenant add constraint tenant_currency_is_jurisdictions
      check ((jurisdiction = 'SA' and base_currency = 'SAR') or (jurisdiction = 'AE' and base_currency = 'AED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenant_licence_known') then
    alter table core.tenant add constraint tenant_licence_known check (licence_type in ('BANK', 'FINANCE_COMPANY', 'DEVELOPMENT_FUND', 'FINTECH'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenant_window_known') then
    alter table core.tenant add constraint tenant_window_known check (product_window in ('ISLAMIC', 'CONVENTIONAL', 'BOTH'));
  end if;
end;
$$;

comment on column core.tenant.jurisdiction is
  'ISO 3166 alpha-2 of the jurisdiction the institution was onboarded under (ADR 0005). Decides rules, currency, calendars and rails.';
comment on column core.tenant.base_currency is
  'The jurisdiction''s currency. Every money-bearing row of this tenant is in it.';

-- -----------------------------------------------------------------------------
-- 2. Jurisdiction and currency are frozen once the tenant has done business.
-- -----------------------------------------------------------------------------
create or replace function core.tenant_has_business(p_tenant uuid) returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from core.origination_request where tenant_id = p_tenant)
      or exists (select 1 from core.transaction where tenant_id = p_tenant)
      or exists (select 1 from core.offer where tenant_id = p_tenant);
$$;

create or replace function core.tenant_jurisdiction_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.jurisdiction <> old.jurisdiction or new.base_currency <> old.base_currency)
     and core.tenant_has_business(old.id) then
    raise exception 'tenant % has recorded business in %; its jurisdiction and currency do not change — onboard a new tenant',
      old.code, old.base_currency using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_tenant_jurisdiction_guard on core.tenant;
create trigger trg_tenant_jurisdiction_guard
  before update on core.tenant
  for each row execute function core.tenant_jurisdiction_guard();

-- -----------------------------------------------------------------------------
-- 3. Every money-bearing row is in its tenant's currency.
-- -----------------------------------------------------------------------------
create or replace function core.assert_tenant_currency() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_base char(3);
begin
  select base_currency into v_base from core.tenant where id = new.tenant_id;
  if v_base is null then
    raise exception 'unknown tenant %', new.tenant_id using errcode = 'foreign_key_violation';
  end if;
  if new.currency is distinct from v_base then
    raise exception 'currency % is not the tenant''s base currency %', new.currency, v_base using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['core.programme', 'core.transaction', 'core.financed_invoice_registry', 'core.obligation', 'core.charity_ledger'] loop
    execute format('drop trigger if exists trg_tenant_currency on %s', t);
    execute format('create trigger trg_tenant_currency before insert or update on %s for each row execute function core.assert_tenant_currency()', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. Onboarding facts for the existing tenants, and the illustrative UAE tenant.
-- -----------------------------------------------------------------------------
update core.tenant set jurisdiction = 'SA', base_currency = 'SAR', licence_type = 'BANK', product_window = 'BOTH' where code = 'bank-a';
update core.tenant set jurisdiction = 'SA', base_currency = 'SAR', licence_type = 'FINANCE_COMPANY', product_window = 'BOTH' where code = 'fintech-b';

insert into core.tenant (code, name_en, name_ar, jurisdiction, base_currency, licence_type, product_window, onboarded_by)
values ('sme-fund-ae', 'SME Development Fund (UAE) — illustrative tenant', 'صندوق تنمية المنشآت (الإمارات) — مؤسسة توضيحية', 'AE', 'AED', 'DEVELOPMENT_FUND', 'BOTH', 'migration-0013')
on conflict (code) do nothing;

do $$
declare
  r text;
begin
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on function core.tenant_has_business(uuid) from %I', r);
  end loop;
end;
$$;
