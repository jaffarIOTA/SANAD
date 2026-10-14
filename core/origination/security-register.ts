/**
 * The security register of a business application: the collateral offered
 * and the guarantees given, each recorded by one person and confirmed by
 * another before it counts (UAE M3).
 *
 * Pure. Product-agnostic and jurisdiction-neutral: which securities a variant
 * requires, the haircut on each kind of collateral and how old a valuation may
 * be are the tenant's configuration (`config/tenants/<t>/credit-policy/
 * security.json`), never code. A charge is recorded as registered, pending or
 * not applicable with the registry's reference; which registry is the
 * jurisdiction's business, not this module's.
 *
 * What counts:
 * - only confirmed, unwithdrawn items, and a collateral item only while its
 *   valuation is within the tenant's maximum age;
 * - lending value = market value less the kind's haircut, rounded down;
 * - cover = total lending value ÷ the amount requested, per ten thousand,
 *   rounded down; loan-to-value is the inverse, rounded up, so neither is
 *   ever flattering. Integer arithmetic only.
 */

import { type CurrencyCode, type Money, money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import { containsIdentityNumber } from './business-application.ts';

export const COLLATERAL_KINDS = [
  'REAL_ESTATE',
  'VEHICLE',
  'EQUIPMENT',
  'INVENTORY',
  'RECEIVABLES',
  'CASH_DEPOSIT',
  'FINANCED_ASSET',
  'PROMISSORY_NOTE',
  'INSURANCE_ASSIGNMENT',
  'OTHER',
] as const;
export type CollateralKind = (typeof COLLATERAL_KINDS)[number];

export const CHARGE_STATUSES = ['REGISTERED', 'PENDING', 'NOT_APPLICABLE'] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

interface Recorded {
  readonly recordedBy: string;
  readonly recordedAtEpochSeconds: bigint;
  readonly confirmedBy?: string;
  readonly confirmedAtEpochSeconds?: bigint;
  /** Withdrawn before submission: kept in the record, counted nowhere. */
  readonly withdrawnBy?: string;
}

export interface CollateralItem extends Recorded {
  readonly itemId: string;
  readonly kind: CollateralKind;
  /** A short description of the asset. No identity number, no personal detail. */
  readonly description: string;
  readonly marketValue: Money;
  readonly valuedAtEpochSeconds: bigint;
  /** The valuer, by reference. */
  readonly valuerRef: string;
  /** The valuation report or the instrument itself, as a document on the application. */
  readonly evidenceRef?: string;
  readonly charge: ChargeStatus;
  /** The registry's reference, required once the charge is REGISTERED. */
  readonly chargeRef?: string;
}

export type GuaranteeLimit = { readonly kind: 'UNLIMITED' } | { readonly kind: 'LIMITED'; readonly amount: Money };

export interface Guarantee extends Recorded {
  readonly guaranteeId: string;
  readonly guarantorKind: 'PERSONAL' | 'CORPORATE';
  /** PERSONAL: one of the applicant's owners, by party reference. CORPORATE: the guarantor company's registration reference. */
  readonly guarantorRef: string;
  /** Display name only. */
  readonly guarantorName: string;
  readonly limit: GuaranteeLimit;
  /** The signed guarantee deed, as a document on the application. */
  readonly deedRef?: string;
}

export interface SecurityRegister {
  readonly collateral: readonly CollateralItem[];
  readonly guarantees: readonly Guarantee[];
}

export const emptyRegister = (): SecurityRegister => ({ collateral: [], guarantees: [] });

// =============================================================================
// Tenant policy
// =============================================================================

export type SecurityRequirement =
  | { readonly kind: 'GUARANTEE_FROM_EACH_OWNER' }
  | { readonly kind: 'COLLATERAL'; readonly collateralKind: CollateralKind };

export interface SecurityPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly policyRef: string;
  /** Per kind, the share of market value not lent against, per ten thousand. */
  readonly haircutsPerTenThousand: Readonly<Record<CollateralKind, number>>;
  /** A valuation older than this at the time of reckoning counts for nothing. */
  readonly maxValuationAgeDays: number;
  /** A variant's collateral code (the product catalogue) → what the register must hold to meet it. */
  readonly requirements: Readonly<Record<string, SecurityRequirement>>;
}

