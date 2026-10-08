/**
 * Configuration loading.
 *
 * Tenants are addressed by their stable **code** (`bank-a`, `fintech-b`), not by
 * their database identifier. The uuid differs between environments; the code
 * does not, so a configuration file is the same file in dev, UAT and production.
 * The code-to-uuid resolution happens at the persistence boundary, not here.
 *
 * Everything loaded here goes through a validating parser. A malformed tenant
 * file is a refusal to activate, never a silent default — and for structure
 * definitions the parser also enforces the platform floor, so a tenant's file
 * can tighten a gate but never remove one.
 */

import bankAStructure from './tenants/bank-a/structures/murabaha-distributor.json' with { type: 'json' };
import fintechBStructure from './tenants/fintech-b/structures/murabaha-distributor.json' with { type: 'json' };
import bankAPolicyV1 from './tenants/bank-a/credit-policy/wasl-distributor-v1.json' with { type: 'json' };
import fintechBPolicyV1 from './tenants/fintech-b/credit-policy/wasl-distributor-v1.json' with { type: 'json' };
import bankAOrigination from './tenants/bank-a/origination/policy.json' with { type: 'json' };
import fintechBOrigination from './tenants/fintech-b/origination/policy.json' with { type: 'json' };
import bankAChecklist from './tenants/bank-a/documents/wasl-distributor.json' with { type: 'json' };
import bankACatalogue from './tenants/bank-a/products/catalogue.json' with { type: 'json' };
import fintechBCatalogue from './tenants/fintech-b/products/catalogue.json' with { type: 'json' };
import fintechBChecklist from './tenants/fintech-b/documents/wasl-distributor.json' with { type: 'json' };
import bankARails from './tenants/bank-a/rails/rails.json' with { type: 'json' };
import fintechBRails from './tenants/fintech-b/rails/rails.json' with { type: 'json' };
import bankAIdentity from './tenants/bank-a/identity/staff-identity.json' with { type: 'json' };
import fintechBIdentity from './tenants/fintech-b/identity/staff-identity.json' with { type: 'json' };
import saSmeDefinition from './regulatory/sa/sme-definition.json' with { type: 'json' };
import aeSmeDefinition from './regulatory/ae/sme-definition.json' with { type: 'json' };
// Named ksa/uae, not sa/ae: a file called `sa.json` is a cloud service-account key by convention, and the secret scanner rightly refuses one.
import saJurisdiction from './jurisdictions/ksa.json' with { type: 'json' };
import aeJurisdiction from './jurisdictions/uae.json' with { type: 'json' };
import bankATenant from './tenants/bank-a/tenant.json' with { type: 'json' };
import fintechBTenant from './tenants/fintech-b/tenant.json' with { type: 'json' };
import fundAeTenant from './tenants/sme-fund-ae/tenant.json' with { type: 'json' };
import fundAeCatalogue from './tenants/sme-fund-ae/products/catalogue.json' with { type: 'json' };
import fundAeRails from './tenants/sme-fund-ae/rails/rails.json' with { type: 'json' };
import fundAeIdentity from './tenants/sme-fund-ae/identity/staff-identity.json' with { type: 'json' };
import fundAeOrigination from './tenants/sme-fund-ae/origination/policy.json' with { type: 'json' };
import fundAeSmeAssessment from './tenants/sme-fund-ae/credit-policy/sme-assessment.json' with { type: 'json' };
import fundAeChecklistSmallLoan from './tenants/sme-fund-ae/documents/sme-ae-small-loan.json' with { type: 'json' };
import fundAeChecklistWorkingCapital from './tenants/sme-fund-ae/documents/sme-ae-working-capital.json' with { type: 'json' };
import fundAeChecklistFixedAssets from './tenants/sme-fund-ae/documents/sme-ae-fixed-assets.json' with { type: 'json' };
import fundAeChecklistExpansion from './tenants/sme-fund-ae/documents/sme-ae-expansion.json' with { type: 'json' };
import fundAeChecklistFounders from './tenants/sme-fund-ae/documents/sme-ae-first-time-founders.json' with { type: 'json' };
import fundAeChecklistAdvancedTech from './tenants/sme-fund-ae/documents/sme-ae-advanced-tech.json' with { type: 'json' };

