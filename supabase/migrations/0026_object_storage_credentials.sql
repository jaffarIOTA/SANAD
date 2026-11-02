-- =============================================================================
-- 0026_object_storage_credentials.sql
-- Sanad — a credential provider for the document object store (UAE M2b).
--
-- Widens the provider list on config.integration_credential that migration
-- 0015 set, keeping every code. 'S3_STORAGE' is any S3-compatible object
-- store: Supabase Storage for development and UAT (synthetic data only,
-- ADR 0004), an in-Kingdom or in-country S3-compatible store in production.
-- The application addresses it by capability (OBJECT_STORAGE in
-- core/ports/credentials.ts). Keys stored under it: access_key_id,
-- secret_access_key, endpoint, region, bucket.
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
    -- UAE rails (migration 0015, ADR 0005)
    'AECB',            -- Al Etihad Credit Bureau
    'UAE_PASS',        -- national digital identity (authentication, signing intent)
    'ICP',             -- Emirates ID verification
    'NER',             -- National Economic Register (trade licences)
    'MOHRE',           -- WPS salary report
    'FTA',             -- Federal Tax Authority registration status
    'PARTNER_BANK',    -- the partner bank the institution contracts for money movement
    -- Document object store (this migration)
    'S3_STORAGE'       -- S3-compatible object store for uploaded documents
  ));