const DAY = 86_400n;

const bad = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

const isKind = (v: unknown): v is CollateralKind => (COLLATERAL_KINDS as readonly unknown[]).includes(v);

const wholeIn = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : typeof v === 'number' ? v : undefined;
  return n !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

export function parseSecurityPolicy(raw: unknown): Result<SecurityPolicy> {
  if (raw === null || typeof raw !== 'object')
    return bad('SECURITY_POLICY_INVALID', 'The security policy is an object');
  const r = raw as Record<string, unknown>;
  const policyId = r['policyId'];
  const version = r['version'];
  const policyRef = r['policyRef'];
  if (typeof policyId !== 'string' || typeof version !== 'string' || typeof policyRef !== 'string' || policyRef === '')
    return bad('SECURITY_POLICY_INVALID', 'The security policy names its id, version and source');
  const haircutsRaw = r['haircutsPerTenThousand'];
  if (haircutsRaw === null || typeof haircutsRaw !== 'object')
    return bad('SECURITY_POLICY_INVALID', 'The security policy gives a haircut per collateral kind');
  const haircuts: Partial<Record<CollateralKind, number>> = {};
  for (const kind of COLLATERAL_KINDS) {
    const h = wholeIn((haircutsRaw as Record<string, unknown>)[kind], 0, 10_000);
    if (h === undefined)
      return bad('SECURITY_POLICY_INVALID', 'Every collateral kind has a haircut between 0 and 10000', { kind });
    haircuts[kind] = h;
  }
  const maxAge = wholeIn(r['maxValuationAgeDays'], 1, 3650);
  if (maxAge === undefined)
    return bad('SECURITY_POLICY_INVALID', 'The maximum valuation age is a whole number of days');
  const reqRaw = r['requirements'];
  if (reqRaw === null || typeof reqRaw !== 'object')
    return bad('SECURITY_POLICY_INVALID', 'The security policy maps each collateral code to a requirement');
  const requirements: Record<string, SecurityRequirement> = {};
  for (const [code, v] of Object.entries(reqRaw as Record<string, unknown>)) {
    const req = v as Record<string, unknown> | null;
    if (req?.['kind'] === 'GUARANTEE_FROM_EACH_OWNER') requirements[code] = { kind: 'GUARANTEE_FROM_EACH_OWNER' };
    else if (req?.['kind'] === 'COLLATERAL' && isKind(req['collateralKind']))
      requirements[code] = { kind: 'COLLATERAL', collateralKind: req['collateralKind'] };
    else
      return bad('SECURITY_POLICY_INVALID', 'A requirement is a guarantee from each owner or a kind of collateral', {
        code,
      });
  }
  return ok({
    policyId,
    version,
    policyRef,
    haircutsPerTenThousand: haircuts as Record<CollateralKind, number>,
    maxValuationAgeDays: maxAge,
    requirements,
  });
}

// =============================================================================
// Entries
// =============================================================================

const REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;

export interface CollateralEntry {
  readonly kind: string;
  readonly description: string;
  readonly marketValueMinorUnits: bigint;
  readonly valuedAtEpochSeconds: bigint;
  readonly valuerRef: string;
  readonly evidenceRef?: string;
  readonly charge: string;
  readonly chargeRef?: string;
}