import {
  type StructureDefinition,
  parseStructureDefinition,
} from '../products/murabaha-scf/structures/definition.ts';
import { type CreditPolicy, parseCreditPolicy } from '../core/decisioning/policy.ts';
import { type AdapterCatalogue, type RailsConfiguration, parseRailsConfiguration, restrictCatalogue } from '../core/config/rails.ts';
import { type DeploymentProfile, type StaffIdentityConfiguration, parseStaffIdentity } from '../core/config/staff-identity.ts';
import { type OriginationPolicy, parseOriginationPolicy } from '../core/origination/policy.ts';
import { type SmeDefinition, parseSmeDefinition } from '../core/applicant/sme-size.ts';
import { type JurisdictionCode, type JurisdictionProfile, type TenantOnboarding, parseJurisdictionProfile, parseTenantOnboarding } from '../core/jurisdiction/profile.ts';
import { type DocumentChecklist, parseDocumentChecklist } from '../core/documents/checklist.ts';
import { type SmeAssessmentPolicy, parseSmeAssessmentPolicy } from '../core/decisioning/sme-assessment.ts';
import { type Result, ok, reject } from '../core/kernel/result.ts';
import { type ProductCatalogue, parseProductCatalogue } from '../core/products/catalogue.ts';
import { ISLAMIC_PRODUCT_CODES } from '../core/products/registry.ts';

/** The tenant codes this deployment knows about. */
export const TENANT_CODES = ['bank-a', 'fintech-b', 'sme-fund-ae'] as const;
export type TenantCode = (typeof TENANT_CODES)[number];

// -- Jurisdictions (ADR 0005) ------------------------------------------------------

const JURISDICTIONS: Readonly<Record<JurisdictionCode, unknown>> = { SA: saJurisdiction, AE: aeJurisdiction };

export function loadJurisdictionProfile(code: JurisdictionCode): Result<JurisdictionProfile> {
  return parseJurisdictionProfile(JURISDICTIONS[code]);
}

/** Both profiles, parsed; a malformed profile refuses to activate anything. */
export function loadJurisdictionProfiles(): Result<Readonly<Record<JurisdictionCode, JurisdictionProfile>>> {
  const sa = loadJurisdictionProfile('SA'); if (!sa.ok) return sa;
  const ae = loadJurisdictionProfile('AE'); if (!ae.ok) return ae;
  return ok({ SA: sa.value, AE: ae.value });
}

const ONBOARDING: Readonly<Record<TenantCode, unknown>> = { 'bank-a': bankATenant, 'fintech-b': fintechBTenant, 'sme-fund-ae': fundAeTenant };

/**
 * What the institution was onboarded as — its jurisdiction, licence and base
 * currency. The database record (core.tenant, migration 0013) is the same
 * record; this is the checked-in copy for environments without one, and a
 * test asserts the two agree.
 */
export function loadTenantOnboarding(tenant: TenantCode): Result<TenantOnboarding> {
  const profiles = loadJurisdictionProfiles();
  if (!profiles.ok) return profiles;
  const parsed = parseTenantOnboarding(ONBOARDING[tenant], profiles.value);
  if (parsed.ok && parsed.value.tenantCode !== tenant) return reject('OP-DETERMINACY', 'ONBOARDING_TENANT_MISMATCH', 'The onboarding record is for a different tenant', { tenant });
  return parsed;
}

/** The jurisdiction profile that applies to a tenant, from its onboarding. */
export function loadTenantJurisdiction(tenant: TenantCode): Result<JurisdictionProfile> {
  const onboarding = loadTenantOnboarding(tenant);
  if (!onboarding.ok) return onboarding;
  return loadJurisdictionProfile(onboarding.value.jurisdiction);
}

const STRUCTURES: Readonly<Record<TenantCode, readonly unknown[]>> = {
  'bank-a': [bankAStructure],
  'fintech-b': [fintechBStructure],
  // The UAE fund does not offer Murabaha supply-chain finance.
  'sme-fund-ae': [],
};

