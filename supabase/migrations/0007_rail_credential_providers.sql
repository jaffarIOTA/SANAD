-- =============================================================================
-- 0007_rail_credential_providers.sql
-- Sanad — credential providers for the KSA integration rails (CLAUDE.md §5).
--
-- Widens the provider list on config.integration_credential. Provider names
-- here are the institution's *vendors* — this is the one place vendor names
-- belong, beside the vault reference for their credentials. The application
-- addresses them by capability (core/ports/credentials.ts).
-- =============================================================================

alter table config.integration_credential
  drop constraint if exists integration_credential_provider_check;

alter table config.integration_credential
  add constraint integration_credential_provider_check check (provider in (
    'TUUM',            -- core banking
    'NUTRIENT',        -- document engine & signature
    'ZATCA',           -- e-invoicing authority; tax certificate status
    'NAFATH',          -- national digital identity (authentication)
    'YAKEEN',          -- identity attribute verification
    'TAHAQOQ',         -- national document verification
    'WATHQ',           -- business registry
    'SIMAH',           -- credit bureau (primary)
    'BAYAN',           -- credit bureau (secondary)
    'GOSI',            -- employment and registered salary
    'OPEN_BANKING',    -- the licensed TPP or the institution's own connection
    'SADAD',           -- bill presentment and collection
    'PAYMENTS_HUB',    -- the institution's payments hub
    'RATE_PUBLISHER',  -- benchmark and market rate publisher
    'COMMODITY_BROKER',-- organised tawarruq broker
    'WORKFLOW_ENGINE', -- durable workflow persistence (ADR 0003)
    'SCREENING',       -- sanctions / PEP
    'CSP',             -- certification service provider (signing)
    'TSA'              -- timestamping authority
  ));
