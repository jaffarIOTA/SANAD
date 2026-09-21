/**
 * The applicant snapshot.
 *
 * Everything the credit policy is allowed to see, gathered before evaluation
 * begins and frozen. The engine makes no calls of its own: if a value is not in
 * the snapshot, the policy cannot consider it. That is what makes a decision
 * reproducible — the same snapshot and the same policy version return the same
 * outcome, today and in three years when the Board or the regulator asks why
 * this counterparty was declined (BR-C02, SDD §6.6).
 *
 * The primary underwriting input is the counterparty's own cleared invoice
 * history: a tax-authority-verified record of who it sells to, how much, how
 * often and on what terms. Bureau and bank data are confirmatory rather than
 * primary, which is the inversion that makes thin-file SME lending work here
 * (SDD §3.8).
 *
 * What is deliberately not in here: national identifiers, names, addresses,
 * dates of birth. The policy evaluates the business, not the person. The
 * signatory appears only as a verification outcome and an assertion reference,
 * so a decision record can be retained and replayed without retaining personal
 * data (CLAUDE.md §10, RC-05).
 */

import type { CurrencyCode } from '../kernel/money.ts';

export type Availability = 'AVAILABLE' | 'UNAVAILABLE' | 'NOT_CONSENTED';

export type ScreeningOutcome = 'CLEAR' | 'HIT' | 'POTENTIAL_MATCH' | 'UNAVAILABLE';

export type RegistrationStatus = 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'CANCELLED' | 'UNKNOWN';

export type PermissibilityOutcome = 'PERMITTED' | 'EXCLUDED' | 'REVIEW';

export type RecourseTerms = 'NONE' | 'PARTIAL' | 'FULL';

export interface RegistrationFacts {
  /** Verified commercial registration number. A business identifier, not personal. */
  readonly crNumber: string;
  readonly status: RegistrationStatus;
  /** Trading history length, from the registration date. */
  readonly ageMonths: number;
  readonly legalForm: string;
  /** Classification codes, used for activity permissibility and sector limits. */
  readonly activityCodes: readonly string[];
  readonly paidCapitalMinorUnits: bigint;
  /** Seconds since this was retrieved. Freshness is a policy input (BR-B10). */
  readonly retrievedSecondsAgo: number;
}

export interface SignatoryFacts {
  /** Authority to bind the entity, confirmed against the registration record. */
  readonly authorityVerified: boolean;
  readonly method: 'NATIONAL_IDENTITY_PROVIDER' | 'MANUAL_REVIEW';
  /** Reference to the retained assertion. Not the assertion itself. */
  readonly assertionId: string;
  readonly retrievedSecondsAgo: number;
}

export interface ScreeningFacts {
  readonly sanctions: ScreeningOutcome;
  readonly politicallyExposed: ScreeningOutcome;
  readonly adverseMedia: ScreeningOutcome;
  /** Business activity against the Board's excluded-activity register (SH-12). */
  readonly activityPermissibility: PermissibilityOutcome;
  readonly retrievedSecondsAgo: number;
}

/** Trade with the programme's anchor specifically. The strongest signal we have. */
export interface AnchorTradeFacts {
  readonly monthsTrading: number;
  readonly clearedInvoiceCount: number;
  readonly totalValueMinorUnits: bigint;
  readonly medianMonthlyValueMinorUnits: bigint;
  readonly largestSingleInvoiceMinorUnits: bigint;
  readonly medianDaysToPayment: number;
  /** Invoices settled beyond terms, per ten thousand. Integer, no floating point. */
  readonly latePaymentPerTenThousand: number;
  readonly disputeCount: number;
  readonly creditNotePerTenThousand: number;
}

export interface TradeHistoryFacts {
  readonly availability: Availability;
  readonly monthsObserved: number;
  readonly clearedInvoiceCount: number;
  readonly totalClearedValueMinorUnits: bigint;
  readonly distinctBuyerCount: number;
  /** Share of value taken by the largest buyer, per ten thousand. */
  readonly largestBuyerSharePerTenThousand: number;
  readonly withAnchor: AnchorTradeFacts;
  readonly retrievedSecondsAgo: number;
}

export interface BureauFacts {
  readonly availability: Availability;
  readonly obligationsTotalMinorUnits: bigint;
  readonly activeFacilityCount: number;
  readonly defaultsLast24Months: number;
  readonly worstArrearsDaysLast12Months: number;
  readonly enquiriesLast6Months: number;
  readonly judgmentCount: number;
  readonly retrievedSecondsAgo: number;
}

export interface OpenBankingFacts {
  readonly availability: Availability;
  readonly averageMonthlyInflowMinorUnits: bigint;
  readonly lowestMonthEndBalanceMinorUnits: bigint;
  readonly returnedPaymentsLast6Months: number;
  readonly retrievedSecondsAgo: number;
}

export interface WorkforceFacts {
  readonly availability: Availability;
  readonly employeeCount: number;
  readonly socialInsuranceRegistered: boolean;
  readonly retrievedSecondsAgo: number;
}

export interface ProgrammeFacts {
  readonly anchorRecourse: RecourseTerms;
  readonly programmeLimitMinorUnits: bigint;
  readonly programmeUtilisedMinorUnits: bigint;
  readonly sectorCode: string;
  readonly goodsCategoryCode: string;
}

export interface ExposureFacts {
  /** Exposure this platform already holds to the counterparty, all programmes. */
  readonly platformExposureMinorUnits: bigint;
  /** Other exposure the institution holds, read through the core banking adapter. */
  readonly coreBankingExposureMinorUnits: bigint;
  readonly groupExposureMinorUnits: bigint;
}

export interface ConsentFacts {
  readonly eInvoicing: boolean;
  readonly creditBureau: boolean;
  readonly openBanking: boolean;
  readonly workforce: boolean;
}

export interface ApplicantSnapshot {
  readonly snapshotId: string;
  readonly tenantId: string;
  readonly counterpartyId: string;
  readonly programmeId: string;
  readonly currency: CurrencyCode;

  /**
   * When the snapshot was assembled. Recorded for the audit trail; the engine
   * never reads it as "now", because the engine has no concept of now.
   */
  readonly capturedAtEpochSeconds: bigint;

  readonly registration: RegistrationFacts;
  readonly signatory: SignatoryFacts;
  readonly screening: ScreeningFacts;
  readonly tradeHistory: TradeHistoryFacts;
  readonly bureau: BureauFacts;
  readonly openBanking: OpenBankingFacts;
  readonly workforce: WorkforceFacts;
  readonly programme: ProgrammeFacts;
  readonly exposure: ExposureFacts;
  readonly consent: ConsentFacts;
}

/** Programme capacity left, floored at zero. */
export function programmeHeadroomMinorUnits(s: ApplicantSnapshot): bigint {
  const headroom = s.programme.programmeLimitMinorUnits - s.programme.programmeUtilisedMinorUnits;
  return headroom > 0n ? headroom : 0n;
}

/** Everything the institution is already on the hook for, across sources. */
export function aggregateExposureMinorUnits(s: ApplicantSnapshot): bigint {
  return (
    s.exposure.platformExposureMinorUnits +
    s.exposure.coreBankingExposureMinorUnits +
    s.exposure.groupExposureMinorUnits
  );
}