/** A collateral entry checked against the tenant's currency and the reckoning instant; the recorder supplies who and when. */
export function validateCollateralEntry(
  e: CollateralEntry,
  currency: CurrencyCode,
  nowEpochSeconds: bigint,
): Result<Omit<CollateralItem, 'itemId' | keyof Recorded>> {
  if (!isKind(e.kind)) return bad('COLLATERAL_KIND_INVALID', 'Choose a kind of collateral from the list');
  const description = e.description.trim();
  if (description.length < 3 || description.length > 120)
    return bad('COLLATERAL_DESCRIPTION_INVALID', 'Describe the asset in 3 to 120 characters');
  if (
    containsIdentityNumber(description) ||
    containsIdentityNumber(e.valuerRef) ||
    containsIdentityNumber(e.chargeRef ?? '')
  )
    return bad('IDENTITY_NUMBER_IN_FREE_TEXT', 'No identity number belongs in a collateral record');
  if (e.marketValueMinorUnits <= 0n) return bad('COLLATERAL_VALUE_INVALID', 'The market value is a positive amount');
  if (e.valuedAtEpochSeconds > nowEpochSeconds)
    return bad('VALUATION_IN_FUTURE', 'A valuation is dated on or before today');
  if (!REF.test(e.valuerRef)) return bad('COLLATERAL_REF_INVALID', 'The valuer is recorded by reference');
  if (e.evidenceRef !== undefined && !REF.test(e.evidenceRef))
    return bad('COLLATERAL_REF_INVALID', 'The evidence is a document on the application, by reference');
  if (!(CHARGE_STATUSES as readonly string[]).includes(e.charge))
    return bad('CHARGE_STATUS_INVALID', 'A charge is registered, pending or not applicable');
  const charge = e.charge as ChargeStatus;
  if (charge === 'REGISTERED' && (e.chargeRef === undefined || !REF.test(e.chargeRef)))
    return bad('CHARGE_REF_REQUIRED', 'A registered charge carries the registry’s reference');
  return ok({
    kind: e.kind,
    description,
    marketValue: money(e.marketValueMinorUnits, currency),
    valuedAtEpochSeconds: e.valuedAtEpochSeconds,
    valuerRef: e.valuerRef,
    ...(e.evidenceRef === undefined ? {} : { evidenceRef: e.evidenceRef }),
    charge,
    ...(charge === 'REGISTERED' && e.chargeRef !== undefined ? { chargeRef: e.chargeRef } : {}),
  });
}

export interface GuaranteeEntry {
  readonly guarantorKind: string;
  readonly guarantorRef: string;
  readonly guarantorName: string;
  /** Absent: unlimited. */
  readonly limitMinorUnits?: bigint;
  readonly deedRef?: string;
}

/** A personal guarantor is one of the applicant's owners; a corporate one is named by its registration reference. */
export function validateGuaranteeEntry(
  e: GuaranteeEntry,
  owners: readonly { readonly ref: string; readonly displayName: string }[],
  currency: CurrencyCode,
): Result<Omit<Guarantee, 'guaranteeId' | keyof Recorded>> {
  if (e.guarantorKind !== 'PERSONAL' && e.guarantorKind !== 'CORPORATE')
    return bad('GUARANTOR_KIND_INVALID', 'A guarantor is a person or a company');
  if (!REF.test(e.guarantorRef)) return bad('GUARANTOR_REF_INVALID', 'The guarantor is recorded by reference');
  if (containsIdentityNumber(e.guarantorRef) || containsIdentityNumber(e.guarantorName))
    return bad('IDENTITY_NUMBER_IN_FREE_TEXT', 'No identity number belongs in a guarantee record');
  let name = e.guarantorName.trim();
  if (e.guarantorKind === 'PERSONAL') {
    const owner = owners.find((o) => o.ref === e.guarantorRef);
    if (owner === undefined)
      return bad('GUARANTOR_NOT_AN_OWNER', 'A personal guarantor is one of the applicant’s owners');
    name = owner.displayName;
  } else if (name.length < 2 || name.length > 120)
    return bad('GUARANTOR_NAME_INVALID', 'Name the guarantor company in 2 to 120 characters');
  if (e.limitMinorUnits !== undefined && e.limitMinorUnits <= 0n)
    return bad('GUARANTEE_LIMIT_INVALID', 'A limited guarantee has a positive limit');
  if (e.deedRef !== undefined && !REF.test(e.deedRef))
    return bad('GUARANTOR_REF_INVALID', 'The deed is a document on the application, by reference');
  return ok({
    guarantorKind: e.guarantorKind,
    guarantorRef: e.guarantorRef,
    guarantorName: name,
    limit:
      e.limitMinorUnits === undefined
        ? { kind: 'UNLIMITED' }
        : { kind: 'LIMITED', amount: money(e.limitMinorUnits, currency) },
    ...(e.deedRef === undefined ? {} : { deedRef: e.deedRef }),
  });
}

