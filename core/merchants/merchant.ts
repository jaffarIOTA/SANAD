/**
 * Merchant onboarding for buy-now-pay-later and embedded finance.
 *
 * A merchant is a business the platform settles to and, for embedded
 * finance, collects through. Onboarding is a small state machine: begun with
 * a commercial registration, verified against the registry and screened,
 * then active — or suspended by a named principal with a reason. Nothing
 * personal is held: signatories are references into the identity provider,
 * the settlement account is a reference into the payments hub.
 *
 * Verification evidence is *what the rails answered*, by reference, not our
 * reading of it: the registry lookup reference and the screening result
 * reference. A merchant cannot become active on a form alone.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';

export type MerchantStatus = 'PENDING_VERIFICATION' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED';

export interface MerchantCore {
  readonly merchantId: string;
  readonly tenantId: string;
  readonly commercialRegistration: string;
  readonly legalNameAr: string;
  readonly legalNameEn: string;
  /** Merchant category, from the tenant's register; screened against the board's excluded activities. */
  readonly categoryCode: string;
  /** Reference into the payments hub. Never an account number. */
  readonly settlementAccountRef: string;
  /** The partner or aggregator that introduced the merchant, where one did. */
  readonly introducedByPartnerRef?: string;
  /** The member of staff who began the onboarding. They may not be the one who verifies it. */
  readonly onboardedBy: string;
  readonly correlationId: string;
}

export interface Verification {
  /**
   * Reference of the executed store contract. The contract between the
   * institution and a store is a condition of dealing through it (SAMA Rules
   * for Regulating BNPL Companies, Nov 2023, Art. 27; Art. 19(7) obliges the
   * store, through it, not to pass fees to the consumer).
   */
  readonly agreementRef: string;
  readonly registryLookupRef: string;
  readonly registryStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  readonly screeningResultRef: string;
  readonly screeningOutcome: 'CLEAR' | 'REFER' | 'REJECT' | 'PENDING_INVESTIGATION';
  readonly activityPermitted: boolean;
  readonly verifiedBy: string;
  readonly verifiedAt: TsaInstant;
}

interface WithCore {
  readonly core: MerchantCore;
}
export interface PendingVerification extends WithCore {
  readonly status: 'PENDING_VERIFICATION';
  readonly begunAt: TsaInstant;
}
export interface Active extends WithCore {
  readonly status: 'ACTIVE';
  readonly verification: Verification;
  readonly activatedAt: TsaInstant;
}
export interface Suspended extends WithCore {
  readonly status: 'SUSPENDED';
  readonly verification: Verification;
  readonly suspendedBy: string;
  readonly reason: string;
  readonly suspendedAt: TsaInstant;
}
export interface Closed extends WithCore {
  readonly status: 'CLOSED';
  readonly closedBy: string;
  readonly reason: string;
  readonly closedAt: TsaInstant;
}
export type Merchant = PendingVerification | Active | Suspended | Closed;

export function beginOnboarding(core: MerchantCore, at: TsaInstant): Result<PendingVerification> {
  if (!/^\d{10}$/.test(core.commercialRegistration))
    return reject('OP-DETERMINACY', 'CR_MALFORMED', 'A commercial registration number is ten digits');
  if (core.legalNameAr.trim().length === 0 || core.legalNameEn.trim().length === 0)
    return reject('OP-DETERMINACY', 'LEGAL_NAME_REQUIRED', 'Both legal names are required');
  if (core.settlementAccountRef.trim().length === 0)
    return reject('OP-DETERMINACY', 'SETTLEMENT_ACCOUNT_REQUIRED', 'A settlement account reference is required');
  if (/^\d{8,}$/.test(core.settlementAccountRef) || /^SA\d{2}/i.test(core.settlementAccountRef))
    return reject(
      'OP-DETERMINACY',
      'SETTLEMENT_ACCOUNT_BY_VALUE',
      'The settlement account is referenced, never given by number',
    );
  if (core.onboardedBy.trim().length === 0)
    return reject('OP-DETERMINACY', 'ONBOARDED_BY_REQUIRED', 'An onboarding names who began it');
  return ok({ status: 'PENDING_VERIFICATION', core, begunAt: at });
}

/**
 * Active only when a second person verifies it, the store contract is on
 * record, the registry says active, screening is clear and the activity is
 * permitted. Anything else stays pending.
 */
export function verify(m: PendingVerification, v: Verification): Result<Active> {
  if (v.verifiedBy.trim().length === 0)
    return reject('OP-DETERMINACY', 'VERIFIED_BY_REQUIRED', 'A verification names who performed it');
  if (v.verifiedBy === m.core.onboardedBy)
    return reject(
      'OP-DETERMINACY',
      'FOUR_EYES_SELF_VERIFICATION',
      'The person who onboarded a merchant may not verify it',
      { onboardedBy: m.core.onboardedBy },
    );
  if (v.agreementRef.trim().length === 0)
    return reject(
      'OP-DETERMINACY',
      'MERCHANT_AGREEMENT_REQUIRED',
      'A store transacts only under an executed contract with the institution',
      { citation: 'SAMA Rules for Regulating BNPL Companies, Nov 2023 (Jumada I 1445H), Art. 27' },
    );
  if (v.registryLookupRef.length === 0 || v.screeningResultRef.length === 0)
    return reject(
      'OP-DETERMINACY',
      'VERIFICATION_EVIDENCE_REQUIRED',
      'Verification cites the registry lookup and the screening result',
    );
  if (v.registryStatus !== 'ACTIVE')
    return reject('OP-DETERMINACY', 'REGISTRATION_NOT_ACTIVE', 'The commercial registration is not active', {
      status: v.registryStatus,
    });
  if (v.screeningOutcome !== 'CLEAR')
    return reject('SH-12', 'SCREENING_NOT_CLEAR', 'Screening did not clear the merchant', {
      outcome: v.screeningOutcome,
    });
  if (!v.activityPermitted)
    return reject(
      'SH-12',
      'ACTIVITY_NOT_PERMITTED',
      'The merchant’s activity is not permitted under the tenant’s register',
    );
  return ok({ status: 'ACTIVE', core: m.core, verification: v, activatedAt: v.verifiedAt });
}

export function suspend(m: Active, by: string, reason: string, at: TsaInstant): Result<Suspended> {
  if (reason.trim().length === 0) return reject('OP-DETERMINACY', 'REASON_REQUIRED', 'Suspension carries a reason');
  return ok({
    status: 'SUSPENDED',
    core: m.core,
    verification: m.verification,
    suspendedBy: by,
    reason,
    suspendedAt: at,
  });
}

export function reinstate(m: Suspended, at: TsaInstant): Active {
  return { status: 'ACTIVE', core: m.core, verification: m.verification, activatedAt: at };
}

export function close(m: Active | Suspended, by: string, reason: string, at: TsaInstant): Result<Closed> {
  if (reason.trim().length === 0) return reject('OP-DETERMINACY', 'REASON_REQUIRED', 'Closure carries a reason');
  return ok({ status: 'CLOSED', core: m.core, closedBy: by, reason, closedAt: at });
}

/** The one question checkout asks. */
export const canTransact = (m: Merchant): boolean => m.status === 'ACTIVE';
