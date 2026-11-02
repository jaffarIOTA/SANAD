-- 0030 — each charity ledger entry names what it came from (Wasl W4b-2).
--
-- A late amount reaches core.charity_ledger when SADAD reports its bill paid,
-- by webhook or in the paid-bills file, whichever arrives first. The entry now
-- carries the bill's reference (`wasl:<transaction>:late:I<n>`), unique per
-- tenant, so the same collection can never raise the liability twice — the
-- database is the second lock behind the event log's own check.
--
-- Nullable: entries from before this migration, and amounts identified by
-- review rather than collected against a bill, have none. Once written it is
-- as immutable as the amount (the write-once trigger is extended to it).
--
-- Portable PostgreSQL. Idempotent.

alter table core.charity_ledger
  add column if not exists source_ref text
    check (source_ref is null or source_ref ~ '^[A-Za-z0-9_:-]{1,128}$');

create unique index if not exists charity_ledger_source_once
  on core.charity_ledger (tenant_id, source_ref)
  where source_ref is not null;

comment on column core.charity_ledger.source_ref is
  'What raised this entry: for a collected late amount, the late bill''s idempotency key. One entry per source.';

-- An entry is written once. Only the disbursement fields may later be filled in, once.
create or replace function core.charity_ledger_write_once() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'charity ledger entries are never deleted'
      using errcode = 'restrict_violation';
  end if;
  if new.amount_minor    is distinct from old.amount_minor
  or new.account_class   is distinct from old.account_class
  or new.reason          is distinct from old.reason
  or new.transaction_id  is distinct from old.transaction_id
  or new.tenant_id       is distinct from old.tenant_id
  or new.source_ref      is distinct from old.source_ref
  or new.computation_basis_config_key is distinct from old.computation_basis_config_key
  or new.shariah_approval_id is distinct from old.shariah_approval_id
  or new.recorded_at     is distinct from old.recorded_at then
    raise exception
      'charity ledger entry % is immutable; only the disbursement record may be completed', old.id
      using errcode = 'restrict_violation';
  end if;
  if old.disbursement_ref is not null then
    raise exception 'charity ledger entry % has already been disbursed', old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;
