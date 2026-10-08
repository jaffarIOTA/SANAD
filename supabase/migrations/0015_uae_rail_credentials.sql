-- =============================================================================
-- 0015_uae_rail_credentials.sql
-- Sanad — credential providers for the UAE integration rails (ADR 0005).
--
-- Widens the provider list on config.integration_credential that migration
-- 0007 set, keeping every Saudi code. As in 0007, provider names here are the
-- institution's vendors and rails — the one place they belong, beside the
-- vault reference for their credentials. The application addresses them by
-- capability (core/ports/credentials.ts) and resolves the code from the
-- tenant's rail configuration (the vault credential provider in
-- adapters/kernel/).
-- =============================================================================

alter table config.integration_credential
  drop constraint if exists integration_credential_provider_check;

alter table config.integration_credential
  add constraint integration_credential_provider_check check (provider in (
    -- Platform and Saudi rails (migration 0007)
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
    'TSA',             -- timestamping authority
    -- UAE rails (ADR 0005)
    'AECB',            -- Al Etihad Credit Bureau
    'UAE_PASS',        -- national digital identity (authentication, signing intent)
    'ICP',             -- Emirates ID verification (Federal Authority for Identity, Citizenship, Customs & Port Security)
    'NER',             -- National Economic Register (trade licences)
    'MOHRE',           -- WPS salary report (Ministry of Human Resources and Emiratisation)
    'FTA',             -- Federal Tax Authority registration status
    'PARTNER_BANK'     -- the partner bank the institution contracts for money movement
  ));
