-- 0028 — the SME portal's spent tokens (Wasl W3).
--
-- The SME portal signs a distributor's authorised signatory in through the
-- national digital identity service and keeps the session in a sealed cookie,
-- as the consumer journey does (0023). Two more purposes:
--
-- * SME_SESSION — a signed-out session; a copy of the cookie is no session (SR-030).
-- * SME_PENDING — the pending identity request between start and confirmation
--   (sign-in, or the signature on a sale offer): consumed once, so a copied
--   cookie confirms nothing a second time (SR-043).
--
-- Portable PostgreSQL. Idempotent.

alter table config.spent_token drop constraint if exists spent_token_purpose_check;
alter table config.spent_token add constraint spent_token_purpose_check
  check (purpose in ('ADMIN_OIDC_STATE', 'OPS_OIDC_STATE', 'ADMIN_SESSION', 'OPS_SESSION', 'CONSUMER_SESSION',
                     'SME_SESSION', 'SME_PENDING'));
