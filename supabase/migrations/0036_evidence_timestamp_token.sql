-- 0036 — evidence keeps the timestamp token that attests it (SR-006, SH-06).
--
-- Evidence has carried the digest of the token behind its instant since 0003,
-- but not the token, so an auditor could not re-verify when the evidence was
-- captured. With an RFC 3161 authority in place, the token is stamped over the
-- artefact's own SHA-256 and kept here beside its digest; a contract leg
-- already keeps its token (core.contract_leg.tsa_token).
--
-- Null where the host clock stood in (it issues no token; development and
-- declared-synthetic data only, ADR 0004). Once written it never changes: the
-- append-only guard now covers it and the digest too.
--
-- Portable PostgreSQL. Idempotent.

alter table evidence.evidence add column if not exists captured_tsa_token bytea;

comment on column evidence.evidence.captured_tsa_token is
  'The RFC 3161 token attesting captured_at, stamped over artefact_hash; its SHA-256 is captured_tsa_digest. '
  'Null only where the host clock stood in for the authority.';

create or replace function core.evidence_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'evidence is never deleted; supersede it instead'
      using errcode = 'restrict_violation';
  end if;

  if old.superseded_by is not null then
    raise exception 'evidence % is already superseded and cannot change again', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.id                  is distinct from old.id
  or new.tenant_id           is distinct from old.tenant_id
  or new.transaction_id      is distinct from old.transaction_id
  or new.evidence_type       is distinct from old.evidence_type
  or new.gate_satisfied      is distinct from old.gate_satisfied
  or new.source              is distinct from old.source
  or new.artefact_hash       is distinct from old.artefact_hash
  or new.captured_at         is distinct from old.captured_at
  or new.captured_tsa_digest is distinct from old.captured_tsa_digest
  or new.captured_tsa_token  is distinct from old.captured_tsa_token
  or new.validation_status   is distinct from old.validation_status then
    raise exception
      'evidence % is immutable; the only permitted change is to record that it has been superseded', old.id
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;