// =============================================================================
// Position
// =============================================================================

const counts = (i: Recorded): boolean => i.confirmedBy !== undefined && i.withdrawnBy === undefined;

export const valuationCurrent = (item: CollateralItem, policy: SecurityPolicy, nowEpochSeconds: bigint): boolean =>
  nowEpochSeconds - item.valuedAtEpochSeconds <= BigInt(policy.maxValuationAgeDays) * DAY;

/** Market value less the kind's haircut, rounded down. */
export function lendingValue(item: CollateralItem, policy: SecurityPolicy): Money {
  const keep = 10_000n - BigInt(policy.haircutsPerTenThousand[item.kind]);
  return money((item.marketValue.minorUnits * keep) / 10_000n, item.marketValue.currency);
}

export interface RequirementStatus {
  /** The variant's collateral code, as the catalogue labels it. */
  readonly code: string;
  readonly met: boolean;
  /** For GUARANTEE_FROM_EACH_OWNER: the owners' refs still without a confirmed guarantee. */
  readonly missingOwners: readonly string[];
  /** The code has no mapping in the tenant's policy: never met, so it cannot be forgotten. */
  readonly unmapped: boolean;
}

export interface SecurityPosition {
  readonly lendingValue: Money;
  /** Total confirmed, current lending value ÷ requested, per ten thousand, rounded down. */
  readonly coveragePerTenThousand: bigint;
  /** Requested ÷ total lending value, per ten thousand, rounded up; absent when there is no lending value. */
  readonly loanToValuePerTenThousand?: bigint;
  readonly requirements: readonly RequirementStatus[];
  readonly complete: boolean;
  /** Confirmed items whose valuation is too old to count. */
  readonly staleItemIds: readonly string[];
  /** Recorded and not yet confirmed. */
  readonly awaitingConfirmation: number;
}

export function securityPosition(
  register: SecurityRegister,
  requested: Money,
  requiredCodes: readonly string[],
  owners: readonly { readonly ref: string }[],
  policy: SecurityPolicy,
  nowEpochSeconds: bigint,
): SecurityPosition {
  const live = register.collateral.filter(counts);
  const current = live.filter((c) => valuationCurrent(c, policy, nowEpochSeconds));
  const total = current.reduce((sum, c) => sum + lendingValue(c, policy).minorUnits, 0n);
  const guarantees = register.guarantees.filter(counts);
  const requirements = requiredCodes.map((code): RequirementStatus => {
    const req = policy.requirements[code];
    if (req === undefined) return { code, met: false, missingOwners: [], unmapped: true };
    if (req.kind === 'GUARANTEE_FROM_EACH_OWNER') {
      const missingOwners = owners
        .map((o) => o.ref)
        .filter((ref) => !guarantees.some((g) => g.guarantorKind === 'PERSONAL' && g.guarantorRef === ref));
      return { code, met: owners.length > 0 && missingOwners.length === 0, missingOwners, unmapped: false };
    }
    return { code, met: current.some((c) => c.kind === req.collateralKind), missingOwners: [], unmapped: false };
  });
  const requestedMinor = requested.minorUnits;
  return {
    lendingValue: money(total, requested.currency),
    coveragePerTenThousand: requestedMinor > 0n ? (total * 10_000n) / requestedMinor : 0n,
    ...(total > 0n ? { loanToValuePerTenThousand: (requestedMinor * 10_000n + total - 1n) / total } : {}),
    requirements,
    complete: requirements.every((r) => r.met),
    staleItemIds: live.filter((c) => !valuationCurrent(c, policy, nowEpochSeconds)).map((c) => c.itemId),
    awaitingConfirmation: [...register.collateral, ...register.guarantees].filter(
      (i) => i.confirmedBy === undefined && i.withdrawnBy === undefined,
    ).length,
  };
}
