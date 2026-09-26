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

import {
  type StructureDefinition,
  parseStructureDefinition,
} from '../products/murabaha-scf/structures/definition.ts';
import { type CreditPolicy, parseCreditPolicy } from '../core/decisioning/policy.ts';
import { type OriginationPolicy, parseOriginationPolicy } from '../core/origination/policy.ts';
import { type DocumentChecklist, parseDocumentChecklist } from '../core/documents/checklist.ts';
import { type Result, ok, reject } from '../core/kernel/result.ts';
import { type ProductCatalogue, parseProductCatalogue } from '../core/products/catalogue.ts';
import { ISLAMIC_PRODUCT_CODES } from '../core/products/registry.ts';

/** The tenant codes this deployment knows about. */
export const TENANT_CODES = ['bank-a', 'fintech-b'] as const;
export type TenantCode = (typeof TENANT_CODES)[number];

const STRUCTURES: Readonly<Record<TenantCode, readonly unknown[]>> = {
  'bank-a': [bankAStructure],
  'fintech-b': [fintechBStructure],
};

const CREDIT_POLICIES: Readonly<Record<TenantCode, readonly unknown[]>> = {
  'bank-a': [bankAPolicyV1],
  'fintech-b': [fintechBPolicyV1],
};

const ORIGINATION_POLICIES: Readonly<Record<TenantCode, unknown>> = {
  'bank-a': bankAOrigination,
  'fintech-b': fintechBOrigination,
};

/**
 * The tenant's intake parameters: expiry, SLAs, approval tiers, agent and
 * partner entitlements. Parsed strictly; a malformed file refuses to activate.
 */
const PRODUCT_CATALOGUES: Readonly<Record<TenantCode, unknown>> = {
  'bank-a': bankACatalogue,
  'fintech-b': fintechBCatalogue,
};

export function loadProductCatalogue(tenant: TenantCode): Result<ProductCatalogue> {
  return parseProductCatalogue(PRODUCT_CATALOGUES[tenant], ISLAMIC_PRODUCT_CODES);
}

export function loadOriginationPolicy(tenant: TenantCode): Result<OriginationPolicy> {
  return parseOriginationPolicy(ORIGINATION_POLICIES[tenant]);
}

const CHECKLISTS: Readonly<Record<TenantCode, readonly unknown[]>> = {
  'bank-a': [bankAChecklist],
  'fintech-b': [fintechBChecklist],
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
