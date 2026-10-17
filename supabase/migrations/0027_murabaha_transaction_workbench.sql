-- =============================================================================
-- 0027 — the Murabaha transaction in the workbench (Wasl W1).
--
-- An approved origination request opens one transaction, in DRAFT
-- (products/murabaha-scf/origination/open-transaction.ts). Migration 0003 holds
-- the transaction's figures, gates and instants; this adds what links it to the
-- workbench and the trade, and the transaction's own append-only event log —
-- the record of who moved it, when, and on what evidence.
--
-- * transaction_ref — the reference staff and the distributor see (WT-…).
-- * request_ref — the approved origination request it came from. One
--   transaction per request: approving opens a file once.
-- * trade_* — the cleared invoice it finances (SH-10). The financed-invoice
--   registry (0003) is what makes financing it twice impossible (M-5); these
--   columns say which trade this transaction is.
--
-- All of them are written at opening and never change: a transaction does not
-- become another request's or another trade's.
-- =============================================================================

alter table core.transaction add column if not exists transaction_ref    text;
alter table core.transaction add column if not exists request_ref        text;
alter table core.transaction add column if not exists trade_invoice_uuid uuid;
alter table core.transaction add column if not exists trade_invoice_hash text;
alter table core.transaction add column if not exists trade_issuer_cr    text;
alter table core.transaction add column if not exists trade_recipient_cr text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transaction_ref_shape') then
    alter table core.transaction add constraint transaction_ref_shape
      check (transaction_ref is null or transaction_ref ~ '^WT-[0-9]{6,10}$');
  end if;
  -- Opened from the workbench, a transaction carries all of its links; a row without them is 0003's own.
  if not exists (select 1 from pg_constraint where conname = 'transaction_links_together') then
    alter table core.transaction add constraint transaction_links_together
      check (
        (transaction_ref is null and request_ref is null and trade_invoice_uuid is null)
        or (transaction_ref is not null and request_ref is not null and trade_invoice_uuid is not null
            and trade_invoice_hash is not null and trade_issuer_cr is not null and trade_recipient_cr is not null)
      );
  end if;
end;
$$;

create unique index if not exists transaction_ref_once
  on core.transaction (tenant_id, transaction_ref) where transaction_ref is not null;
create unique index if not exists transaction_request_once
  on core.transaction (tenant_id, request_ref) where request_ref is not null;

create or replace function core.transaction_links_immutable() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.transaction_ref is not null and (
       new.transaction_ref    is distinct from old.transaction_ref
    or new.request_ref        is distinct from old.request_ref
    or new.trade_invoice_uuid is distinct from old.trade_invoice_uuid
    or new.trade_invoice_hash is distinct from old.trade_invoice_hash
    or new.trade_issuer_cr    is distinct from old.trade_issuer_cr
    or new.trade_recipient_cr is distinct from old.trade_recipient_cr
    or new.tenant_id          is distinct from old.tenant_id
    or new.programme_id       is distinct from old.programme_id
    or new.counterparty_id    is distinct from old.counterparty_id) then
    raise exception 'transaction % keeps its request, trade, programme and counterparty', old.transaction_ref
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_transaction_links_immutable on core.transaction;
create trigger trg_transaction_links_immutable
  before update on core.transaction
  for each row execute function core.transaction_links_immutable();

-- -----------------------------------------------------------------------------
-- core.transaction_event — append-only.
-- -----------------------------------------------------------------------------
create table if not exists core.transaction_event (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references core.tenant(id) on delete restrict,
  transaction_id     uuid        not null references core.transaction(id) on delete restrict,
  event_type         text        not null check (event_type ~ '^[A-Z][A-Z_]{2,63}$'),
  from_state         text,
  to_state           text,
  actor              text        not null,
  -- References only: evidence ids, leg ids, document hashes, codes. Never a person's identifier.
  detail             jsonb       not null default '{}'::jsonb,
  occurred_at_epoch  bigint      not null,
  correlation_id     text        not null,
  created_at         timestamptz not null default now()
);

create index if not exists transaction_event_by_transaction
  on core.transaction_event (tenant_id, transaction_id, occurred_at_epoch);

alter table core.transaction_event enable row level security;
alter table core.transaction_event force row level security;
drop policy if exists tenant_scope on core.transaction_event;
create policy tenant_scope on core.transaction_event
  using (tenant_id = core.current_tenant_id())
  with check (tenant_id = core.current_tenant_id());

drop trigger if exists trg_append_only on core.transaction_event;
create trigger trg_append_only before update or delete on core.transaction_event
  for each row execute function core.reject_update_and_delete();

do $$
declare
  r text;
begin
  revoke all on core.transaction_event from public;
  foreach r in array core.hosted_platform_roles() loop
    execute format('revoke all on core.transaction_event from %I', r);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'sanad_app') then
    grant select, insert on core.transaction_event to sanad_app;
  end if;
exception
  when insufficient_privilege then
    raise notice 'grants on core.transaction_event skipped; apply them with a privileged role';
end;
$$;