const CREDIT_POLICIES: Readonly<Record<TenantCode, readonly unknown[]>> = {
  'bank-a': [bankAPolicyV1],
  'fintech-b': [fintechBPolicyV1],
  'sme-fund-ae': [],
};

const ORIGINATION_POLICIES: Readonly<Record<TenantCode, unknown>> = {
  'bank-a': bankAOrigination,
  'fintech-b': fintechBOrigination,
  'sme-fund-ae': fundAeOrigination,
};

/**
 * The tenant's intake parameters: expiry, SLAs, approval tiers, agent and
 * partner entitlements. Parsed strictly; a malformed file refuses to activate.
 */
const PRODUCT_CATALOGUES: Readonly<Record<TenantCode, unknown>> = {
  'bank-a': bankACatalogue,
  'fintech-b': fintechBCatalogue,
  'sme-fund-ae': fundAeCatalogue,
};

export function loadProductCatalogue(tenant: TenantCode): Result<ProductCatalogue> {
  return parseProductCatalogue(PRODUCT_CATALOGUES[tenant], ISLAMIC_PRODUCT_CODES);
}

const RAILS: Readonly<Record<TenantCode, unknown>> = {
  'bank-a': bankARails,
  'fintech-b': fintechBRails,
  'sme-fund-ae': fundAeRails,
};

/**
 * The adapter catalogue the caller supplies, narrowed to what the tenant's
 * onboarded jurisdiction permits. Every parse of a tenant's rails goes through
 * this, so a Saudi tenant cannot be configured onto a UAE bureau or the reverse.
 */
export function catalogueForTenant(tenant: TenantCode, allowed: AdapterCatalogue): Result<AdapterCatalogue> {
  const jurisdiction = loadTenantJurisdiction(tenant);
  if (!jurisdiction.ok) return jurisdiction;
  return ok(restrictCatalogue(allowed, jurisdiction.value.railAdapters));
}

/** The rails the tenant consumes, checked against the adapter catalogue the caller supplies (the engine names no vendor) as its jurisdiction permits. */
export function loadRailsConfiguration(tenant: TenantCode, allowed: AdapterCatalogue): Result<RailsConfiguration> {
  const catalogue = catalogueForTenant(tenant, allowed);
  if (!catalogue.ok) return catalogue;
  return parseRailsConfiguration(RAILS[tenant], catalogue.value);
}

const STAFF_IDENTITY: Readonly<Record<TenantCode, unknown>> = {
  'bank-a': bankAIdentity,
  'fintech-b': fintechBIdentity,
  'sme-fund-ae': fundAeIdentity,
};

export function loadStaffIdentity(tenant: TenantCode, profile: DeploymentProfile): Result<StaffIdentityConfiguration> {
  return parseStaffIdentity(STAFF_IDENTITY[tenant], profile);
}

export function loadOriginationPolicy(tenant: TenantCode): Result<OriginationPolicy> {
  return parseOriginationPolicy(ORIGINATION_POLICIES[tenant]);
}

const CHECKLISTS: Readonly<Record<TenantCode, readonly unknown[]>> = {
  'bank-a': [bankAChecklist],
  'fintech-b': [fintechBChecklist],
  // One checklist per SME product variant, keyed by the variant's documentChecklistRef
  // (config/tenants/sme-fund-ae/products/catalogue.json): sme-ae-small-loan, sme-ae-working-capital,
  // sme-ae-fixed-assets, sme-ae-expansion, sme-ae-first-time-founders, sme-ae-advanced-tech.
  'sme-fund-ae': [fundAeChecklistSmallLoan, fundAeChecklistWorkingCapital, fundAeChecklistFixedAssets, fundAeChecklistExpansion, fundAeChecklistFounders, fundAeChecklistAdvancedTech],
};

/** The documents a programme requires of this tenant's counterparties. */
export function loadDocumentChecklist(tenant: TenantCode, programmeId: string): Result<DocumentChecklist> {
  for (const candidate of CHECKLISTS[tenant]) {
    const parsed = parseDocumentChecklist(candidate);
    if (!parsed.ok) return parsed;
    if (parsed.value.programmeId === programmeId) return parsed;
  }
  return reject('OP-DETERMINACY', 'DOCUMENT_CHECKLIST_NOT_FOUND', 'No document checklist is configured for that programme', { tenant, programmeId });
}

