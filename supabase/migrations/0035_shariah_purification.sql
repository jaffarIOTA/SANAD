-- 0035 — purification closes the incident (Wasl W6b-2; BR-F06).
--
-- An incident remediated as having affected income was refused closure
-- outright (0034) until purification existed. Purification now does: it is
-- proposed by a Shariah reviewer, confirmed by a second (the
-- PURIFICATION_CONFIRMED event on the transaction, carrying the amount), and
-- raised to core.charity_ledger as NON_COMPLIANT_INCOME share by share, as
-- each instalment is collected, under the key
-- `wasl:<transaction>:purify:<incident>:I<n>` (decided 26 October 2026).
--
-- So the closure is allowed when, and only when, a confirmed purification
-- exists for the incident and the charity ledger holds exactly its amount
-- under the incident's keys: the database checks the segregation itself, not
-- the application's word for it. Everything else in the guard is unchanged.
--
-- Portable PostgreSQL. Idempotent.

create or replace function core.shariah_incident_event_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_remediation record;
  v_ref text;
  v_confirmed bigint;
  v_raised bigint;
begin
  if tg_op <> 'INSERT' then
    raise exception 'Shariah incident events are never changed or deleted' using errcode = 'restrict_violation';
  end if;
  select incident_ref into v_ref
    from core.shariah_incident where id = new.incident_id and tenant_id = new.tenant_id;
  if v_ref is null then
    raise exception 'incident % is not this tenant''s', new.incident_id using errcode = 'restrict_violation';
  end if;
  if new.seq > 1 and not exists (
    select 1 from core.shariah_incident_event where incident_id = new.incident_id and seq = new.seq - 1
  ) then
    raise exception 'incident % step % comes after step %', new.incident_id, new.seq, new.seq - 1
      using errcode = 'restrict_violation';
  end if;
  if new.kind = 'CLOSE' then
    select actor, detail into v_remediation
      from core.shariah_incident_event where incident_id = new.incident_id and kind = 'REMEDIATE';
    if v_remediation.actor = new.actor then
      raise exception 'incident % is closed by someone other than its remediator', new.incident_id
        using errcode = 'restrict_violation';
    end if;
    if (v_remediation.detail ->> 'purificationRequired')::boolean is true then
      select max((e.detail ->> 'amountMinor')::bigint) into v_confirmed
        from core.transaction_event e
       where e.tenant_id = new.tenant_id and e.event_type = 'PURIFICATION_CONFIRMED'
         and e.detail ->> 'incidentRef' = v_ref;
      select coalesce(sum(l.amount_minor), 0) into v_raised
        from core.charity_ledger l
       where l.tenant_id = new.tenant_id and l.reason = 'NON_COMPLIANT_INCOME'
         and l.source_ref like 'wasl:%:purify:' || v_ref || ':I%';
      if v_confirmed is null or v_confirmed <= 0 or v_raised <> v_confirmed then
        raise exception 'incident % affected income; it closes once that income is purified in full', v_ref
          using errcode = 'restrict_violation';
      end if;
    end if;
  end if;
  return new;
end;
$$;
