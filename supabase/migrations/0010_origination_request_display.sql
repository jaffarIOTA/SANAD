-- 0010_origination_request_display.sql
-- Sanad — display facts beside a stored origination request.
--
-- The workbench shows a request with things that are not part of the domain
-- object: the invoice's human number, for one. They were held in a second
-- in-memory map. With the request store on PostgreSQL they need a home that is
-- not the `request` column, whose content is the domain object and nothing
-- else (the state-matches constraint depends on that).
--
-- `display` holds labels only. No amount, no identifier that is not already in
-- the request, nothing a decision is taken from.

alter table core.origination_request
  add column if not exists display jsonb not null default '{}'::jsonb;

comment on column core.origination_request.display is
  'Non-domain display labels for the workbench (the invoice number as printed). '
  'Never read by a gate or a decision.';

-- The workbench reads a tenant's whole book newest first; the partner feed
-- index leads with partner_id and does not serve that.
create index if not exists origination_request_tenant_feed
  on core.origination_request (tenant_id, sequence desc);