const SME_DEFINITIONS: Readonly<Record<JurisdictionCode, unknown>> = { SA: saSmeDefinition, AE: aeSmeDefinition };

/**
 * The SME size definition of a jurisdiction — the regulator's or the law's,
 * with its instrument. Per jurisdiction, never per tenant. Defaults to the
 * Kingdom for callers written before ADR 0005; new callers pass the tenant's
 * jurisdiction (`loadTenantJurisdiction`).
 */
export function loadSmeDefinition(jurisdiction: JurisdictionCode = 'SA'): Result<SmeDefinition> {
  return parseSmeDefinition(SME_DEFINITIONS[jurisdiction]);
}

/** Tenants that offer the Murabaha supply-chain product (have structure definitions). Not every tenant does. */
export const MURABAHA_TENANT_CODES: readonly TenantCode[] = TENANT_CODES.filter((t) => STRUCTURES[t].length > 0);
/** Tenants with a Wasl-style programme document checklist. */
export const CHECKLIST_TENANT_CODES: readonly TenantCode[] = TENANT_CODES.filter((t) => loadDocumentChecklist(t, 'prg-0001').ok);

/** The SME credit assessment policy (knock-outs, scorecard, risk bands, route) for a tenant that has one. */
const SME_ASSESSMENT_POLICIES: Readonly<Partial<Record<TenantCode, unknown>>> = { 'sme-fund-ae': fundAeSmeAssessment };

export function loadSmeAssessmentPolicy(tenant: TenantCode): Result<SmeAssessmentPolicy> {
  const raw = SME_ASSESSMENT_POLICIES[tenant];
  if (raw === undefined) return reject('OP-DETERMINACY', 'SME_ASSESSMENT_POLICY_NOT_FOUND', 'No SME assessment policy is configured for this tenant', { tenant });
  return parseSmeAssessmentPolicy(raw);
}

export function isTenantCode(value: string): value is TenantCode {
  return (TENANT_CODES as readonly string[]).includes(value);
}

export function loadStructureDefinition(
  tenant: TenantCode,
  definitionId: string,
): Result<StructureDefinition> {
  for (const candidate of STRUCTURES[tenant]) {
    const parsed = parseStructureDefinition(candidate);
    if (!parsed.ok) return parsed;
    if (parsed.value.definitionId === definitionId) return parsed;
  }
  return reject(
    'SH-17',
    'STRUCTURE_DEFINITION_NOT_FOUND',
    'No approved structure definition of that identifier is configured for this tenant',
    { tenant, definitionId },
  );
}

/** All versions of a policy, for effective-date resolution and for replay. */
export function loadCreditPolicyVersions(
  tenant: TenantCode,
  policyId: string,
): Result<readonly CreditPolicy[]> {
  const versions: CreditPolicy[] = [];
  for (const candidate of CREDIT_POLICIES[tenant]) {
    const parsed = parseCreditPolicy(candidate);
    if (!parsed.ok) return parsed;
    if (parsed.value.policyId === policyId) versions.push(parsed.value);
  }
  if (versions.length === 0) {
    return reject(
      'OP-DETERMINACY',
      'CREDIT_POLICY_NOT_FOUND',
      'No credit policy of that identifier is configured for this tenant',
      { tenant, policyId },
    );
  }
  return ok(versions);
}

/** Everything a tenant has configured. Used by the divergence report and by tests. */
export function loadAllForTenant(tenant: TenantCode): Result<{
  readonly structures: readonly StructureDefinition[];
  readonly creditPolicies: readonly CreditPolicy[];
}> {
  const structures: StructureDefinition[] = [];
  for (const candidate of STRUCTURES[tenant]) {
    const parsed = parseStructureDefinition(candidate);
    if (!parsed.ok) return parsed;
    structures.push(parsed.value);
  }

  const creditPolicies: CreditPolicy[] = [];
  for (const candidate of CREDIT_POLICIES[tenant]) {
    const parsed = parseCreditPolicy(candidate);
    if (!parsed.ok) return parsed;
    creditPolicies.push(parsed.value);
  }

  return ok({ structures, creditPolicies });
}
