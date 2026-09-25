/**
 * Consent — recorded, versioned, and required before anything is asked of a
 * third party about a counterparty.
 *
 * BRD §22 wants each consent to carry a type, a version, a date/time, a
 * channel and the customer identifier; §13 wants the bureau asked only after
 * consent. PDPL wants purpose. So a consent here is a record with all of that,
 * it is append-only (withdrawal is a new record, not an edit), and the calls
 * that need one go through `requireConsent`, which refuses with a control code
 * rather than proceeding.
 *
 * Instants are attested. Whether a consent is valid *now* is a pure function
 * of the records and an observed instant.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';

export const CONSENT_TYPES = ['CREDIT_BUREAU', 'SCREENING', 'DATA_SHARING_WITH_PARTNER', 'NOTIFICATIONS'] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export type ConsentChannel = 'PORTAL' | 'BRANCH' | 'PARTNER_API' | 'AGENT' | 'SIGNED_DOCUMENT';

export interface ConsentRecord {
  readonly consentId: string;
  readonly tenantId: string;
  readonly counterpartyId: string;
  readonly type: ConsentType;
  /** Which wording the counterparty agreed to. Wording changes need a new version. */
  readonly version: string;
  readonly purpose: string;
  readonly channel: ConsentChannel;
  /** Evidence of the grant — a signed document id, an assertion id, a portal session ref. */
  readonly evidenceRef: string;
  readonly grantedAt: TsaInstant;
  readonly expiresAt?: TsaInstant;
  /** Set on a *withdrawal* record, which supersedes the grant it names. */
  readonly withdraws?: string;
  readonly withdrawnAt?: TsaInstant;
}

export function grant(params: Omit<ConsentRecord, 'withdraws' | 'withdrawnAt'>): Result<ConsentRecord> {
  if (params.evidenceRef.trim().length === 0) {
    return reject('OP-DETERMINACY', 'CONSENT_WITHOUT_EVIDENCE', 'A consent must reference the evidence of its grant', { type: params.type });
  }
  if (params.purpose.trim().length === 0) {
    return reject('OP-DETERMINACY', 'CONSENT_WITHOUT_PURPOSE', 'A consent must state its purpose', { type: params.type });
  }
  if (params.expiresAt !== undefined && params.expiresAt.epochSeconds <= params.grantedAt.epochSeconds) {
    return reject('OP-DETERMINACY', 'CONSENT_EXPIRY_BEFORE_GRANT', 'A consent cannot expire before it is granted', { type: params.type });
  }
  return ok({ ...params });
}

/** A withdrawal is a new record. The grant it withdraws is retained. */
export function withdraw(grantRecord: ConsentRecord, consentId: string, at: TsaInstant, channel: ConsentChannel, evidenceRef: string): Result<ConsentRecord> {
  if (grantRecord.withdraws !== undefined) {
    return reject('OP-DETERMINACY', 'CANNOT_WITHDRAW_A_WITHDRAWAL', 'Only a grant can be withdrawn', { consentId: grantRecord.consentId });
  }
  return ok({ ...grantRecord, consentId, channel, evidenceRef, withdraws: grantRecord.consentId, withdrawnAt: at });
}

/** Is there a live consent of this type for this counterparty at this instant? */
export function validConsent(
  records: readonly ConsentRecord[],
  counterpartyId: string,
  type: ConsentType,
  observedAt: TsaInstant,
): ConsentRecord | undefined {
  const withdrawn = new Set(records.filter((r) => r.withdraws !== undefined && r.withdrawnAt !== undefined && r.withdrawnAt.epochSeconds <= observedAt.epochSeconds).map((r) => r.withdraws));
  return records.find(
    (r) =>
      r.counterpartyId === counterpartyId &&
      r.type === type &&
      r.withdraws === undefined &&
      !withdrawn.has(r.consentId) &&
      r.grantedAt.epochSeconds <= observedAt.epochSeconds &&
      (r.expiresAt === undefined || r.expiresAt.epochSeconds > observedAt.epochSeconds),
  );
}

/**
 * The gate. Called before a bureau pull, a screening call, or a share with a
 * partner. Refuses with a control code the screen renders; never proceeds on
 * an assumption.
 */
export function requireConsent(
  records: readonly ConsentRecord[],
  counterpartyId: string,
  type: ConsentType,
  observedAt: TsaInstant,
): Result<ConsentRecord> {
  const live = validConsent(records, counterpartyId, type, observedAt);
  if (live === undefined) {
    return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'No valid consent of the required type is on record for this counterparty', { type });
  }
  return ok(live);
}
