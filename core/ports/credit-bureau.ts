/**
 * Port: the credit bureau.
 *
 * BRD §13. A report is requested only after consent (`core/consent`), the
 * bureau's own reference is retained for reconciliation, and an unavailable
 * bureau is a typed outcome that routes to an exception — never a silent
 * pass and never a silent decline.
 *
 * What comes back is a **summary in amounts**: exposure, delinquency, and a
 * score as the bureau's own opaque figure. Nothing here is, or derives, a
 * rate. The adapter that maps a vendor's response must keep it that way.
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';

export interface BureauRequest {
  readonly tenantId: string;
  readonly counterpartyId: string;
  readonly commercialRegistration: string;
  /** The consent record that authorises this pull. Required, never implied. */
  readonly consentId: string;
  readonly correlationId: string;
}

export interface BureauSummary {
  /** The bureau's reference for this enquiry. Stored for reconciliation. */
  readonly bureauReference: string;
  readonly retrievedAt: TsaInstant;
  readonly totalExposure: Money;
  readonly overdueAmount: Money;
  readonly worstDelinquencyDays: number;
  readonly activeFacilities: number;
  /** The bureau's own figure, opaque to us. Not a rate; not used arithmetically. */
  readonly bureauScore?: number;
  readonly defaults: readonly { readonly amount: Money; readonly settled: boolean }[];
}

export type BureauOutcome =
  | { readonly kind: 'REPORT'; readonly summary: BureauSummary }
  | { readonly kind: 'NO_RECORD'; readonly bureauReference: string }
  /** Routes to an exception of type BUREAU_UNAVAILABLE. Never a decline. */
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string; readonly retryAfterSeconds?: number };

/**
 * The reporting duty: a new facility, and every change to it, is reported
 * back to the bureau. Sent from the outbox, never fire-and-forget; the
 * bureau's acknowledgement reference is stored against the facility.
 */
export interface FacilityReport {
  readonly tenantId: string;
  readonly facilityRef: string;
  readonly counterpartyId: string;
  readonly event: 'OPENED' | 'INSTALMENT_PAID' | 'ARREARS' | 'SETTLED' | 'WRITTEN_OFF';
  readonly amount: Money;
  readonly asOfEpochSeconds: bigint;
  /** The outbox event's key; the bureau call is idempotent on it. */
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface CreditBureauPort {
  request(req: BureauRequest): Promise<Result<BureauOutcome>>;
  report(report: FacilityReport): Promise<Result<{ readonly kind: 'ACKNOWLEDGED'; readonly acknowledgementRef: string } | { readonly kind: 'UNAVAILABLE'; readonly reason: string }>>;
}
