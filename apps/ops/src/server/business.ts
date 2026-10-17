/**
 * SME business applications in the workbench — stages 5 to 9 of the direct
 * lending journey (ADR 0005; core/origination/business-application.ts).
 *
 *   5  Credit assessment     figures read from the statements, verified one by one
 *                            (four eyes on keyed figures); the variant's document
 *                            checklist complete; then submitted for scoring
 *   6  Decisioning           knock-outs, scorecard, risk level, route: straight
 *                            through (a checker approves) or the credit committee
 *   7  Contract & disburse   offer letter quoted through the product module on the
 *                            dated schedule, sent, signed (UAE Pass), disbursed
 *                            (partner bank)
 *   8–9 Portfolio, collections  recorded hand-off to the loan system
 *
 * Every transition goes through the core state machine; nothing here decides.
 * The service holds a tenant's book in memory and writes every change through
 * to migration 0016's tables when a database is configured: the book is loaded
 * once per process, changes are marked, and each request's change is made and
 * written in one transaction under the tenant's lock (`mutateBusiness`)
 * before the response that reports it. A save that fails, or finds the
 * application changed elsewhere, drops the working set and answers a typed
 * refusal (PERSISTENCE_FAILED, STALE_APPLICATION); nothing is retried blind.
 *
 * Currency is the tenant's, from its onboarding record — never from input.
 * A hand-over may assert a currency; one that is not the tenant's is refused.
 *
 * Instants come from `developmentAttestation()` (the development stand-in for
 * the timestamping authority). The illustrative seed back-dates its own.
 *
 * Rails: the bureau result, the UAE Pass signature and the partner-bank payment
 * are fixture references until those adapters (adapters/uae/*) have made a
 * verified sandbox call; each is labelled as such where it is recorded.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import {
  type TenantCode,
  loadDocumentChecklist,
  loadJurisdictionProfile,
  loadOfferDatePolicy,
  loadProductCatalogue,
  loadSmeAssessmentPolicy,
  loadSmeDefinition,
  loadTenantOnboarding, loadSecurityPolicy, loadDecisionPackPolicy, loadServicingPolicy } from '@sanad/config/loader.ts';
import {
  type FigureSourceKind,
  type FinancialFigure,
  type FinancialMetric,
  type FinancialRatio,
  type FinancialRatioCode,
  FULL_SPREAD_METRICS,
  OPERATING_CASH_FLOW_PROXY,
  ceilDiv,
  completeSpread,
  computeRatios,
  floorDiv,
  isVerified,
  proposeFigure,
  toBusinessFacts,
  verifyFigure as verifyFigureCore,
} from '@sanad/core/applicant/financials.ts';
import {
  type SmeAssessment,
  type SmeAssessmentFacts,
  assessSme,
  committeeApprovalsRequired,
} from '@sanad/core/decisioning/sme-assessment.ts';
import {
  type DocumentChecklist,
  type ItemReport,
  type PresentedDocument,
  blockingItems,
  checklistReport,
  isChecklistComplete,
} from '@sanad/core/documents/checklist.ts';
import { type OfferLetter, buildOfferLetter } from '@sanad/core/documents/offer-letter.ts';
import { ummAlQura } from './hijri.ts';
import type { JurisdictionProfile } from '@sanad/core/jurisdiction/profile.ts';
import type { StorableMediaType } from '@sanad/core/ports/object-storage.ts';
import {
  type CollateralEntry,
  type CollateralItem,
  type Guarantee,
  type GuaranteeEntry,
  type SecurityPosition,
  type SecurityRegister,
  lendingValue,
  securityPosition,
  validateCollateralEntry,
  validateGuaranteeEntry,
  valuationCurrent,
} from '@sanad/core/origination/security-register.ts';
import {
  type Condition,
  type ConditionEntry,
  type Covenant,
  type Deviation,
  type Justification,
  attachedCount,
  covenantTemplate,
  deviationsOf,
  packDigest,
  validateCondition,
  validateJustification,
} from '@sanad/core/origination/decision-pack.ts';
import { type CurrencyCode, type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { maskIban, validateIban } from '@sanad/core/kernel/iban.ts';
import {
  type OfferNotificationRecipient,
  type OfferNotifications,
  buildOfferNotifications,
  isMaskedEmail,
  isMaskedMobile,
  previewOfferNotifications,
} from '@sanad/core/notifications/offer-notification.ts';
import {
  type ApprovalLimits,
  type ApprovedTerms,
  type BusinessApplicant,
  type BusinessApplication,
  type BusinessStage,
  type CommitteeApproval,
  type OfferDatePolicy,
  type StageEvent,
  type Transition,
  approveStraightThrough as approveStraightThroughCore,
  approvedTermsOf,
  REGISTRATION_FIELDS,
  containsIdentityNumber,
  decideInCommittee as decideInCommitteeCore,
  defaultApprovedTerms,
  receiveHandover,
  recordAssessment,
  recordCreditNotes as recordCreditNotesCore,
  recordDisbursed as recordDisbursedCore,
  recordOfferSent,
  recordSigned as recordSignedCore,
  startSpreading,
  submitForAssessment as submitForAssessmentCore,
  withdraw,
} from '@sanad/core/origination/business-application.ts';
import { type Outbox, type OutboxEvent, emptyOutbox, enqueue } from '@sanad/core/outbox/outbox.ts';
import { type OutboxStore, inMemoryOutboxStore } from '@sanad/core/outbox/store.ts';
import type { DatedSchedule } from '@sanad/core/pricing/dated-schedule.ts';
import { resolvePricingInputs } from '@sanad/core/pricing/quotation.ts';
import type { RateBasis, RatePeriod } from '@sanad/core/pricing/rate.ts';
import type { ProductCatalogue } from '@sanad/core/products/catalogue.ts';
import { buildOffer } from '@sanad/core/products/offer.ts';
import { type TsaInstant, restoreAttestedInstant } from '@sanad/core/time/tsa.ts';
import { hostClockInstant } from '@sanad/origination/host-clock.ts';
import { resolveProductCatalogue } from '@sanad/origination/catalogue.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { type NewBusinessAct, newBusinessRefusal } from '@sanad/origination/licensing.ts';
import { smeTermConventional } from '@sanad/products/sme-term-conventional/index.ts';
import { smeTermIslamic } from '@sanad/products/sme-term-islamic/index.ts';
import {
  type SmeIslamicCore,
  purchaseCommodity,
  realiseProceeds,
  sellToCustomer,
  transferTitle,
  open as openTawarruq,
} from '@sanad/products/sme-term-islamic/execution.ts';
import type { SmeIslamicQuote } from '@sanad/products/sme-term-islamic/pricing.ts';
import type { CommodityLot } from '@sanad/core/ports/commodity-broker.ts';
import { type FacilityPosition, type ScheduledInstalment, civilDay, facilityPosition } from '@sanad/core/servicing/instalment-position.ts';
import { lateChargesDue } from '@sanad/core/servicing/late-charges.ts';
import { reamortise, respreadPrice } from '@sanad/core/servicing/restructure.ts';
import type { SmeVariant } from '@sanad/products/sme-term-conventional/variants.ts';

import { postgresOutboxStore } from '../../../../services/outbox/src/postgres-store.ts';
import {
  type ApplicationEvent,
  type ApplicationVersion,
  type FigureRow,
  type PersistedAssessment,
  type PersistedOffer,
  illustrativeSeedPermitted,
  loadBusinessBook,
  saveBusinessChanges,
} from './business-persistence.ts';
import { persistencePool, persistenceUrl } from './persistence.ts';
import { publishedBenchmark } from './rate-rails.ts';
import { developmentAttestation } from './store.ts';

export type { ApplicationEvent, FigureRow } from './business-persistence.ts';
export type { SmeVariant } from '@sanad/products/sme-term-conventional/variants.ts';

// =============================================================================
// Roles and the pipeline
// =============================================================================

/**
 * The fictional people the **illustrative seed** walks its applications
 * through, and nothing else: the screens and their actions act as the
 * signed-in principal (session.ts), whose authorities decide what they may do.
 * Distinct people, so the seeded history shows four eyes: the officer keys
 * figures, presents documents, records the assessment inputs and submits; the
 * checker verifies, validates, runs the assessment and approves
 * straight-through cases; the committee member decides referred cases; the
 * finance user releases disbursement — never the approver. They are the UAE
 * fund's development staff identities (staff.ts), so the seeded history reads
 * as the same people who sign in.
 */
export const SEED_PRINCIPALS = {
  officer: 'stf-ae-officer-01',
  checker: 'stf-ae-checker-01',
  committee: 'stf-ae-committee-01',
  finance: 'stf-ae-finance-01',
} as const;

/**
 * The system path for figures read from a statement (OCR) or a rail: the
 * ingestion functions record under these principals. No workbench form can
 * reach them; a figure keyed through the workbench is always OFFICER_ENTRY.
 */
export const READ_FIGURE_SOURCES = { ocr: 'system:statement-ocr', rail: 'system:rail-ingest' } as const;

export interface PipelineStage {
  readonly stage: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  readonly titleEn: string;
  readonly titleAr: string;
  /** Upstream: the government portal and the core banking customer record. Sanad: this workbench and the loan system. */
  readonly owner: 'UPSTREAM' | 'SANAD';
  /** Target duration in seconds; absent where the stage is ongoing. */
  readonly targetSeconds?: bigint;
  readonly targetEn: string;
  readonly targetAr: string;
}

const MINUTE = 60n;
const HOUR = 3_600n;
const DAY = 86_400n;

/**
 * The nine-stage pipeline and its turnaround targets as the core banking
 * partner's prototype screens show them (2026-10). ILLUSTRATIVE: the fund's
 * service standards replace these before any real use.
 */
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  {
    stage: 1,
    titleEn: 'Application',
    titleAr: 'الطلب',
    owner: 'UPSTREAM',
    targetSeconds: 10n * MINUTE,
    targetEn: '~10 minutes',
    targetAr: 'نحو 10 دقائق',
  },
  {
    stage: 2,
    titleEn: 'Needs assessment',
    titleAr: 'تقييم الاحتياجات',
    owner: 'UPSTREAM',
    targetSeconds: 10n * MINUTE,
    targetEn: '~10 minutes',
    targetAr: 'نحو 10 دقائق',
  },
  {
    stage: 3,
    titleEn: 'Product application',
    titleAr: 'طلب المنتج',
    owner: 'UPSTREAM',
    targetSeconds: 20n * MINUTE,
    targetEn: '~20 minutes',
    targetAr: 'نحو 20 دقيقة',
  },
  {
    stage: 4,
    titleEn: 'Verification',
    titleAr: 'التحقق',
    owner: 'UPSTREAM',
    targetSeconds: 48n * HOUR,
    targetEn: 'up to 48 hours',
    targetAr: 'حتى 48 ساعة',
  },
  {
    stage: 5,
    titleEn: 'Credit assessment',
    titleAr: 'التقييم الائتماني',
    owner: 'SANAD',
    targetSeconds: 5n * DAY,
    targetEn: 'up to 5 days',
    targetAr: 'حتى 5 أيام',
  },
  {
    stage: 6,
    titleEn: 'Decisioning (credit committee)',
    titleAr: 'القرار (لجنة الائتمان)',
    owner: 'SANAD',
    targetSeconds: 10n * DAY,
    targetEn: 'up to 10 days',
    targetAr: 'حتى 10 أيام',
  },
  {
    stage: 7,
    titleEn: 'Contract & disbursement',
    titleAr: 'العقد والصرف',
    owner: 'SANAD',
    targetSeconds: 5n * DAY,
    targetEn: 'up to 5 days',
    targetAr: 'حتى 5 أيام',
  },
  {
    stage: 8,
    titleEn: 'Portfolio management',
    titleAr: 'إدارة المحفظة',
    owner: 'SANAD',
    targetEn: 'ongoing',
    targetAr: 'مستمر',
  },
  { stage: 9, titleEn: 'Collections', titleAr: 'التحصيل', owner: 'SANAD', targetEn: 'ongoing', targetAr: 'مستمر' },
];

/** End-to-end turnaround target from the partner's prototype: 23 days. ILLUSTRATIVE. */
export const TARGET_TURNAROUND_SECONDS = 23n * DAY;

// =============================================================================
// Types
// =============================================================================

export interface BusinessDocument {
  readonly documentType: string;
  /** The document platform's reference. Never the content. */
  readonly documentRef: string;
  readonly capturedAt: TsaInstant;
  /** PENDING when presented; VALID or INVALID only once a principal other than the presenter has checked it. */
  readonly validationStatus: PresentedDocument['validationStatus'];
  readonly presentedBy: string;
  readonly validatedBy?: string;
  /** Present when the document was uploaded rather than referenced: the stored bytes' hash, size, type and store. */
  readonly content?: DocumentContent;
}

/** An uploaded document's stored bytes, by hash. The bytes themselves live in the object store, never here. */
export interface DocumentContent {
  readonly sha256Hex: string;
  readonly byteLength: number;
  readonly mediaType: StorableMediaType;
  /** FIXTURE: the in-memory demonstration store, labelled on screen. LIVE: the tenant's configured store. */
  readonly storage: 'FIXTURE' | 'LIVE';
}

/**
 * What the scorecard reads that the statements do not carry: the bureau
 * snapshot, the officer's assessments and the collateral. Recorded by an
 * officer while the application is in credit assessment, and locked once it
 * is submitted; every value is an integer.
 *
 * MANUAL, deliberately and visibly: there is no live AECB call. The officer
 * keys the score from the commercial report upstream obtained at stage 4,
 * with that report's reference and the consent id it was obtained under
 * (which must be one of the application's stage-4 verification references).
 * The AECB adapter replaces this once it has made a verified sandbox call
 * (adapters/uae/aecb/README.md); until then `source` says AECB_FIXTURE.
 */
export interface AssessmentInputs {
  readonly bureau: {
    readonly reportRef: string;
    readonly consentId: string;
    readonly score: bigint;
    readonly source: BureauSource;
  };
  /** A count of people, for the SME size classification. */
  readonly fullTimeEmployees: number;
  readonly relevantExperienceYears: bigint;
  /** A code from the fund's sector priority list, e.g. PRIORITY or NON_PRIORITY. */
  readonly sectorPriority: string;
  readonly auditedFinancialsAvailable: boolean;
  readonly commitmentRatioPerTenThousand: bigint;
  readonly riskAnalysisScorePerTenThousand: bigint;
  readonly portfolioRepaymentPerTenThousand: bigint;
  readonly failedFilesRatePerTenThousand: bigint;
  /** The value of the collateral offered, in the tenant's currency. */
  readonly collateralValue: Money;
  readonly recordedBy: string;
  readonly recordedAtEpochSeconds: bigint;
}

/**
 * Where the bureau result in the assessment inputs came from:
 *   KEYED_FROM_UPSTREAM_REPORT  typed by the officer from the report the upstream customer record
 *                               obtained at stage 4 (applications handed over by a partner), or
 *                               from an owner's individual report where the business has no file
 *   AECB_RAIL_FIXTURE           fetched through the bureau rail, answered by the demonstration transport
 *   AECB_RAIL_LIVE              fetched through the bureau rail from the live bureau
 * Records written before the rail existed said AECB_FIXTURE and meant keyed; they read as KEYED.
 */
export type BureauSource =
  | 'KEYED_FROM_UPSTREAM_REPORT'
  | 'AECB_RAIL_FIXTURE'
  | 'AECB_RAIL_LIVE'
  | 'SIMAH_RAIL_FIXTURE'
  | 'SIMAH_RAIL_LIVE';

export type AssessmentInputsEntry = Omit<
  AssessmentInputs,
  'recordedBy' | 'recordedAtEpochSeconds' | 'collateralValue' | 'bureau'
> & {
  /** Absent when the bureau report was fetched through the rail: the fetched result is used, and nothing typed overrides it. */
  readonly bureau?: { readonly reportRef: string; readonly consentId: string; readonly score: bigint };
  readonly collateralValueMinorUnits: bigint;
};

/**
 * The commercial bureau report as fetched through the rail: the summary the
 * bureau port carries (never the report itself — CLAUDE.md §5, snapshots not
 * copies), its reference, and the consent it was obtained under.
 */
export interface BureauFetch {
  readonly reportRef: string;
  readonly consentId: string;
  readonly score: bigint;
  readonly source: 'FIXTURE' | 'LIVE';
  readonly totalExposure: Money;
  readonly overdueAmount: Money;
  readonly worstDelinquencyDays: number;
  readonly activeFacilities: number;
  readonly defaults: number;
  readonly fetchedBy: string;
  readonly atEpochSeconds: bigint;
}

/**
 * The business's bank-statement facts from Open Finance: cash-flow and
 * conduct evidence beside the financial spread, never a spread figure
 * (average inflow is not revenue; a count of salary credits is not a salary).
 * Fetched by the officer under the business's account-information consent and
 * confirmed by a second person before the assessment relies on it.
 */
export interface BankStatementFacts {
  readonly referenceId: string;
  readonly consentId: string;
  readonly months: number;
  readonly averageMonthlyInflow: Money;
  readonly lowestMonthEndBalance: Money;
  readonly returnedPaymentsLast6Months: number;
  readonly salaryCreditsObserved: number;
  readonly source: 'FIXTURE' | 'LIVE';
  readonly fetchedBy: string;
  readonly atEpochSeconds: bigint;
  readonly confirmedBy?: string;
  readonly confirmedAtEpochSeconds?: bigint;
}

export interface AssessmentRun {
  /** Also the assessment reference recorded on the application. */
  readonly assessmentId: string;
  readonly assessment: SmeAssessment;
  /** Exactly the facts the policy read. */
  readonly facts: SmeAssessmentFacts;
  /** For each fact, where it came from. */
  readonly factSources: Readonly<Record<string, string>>;
  readonly ratios: readonly FinancialRatio[];
  readonly assessedBy: string;
  readonly assessedAtEpochSeconds: bigint;
}

export interface OfferTerms {
  readonly productCode: string;
  readonly variantCode: string;
  readonly months: number;
  readonly graceMonths: number;
  readonly facilityAmount: Money;
  readonly monthlyInstalment: Money;
  readonly totalInterest: Money;
  readonly totalPayable: Money;
  /** The rate snapshot, integer basis points, its basis and period, and its source reference. Shown, never applied here. */
  readonly rateBp: bigint;
  readonly rateBasis: RateBasis;
  readonly ratePeriod: RatePeriod;
  readonly rateSourceRef: string;
  /** Computed by core/pricing/apr.ts from the quote's cash flows. */
  readonly aprBp: bigint;
  readonly disbursementDate: string;
  readonly firstDueDate: string;
  readonly paymentDay: number;
  readonly offerDate: string;
  readonly validUntil: string;
}

export interface OfferRun {
  readonly offerId: string;
  readonly letter: OfferLetter;
  readonly terms: OfferTerms;
  readonly schedule: DatedSchedule;
  readonly createdBy: string;
  readonly createdAtEpochSeconds: bigint;
}

export interface PortfolioStatus {
  readonly daysPastDue: number;
  readonly arrears: Money;
  readonly recordedBy: string;
  readonly asOfEpochSeconds: bigint;
}

export interface FigureView {
  /** The row id: what a verification names. */
  readonly figureId: string;
  readonly figure: FinancialFigure;
  readonly supersedes?: string;
}

export interface BusinessApplicationView {
  readonly application: BusinessApplication;
  /**
   * What was approved, once a decision approved it (`approvedTermsOf`): the
   * amount and tenor the offer is quoted on. The request stays on
   * `application.requested` and `application.tenorMonths`.
   */
  readonly approvedTerms?: ApprovedTerms;
  /** 9 when the loan system reports arrears; the application's stage otherwise. */
  readonly displayStage: BusinessStage;
  readonly currency: CurrencyCode;
  readonly contact: OfferNotificationRecipient;
  /** The current figure per metric, superseded rows left out. */
  readonly figures: readonly FigureView[];
  readonly documents: readonly BusinessDocument[];
  readonly assessmentInputs?: AssessmentInputs;
  readonly bureauFetch?: BureauFetch;
  readonly bankFacts?: BankStatementFacts;
  /** The collateral offered and the guarantees given, withdrawn items included. */
  readonly security: SecurityRegister;
  /** Conditions and covenants attached, deviation justifications, and the digest frozen at approval. */
  readonly pack: DecisionPackRecord;
  /** Closing (UAE M5): the signing in progress, each condition precedent's evidence, and the payee account. */
  readonly closing: ClosingRecord;
  /** The loan as booked in the institution's loan system (UAE M6), once it is. */
  readonly booking?: LoanBookingRecord;
  /** Servicing (S1): repayments received and the position against the signed schedule, once disbursed. */
  readonly servicing?: ServicingView;
  /** The offer letters rendered as PDF, by letter version (the PDF is a rendition; the version is the letter). */
  readonly letterPdfs: readonly LetterPdf[];
  readonly assessments: readonly AssessmentRun[];
  readonly latestAssessment?: AssessmentRun;
  readonly offers: readonly OfferRun[];
  readonly latestOffer?: OfferRun;
  readonly portfolio?: PortfolioStatus;
  readonly events: readonly ApplicationEvent[];
}

export interface FigureReadiness {
  readonly requiredMetrics: readonly FinancialMetric[];
  readonly missingFigures: readonly FinancialMetric[];
  readonly unverifiedFigures: readonly FinancialMetric[];
  readonly spreadComplete: boolean;
  readonly correctedCount: number;
  /** Present only once the spread is complete; each ratio its own Result, so one zero denominator hides nothing. */
  readonly ratios?: Readonly<Record<FinancialRatioCode, Result<FinancialRatio>>>;
}

export interface ChecklistStatus {
  readonly checklist: DocumentChecklist;
  readonly report: readonly ItemReport[];
  readonly complete: boolean;
  readonly missing: readonly string[];
}

export interface HandoverRequest {
  readonly applicationId: string;
  readonly upstreamRef: string;
  readonly applicant: BusinessApplicant;
  readonly productCode: string;
  readonly variantCode: string;
  readonly purpose: string;
  readonly requestedMinorUnits: bigint;
  /**
   * Asserted only. The amount is held in the tenant's base currency from its
   * onboarding; a hand-over that says otherwise is refused, never converted.
   */
  readonly currency?: string;
  readonly tenorMonths: number;
  readonly graceMonths: number;
  readonly contributionPerTenThousand: number;
  /** Who the offer goes to: a party reference and masked display strings only. Defaults to the first owner's reference. */
  readonly contact?: OfferNotificationRecipient;
}

/**
 * A figure keyed through the workbench. It carries no source kind: whatever
 * is submitted from a form is OFFICER_ENTRY, entered by the acting principal.
 */
export interface OfficerFigureEntry {
  readonly metric: FinancialMetric;
  readonly periodLabel: string;
  readonly minorUnits: bigint;
  /** The document the officer keyed it from. */
  readonly sourceRef: string;
}

/** A figure read by the system from a statement (OCR) or a rail. Only `ingestReadFigures` accepts one. */
export interface ReadFigureEntry extends OfficerFigureEntry {
  readonly sourceKind: Exclude<FigureSourceKind, 'OFFICER_ENTRY'>;
}

/** Both kinds, as the internal recorder takes them. */
type FigureProposalEntry = OfficerFigureEntry & { readonly sourceKind: FigureSourceKind };

export interface FrozenPack {
  readonly digest: string;
  readonly atEpochSeconds: bigint;
}

export interface DecisionPackRecord {
  readonly conditions: readonly Condition[];
  readonly covenants: readonly Covenant[];
  readonly justifications: Readonly<Record<string, Justification>>;
  readonly frozen?: FrozenPack;
}

export interface SigningInProgress {
  readonly transactionRef: string;
  /** The letter version (its SHA-256) the signing intent was opened on. */
  readonly letterVersion: string;
  readonly expiresAtEpochSeconds: bigint;
  readonly startedBy: string;
  readonly source: 'LIVE' | 'FIXTURE';
}

export interface SignerRecord {
  readonly assertionId: string;
  /** The identity service's reference for the person who signed. Never an identity number. */
  readonly identityRef: string;
  readonly source: 'LIVE' | 'FIXTURE';
}

export interface CpEvidence {
  readonly evidenceRef: string;
  readonly satisfiedBy: string;
  readonly satisfiedAtEpochSeconds: bigint;
  readonly verifiedBy?: string;
}

export interface Payee {
  /** Electronic form, validated (country, length, mod 97). Shown masked except to the person confirming it. */
  readonly iban: string;
  readonly accountName: string;
  /** The bank letter or statement header proving the account, as a document on the application. */
  readonly evidenceRef: string;
  readonly recordedBy: string;
  readonly recordedAtEpochSeconds: bigint;
  readonly confirmedBy?: string;
}

export type RepaymentChannel = 'MANUAL' | 'SADAD' | 'PARTNER_BANK' | 'PAYMENTS_HUB';

/** A receipt against the facility. A manual one counts once a second person confirms it; a rail's is confirmed by the rail. */
export interface RepaymentRecord {
  readonly repaymentId: string;
  /** yyyy-mm-dd: the value date. */
  readonly receivedOn: string;
  readonly amount: Money;
  /** The channel's reference (the bank's, SADAD's), unique per facility. */
  readonly reference: string;
  readonly channel: RepaymentChannel;
  readonly recordedBy: string;
  readonly confirmedBy?: string;
  readonly source: 'LIVE' | 'FIXTURE';
}

/** An instalment presented for collection: a SADAD bill (Saudi Arabia) or a direct collection by the partner bank (UAE). */
export interface CollectionRecord {
  readonly instalmentNumber: number;
  readonly idempotencyKey: string;
  readonly channel: 'SADAD' | 'PARTNER_BANK';
  readonly amount: Money;
  readonly dueDate: string;
  readonly presentedBy: string;
  readonly presentedAtEpochSeconds: bigint;
  readonly result?: 'PAID' | 'RETURNED';
}

export interface LateChargeRecord {
  readonly instalmentNumber: number;
  readonly amount: Money;
  /** INCOME for a term loan; CHARITY for an Islamic facility — never the institution's income. */
  readonly treatment: 'INCOME' | 'CHARITY';
  readonly assessedBy: string;
  readonly assessedAtEpochSeconds: bigint;
  readonly waivedBy?: string;
  readonly waiverReason?: string;
}

/** Collections and late charges paused while the customer is in hardship, with the reason; lifted by a second person. */
export interface HardshipRecord {
  readonly reason: string;
  readonly setBy: string;
  readonly setAtEpochSeconds: bigint;
}

export interface RestructureRecord {
  readonly restructureId: string;
  readonly effectiveDate: string;
  readonly rows: readonly ScheduledInstalment[];
  /** What was owed on the day, and what the new schedule asks: equal for an Islamic facility, never more. */
  readonly outstandingBefore: Money;
  readonly totalAfter: Money;
  readonly proposedBy: string;
  readonly approvedBy?: string;
  readonly reason: string;
}

export interface ServicingView {
  readonly repayments: readonly RepaymentRecord[];
  readonly collections: readonly CollectionRecord[];
  /** The months (yyyy-mm) whose status has been reported to the credit bureau. */
  readonly bureauReports: readonly string[];
  readonly lateCharges: readonly LateChargeRecord[];
  readonly hardship?: HardshipRecord;
  readonly restructures: readonly RestructureRecord[];
  /** Against the signed schedule, confirmed repayments only, as of today in the tenant's time zone. */
  readonly position: FacilityPosition;
  /** The loan system's last reported status, set against Sanad's own: a difference is flagged, never overwritten. */
  readonly reconciliation?: { readonly loanSystemDaysPastDue: number; readonly sanadDaysPastDue: number; readonly matches: boolean };
}

export interface LetterPdf {
  /** The letter's version: the SHA-256 of its content, which is what the customer signs. */
  readonly letterVersion: string;
  /** The PDF's own SHA-256, under which its bytes are stored. */
  readonly sha256Hex: string;
  readonly byteLength: number;
  readonly storage: 'LIVE' | 'FIXTURE';
  readonly renderedBy: string;
  readonly renderedAtEpochSeconds: bigint;
}

export interface LoanBookingRecord {
  /** The loan system's account number for the loan, as staff and statements show it. */
  readonly loanAccountNumber: string;
  readonly contractRef: string;
  readonly customerRef: string;
  /** The loan system's product code it was booked under. */
  readonly productCode: string;
  readonly source: 'LIVE' | 'FIXTURE';
  readonly bookedBy: string;
  readonly bookedAtEpochSeconds: bigint;
}

export type TrancheStatus = 'PLANNED' | 'RELEASED' | 'SETTLED' | 'FAILED';

/** One drawdown of the facility, paid by one instruction (re-instructed under a new key after a failure). */
export interface Tranche {
  readonly trancheId: string;
  readonly amount: Money;
  /** The civil date (yyyy-mm-dd) it may be released from; the first defaults to the signed offer's disbursement date. */
  readonly plannedDate?: string;
  readonly status: TrancheStatus;
  /** How many instructions have gone out for it. */
  readonly releases: number;
  readonly idempotencyKey?: string;
  readonly releasedBy?: string;
  readonly instructionRef?: string;
  readonly failureCode?: string;
  readonly failedAtEpochSeconds?: bigint;
}

export interface ClosingRecord {
  readonly signing?: SigningInProgress;
  readonly signer?: SignerRecord;
  readonly cps: Readonly<Record<string, CpEvidence>>;
  readonly payee?: Payee;
  /** The drawdown plan; absent until planned or first released (then one tranche of the whole facility). */
  readonly tranches?: readonly Tranche[];
  /** Tawarruq only (KSA K4): the commodity steps between signature and disbursement. */
  readonly tawarruq?: TawarruqRecord;
}

/**
 * A Tawarruq's execution, step by step, as products/sme-term-islamic validates
 * it: the institution buys the commodity at exactly the quoted cost, sells it
 * to the customer for the deferred price on a signed instrument, title passes,
 * and the customer (or the institution as agent, where the board permits) sells
 * it on for cash — the proceeds the customer receives. Each step attested
 * strictly after the one before.
 */
export interface TawarruqRecord {
  readonly state: 'COMMODITY_PURCHASED' | 'SOLD_TO_CUSTOMER' | 'TITLE_TRANSFERRED' | 'PROCEEDS_REALISED';
  readonly lot: CommodityLot;
  readonly purchasedAt: TsaInstant;
  readonly saleDocumentRef?: string;
  readonly soldAt?: TsaInstant;
  readonly transferRef?: string;
  readonly transferredAt?: TsaInstant;
  readonly saleRef?: string;
  readonly proceeds?: Money;
  readonly agencyRef?: string;
  readonly realisedAt?: TsaInstant;
  readonly source: 'LIVE' | 'FIXTURE';
}

// =============================================================================
// State
// =============================================================================

interface BusinessRecord {
  application: BusinessApplication;
  contact: OfferNotificationRecipient;
  figures: FigureRow[];
  documents: BusinessDocument[];
  inputs?: AssessmentInputs;
  bureauFetch?: BureauFetch;
  bankFacts?: BankStatementFacts;
  security: { collateral: CollateralItem[]; guarantees: Guarantee[] };
  pack: { conditions: Condition[]; covenants: Covenant[]; justifications: Record<string, Justification>; frozen?: FrozenPack };
  closing: {
    signing?: SigningInProgress;
    signer?: SignerRecord;
    cps: Record<string, CpEvidence>;
    payee?: Payee;
    tranches?: Tranche[];
    tawarruq?: TawarruqRecord;
  };
  booking?: LoanBookingRecord;
  letterPdfs: LetterPdf[];
  servicing: {
    repayments: RepaymentRecord[];
    collections: CollectionRecord[];
    bureauReports: string[];
    settledReported?: true;
    lateCharges: LateChargeRecord[];
    hardship?: HardshipRecord;
    restructures: RestructureRecord[];
  };
  assessments: AssessmentRun[];
  offers: OfferRun[];
  events: ApplicationEvent[];
  portfolio?: PortfolioStatus;
  /** The stored row's version as last loaded or saved by this process; absent until it is first written. */
  stored?: ApplicationVersion;
}

interface TenantBook {
  readonly records: Map<string, BusinessRecord>;
  hydrated: boolean;
  seeded: boolean;
  /** The one hydration in flight: concurrent first reads share it, so the book is loaded (and seeded) once. */
  loading?: Promise<void>;
  readonly dirty: Set<string>;
  unsavedFigures: (FigureRow & { readonly applicationId: string })[];
  unsavedAssessments: PersistedAssessment[];
  unsavedOffers: PersistedOffer[];
  unsavedEvents: (ApplicationEvent & { readonly applicationId: string })[];
  /** Side effects caused by the unsaved changes, written with them in one transaction. */
  unsavedOutbox: OutboxEvent[];
  /** Set when a failed or stale save dropped this working set; nothing may be recorded on it afterwards. */
  discarded?: true;
}

interface BusinessState {
  readonly books: Map<string, TenantBook>;
  /** Every side effect this process has queued (all tenants), for the operations view and tests. */
  outbox: Outbox;
  outboxStore: OutboxStore;
  outboxOnDatabase: boolean;
  /** Tests only: a pool standing in for the configured database. */
  pool?: Pool;
}

/** On globalThis for the same reason as the request book (store.ts): one copy per process across module graphs. */
const KEY = Symbol.for('sanad.ops.businessStore');
const scope = globalThis as unknown as Record<symbol, BusinessState | undefined>;
const state: BusinessState = (scope[KEY] ??= {
  books: new Map(),
  outbox: emptyOutbox(),
  outboxStore: inMemoryOutboxStore(),
  outboxOnDatabase: false,
});

const freshBook = (seeded: boolean): TenantBook => ({
  records: new Map(),
  hydrated: false,
  seeded,
  dirty: new Set(),
  unsavedFigures: [],
  unsavedAssessments: [],
  unsavedOffers: [],
  unsavedEvents: [],
  unsavedOutbox: [],
});

function bookOf(tenant: TenantCode): TenantBook {
  let book = state.books.get(tenant);
  if (book === undefined) {
    book = freshBook(false);
    state.books.set(tenant, book);
  }
  return book;
}

// -- the per-tenant lock ---------------------------------------------------------

/**
 * One mutation at a time per tenant, from load through change to save. Every
 * exported mutation and every save takes its tenant's lock, so a save that
 * finds the book stale and drops it can never do so while another request is
 * half-way through changing that book: the other request either finished
 * (and its change was in the batch that was refused, so its own save is
 * refused too — see `mutateBusiness`) or has not started (and loads afresh).
 *
 * Re-entrant within one call chain (AsyncLocalStorage carries the tenants
 * held), so a mutation that saves, or a save that runs inside a mutation,
 * does not wait on itself. On globalThis like the book, one per process.
 */
const LOCKS_KEY = Symbol.for('sanad.ops.businessLocks');
const lockScope = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>;
const lockTails: Map<string, Promise<void>> = (lockScope[LOCKS_KEY] ??= new Map());
const locksHeld = new AsyncLocalStorage<ReadonlySet<string>>();

async function withTenantLock<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  const held = locksHeld.getStore();
  if (held?.has(tenant) === true) return fn();
  const previous = lockTails.get(tenant) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  lockTails.set(tenant, tail);
  await previous;
  try {
    return await locksHeld.run(new Set([...(held ?? []), tenant]), fn);
  } finally {
    release();
    if (lockTails.get(tenant) === tail) lockTails.delete(tenant);
  }
}

/** The database pool the book is written to, if any. */
const poolOf = (): Pool | undefined => state.pool ?? persistencePool();

/** Set while the illustrative seed runs for a tenant: the seed's own calls must not wait on the hydration that started it. */
const seeding = new AsyncLocalStorage<string>();

/** Where the business book lives: the database when one is configured, this process's memory otherwise. */
export const businessBacking = (): 'POSTGRESQL' | 'MEMORY' =>
  persistenceUrl() === undefined ? 'MEMORY' : 'POSTGRESQL';

// =============================================================================
// Small helpers
// =============================================================================

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);
const notFound = (applicationId: string): Result<never> =>
  fail('BUSINESS_APPLICATION_NOT_FOUND', 'No business application with that id for this institution', {
    applicationId,
  });

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;

/**
 * The first named text input that carries an identity-number shape (Emirates
 * ID or Saudi national id / iqama), refused before anything is recorded —
 * applied to every free-text and reference input after the hand-over, as the
 * hand-over itself is. The refusal names the field, never the value.
 */
function identityNumberIn(fields: Readonly<Record<string, string>>): Result<never> | undefined {
  for (const [field, value] of Object.entries(fields)) {
    if (containsIdentityNumber(value))
      return fail(
        'IDENTITY_NUMBER_IN_PAYLOAD',
        'An identity number does not belong in the application record; send a reference',
        { field },
      );
  }
  return undefined;
}

interface TenantContext {
  readonly currency: CurrencyCode;
  readonly profile: JurisdictionProfile;
  readonly legalNameEn: string;
  readonly legalNameAr: string;
}

function tenantContext(tenant: TenantCode): Result<TenantContext> {
  const onboarding = loadTenantOnboarding(tenant);
  if (!onboarding.ok) return onboarding;
  const profile = loadJurisdictionProfile(onboarding.value.jurisdiction);
  if (!profile.ok) return profile;
  return ok({
    currency: onboarding.value.baseCurrency,
    profile: profile.value,
    legalNameEn: onboarding.value.legalNameEn,
    legalNameAr: onboarding.value.legalNameAr,
  });
}

/** The tenant's catalogue: the approved revision in force when a database is configured, the checked-in file otherwise. */
async function catalogueFor(tenant: TenantCode, at: TsaInstant): Promise<Result<ProductCatalogue>> {
  if (persistenceUrl() === undefined) return loadProductCatalogue(tenant);
  return (await resolveProductCatalogue(tenant, at.epochSeconds)).catalogue;
}

interface ProductContext {
  readonly entry: ProductCatalogue['entries'][number];
  readonly variant: SmeVariant;
  readonly terms: Parameters<typeof smeTermConventional.quote>[0] | Parameters<typeof smeTermIslamic.quote>[0];
  /** The product module that quotes and discloses it. */
  readonly module: typeof smeTermConventional | typeof smeTermIslamic;
}

/**
 * The SME product modules a business application is quoted through: the
 * conventional term loan and, where the tenant's catalogue enables it under
 * its board's ruling (core/products/catalogue.ts refuses it otherwise), the
 * Tawarruq module (KSA K4). The modules share the variant and SME rules.
 */
const SME_MODULES: Readonly<Record<string, typeof smeTermConventional | typeof smeTermIslamic>> = {
  [smeTermConventional.descriptor.code]: smeTermConventional,
  [smeTermIslamic.descriptor.code]: smeTermIslamic,
};

/** Whether a business application's product is the Tawarruq module: sold for a deferred price, closed by the commodity steps. */
export const isTawarruq = (productCode: string): boolean => productCode === smeTermIslamic.descriptor.code;

/**
 * The catalogue entry, its parsed term sheet and the variant. Only the
 * conventional SME module is quoted here: the Islamic module is disabled in
 * the fund's catalogue until its board ruling is recorded (a hand-over for it
 * is refused, not quietly priced as conventional).
 */
async function productFor(
  tenant: TenantCode,
  productCode: string,
  variantCode: string,
  at: TsaInstant,
): Promise<Result<ProductContext>> {
  const catalogue = await catalogueFor(tenant, at);
  if (!catalogue.ok) return catalogue;
  const entry = catalogue.value.entries.find((e) => e.productCode === productCode);
  if (entry === undefined || !entry.enabled)
    return fail('PRODUCT_NOT_IN_CATALOGUE', 'The product is not enabled in this institution’s catalogue', {
      productCode,
    });
  const module = SME_MODULES[productCode];
  if (module === undefined)
    return fail('PRODUCT_NOT_QUOTED_HERE', 'Business applications are quoted through the SME modules only', {
      productCode,
    });
  const terms = module.validateTerms(entry.terms);
  if (!terms.ok) return terms;
  const variant = terms.value.variants.find((v) => v.code === variantCode);
  if (variant === undefined) return fail('VARIANT_UNKNOWN', 'No such variant of this product', { variantCode });
  return ok({ entry, variant: variant as SmeVariant, terms: terms.value, module });
}

// -- dates (integer civil-date arithmetic) -------------------------------------

const OFFSET_SECONDS: Readonly<Record<string, bigint>> = { 'Asia/Dubai': 4n * HOUR, 'Asia/Riyadh': 3n * HOUR };

function civilFromDays(days: bigint): { y: bigint; m: bigint; d: bigint } {
  const z = days + 719_468n;
  const era = (z >= 0n ? z : z - 146_096n) / 146_097n;
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1_460n + doe / 36_524n - doe / 146_096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const d = doy - (153n * mp + 2n) / 5n + 1n;
  const m = mp < 10n ? mp + 3n : mp - 9n;
  return { y: yoe + era * 400n + (m <= 2n ? 1n : 0n), m, d };
}

function daysFromCivil(yIn: bigint, m: bigint, d: bigint): bigint {
  const y = m <= 2n ? yIn - 1n : yIn;
  const era = (y >= 0n ? y : y - 399n) / 400n;
  const yoe = y - era * 400n;
  const doy = (153n * (m > 2n ? m - 3n : m + 9n) + 2n) / 5n + d - 1n;
  return era * 146_097n + yoe * 365n + yoe / 4n - yoe / 100n + doy - 719_468n;
}

const pad = (n: bigint, w: number): string => n.toString().padStart(w, '0');
const isoOfDays = (days: bigint): string => {
  const c = civilFromDays(days);
  return `${pad(c.y, 4)}-${pad(c.m, 2)}-${pad(c.d, 2)}`;
};
function daysOfIso(iso: string): bigint | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m === null ? undefined : daysFromCivil(BigInt(m[1] ?? '0'), BigInt(m[2] ?? '0'), BigInt(m[3] ?? '0'));
}

/** The calendar date of an instant in the jurisdiction's time zone. */
function localDate(at: bigint, profile: JurisdictionProfile): string {
  const local = at + (OFFSET_SECONDS[profile.timeZone] ?? 0n);
  return isoOfDays(local >= 0n ? local / DAY : (local - DAY + 1n) / DAY);
}

/** The first of a month at least the policy's minimum gap after the disbursement date: the default first due date, paying on the 1st. */
function defaultFirstDue(disbursement: string, minGapDays: bigint): string {
  const days = daysOfIso(disbursement) ?? 0n;
  const c = civilFromDays(days);
  let y = c.y;
  let m = c.m + 1n;
  if (m > 12n) {
    m = 1n;
    y += 1n;
  }
  let candidate = daysFromCivil(y, m, 1n);
  while (candidate - days < minGapDays) {
    m += 1n;
    if (m > 12n) {
      m = 1n;
      y += 1n;
    }
    candidate = daysFromCivil(y, m, 1n);
  }
  return isoOfDays(candidate);
}

/**
 * The offer's dates against the tenant's offer date policy
 * (config/tenants/<tenant>/credit-policy/offer-policy.json, loaded through
 * `loadOfferDatePolicy`), each refusal typed and naming the policy: the
 * disbursement on or after the offer date and within the policy's window;
 * the first instalment within the policy's window after disbursement.
 */
export function checkOfferDates(
  policy: OfferDatePolicy,
  offerDate: string,
  disbursementDate: string,
  firstDueDate: string,
): Result<true> {
  const offer = daysOfIso(offerDate);
  const disbursement = daysOfIso(disbursementDate);
  const firstDue = daysOfIso(firstDueDate);
  if (
    offer === undefined ||
    disbursement === undefined ||
    firstDue === undefined ||
    isoOfDays(disbursement) !== disbursementDate ||
    isoOfDays(firstDue) !== firstDueDate
  ) {
    return fail('OFFER_DATE_MALFORMED', 'Dates are calendar dates as YYYY-MM-DD', { disbursementDate, firstDueDate });
  }
  const cite = { policyId: policy.policyId, policyVersion: policy.version };
  if (disbursement < offer)
    return fail('DISBURSEMENT_BEFORE_OFFER', 'The disbursement date is on or after the offer date', {
      offerDate,
      disbursementDate,
    });
  if (disbursement - offer > policy.maxDisbursementAfterOfferDays)
    return fail(
      'DISBURSEMENT_TOO_FAR',
      `The disbursement date is within ${policy.maxDisbursementAfterOfferDays} days of the offer date`,
      { offerDate, disbursementDate, ...cite },
    );
  if (firstDue - disbursement < policy.minFirstDueAfterDisbursementDays)
    return fail(
      'FIRST_DUE_TOO_SOON',
      `The first instalment falls at least ${policy.minFirstDueAfterDisbursementDays} days after disbursement`,
      { disbursementDate, firstDueDate, ...cite },
    );
  if (firstDue - disbursement > policy.maxFirstDueAfterDisbursementDays)
    return fail(
      'FIRST_DUE_TOO_LATE',
      `The first instalment falls at most ${policy.maxFirstDueAfterDisbursementDays} days after disbursement`,
      { disbursementDate, firstDueDate, ...cite },
    );
  return ok(true);
}

// =============================================================================
// Recording
// =============================================================================

function nextSequence(record: BusinessRecord): number {
  return record.events.reduce((max, e) => Math.max(max, e.sequence), 0) + 1;
}

/** Closed applications are never updated again (0016's guard trigger); their later events are recorded without touching the row. */
const CLOSED = new Set(['DECLINED', 'DISBURSED', 'WITHDRAWN']);

function recordEvent(
  book: TenantBook,
  record: BusinessRecord,
  e: Omit<ApplicationEvent, 'eventId' | 'sequence'>,
): ApplicationEvent {
  const event: ApplicationEvent = { ...e, eventId: randomUUID(), sequence: nextSequence(record) };
  record.events.push(event);
  book.unsavedEvents.push({ ...event, applicationId: record.application.applicationId });
  // Every change to an open application rewrites its row, so the version check guards figures, documents and inputs too.
  if (!CLOSED.has(record.application.status)) book.dirty.add(record.application.applicationId);
  return event;
}

function apply(book: TenantBook, record: BusinessRecord, t: Transition): void {
  record.application = t.application;
  book.dirty.add(t.application.applicationId);
  const s: StageEvent = t.event;
  recordEvent(book, record, {
    eventType: s.eventType,
    fromStage: s.fromStage,
    toStage: s.toStage,
    actor: s.actor,
    atEpochSeconds: s.atEpochSeconds,
    detail: s.detail,
  });
}

function currentFigures(record: BusinessRecord): FigureRow[] {
  const superseded = new Set(record.figures.flatMap((f) => (f.supersedes === undefined ? [] : [f.supersedes])));
  return record.figures.filter((f) => !superseded.has(f.rowId));
}

function addFigureRow(book: TenantBook, record: BusinessRecord, row: FigureRow): void {
  record.figures.push(row);
  book.unsavedFigures.push({ ...row, applicationId: record.application.applicationId });
}

function view(record: BusinessRecord, currency: CurrencyCode): BusinessApplicationView {
  const latestAssessment = record.assessments[record.assessments.length - 1];
  const latestOffer = record.offers[record.offers.length - 1];
  const servicing = servicingOf(record);
  const inCollections =
    record.application.status === 'DISBURSED' &&
    ((record.portfolio !== undefined && record.portfolio.daysPastDue > 0) || (servicing?.position.daysPastDue ?? 0) > 0);
  const approvedTerms = approvedTermsOf(record.application);
  return {
    application: record.application,
    ...(approvedTerms === undefined ? {} : { approvedTerms }),
    displayStage: inCollections ? 9 : record.application.stage,
    currency,
    contact: record.contact,
    figures: currentFigures(record).map((f) => ({
      figureId: f.rowId,
      figure: f.figure,
      ...(f.supersedes === undefined ? {} : { supersedes: f.supersedes }),
    })),
    documents: [...record.documents],
    ...(record.inputs === undefined ? {} : { assessmentInputs: record.inputs }),
    ...(record.bureauFetch === undefined ? {} : { bureauFetch: record.bureauFetch }),
    ...(record.bankFacts === undefined ? {} : { bankFacts: record.bankFacts }),
    security: { collateral: [...record.security.collateral], guarantees: [...record.security.guarantees] },
    pack: {
      conditions: [...record.pack.conditions],
      covenants: [...record.pack.covenants],
      justifications: { ...record.pack.justifications },
      ...(record.pack.frozen === undefined ? {} : { frozen: record.pack.frozen }),
    },
    closing: {
      ...(record.closing.signing === undefined ? {} : { signing: record.closing.signing }),
      ...(record.closing.signer === undefined ? {} : { signer: record.closing.signer }),
      cps: { ...record.closing.cps },
      ...(record.closing.payee === undefined ? {} : { payee: record.closing.payee }),
      ...(record.closing.tranches === undefined ? {} : { tranches: [...record.closing.tranches] }),
      ...(record.closing.tawarruq === undefined ? {} : { tawarruq: record.closing.tawarruq }),
    },
    ...(record.booking === undefined ? {} : { booking: record.booking }),
    ...(servicing === undefined ? {} : { servicing }),
    letterPdfs: [...record.letterPdfs],
    assessments: [...record.assessments],
    ...(latestAssessment === undefined ? {} : { latestAssessment }),
    offers: [...record.offers],
    ...(latestOffer === undefined ? {} : { latestOffer }),
    ...(record.portfolio === undefined ? {} : { portfolio: record.portfolio }),
    events: [...record.events],
  };
}

// =============================================================================
// Durability
// =============================================================================

/**
 * Loads the tenant's book once per process. Concurrent first reads share one
 * load (single flight), so nothing is restored — or seeded — twice. An empty
 * book for the illustrative UAE fund is seeded: always in memory; on a
 * database only when its deployment profile is readable and says it is not
 * cleared for production data (never in a deployment that is).
 */
async function hydrate(tenant: TenantCode): Promise<TenantBook> {
  const book = bookOf(tenant);
  // The seed's own calls run inside the load that started it: they take the book as it is.
  if (book.hydrated || seeding.getStore() === tenant) return book;
  book.loading ??= loadInto(tenant, book).catch((error: unknown) => {
    delete book.loading;
    throw error;
  });
  await book.loading;
  return book;
}

async function loadInto(tenant: TenantCode, book: TenantBook): Promise<void> {
  const pool = poolOf();
  if (pool !== undefined) restoreBook(book, await loadBusinessBook(pool, tenant));
  if (
    book.records.size === 0 &&
    !book.seeded &&
    tenant === SEED_TENANT &&
    (pool === undefined || (await illustrativeSeedPermitted(pool)))
  ) {
    book.seeded = true;
    await seeding.run(tenant, () => seedIllustrativeBook(tenant));
  }
  book.seeded = true;
  book.hydrated = true;
}

function restoreBook(book: TenantBook, persisted: Awaited<ReturnType<typeof loadBusinessBook>>): void {
  for (const application of persisted.applications) {
    const firstOwner = application.applicant.owners[0]?.ref ?? application.applicationId;
    const stored = persisted.versions.get(application.applicationId);
    book.records.set(application.applicationId, {
      application,
      contact: { partyRef: firstOwner },
      figures: [],
      documents: [],
      security: { collateral: [], guarantees: [] },
      pack: { conditions: [], covenants: [], justifications: {} },
      closing: { cps: {} },
      servicing: { repayments: [], collections: [], bureauReports: [], lateCharges: [], restructures: [] },
      letterPdfs: [],
      assessments: [],
      offers: [],
      events: [],
      ...(stored === undefined ? {} : { stored }),
    });
  }
  for (const f of persisted.figures) {
    const r = book.records.get(f.applicationId);
    if (r !== undefined)
      r.figures.push({
        rowId: f.rowId,
        figure: f.figure,
        createdBy: f.createdBy,
        ...(f.supersedes === undefined ? {} : { supersedes: f.supersedes }),
      });
  }
  for (const a of persisted.assessments) {
    const r = book.records.get(a.applicationId);
    const trace = a.trace as Omit<AssessmentRun, 'assessmentId' | 'assessedBy' | 'assessedAtEpochSeconds'>;
    if (r !== undefined)
      r.assessments.push({
        ...trace,
        assessmentId: a.assessmentId,
        assessedBy: a.assessedBy,
        assessedAtEpochSeconds: a.assessedAtEpochSeconds,
      });
  }
  for (const o of persisted.offers) {
    const r = book.records.get(o.applicationId);
    const held = o.letter as {
      readonly letter: OfferLetter;
      readonly terms: OfferTerms;
      readonly createdAtEpochSeconds: bigint;
    };
    if (r !== undefined)
      r.offers.push({
        offerId: o.offerId,
        letter: held.letter,
        terms: held.terms,
        schedule: o.schedule as DatedSchedule,
        createdBy: o.createdBy,
        createdAtEpochSeconds: held.createdAtEpochSeconds,
      });
  }
  for (const r of book.records.values())
    r.offers.sort((a, b) =>
      a.createdAtEpochSeconds < b.createdAtEpochSeconds
        ? -1
        : a.createdAtEpochSeconds > b.createdAtEpochSeconds
          ? 1
          : 0,
    );
  for (const e of persisted.events) {
    const r = book.records.get(e.applicationId);
    if (r === undefined) continue;
    const { applicationId: _a, ...event } = e;
    r.events.push(event);
    replayEvent(r, event);
  }
}

/** Rebuilds what is recorded only as an event: contact, documents, assessment inputs, portfolio status. */
/** A stored bureau source: the old AECB_FIXTURE (and an absent one) meant keyed from the upstream report. */
function bureauSourceOf(stored: string | undefined): BureauSource {
  return stored === 'AECB_RAIL_FIXTURE' ||
    stored === 'AECB_RAIL_LIVE' ||
    stored === 'SIMAH_RAIL_FIXTURE' ||
    stored === 'SIMAH_RAIL_LIVE'
    ? stored
    : 'KEYED_FROM_UPSTREAM_REPORT';
}

function contentOf(d: Readonly<Record<string, string>>): DocumentContent {
  const type = d['contentType'];
  return {
    sha256Hex: d['contentSha256'] ?? '',
    byteLength: Number.parseInt(d['contentBytes'] ?? '0', 10),
    mediaType: type === 'image/png' || type === 'image/jpeg' ? type : 'application/pdf',
    storage: d['contentStorage'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
  };
}

// -- the security register (UAE M3) -------------------------------------------

function collateralFromDetail(d: Readonly<Record<string, string>>, currency: CurrencyCode, e: ApplicationEvent): CollateralItem {
  const charge = d['charge'];
  return {
    itemId: d['itemId'] ?? '',
    kind: (d['kind'] ?? 'OTHER') as CollateralItem['kind'],
    description: d['description'] ?? '',
    marketValue: money(BigInt(d['marketValueMinorUnits'] ?? '0'), currency),
    valuedAtEpochSeconds: BigInt(d['valuedAtEpoch'] ?? '0'),
    valuerRef: d['valuerRef'] ?? '',
    ...(d['evidenceRef'] === undefined ? {} : { evidenceRef: d['evidenceRef'] }),
    charge: charge === 'REGISTERED' || charge === 'PENDING' ? charge : 'NOT_APPLICABLE',
    ...(d['chargeRef'] === undefined ? {} : { chargeRef: d['chargeRef'] }),
    recordedBy: e.actor,
    recordedAtEpochSeconds: e.atEpochSeconds,
  };
}

function guaranteeFromDetail(d: Readonly<Record<string, string>>, currency: CurrencyCode, e: ApplicationEvent): Guarantee {
  const limit = d['limitMinorUnits'];
  return {
    guaranteeId: d['itemId'] ?? '',
    guarantorKind: d['guarantorKind'] === 'CORPORATE' ? 'CORPORATE' : 'PERSONAL',
    guarantorRef: d['guarantorRef'] ?? '',
    guarantorName: d['guarantorName'] ?? '',
    limit: limit === undefined ? { kind: 'UNLIMITED' } : { kind: 'LIMITED', amount: money(BigInt(limit), currency) },
    ...(d['deedRef'] === undefined ? {} : { deedRef: d['deedRef'] }),
    recordedBy: e.actor,
    recordedAtEpochSeconds: e.atEpochSeconds,
  };
}

type SecurityMark = { readonly confirmedBy: string; readonly confirmedAtEpochSeconds: bigint } | { readonly withdrawnBy: string };

function updateSecurityItem(r: BusinessRecord, itemId: string, mark: SecurityMark): void {
  const c = r.security.collateral.findIndex((i) => i.itemId === itemId);
  if (c >= 0) {
    r.security.collateral[c] = { ...(r.security.collateral[c] as CollateralItem), ...mark };
    return;
  }
  const g = r.security.guarantees.findIndex((i) => i.guaranteeId === itemId);
  if (g >= 0) r.security.guarantees[g] = { ...(r.security.guarantees[g] as Guarantee), ...mark };
}

const nextSecurityId = (prefix: 'COL' | 'GUA', taken: number): string => `${prefix}-${String(taken + 1).padStart(3, '0')}`;

// -- the decision pack (UAE M4) -----------------------------------------------

function conditionFromDetail(d: Readonly<Record<string, string>>, e: ApplicationEvent): Condition {
  const due = d['dueDaysAfterDisbursement'];
  return {
    conditionId: d['itemId'] ?? '',
    kind: d['kind'] === 'SUBSEQUENT' ? 'SUBSEQUENT' : 'PRECEDENT',
    textEn: d['textEn'] ?? '',
    textAr: d['textAr'] ?? '',
    ...(due === undefined ? {} : { dueDaysAfterDisbursement: Number.parseInt(due, 10) }),
    addedBy: e.actor,
    addedAtEpochSeconds: e.atEpochSeconds,
  };
}

/** A covenant replays from the template as it stood when attached, never from today's policy. */
function covenantFromDetail(d: Readonly<Record<string, string>>, e: ApplicationEvent): Covenant {
  const kind = d['kind'] === 'FINANCIAL' || d['kind'] === 'NEGATIVE' ? d['kind'] : 'INFORMATION';
  const frequency = d['frequency'];
  return {
    covenantId: d['itemId'] ?? '',
    template: {
      code: d['code'] ?? '',
      kind,
      ...(d['metric'] === undefined ? {} : { metric: d['metric'] }),
      ...(d['minimumPerTenThousand'] === undefined
        ? {}
        : { minimumPerTenThousand: Number.parseInt(d['minimumPerTenThousand'], 10) }),
      ...(frequency === 'QUARTERLY' || frequency === 'SEMI_ANNUAL' || frequency === 'ANNUAL' ? { frequency } : {}),
      labelEn: d['labelEn'] ?? '',
      labelAr: d['labelAr'] ?? '',
    },
    addedBy: e.actor,
    addedAtEpochSeconds: e.atEpochSeconds,
  };
}

function withdrawPackItemIn(r: BusinessRecord, itemId: string, actor: string): boolean {
  const c = r.pack.conditions.findIndex((x) => x.conditionId === itemId && x.withdrawnBy === undefined);
  if (c >= 0) {
    r.pack.conditions[c] = { ...(r.pack.conditions[c] as Condition), withdrawnBy: actor };
    return true;
  }
  const v = r.pack.covenants.findIndex((x) => x.covenantId === itemId && x.withdrawnBy === undefined);
  if (v >= 0) {
    r.pack.covenants[v] = { ...(r.pack.covenants[v] as Covenant), withdrawnBy: actor };
    return true;
  }
  return false;
}

// -- tranches and payment results (UAE M5b) ------------------------------------

/** A failed payment withdraws the payee confirmation: a second person confirms the account (corrected or not) before money goes again. */
function withdrawPayeeConfirmation(r: BusinessRecord): void {
  if (r.closing.payee === undefined) return;
  const { confirmedBy: _withdrawn, ...unconfirmed } = r.closing.payee;
  r.closing.payee = unconfirmed;
}

function updateTranche(r: BusinessRecord, trancheId: string, f: (t: Tranche) => Tranche): void {
  const i = (r.closing.tranches ?? []).findIndex((t) => t.trancheId === trancheId);
  if (i < 0 || r.closing.tranches === undefined) return;
  r.closing.tranches[i] = f(r.closing.tranches[i] as Tranche);
}

/** A bank status on a released tranche: settled, or failed (rejected, returned). Accepted changes only the reference. */
function applyPaymentResult(
  t: Tranche,
  status: string,
  instructionRef: string | undefined,
  reasonCode: string | undefined,
  at: bigint,
): Tranche {
  const ref = instructionRef === undefined ? {} : { instructionRef };
  if (status === 'SETTLED') return { ...t, ...ref, status: 'SETTLED' };
  if (status === 'REJECTED' || status === 'RETURNED')
    return { ...t, ...ref, status: 'FAILED', failureCode: reasonCode ?? status, failedAtEpochSeconds: at };
  return { ...t, ...ref };
}

function replayEvent(r: BusinessRecord, e: ApplicationEvent): void {
  const d = e.detail;
  switch (e.eventType) {
    case 'CONTACT_RECORDED':
      r.contact = {
        partyRef: d['partyRef'] ?? r.contact.partyRef,
        ...(d['emailMasked'] === undefined ? {} : { emailMasked: d['emailMasked'] }),
        ...(d['mobileMasked'] === undefined ? {} : { mobileMasked: d['mobileMasked'] }),
      };
      return;
    case 'DOCUMENT_PRESENTED':
      r.documents.push({
        documentType: d['documentType'] ?? '',
        documentRef: d['documentRef'] ?? '',
        validationStatus: (d['validationStatus'] ?? 'PENDING') as BusinessDocument['validationStatus'],
        capturedAt: restoreAttestedInstant({
          epochSeconds: BigInt(d['capturedAtEpoch'] ?? '0'),
          tokenDigest: d['capturedTokenDigest'] ?? '',
          authorityId: d['capturedAuthority'] ?? '',
        }),
        presentedBy: e.actor,
        ...(d['contentSha256'] === undefined ? {} : { content: contentOf(d) }),
      });
      return;
    case 'DOCUMENT_VALIDATED':
      markValidated(
        r,
        d['documentRef'] ?? '',
        (d['validationStatus'] ?? 'PENDING') as BusinessDocument['validationStatus'],
        e.actor,
      );
      return;
    case 'ASSESSMENT_INPUTS_RECORDED':
      r.inputs = {
        bureau: {
          reportRef: d['bureauReportRef'] ?? '',
          consentId: d['bureauConsentId'] ?? '',
          score: BigInt(d['bureauScore'] ?? '0'),
          source: bureauSourceOf(d['bureauSource']),
        },
        fullTimeEmployees: Number.parseInt(d['fullTimeEmployees'] ?? '0', 10),
        relevantExperienceYears: BigInt(d['relevantExperienceYears'] ?? '0'),
        sectorPriority: d['sectorPriority'] ?? '',
        auditedFinancialsAvailable: d['auditedFinancialsAvailable'] === 'true',
        commitmentRatioPerTenThousand: BigInt(d['commitmentRatioPerTenThousand'] ?? '0'),
        riskAnalysisScorePerTenThousand: BigInt(d['riskAnalysisScorePerTenThousand'] ?? '0'),
        portfolioRepaymentPerTenThousand: BigInt(d['portfolioRepaymentPerTenThousand'] ?? '0'),
        failedFilesRatePerTenThousand: BigInt(d['failedFilesRatePerTenThousand'] ?? '0'),
        collateralValue: money(BigInt(d['collateralValueMinorUnits'] ?? '0'), r.application.requested.currency),
        recordedBy: e.actor,
        recordedAtEpochSeconds: e.atEpochSeconds,
      };
      return;
    case 'BUREAU_REPORT_FETCHED': {
      const currency = r.application.requested.currency;
      r.bureauFetch = {
        reportRef: d['reportRef'] ?? '',
        consentId: d['consentId'] ?? '',
        score: BigInt(d['score'] ?? '0'),
        source: d['source'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
        totalExposure: money(BigInt(d['totalExposureMinorUnits'] ?? '0'), currency),
        overdueAmount: money(BigInt(d['overdueMinorUnits'] ?? '0'), currency),
        worstDelinquencyDays: Number.parseInt(d['worstDelinquencyDays'] ?? '0', 10),
        activeFacilities: Number.parseInt(d['activeFacilities'] ?? '0', 10),
        defaults: Number.parseInt(d['defaults'] ?? '0', 10),
        fetchedBy: e.actor,
        atEpochSeconds: e.atEpochSeconds,
      };
      return;
    }
    case 'BANK_STATEMENTS_FETCHED': {
      const currency = r.application.requested.currency;
      r.bankFacts = {
        referenceId: d['referenceId'] ?? '',
        consentId: d['consentId'] ?? '',
        months: Number.parseInt(d['months'] ?? '0', 10),
        averageMonthlyInflow: money(BigInt(d['averageMonthlyInflowMinorUnits'] ?? '0'), currency),
        lowestMonthEndBalance: money(BigInt(d['lowestMonthEndBalanceMinorUnits'] ?? '0'), currency),
        returnedPaymentsLast6Months: Number.parseInt(d['returnedPaymentsLast6Months'] ?? '0', 10),
        salaryCreditsObserved: Number.parseInt(d['salaryCreditsObserved'] ?? '0', 10),
        source: d['source'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
        fetchedBy: e.actor,
        atEpochSeconds: e.atEpochSeconds,
      };
      return;
    }
    case 'BANK_STATEMENTS_CONFIRMED':
      if (r.bankFacts !== undefined)
        r.bankFacts = { ...r.bankFacts, confirmedBy: e.actor, confirmedAtEpochSeconds: e.atEpochSeconds };
      return;
    case 'COLLATERAL_RECORDED':
      r.security.collateral.push(collateralFromDetail(d, r.application.requested.currency, e));
      return;
    case 'GUARANTEE_RECORDED':
      r.security.guarantees.push(guaranteeFromDetail(d, r.application.requested.currency, e));
      return;
    case 'SECURITY_CONFIRMED':
      updateSecurityItem(r, d['itemId'] ?? '', { confirmedBy: e.actor, confirmedAtEpochSeconds: e.atEpochSeconds });
      return;
    case 'SECURITY_WITHDRAWN':
      updateSecurityItem(r, d['itemId'] ?? '', { withdrawnBy: e.actor });
      return;
    case 'CONDITION_ADDED':
      r.pack.conditions.push(conditionFromDetail(d, e));
      return;
    case 'COVENANT_ADDED':
      r.pack.covenants.push(covenantFromDetail(d, e));
      return;
    case 'PACK_ITEM_WITHDRAWN':
      withdrawPackItemIn(r, d['itemId'] ?? '', e.actor);
      return;
    case 'DEVIATION_JUSTIFIED':
      r.pack.justifications[d['code'] ?? ''] = { text: d['text'] ?? '', by: e.actor, atEpochSeconds: e.atEpochSeconds };
      return;
    case 'DECISION_PACK_FROZEN':
      r.pack.frozen = { digest: d['digest'] ?? '', atEpochSeconds: e.atEpochSeconds };
      return;
    case 'SIGNING_STARTED':
      r.closing.signing = {
        transactionRef: d['transactionRef'] ?? '',
        letterVersion: d['letterVersion'] ?? '',
        expiresAtEpochSeconds: BigInt(d['expiresAtEpoch'] ?? '0'),
        startedBy: e.actor,
        source: d['source'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
      };
      return;
    case 'SIGNING_ENDED':
      delete r.closing.signing;
      return;
    case 'SIGNER_VERIFIED':
      delete r.closing.signing;
      r.closing.signer = {
        assertionId: d['assertionId'] ?? '',
        identityRef: d['identityRef'] ?? '',
        source: d['source'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
      };
      return;
    case 'CP_SATISFIED':
      r.closing.cps[d['conditionId'] ?? ''] = {
        evidenceRef: d['evidenceRef'] ?? '',
        satisfiedBy: e.actor,
        satisfiedAtEpochSeconds: e.atEpochSeconds,
      };
      return;
    case 'CP_VERIFIED': {
      const cp = r.closing.cps[d['conditionId'] ?? ''];
      if (cp !== undefined) r.closing.cps[d['conditionId'] ?? ''] = { ...cp, verifiedBy: e.actor };
      return;
    }
    case 'PAYEE_RECORDED':
      r.closing.payee = {
        iban: d['iban'] ?? '',
        accountName: d['accountName'] ?? '',
        evidenceRef: d['evidenceRef'] ?? '',
        recordedBy: e.actor,
        recordedAtEpochSeconds: e.atEpochSeconds,
      };
      return;
    case 'PAYEE_CONFIRMED':
      if (r.closing.payee !== undefined) r.closing.payee = { ...r.closing.payee, confirmedBy: e.actor };
      return;
    case 'TAWARRUQ_STEP': {
      const at = restoreAttestedInstant({
        epochSeconds: BigInt(d['atEpoch'] ?? '0'),
        tokenDigest: d['tokenDigest'] || 'replayed',
        authorityId: d['authority'] || 'replayed',
      });
      const currency = r.application.requested.currency;
      const step = d['step'];
      if (step === 'COMMODITY_PURCHASED')
        r.closing.tawarruq = {
          state: 'COMMODITY_PURCHASED',
          lot: {
            lotRef: d['lotRef'] ?? '',
            commodityCode: d['commodityCode'] ?? '',
            quantity: d['quantity'] ?? '',
            unit: d['unit'] ?? '',
            price: money(BigInt(d['priceMinorUnits'] ?? '0'), currency),
            confirmedAtEpochSeconds: BigInt(d['brokerConfirmedAt'] ?? '0'),
          },
          purchasedAt: at,
          source: d['source'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
        };
      else if (r.closing.tawarruq !== undefined && step === 'SOLD_TO_CUSTOMER')
        r.closing.tawarruq = { ...r.closing.tawarruq, state: 'SOLD_TO_CUSTOMER', saleDocumentRef: d['saleDocumentRef'] ?? '', soldAt: at };
      else if (r.closing.tawarruq !== undefined && step === 'TITLE_TRANSFERRED')
        r.closing.tawarruq = { ...r.closing.tawarruq, state: 'TITLE_TRANSFERRED', transferRef: d['transferRef'] ?? '', transferredAt: at };
      else if (r.closing.tawarruq !== undefined && step === 'PROCEEDS_REALISED')
        r.closing.tawarruq = {
          ...r.closing.tawarruq,
          state: 'PROCEEDS_REALISED',
          saleRef: d['saleRef'] ?? '',
          proceeds: money(BigInt(d['proceedsMinorUnits'] ?? '0'), currency),
          ...(d['agencyRef'] === undefined ? {} : { agencyRef: d['agencyRef'] }),
          realisedAt: at,
        };
      return;
    }
    case 'REPAYMENT_RECORDED':
      r.servicing.repayments.push({
        repaymentId: d['repaymentId'] ?? '',
        receivedOn: d['receivedOn'] ?? '',
        amount: money(BigInt(d['amountMinorUnits'] ?? '0'), r.application.requested.currency),
        reference: d['reference'] ?? '',
        channel: (d['channel'] ?? 'MANUAL') as RepaymentChannel,
        recordedBy: e.actor,
        ...(d['confirmedBy'] === undefined ? {} : { confirmedBy: d['confirmedBy'] }),
        source: d['source'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
      });
      return;
    case 'COLLECTION_PRESENTED':
      r.servicing.collections.push({
        instalmentNumber: Number.parseInt(d['instalment'] ?? '0', 10),
        idempotencyKey: d['idempotencyKey'] ?? '',
        channel: d['channel'] === 'SADAD' ? 'SADAD' : 'PARTNER_BANK',
        amount: money(BigInt(d['amountMinorUnits'] ?? '0'), r.application.requested.currency),
        dueDate: d['dueDate'] ?? '',
        presentedBy: e.actor,
        presentedAtEpochSeconds: e.atEpochSeconds,
      });
      return;
    case 'COLLECTION_RESULT': {
      const i = r.servicing.collections.findIndex((x) => x.idempotencyKey === d['idempotencyKey']);
      if (i >= 0) r.servicing.collections[i] = { ...(r.servicing.collections[i] as CollectionRecord), result: d['result'] === 'PAID' ? 'PAID' : 'RETURNED' };
      return;
    }
    case 'LATE_CHARGE_ASSESSED':
      r.servicing.lateCharges.push({
        instalmentNumber: Number.parseInt(d['instalment'] ?? '0', 10),
        amount: money(BigInt(d['amountMinorUnits'] ?? '0'), r.application.requested.currency),
        treatment: d['treatment'] === 'CHARITY' ? 'CHARITY' : 'INCOME',
        assessedBy: e.actor,
        assessedAtEpochSeconds: e.atEpochSeconds,
      });
      return;
    case 'LATE_CHARGE_WAIVED': {
      const i = r.servicing.lateCharges.findIndex((x) => String(x.instalmentNumber) === d['instalment'] && x.waivedBy === undefined);
      if (i >= 0) r.servicing.lateCharges[i] = { ...(r.servicing.lateCharges[i] as LateChargeRecord), waivedBy: e.actor, waiverReason: d['reason'] ?? '' };
      return;
    }
    case 'HARDSHIP_SET':
      r.servicing.hardship = { reason: d['reason'] ?? '', setBy: e.actor, setAtEpochSeconds: e.atEpochSeconds };
      return;
    case 'HARDSHIP_LIFTED':
      delete r.servicing.hardship;
      return;
    case 'RESTRUCTURE_PROPOSED': {
      const currency = r.application.requested.currency;
      r.servicing.restructures.push({
        restructureId: d['restructureId'] ?? '',
        effectiveDate: d['effectiveDate'] ?? '',
        rows: (d['rows'] ?? '')
          .split(';')
          .filter((x) => x !== '')
          .map((x) => {
            const [n, due, pr, ch] = x.split('|');
            return { number: Number.parseInt(n ?? '0', 10), dueDate: due ?? '', principal: money(BigInt(pr ?? '0'), currency), charge: money(BigInt(ch ?? '0'), currency) };
          }),
        outstandingBefore: money(BigInt(d['outstandingBefore'] ?? '0'), currency),
        totalAfter: money(BigInt(d['totalAfter'] ?? '0'), currency),
        proposedBy: e.actor,
        reason: d['reason'] ?? '',
      });
      return;
    }
    case 'RESTRUCTURE_APPROVED': {
      const i = r.servicing.restructures.findIndex((x) => x.restructureId === d['restructureId']);
      if (i >= 0) r.servicing.restructures[i] = { ...(r.servicing.restructures[i] as RestructureRecord), approvedBy: e.actor };
      return;
    }
    case 'BUREAU_STATUS_REPORTED':
      r.servicing.bureauReports.push(d['month'] ?? '');
      return;
    case 'BUREAU_SETTLED_REPORTED':
      r.servicing.settledReported = true;
      return;
    case 'REPAYMENT_CONFIRMED': {
      const i = r.servicing.repayments.findIndex((x) => x.repaymentId === d['repaymentId']);
      if (i >= 0) r.servicing.repayments[i] = { ...(r.servicing.repayments[i] as RepaymentRecord), confirmedBy: e.actor };
      return;
    }
    case 'OFFER_PDF_RENDERED':
      r.letterPdfs.push({
        letterVersion: d['letterVersion'] ?? '',
        sha256Hex: d['sha256'] ?? '',
        byteLength: Number.parseInt(d['byteLength'] ?? '0', 10),
        storage: d['storage'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
        renderedBy: e.actor,
        renderedAtEpochSeconds: e.atEpochSeconds,
      });
      return;
    case 'LOAN_BOOKED':
      r.booking = {
        loanAccountNumber: d['loanAccountNumber'] ?? '',
        contractRef: d['contractRef'] ?? '',
        customerRef: d['customerRef'] ?? '',
        productCode: d['productCode'] ?? '',
        source: d['source'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
        bookedBy: e.actor,
        bookedAtEpochSeconds: e.atEpochSeconds,
      };
      return;
    case 'TRANCHES_PLANNED': {
      const amounts = (d['amounts'] ?? '').split(',');
      const dates = (d['dates'] ?? '').split(',');
      r.closing.tranches = amounts.map((a, i) => ({
        trancheId: `T${String(i + 1)}`,
        amount: money(BigInt(a || '0'), r.application.requested.currency),
        ...(dates[i] ? { plannedDate: dates[i] } : {}),
        status: 'PLANNED' as const,
        releases: 0,
      }));
      return;
    }
    case 'TRANCHE_RELEASED': {
      const id = d['trancheId'] ?? 'T1';
      r.closing.tranches ??= [
        { trancheId: 'T1', amount: money(BigInt(d['minorUnits'] ?? '0'), r.application.requested.currency), status: 'PLANNED', releases: 0 },
      ];
      updateTranche(r, id, (t) => ({
        ...t,
        status: 'RELEASED',
        releases: t.releases + 1,
        idempotencyKey: d['idempotencyKey'] ?? '',
        releasedBy: e.actor,
      }));
      return;
    }
    case 'PAYMENT_RESULT_RECORDED':
      updateTranche(r, d['trancheId'] ?? '', (t) => applyPaymentResult(t, d['status'] ?? '', d['instructionRef'], d['reasonCode'], e.atEpochSeconds));
      if (d['status'] === 'REJECTED' || d['status'] === 'RETURNED') withdrawPayeeConfirmation(r);
      return;
    case 'PORTFOLIO_STATUS_RECORDED':
      r.portfolio = {
        daysPastDue: Number.parseInt(d['daysPastDue'] ?? '0', 10),
        arrears: money(BigInt(d['arrearsMinorUnits'] ?? '0'), r.application.requested.currency),
        recordedBy: e.actor,
        asOfEpochSeconds: e.atEpochSeconds,
      };
      return;
    default:
      return;
  }
}

/** The most recent presentation of a document reference takes the checker's status. */
function markValidated(
  r: BusinessRecord,
  documentRef: string,
  status: BusinessDocument['validationStatus'],
  validator: string,
): void {
  for (let i = r.documents.length - 1; i >= 0; i -= 1) {
    const doc = r.documents[i];
    if (doc !== undefined && doc.documentRef === documentRef) {
      r.documents[i] = { ...doc, validationStatus: status, validatedBy: validator };
      return;
    }
  }
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * The store the dispatcher reads: the database's when one is configured. The
 * business service never appends through it — its events are written inside
 * the business transaction — but other callers may, so the tenant code is
 * still translated to the table's uuid on the way in.
 */
function useDatabaseOutbox(): void {
  if (state.outboxOnDatabase) return;
  const pool = poolOf();
  if (pool === undefined) return;
  const durable = postgresOutboxStore(pool);
  state.outboxStore = {
    ...durable,
    async append(events) {
      const mapped: OutboxEvent[] = [];
      for (const e of events)
        mapped.push(isUuid(e.tenantId) ? e : { ...e, tenantId: await tenantUuidByCode(pool, e.tenantId) });
      await durable.append(mapped);
    },
  };
  state.outboxOnDatabase = true;
}

/** The reasons a save answers with, as opposed to a refusal by the domain. Nothing of the change was written. */
export const SETTLE_FAILURE_REASONS: ReadonlySet<string> = new Set(['STALE_APPLICATION', 'PERSISTENCE_FAILED']);

/** Whether a refusal came from saving the change (nothing written; retry may succeed) rather than from the domain. */
export const isSettleFailure = (error: { readonly reason: string }): boolean =>
  SETTLE_FAILURE_REASONS.has(error.reason);

/**
 * Drops the tenant's working set: the next read reloads it from the database.
 * The side effects it had queued are dropped with it — they were never
 * written, so they must never be dispatched.
 */
function discardBook(tenant: string, book: TenantBook): void {
  book.discarded = true;
  if (state.books.get(tenant) === book) state.books.set(tenant, freshBook(book.seeded));
  const dropped = new Set(book.unsavedOutbox.map((e) => e.eventId));
  if (dropped.size > 0) state.outbox = { events: state.outbox.events.filter((e) => !dropped.has(e.eventId)) };
}

/**
 * Writes one tenant's pending changes in one transaction, under its lock. On
 * a conflict (STALE) or any other database failure (PERSISTENCE_FAILED) the
 * transaction is rolled back, the working set is dropped and reloaded on the
 * next read, and the outcome is a typed refusal — never a throw, and never a
 * batch left marked to be retried forever, which would make every later
 * action on the tenant fail with it.
 */
async function flushTenant(tenant: string, pool: Pool): Promise<Result<true>> {
  const book = state.books.get(tenant);
  if (book === undefined) return ok(true);
  const dirty = [...book.dirty].flatMap((id) => {
    const r = book.records.get(id);
    return r === undefined ? [] : [r];
  });
  const applications = dirty.map((r) => ({
    application: r.application,
    ...(r.stored === undefined ? {} : { expected: r.stored }),
  }));
  const figures = [...book.unsavedFigures];
  const assessments = [...book.unsavedAssessments];
  const offers = [...book.unsavedOffers];
  const events = [...book.unsavedEvents];
  const outbox = [...book.unsavedOutbox];
  let saved: Awaited<ReturnType<typeof saveBusinessChanges>>;
  try {
    saved = await saveBusinessChanges(pool, tenant, { applications, figures, assessments, offers, events, outbox });
  } catch {
    // The database's message may quote a value; it is not carried into the refusal.
    discardBook(tenant, book);
    return fail(
      'PERSISTENCE_FAILED',
      'The change could not be saved and nothing of it was written. Reload and try again',
    );
  }
  if (saved.kind === 'STALE') {
    discardBook(tenant, book);
    return fail(
      'STALE_APPLICATION',
      'The application was changed elsewhere since this screen loaded it; nothing was saved. Reload and try again',
      { applicationId: saved.applicationId },
    );
  }
  for (const r of dirty) {
    book.dirty.delete(r.application.applicationId);
    const version = saved.versions.get(r.application.applicationId);
    if (version !== undefined) r.stored = version;
  }
  book.unsavedFigures = book.unsavedFigures.filter((f) => !figures.includes(f));
  book.unsavedAssessments = book.unsavedAssessments.filter((a) => !assessments.includes(a));
  book.unsavedOffers = book.unsavedOffers.filter((o) => !offers.includes(o));
  book.unsavedEvents = book.unsavedEvents.filter((e) => !events.includes(e));
  book.unsavedOutbox = book.unsavedOutbox.filter((e) => !outbox.includes(e));
  return ok(true);
}

/** In memory there is nothing to conflict with: the queued side effects go to the in-memory outbox store as the marks are cleared. */
async function flushTenantInMemory(tenant: string): Promise<Result<true>> {
  const book = state.books.get(tenant);
  if (book === undefined) return ok(true);
  const outbox = book.unsavedOutbox;
  book.dirty.clear();
  book.unsavedFigures = [];
  book.unsavedAssessments = [];
  book.unsavedOffers = [];
  book.unsavedEvents = [];
  book.unsavedOutbox = [];
  if (outbox.length > 0) await state.outboxStore.append(outbox);
  return ok(true);
}

async function settleTenant(tenant: string): Promise<Result<true>> {
  const pool = poolOf();
  if (pool === undefined) return flushTenantInMemory(tenant);
  const settled = await flushTenant(tenant, pool);
  if (settled.ok) useDatabaseOutbox();
  return settled;
}

/**
 * Writes every tenant's pending changes, each tenant in its own transaction
 * under its lock — the outbox rows those changes caused included, so a side
 * effect is durable exactly when its cause is. Answers the first tenant's
 * refusal (STALE_APPLICATION, PERSISTENCE_FAILED) if any; never throws for a
 * database failure.
 *
 * For pages and tests. A request that changes something uses
 * `mutateBusiness`, which saves its own change before anyone else can save —
 * or drop — the book it changed.
 */
export async function flushBusiness(): Promise<Result<true>> {
  let first: Result<never> | undefined;
  for (const tenant of [...state.books.keys()]) {
    const settled = await withTenantLock(tenant, () => settleTenant(tenant));
    if (!settled.ok) first ??= settled;
  }
  return first ?? ok(true);
}

/**
 * Runs one change and saves it, as one unit under the tenant's lock: the
 * change is made on the book as loaded, and written before any other request
 * on the tenant may change, save or drop that book. The answer is the
 * change's own result once it is durable; or the domain's refusal (nothing
 * to save); or the save's refusal (STALE_APPLICATION, PERSISTENCE_FAILED —
 * see `isSettleFailure`), in which case nothing of it was written.
 */
export async function mutateBusiness<T>(tenant: TenantCode, change: () => Promise<Result<T>>): Promise<Result<T>> {
  return withTenantLock(tenant, async () => {
    const result = await change();
    if (!result.ok) return result;
    const settled = await settleTenant(tenant);
    return settled.ok ? result : settled;
  });
}

/** Loads the tenant's book (once) and writes anything pending. Awaited by pages and routes before they read. */
export async function syncBusiness(tenant: TenantCode): Promise<void> {
  await hydrate(tenant);
  // A refused batch has already been dropped and is reloaded by the next read; the page shows the current state.
  const settled = await withTenantLock(tenant, () => settleTenant(tenant));
  if (!settled.ok) await hydrate(tenant);
}

/** Notification events queued by this process (sent offers), for the operations view and tests. */
export const queuedBusinessNotifications = (): readonly OutboxEvent[] => state.outbox.events;

/** The outbox store the dispatcher reads (the database's when one is configured). */
export const businessOutboxStore = (): OutboxStore => state.outboxStore;

/**
 * Clears this process's working set. Tests only: a fresh book, seeded again on
 * next access unless `seed` is false. Never called by a screen or a route.
 */
export function resetBusinessStore(options: { readonly seed?: boolean; readonly pool?: Pool } = {}): void {
  state.books.clear();
  state.outbox = emptyOutbox();
  state.outboxStore = inMemoryOutboxStore();
  state.outboxOnDatabase = false;
  if (options.pool === undefined) delete state.pool;
  else state.pool = options.pool;
  if (options.seed === false) {
    const book = bookOf(SEED_TENANT);
    book.seeded = true;
  }
}

// =============================================================================
// Reads
// =============================================================================

export async function listApplications(tenant: TenantCode): Promise<readonly BusinessApplicationView[]> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return [];
  return [...book.records.values()]
    .map((r) => view(r, ctx.value.currency))
    .sort((a, b) =>
      a.application.receivedAtEpochSeconds > b.application.receivedAtEpochSeconds
        ? -1
        : a.application.receivedAtEpochSeconds < b.application.receivedAtEpochSeconds
          ? 1
          : 0,
    );
}

export async function getApplication(
  tenant: TenantCode,
  applicationId: string,
): Promise<BusinessApplicationView | undefined> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  const r = book.records.get(applicationId);
  return r === undefined || !ctx.ok ? undefined : view(r, ctx.value.currency);
}

function readinessOf(record: BusinessRecord, currency: CurrencyCode): FigureReadiness {
  const current = currentFigures(record);
  const present = new Set(current.map((f) => f.figure.metric));
  const missingFigures = FULL_SPREAD_METRICS.filter((m) => !present.has(m));
  const unverifiedFigures = FULL_SPREAD_METRICS.filter(
    (m) => present.has(m) && !current.some((f) => f.figure.metric === m && isVerified(f.figure)),
  );
  const spread = completeSpread(
    current.map((f) => f.figure),
    FULL_SPREAD_METRICS,
    currency,
  );
  return {
    requiredMetrics: FULL_SPREAD_METRICS,
    missingFigures,
    unverifiedFigures,
    spreadComplete: spread.ok,
    correctedCount: spread.ok ? spread.value.correctedCount : 0,
    ...(spread.ok ? { ratios: computeRatios(spread.value) } : {}),
  };
}

/** Which required figures are missing or unverified, and the ratios once the spread is complete. */
export async function figureReadiness(tenant: TenantCode, applicationId: string): Promise<Result<FigureReadiness>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  return ok(readinessOf(r, ctx.value.currency));
}

async function checklistOf(
  tenant: TenantCode,
  record: BusinessRecord,
  at: TsaInstant,
): Promise<Result<ChecklistStatus>> {
  const product = await productFor(tenant, record.application.productCode, record.application.variantCode, at);
  if (!product.ok) return product;
  const ref = product.value.variant.documentChecklistRef;
  if (ref === undefined)
    return fail('DOCUMENT_CHECKLIST_NOT_FOUND', 'The variant names no document checklist', {
      variantCode: record.application.variantCode,
    });
  const checklist = loadDocumentChecklist(tenant, ref);
  if (!checklist.ok) return checklist;
  const report = checklistReport(checklist.value, record.documents, at);
  return ok({
    checklist: checklist.value,
    report,
    complete: isChecklistComplete(report),
    missing: blockingItems(report).map((i) => i.item.documentType),
  });
}

/**
 * The conventional SME product's variants as the tenant's catalogue holds
 * them (name, limits, purposes, collateral), keyed by code — for display on
 * the pipeline screens. Empty when the product is not in the catalogue.
 */
export async function productVariants(tenant: TenantCode): Promise<ReadonlyMap<string, SmeVariant>> {
  const catalogue = await catalogueFor(tenant, developmentAttestation());
  if (!catalogue.ok) return new Map();
  const entry = catalogue.value.entries.find((e) => e.productCode === smeTermConventional.descriptor.code);
  if (entry === undefined) return new Map();
  const terms = smeTermConventional.validateTerms(entry.terms);
  return terms.ok ? new Map(terms.value.variants.map((v) => [v.code, v] as const)) : new Map();
}

/** The variant's document checklist against the documents presented, at the current attested instant. */
export async function checklistStatus(tenant: TenantCode, applicationId: string): Promise<Result<ChecklistStatus>> {
  const book = await hydrate(tenant);
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  return checklistOf(tenant, r, developmentAttestation());
}

// =============================================================================
// Stage 5: hand-over, figures, documents, inputs, submission
// =============================================================================

async function handOverAt(
  tenant: TenantCode,
  request: HandoverRequest,
  actor: string,
  at: TsaInstant,
): Promise<Result<{ readonly view: BusinessApplicationView; readonly created: boolean }>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const currency = ctx.value.currency;

  // No identity number anywhere in what was handed over — the contact and the upstream reference as much as the applicant.
  if (containsIdentityNumber(request, REGISTRATION_FIELDS, request.applicant.registrationRef))
    return fail(
      'IDENTITY_NUMBER_IN_PAYLOAD',
      'An identity number does not belong in the application record; send a reference',
    );

  // Idempotent on the upstream reference: the same hand-over twice is the same application.
  const existing = [...book.records.values()].find((r) => r.application.upstreamRef === request.upstreamRef);
  if (existing !== undefined) {
    if (existing.application.applicationId !== request.applicationId)
      return fail('UPSTREAM_REF_REUSED', 'This upstream reference already handed over a different application', {
        upstreamRef: request.upstreamRef,
      });
    return ok({ view: view(existing, currency), created: false });
  }
  if (book.records.has(request.applicationId))
    return fail(
      'APPLICATION_ID_TAKEN',
      'An application with this id was handed over under a different upstream reference',
      { applicationId: request.applicationId },
    );

  const product = await productFor(tenant, request.productCode, request.variantCode, at);
  if (!product.ok) return product;
  if (!product.value.variant.purposes.some((p) => p.code === request.purpose))
    return reject('OP-LIMIT', 'PURPOSE_NOT_ALLOWED', 'This variant does not finance that purpose', {
      variantCode: request.variantCode,
      purpose: request.purpose,
    });

  const contact: OfferNotificationRecipient = request.contact ?? {
    partyRef: request.applicant.owners[0]?.ref ?? request.applicationId,
  };
  if (!REF_SHAPE.test(contact.partyRef)) return fail('CONTACT_PARTY_REF_INVALID', 'The contact is a party reference');
  if (contact.emailMasked !== undefined && !isMaskedEmail(contact.emailMasked))
    return fail('CONTACT_EMAIL_NOT_MASKED', 'An email address is carried masked only');
  if (contact.mobileMasked !== undefined && !isMaskedMobile(contact.mobileMasked))
    return fail('CONTACT_MOBILE_NOT_MASKED', 'A mobile number is carried masked only');

  // The amount is in the tenant's currency. A stated currency is checked by the domain, never adopted.
  const stated = request.currency ?? currency;
  const t = receiveHandover(
    {
      applicationId: request.applicationId,
      upstreamRef: request.upstreamRef,
      tenantId: tenant,
      applicant: request.applicant,
      productCode: request.productCode,
      variantCode: request.variantCode,
      purpose: request.purpose,
      requested: { minorUnits: request.requestedMinorUnits, currency: stated as CurrencyCode },
      tenorMonths: request.tenorMonths,
      graceMonths: request.graceMonths,
      contributionPerTenThousand: request.contributionPerTenThousand,
    },
    currency,
    actor,
    at.epochSeconds,
  );
  if (!t.ok) return t;

  const record: BusinessRecord = {
    application: t.value.application,
    contact,
    figures: [],
    documents: [],
    security: { collateral: [], guarantees: [] },
    pack: { conditions: [], covenants: [], justifications: {} },
    closing: { cps: {} },
    servicing: { repayments: [], collections: [], bureauReports: [], lateCharges: [], restructures: [] },
    letterPdfs: [],
    assessments: [],
    offers: [],
    events: [],
  };
  book.records.set(request.applicationId, record);
  apply(book, record, t.value);
  recordEvent(book, record, {
    eventType: 'CONTACT_RECORDED',
    fromStage: null,
    toStage: null,
    actor,
    atEpochSeconds: at.epochSeconds,
    detail: {
      partyRef: contact.partyRef,
      ...(contact.emailMasked === undefined ? {} : { emailMasked: contact.emailMasked }),
      ...(contact.mobileMasked === undefined ? {} : { mobileMasked: contact.mobileMasked }),
    },
  });
  return ok({ view: view(record, currency), created: true });
}

/**
 * Receive an application from upstream at stage 5. Idempotent on
 * `upstreamRef`: a repeat returns the same application with `created: false`.
 */
export async function handOver(
  tenant: TenantCode,
  request: HandoverRequest,
  actor: string,
): Promise<Result<{ readonly view: BusinessApplicationView; readonly created: boolean }>> {
  // Starting an application is new business: the installation's licence must permit the product (ADR 0006).
  const licence = await licencePermits({ productCode: request.productCode });
  if (!licence.ok) return licence;
  return withTenantLock(tenant, () => handOverAt(tenant, request, actor, developmentAttestation()));
}

/**
 * The installation licence's answer for a new-business act (ADR 0006), as a
 * Result. Called by the hand-over, offer generation and disbursement wrappers
 * only — never by servicing, portfolio status, withdrawal or the outbox, so no
 * licence state can stop what is owed on an existing facility. The seed calls
 * the `*At` functions directly and is not gated.
 */
async function licencePermits(act: NewBusinessAct): Promise<Result<true>> {
  const refusal = await newBusinessRefusal(act);
  return refusal === undefined ? ok(true) : { ok: false, error: refusal };
}

/** The application's product and signing instant, read under the tenant's lock, for the licence gate. */
async function licenceFacts(
  tenant: TenantCode,
  applicationId: string,
): Promise<{ readonly productCode: string; readonly signedAtEpochSeconds?: bigint } | undefined> {
  const r = (await hydrate(tenant)).records.get(applicationId);
  if (r === undefined) return undefined;
  const signedAt = r.application.signature?.atEpochSeconds;
  return {
    productCode: r.application.productCode,
    ...(signedAt === undefined ? {} : { signedAtEpochSeconds: signedAt }),
  };
}

function startSpreadingIfReceived(book: TenantBook, record: BusinessRecord, actor: string, at: bigint): Result<true> {
  if (record.application.status !== 'RECEIVED') return ok(true);
  const t = startSpreading(record.application, actor, at);
  if (!t.ok) return t;
  apply(book, record, t.value);
  return ok(true);
}

const SPREAD_OPEN = new Set(['RECEIVED', 'SPREADING']);

async function proposeFiguresAt(
  tenant: TenantCode,
  applicationId: string,
  entries: readonly FigureProposalEntry[],
  actor: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  if (!SPREAD_OPEN.has(r.application.status))
    return fail('TRANSITION_NOT_ALLOWED', 'Figures are proposed only while the application is in credit assessment', {
      status: r.application.status,
    });
  if (entries.length === 0) return fail('FIGURES_EMPTY', 'Propose at least one figure');
  for (const e of entries) {
    const identity = identityNumberIn({ sourceRef: e.sourceRef, periodLabel: e.periodLabel });
    if (identity !== undefined) return identity;
  }

  // Validate every proposal before recording any: a batch is recorded whole or not at all.
  const figures: FinancialFigure[] = [];
  for (const e of entries) {
    const f = proposeFigure(
      {
        metric: e.metric,
        periodLabel: e.periodLabel,
        value: money(e.minorUnits, ctx.value.currency),
        sourceKind: e.sourceKind,
        sourceRef: e.sourceRef,
        ...(e.sourceKind === 'OFFICER_ENTRY' ? { enteredBy: actor } : {}),
        proposedAtEpochSeconds: at.epochSeconds,
      },
      ctx.value.currency,
    );
    if (!f.ok) return f;
    figures.push(f.value);
  }
  // A double submit of the same proposal is one proposal: an identical pending figure is not superseded by its twin.
  const fresh = figures.filter((figure) => !currentFigures(r).some((f) => isSamePendingProposal(f.figure, figure)));
  if (fresh.length === 0) return ok(view(r, ctx.value.currency));
  const started = startSpreadingIfReceived(book, r, actor, at.epochSeconds);
  if (!started.ok) return started;
  for (const figure of fresh) {
    // One current figure per metric: a new proposal supersedes the current one, verified or not.
    const current = currentFigures(r).find((f) => f.figure.metric === figure.metric);
    const rowId = randomUUID();
    addFigureRow(book, r, {
      rowId,
      figure,
      createdBy: figure.enteredBy ?? `${figure.sourceKind.toLowerCase()}:${figure.sourceRef}`.slice(0, 128),
      ...(current === undefined ? {} : { supersedes: current.rowId }),
    });
    recordEvent(book, r, {
      eventType: 'FIGURE_PROPOSED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at.epochSeconds,
      detail: {
        figureId: rowId,
        metric: figure.metric,
        periodLabel: figure.periodLabel,
        sourceKind: figure.sourceKind,
        ...(current === undefined ? {} : { supersedes: current.rowId }),
      },
    });
  }
  return ok(view(r, ctx.value.currency));
}

function isSamePendingProposal(existing: FinancialFigure, proposed: FinancialFigure): boolean {
  return (
    existing.status === 'PROPOSED' &&
    existing.metric === proposed.metric &&
    existing.periodLabel === proposed.periodLabel &&
    existing.proposedValue.minorUnits === proposed.proposedValue.minorUnits &&
    existing.proposedValue.currency === proposed.proposedValue.currency &&
    existing.sourceKind === proposed.sourceKind &&
    existing.sourceRef === proposed.sourceRef &&
    existing.enteredBy === proposed.enteredBy
  );
}

/**
 * Record figures keyed by the acting officer. Whatever the caller says about
 * the source, a figure submitted through the workbench is OFFICER_ENTRY with
 * `enteredBy` the acting principal, so it is verified only by someone else.
 * Not yet usable: each is verified next. A proposal for a metric that already
 * has a figure supersedes it; an identical pending proposal is a no-op.
 */
export async function proposeFigures(
  tenant: TenantCode,
  applicationId: string,
  entries: readonly OfficerFigureEntry[],
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  // Built field by field: a `sourceKind` smuggled onto an entry never reaches the recorder.
  const keyed: FigureProposalEntry[] = entries.map((e) => ({
    metric: e.metric,
    periodLabel: e.periodLabel,
    minorUnits: e.minorUnits,
    sourceRef: e.sourceRef,
    sourceKind: 'OFFICER_ENTRY',
  }));
  return withTenantLock(tenant, () => proposeFiguresAt(tenant, applicationId, keyed, actor, developmentAttestation()));
}

/**
 * The system path for figures read from a statement (OCR) or a rail. Not
 * reachable from a workbench form: the server actions do not import it, and
 * it refuses an OFFICER_ENTRY. `source` is the ingesting system's principal.
 */
export async function ingestReadFigures(
  tenant: TenantCode,
  applicationId: string,
  entries: readonly ReadFigureEntry[],
  source: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    ingestReadFiguresAt(tenant, applicationId, entries, source, developmentAttestation()),
  );
}

const READ_SOURCE_PRINCIPALS: ReadonlySet<string> = new Set(Object.values(READ_FIGURE_SOURCES));

async function ingestReadFiguresAt(
  tenant: TenantCode,
  applicationId: string,
  entries: readonly ReadFigureEntry[],
  source: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  // Only the system's own ingestion principals record a read figure: an officer (or anyone else) calling this path is refused,
  // so a figure that says it was read can never have been keyed by a person who could then verify it.
  if (!READ_SOURCE_PRINCIPALS.has(source))
    return fail(
      'FIGURE_SOURCE_PRINCIPAL_INVALID',
      'Read figures are recorded only by the statement-reading or rail-ingestion system',
    );
  const read: FigureProposalEntry[] = [];
  for (const e of entries) {
    if (e.sourceKind !== 'OCR' && e.sourceKind !== 'RAIL')
      return fail('FIGURE_SOURCE_NOT_READ', 'Only figures read from a statement or a rail enter through ingestion', {
        metric: e.metric,
      });
    read.push({
      metric: e.metric,
      periodLabel: e.periodLabel,
      minorUnits: e.minorUnits,
      sourceRef: e.sourceRef,
      sourceKind: e.sourceKind,
    });
  }
  return proposeFiguresAt(tenant, applicationId, read, source, at);
}

async function verifyFigureAt(
  tenant: TenantCode,
  applicationId: string,
  figureId: string,
  verifier: string,
  correctedMinorUnits: bigint | undefined,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  if (!SPREAD_OPEN.has(r.application.status))
    return fail('TRANSITION_NOT_ALLOWED', 'Figures are verified only while the application is in credit assessment', {
      status: r.application.status,
    });
  const row = currentFigures(r).find((f) => f.rowId === figureId);
  if (row === undefined)
    return fail('FIGURE_NOT_FOUND', 'No current figure with that id; it may have been superseded', { figureId });

  if (correctedMinorUnits !== undefined && correctedMinorUnits !== row.figure.proposedValue.minorUnits) {
    // A correction is not a verification: it is the verifier's own keyed figure, superseding the reading (both rows
    // kept), and like any keyed figure it is verified by a different principal before it is used.
    if (isVerified(row.figure))
      return fail('FIGURE_ALREADY_VERIFIED', 'A verified figure is corrected by proposing a new one', { figureId });
    const corrected = proposeFigure(
      {
        metric: row.figure.metric,
        periodLabel: row.figure.periodLabel,
        value: money(correctedMinorUnits, ctx.value.currency),
        sourceKind: 'OFFICER_ENTRY',
        sourceRef: row.figure.sourceRef,
        enteredBy: verifier,
        proposedAtEpochSeconds: at.epochSeconds,
      },
      ctx.value.currency,
    );
    if (!corrected.ok) return corrected;
    const rowId = randomUUID();
    addFigureRow(book, r, { rowId, figure: corrected.value, supersedes: row.rowId, createdBy: verifier });
    recordEvent(book, r, {
      eventType: 'FIGURE_CORRECTED',
      fromStage: null,
      toStage: null,
      actor: verifier,
      atEpochSeconds: at.epochSeconds,
      detail: { figureId: rowId, corrects: row.rowId, metric: row.figure.metric, sourceKind: 'OFFICER_ENTRY' },
    });
    return ok(view(r, ctx.value.currency));
  }

  const verified = verifyFigureCore(
    row.figure,
    { verifiedBy: verifier, verifiedAtEpochSeconds: at.epochSeconds },
    ctx.value.currency,
  );
  if (!verified.ok) return verified;
  const rowId = randomUUID();
  addFigureRow(book, r, { rowId, figure: verified.value, supersedes: row.rowId, createdBy: verifier });
  recordEvent(book, r, {
    eventType: 'FIGURE_VERIFIED',
    fromStage: null,
    toStage: null,
    actor: verifier,
    atEpochSeconds: at.epochSeconds,
    detail: {
      figureId: rowId,
      verifies: row.rowId,
      metric: verified.value.metric,
      corrected: String(verified.value.verification.correctedFromProposal),
    },
  });
  return ok(view(r, ctx.value.currency));
}

/**
 * An officer confirms or corrects a figure. A figure keyed in by an officer
 * is verified by a different officer (four eyes, core/applicant/financials.ts).
 * A correction (a different amount) is recorded as the verifier's own keyed
 * proposal, superseding the reading; a different principal then verifies it.
 */
export async function verifyFigure(
  tenant: TenantCode,
  applicationId: string,
  figureId: string,
  verifier: string,
  correctedMinorUnits?: bigint,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    verifyFigureAt(tenant, applicationId, figureId, verifier, correctedMinorUnits, developmentAttestation()),
  );
}

async function presentDocumentAt(
  tenant: TenantCode,
  applicationId: string,
  doc: { readonly documentType: string; readonly documentRef: string; readonly content?: DocumentContent },
  actor: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  if (!SPREAD_OPEN.has(r.application.status))
    return fail('TRANSITION_NOT_ALLOWED', 'Documents are presented while the application is in credit assessment', {
      status: r.application.status,
    });
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(doc.documentType))
    return fail('DOCUMENT_TYPE_INVALID', 'A document type is a checklist code');
  if (!REF_SHAPE.test(doc.documentRef))
    return fail('DOCUMENT_REF_INVALID', 'A document is presented by its reference, not its content');
  const identity = identityNumberIn({ documentRef: doc.documentRef });
  if (identity !== undefined) return identity;
  // A typed reference proves nothing about the document: it is PENDING until a different principal validates it.
  const status: BusinessDocument['validationStatus'] = 'PENDING';
  if (doc.content !== undefined && !/^[0-9a-f]{64}$/.test(doc.content.sha256Hex))
    return fail('DOCUMENT_CONTENT_INVALID', 'An uploaded document is recorded by the hash of its bytes');
  r.documents.push({
    documentType: doc.documentType,
    documentRef: doc.documentRef,
    capturedAt: at,
    validationStatus: status,
    presentedBy: actor,
    ...(doc.content === undefined ? {} : { content: doc.content }),
  });
  recordEvent(book, r, {
    eventType: 'DOCUMENT_PRESENTED',
    fromStage: null,
    toStage: null,
    actor,
    atEpochSeconds: at.epochSeconds,
    detail: {
      documentType: doc.documentType,
      documentRef: doc.documentRef,
      validationStatus: status,
      capturedAtEpoch: at.epochSeconds.toString(),
      capturedTokenDigest: at.tokenDigest,
      capturedAuthority: at.authorityId,
      ...(doc.content === undefined
        ? {}
        : {
            contentSha256: doc.content.sha256Hex,
            contentBytes: String(doc.content.byteLength),
            contentType: doc.content.mediaType,
            contentStorage: doc.content.storage,
          }),
    },
  });
  return ok(view(r, ctx.value.currency));
}

/**
 * Present a document by reference, captured at the current attested instant.
 * It is PENDING — not counted by the checklist — until validated.
 */
export async function presentDocument(
  tenant: TenantCode,
  applicationId: string,
  doc: { readonly documentType: string; readonly documentRef: string; readonly content?: DocumentContent },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => presentDocumentAt(tenant, applicationId, doc, actor, developmentAttestation()));
}

async function validateDocumentAt(
  tenant: TenantCode,
  applicationId: string,
  documentRef: string,
  decision: 'VALID' | 'INVALID',
  validator: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  if (!SPREAD_OPEN.has(r.application.status))
    return fail('TRANSITION_NOT_ALLOWED', 'Documents are validated while the application is in credit assessment', {
      status: r.application.status,
    });
  if (decision !== 'VALID' && decision !== 'INVALID')
    return fail('DOCUMENT_DECISION_INVALID', 'A document is validated as VALID or INVALID');
  const identity = identityNumberIn({ documentRef });
  if (identity !== undefined) return identity;
  const doc = [...r.documents].reverse().find((d) => d.documentRef === documentRef);
  if (doc === undefined)
    return fail('DOCUMENT_NOT_FOUND', 'No document with that reference on this application', { documentRef });
  if (doc.validationStatus !== 'PENDING')
    return fail(
      'DOCUMENT_ALREADY_VALIDATED',
      'The document has already been validated; present it again to re-check it',
      { documentRef },
    );
  if (doc.presentedBy === validator)
    return fail('FOUR_EYES_REQUIRED', 'A document is validated by a principal other than the one who presented it', {
      documentRef,
    });
  markValidated(r, documentRef, decision, validator);
  recordEvent(book, r, {
    eventType: 'DOCUMENT_VALIDATED',
    fromStage: null,
    toStage: null,
    actor: validator,
    atEpochSeconds: at.epochSeconds,
    detail: { documentType: doc.documentType, documentRef, validationStatus: decision },
  });
  return ok(view(r, ctx.value.currency));
}

/**
 * The checker's check of a presented document: VALID (it now counts toward
 * the checklist) or INVALID. Never by the principal who presented it.
 */
export async function validateDocument(
  tenant: TenantCode,
  applicationId: string,
  documentRef: string,
  decision: 'VALID' | 'INVALID',
  validator: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    validateDocumentAt(tenant, applicationId, documentRef, decision, validator, developmentAttestation()),
  );
}

const PER_TEN_THOUSAND_MAX = 100_000n;

async function recordAssessmentInputsAt(
  tenant: TenantCode,
  applicationId: string,
  entry: AssessmentInputsEntry,
  actor: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  // Locked at submission: what was scored is what was submitted, and nobody edits it between the two.
  if (!SPREAD_OPEN.has(r.application.status))
    return fail('ASSESSMENT_INPUTS_LOCKED', 'Assessment inputs are recorded only before the application is submitted', {
      status: r.application.status,
    });
  // A report fetched through the rail is the bureau result, and nothing typed overrides it.
  // Without one, the officer keys the result from the upstream report under its stage-4 consent.
  const fetched = r.bureauFetch;
  let bureau: AssessmentInputs['bureau'];
  if (fetched !== undefined) {
    bureau = {
      reportRef: fetched.reportRef,
      consentId: fetched.consentId,
      score: fetched.score,
      // The jurisdiction's bureau: AECB in the UAE, SIMAH in Saudi Arabia.
      source:
        ctx.value.profile.code === 'SA'
          ? fetched.source === 'LIVE'
            ? 'SIMAH_RAIL_LIVE'
            : 'SIMAH_RAIL_FIXTURE'
          : fetched.source === 'LIVE'
            ? 'AECB_RAIL_LIVE'
            : 'AECB_RAIL_FIXTURE',
    };
  } else {
    const keyed = entry.bureau;
    if (keyed === undefined)
      return fail('BUREAU_RESULT_REQUIRED', 'Fetch the bureau report, or key it from the upstream report');
    if (!REF_SHAPE.test(keyed.reportRef))
      return fail('BUREAU_REF_INVALID', 'The bureau report is recorded by its reference');
    if (!REF_SHAPE.test(keyed.consentId))
      return fail('BUREAU_CONSENT_MISSING', 'The bureau result is recorded with the consent id it was obtained under');
    // The consent must be one stage 4 recorded; a consent id typed here and nowhere else is not a consent.
    if (!r.application.applicant.upstreamVerificationRefs.includes(keyed.consentId))
      return fail(
        'BUREAU_CONSENT_NOT_ON_RECORD',
        'The bureau consent is not among the stage-4 verification references handed over',
      );
    if (keyed.score < 0n || keyed.score > 10_000n)
      return fail('BUREAU_SCORE_INVALID', 'The bureau score is the bureau’s own whole number');
    bureau = { ...keyed, source: 'KEYED_FROM_UPSTREAM_REPORT' };
  }
  const identity = identityNumberIn({
    bureauReportRef: bureau.reportRef,
    bureauConsentId: bureau.consentId,
    sectorPriority: entry.sectorPriority,
  });
  if (identity !== undefined) return identity;
  if (!Number.isSafeInteger(entry.fullTimeEmployees) || entry.fullTimeEmployees < 0)
    return fail('EMPLOYEES_INVALID', 'Full-time employees is a whole, non-negative count');
  if (entry.relevantExperienceYears < 0n || entry.relevantExperienceYears > 80n)
    return fail('EXPERIENCE_INVALID', 'Relevant experience is a whole number of years');
  if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(entry.sectorPriority))
    return fail('SECTOR_PRIORITY_INVALID', 'Sector priority is a code');
  for (const [name, v] of [
    ['commitmentRatioPerTenThousand', entry.commitmentRatioPerTenThousand],
    ['riskAnalysisScorePerTenThousand', entry.riskAnalysisScorePerTenThousand],
    ['portfolioRepaymentPerTenThousand', entry.portfolioRepaymentPerTenThousand],
    ['failedFilesRatePerTenThousand', entry.failedFilesRatePerTenThousand],
  ] as const) {
    if (v < 0n || v > PER_TEN_THOUSAND_MAX)
      return fail('INPUT_OUT_OF_RANGE', 'A per-ten-thousand input is between 0 and 100000', { input: name });
  }
  if (entry.collateralValueMinorUnits < 0n) return fail('COLLATERAL_NEGATIVE', 'The collateral value is not negative');
  const inputs: AssessmentInputs = {
    bureau,
    fullTimeEmployees: entry.fullTimeEmployees,
    relevantExperienceYears: entry.relevantExperienceYears,
    sectorPriority: entry.sectorPriority,
    auditedFinancialsAvailable: entry.auditedFinancialsAvailable,
    commitmentRatioPerTenThousand: entry.commitmentRatioPerTenThousand,
    riskAnalysisScorePerTenThousand: entry.riskAnalysisScorePerTenThousand,
    portfolioRepaymentPerTenThousand: entry.portfolioRepaymentPerTenThousand,
    failedFilesRatePerTenThousand: entry.failedFilesRatePerTenThousand,
    collateralValue: money(entry.collateralValueMinorUnits, ctx.value.currency),
    recordedBy: actor,
    recordedAtEpochSeconds: at.epochSeconds,
  };
  r.inputs = inputs;
  recordEvent(book, r, {
    eventType: 'ASSESSMENT_INPUTS_RECORDED',
    fromStage: null,
    toStage: null,
    actor,
    atEpochSeconds: at.epochSeconds,
    detail: {
      bureauReportRef: inputs.bureau.reportRef,
      bureauConsentId: inputs.bureau.consentId,
      bureauScore: inputs.bureau.score.toString(),
      bureauSource: inputs.bureau.source,
      fullTimeEmployees: String(inputs.fullTimeEmployees),
      relevantExperienceYears: inputs.relevantExperienceYears.toString(),
      sectorPriority: inputs.sectorPriority,
      auditedFinancialsAvailable: String(inputs.auditedFinancialsAvailable),
      commitmentRatioPerTenThousand: inputs.commitmentRatioPerTenThousand.toString(),
      riskAnalysisScorePerTenThousand: inputs.riskAnalysisScorePerTenThousand.toString(),
      portfolioRepaymentPerTenThousand: inputs.portfolioRepaymentPerTenThousand.toString(),
      failedFilesRatePerTenThousand: inputs.failedFilesRatePerTenThousand.toString(),
      collateralValueMinorUnits: inputs.collateralValue.minorUnits.toString(),
    },
  });
  return ok(view(r, ctx.value.currency));
}

/**
 * Record what the scorecard reads beyond the statements: bureau snapshot
 * (keyed manually from the stage-4 AECB report, with its reference and
 * consent id — there is no live AECB call yet), officer assessments,
 * collateral. Refused once the application is submitted.
 */
export async function recordAssessmentInputs(
  tenant: TenantCode,
  applicationId: string,
  entry: AssessmentInputsEntry,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    recordAssessmentInputsAt(tenant, applicationId, entry, actor, developmentAttestation()),
  );
}

/**
 * The consent recorded at intake for the business, of the given type, among
 * the application's verification references — or undefined when the
 * application did not come through Sanad's own intake (a partner hand-over
 * carries its own stage-4 references, which Sanad's ledger does not hold).
 */
export function intakeConsentFor(
  application: BusinessApplication,
  type: 'credit_bureau' | 'account_information',
): string | undefined {
  if (!application.upstreamRef.startsWith('intake:')) return undefined;
  const id = `${application.upstreamRef.slice('intake:'.length)}:entity:${type}`.toLowerCase();
  return application.applicant.upstreamVerificationRefs.find((r) => r.toLowerCase() === id);
}

/** Record a bureau report fetched through the rail: its summary, reference and consent, before the inputs are recorded. */
export async function recordBureauFetch(
  tenant: TenantCode,
  applicationId: string,
  fetch: Omit<BureauFetch, 'fetchedBy' | 'atEpochSeconds'>,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    const book = await hydrate(tenant);
    const ctx = tenantContext(tenant);
    if (!ctx.ok) return ctx;
    const r = book.records.get(applicationId);
    if (r === undefined) return notFound(applicationId);
    // Like the inputs it feeds: fetched only before submission, so what is scored is what was fetched.
    if (!SPREAD_OPEN.has(r.application.status))
      return fail('ASSESSMENT_INPUTS_LOCKED', 'The bureau report is fetched only before the application is submitted', {
        status: r.application.status,
      });
    if (!REF_SHAPE.test(fetch.reportRef) || !REF_SHAPE.test(fetch.consentId))
      return fail('BUREAU_REF_INVALID', 'The bureau report is recorded by its reference');
    if (!r.application.applicant.upstreamVerificationRefs.includes(fetch.consentId))
      return fail(
        'BUREAU_CONSENT_NOT_ON_RECORD',
        'The bureau consent is not among the application’s recorded consents',
      );
    const at = developmentAttestation().epochSeconds;
    r.bureauFetch = { ...fetch, fetchedBy: actor, atEpochSeconds: at };
    recordEvent(book, r, {
      eventType: 'BUREAU_REPORT_FETCHED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: {
        reportRef: fetch.reportRef,
        consentId: fetch.consentId,
        score: fetch.score.toString(),
        source: fetch.source,
        totalExposureMinorUnits: fetch.totalExposure.minorUnits.toString(),
        overdueMinorUnits: fetch.overdueAmount.minorUnits.toString(),
        worstDelinquencyDays: String(fetch.worstDelinquencyDays),
        activeFacilities: String(fetch.activeFacilities),
        defaults: String(fetch.defaults),
      },
    });
    return ok(view(r, ctx.value.currency));
  });
}

/** Record the bank-statement facts fetched through Open Finance. A new fetch replaces the last and needs confirming again. */
export async function recordBankStatementFacts(
  tenant: TenantCode,
  applicationId: string,
  facts: Omit<BankStatementFacts, 'fetchedBy' | 'atEpochSeconds' | 'confirmedBy' | 'confirmedAtEpochSeconds'>,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    const book = await hydrate(tenant);
    const ctx = tenantContext(tenant);
    if (!ctx.ok) return ctx;
    const r = book.records.get(applicationId);
    if (r === undefined) return notFound(applicationId);
    if (!SPREAD_OPEN.has(r.application.status))
      return fail('ASSESSMENT_INPUTS_LOCKED', 'Bank statements are fetched only before the application is submitted', {
        status: r.application.status,
      });
    if (!REF_SHAPE.test(facts.referenceId) || !REF_SHAPE.test(facts.consentId))
      return fail('BANK_STATEMENT_REF_INVALID', 'Bank-statement facts are recorded by the provider’s reference');
    if (!r.application.applicant.upstreamVerificationRefs.includes(facts.consentId))
      return fail(
        'ACCOUNT_CONSENT_NOT_ON_RECORD',
        'The account-information consent is not among the application’s recorded consents',
      );
    if (facts.averageMonthlyInflow.currency !== ctx.value.currency)
      return fail('BANK_STATEMENT_CURRENCY', 'Bank-statement facts are in the tenant’s currency');
    const at = developmentAttestation().epochSeconds;
    r.bankFacts = { ...facts, fetchedBy: actor, atEpochSeconds: at };
    recordEvent(book, r, {
      eventType: 'BANK_STATEMENTS_FETCHED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: {
        referenceId: facts.referenceId,
        consentId: facts.consentId,
        months: String(facts.months),
        averageMonthlyInflowMinorUnits: facts.averageMonthlyInflow.minorUnits.toString(),
        lowestMonthEndBalanceMinorUnits: facts.lowestMonthEndBalance.minorUnits.toString(),
        returnedPaymentsLast6Months: String(facts.returnedPaymentsLast6Months),
        salaryCreditsObserved: String(facts.salaryCreditsObserved),
        source: facts.source,
      },
    });
    return ok(view(r, ctx.value.currency));
  });
}

/** A second person confirms the bank-statement facts before the assessment relies on them. */
export async function confirmBankStatementFacts(
  tenant: TenantCode,
  applicationId: string,
  confirmer: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    const book = await hydrate(tenant);
    const ctx = tenantContext(tenant);
    if (!ctx.ok) return ctx;
    const r = book.records.get(applicationId);
    if (r === undefined) return notFound(applicationId);
    const facts = r.bankFacts;
    if (facts === undefined)
      return fail('BANK_STATEMENTS_NOT_FETCHED', 'Fetch the bank statements before confirming them');
    if (facts.confirmedBy !== undefined)
      return fail('BANK_STATEMENTS_ALREADY_CONFIRMED', 'These bank-statement facts are already confirmed');
    if (confirmer === facts.fetchedBy)
      return reject(
        'OP-DETERMINACY',
        'FOUR_EYES_SELF_CONFIRMATION',
        'The officer who fetched the bank statements does not confirm them',
      );
    const at = developmentAttestation().epochSeconds;
    r.bankFacts = { ...facts, confirmedBy: confirmer, confirmedAtEpochSeconds: at };
    recordEvent(book, r, {
      eventType: 'BANK_STATEMENTS_CONFIRMED',
      fromStage: null,
      toStage: null,
      actor: confirmer,
      atEpochSeconds: at,
      detail: { referenceId: facts.referenceId },
    });
    return ok(view(r, ctx.value.currency));
  });
}

/** Where the register may change: before submission, while the case is being prepared. */
function securityOpen(r: BusinessRecord): Result<true> {
  return SPREAD_OPEN.has(r.application.status)
    ? ok(true)
    : fail('SECURITY_LOCKED', 'The security register changes only before the application is submitted', {
        status: r.application.status,
      });
}

/** Evidence named on a security item is a document already on the application, uploaded or referenced. */
function evidenceOnFile(r: BusinessRecord, ref: string | undefined): Result<true> {
  if (ref === undefined || r.documents.some((d) => d.documentRef === ref)) return ok(true);
  return fail('SECURITY_EVIDENCE_NOT_ON_FILE', 'Attach the valuation or deed to the application first, then name it here');
}

/** The officer records a collateral item. It counts once a different person confirms it. */
export async function recordCollateral(
  tenant: TenantCode,
  applicationId: string,
  entry: CollateralEntry,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    recordCollateralAt(tenant, applicationId, entry, actor, developmentAttestation().epochSeconds),
  );
}

async function recordCollateralAt(
  tenant: TenantCode,
  applicationId: string,
  entry: CollateralEntry,
  actor: string,
  at: bigint,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const open = securityOpen(r);
  if (!open.ok) return open;
  const item = validateCollateralEntry(entry, ctx.value.currency, at);
  if (!item.ok) return item;
  const evidence = evidenceOnFile(r, item.value.evidenceRef);
  if (!evidence.ok) return evidence;
  const itemId = nextSecurityId('COL', r.security.collateral.length);
  r.security.collateral.push({ ...item.value, itemId, recordedBy: actor, recordedAtEpochSeconds: at });
  recordEvent(book, r, {
    eventType: 'COLLATERAL_RECORDED',
    fromStage: null,
    toStage: null,
    actor,
    atEpochSeconds: at,
    detail: {
      itemId,
      kind: item.value.kind,
      description: item.value.description,
      marketValueMinorUnits: item.value.marketValue.minorUnits.toString(),
      valuedAtEpoch: item.value.valuedAtEpochSeconds.toString(),
      valuerRef: item.value.valuerRef,
      ...(item.value.evidenceRef === undefined ? {} : { evidenceRef: item.value.evidenceRef }),
      charge: item.value.charge,
      ...(item.value.chargeRef === undefined ? {} : { chargeRef: item.value.chargeRef }),
    },
  });
  return ok(view(r, ctx.value.currency));
}

/** The officer records a guarantee: a personal one from an owner, or a corporate one. It counts once confirmed by another person. */
export async function recordGuarantee(
  tenant: TenantCode,
  applicationId: string,
  entry: GuaranteeEntry,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    recordGuaranteeAt(tenant, applicationId, entry, actor, developmentAttestation().epochSeconds),
  );
}

async function recordGuaranteeAt(
  tenant: TenantCode,
  applicationId: string,
  entry: GuaranteeEntry,
  actor: string,
  at: bigint,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const open = securityOpen(r);
  if (!open.ok) return open;
  const g = validateGuaranteeEntry(entry, r.application.applicant.owners, ctx.value.currency);
  if (!g.ok) return g;
  if (
    r.security.guarantees.some(
      (x) => x.withdrawnBy === undefined && x.guarantorKind === g.value.guarantorKind && x.guarantorRef === g.value.guarantorRef,
    )
  )
    return fail('GUARANTEE_DUPLICATE', 'This guarantor already has a guarantee on the application; withdraw it to replace it');
  const evidence = evidenceOnFile(r, g.value.deedRef);
  if (!evidence.ok) return evidence;
  const guaranteeId = nextSecurityId('GUA', r.security.guarantees.length);
  r.security.guarantees.push({ ...g.value, guaranteeId, recordedBy: actor, recordedAtEpochSeconds: at });
  recordEvent(book, r, {
    eventType: 'GUARANTEE_RECORDED',
    fromStage: null,
    toStage: null,
    actor,
    atEpochSeconds: at,
    detail: {
      itemId: guaranteeId,
      guarantorKind: g.value.guarantorKind,
      guarantorRef: g.value.guarantorRef,
      guarantorName: g.value.guarantorName,
      ...(g.value.limit.kind === 'LIMITED' ? { limitMinorUnits: g.value.limit.amount.minorUnits.toString() } : {}),
      ...(g.value.deedRef === undefined ? {} : { deedRef: g.value.deedRef }),
    },
  });
  return ok(view(r, ctx.value.currency));
}

/** A second person confirms a recorded collateral item or guarantee. A stale valuation is not confirmed. */
export async function confirmSecurityItem(
  tenant: TenantCode,
  applicationId: string,
  itemId: string,
  confirmer: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    confirmSecurityItemAt(tenant, applicationId, itemId, confirmer, developmentAttestation().epochSeconds),
  );
}

async function confirmSecurityItemAt(
  tenant: TenantCode,
  applicationId: string,
  itemId: string,
  confirmer: string,
  at: bigint,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const open = securityOpen(r);
  if (!open.ok) return open;
  const collateral = r.security.collateral.find((i) => i.itemId === itemId);
  const item = collateral ?? r.security.guarantees.find((i) => i.guaranteeId === itemId);
  if (item === undefined) return fail('SECURITY_ITEM_NOT_FOUND', 'No such item in the security register', { itemId });
  if (item.withdrawnBy !== undefined)
    return fail('SECURITY_ITEM_WITHDRAWN', 'A withdrawn item is not confirmed; record it again');
  if (item.confirmedBy !== undefined)
    return fail('SECURITY_ALREADY_CONFIRMED', 'This item is already confirmed');
  if (confirmer === item.recordedBy)
    return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_CONFIRMATION', 'Whoever recorded a security item does not confirm it');
  if (collateral !== undefined) {
    const policy = loadSecurityPolicy(tenant);
    if (!policy.ok) return policy;
    if (!valuationCurrent(collateral, policy.value, at))
      return fail('VALUATION_STALE', 'The valuation is older than the policy allows; record a current one', {
        maxValuationAgeDays: String(policy.value.maxValuationAgeDays),
      });
  }
  updateSecurityItem(r, itemId, { confirmedBy: confirmer, confirmedAtEpochSeconds: at });
  recordEvent(book, r, {
    eventType: 'SECURITY_CONFIRMED',
    fromStage: null,
    toStage: null,
    actor: confirmer,
    atEpochSeconds: at,
    detail: { itemId },
  });
  return ok(view(r, ctx.value.currency));
}

/** Withdraw an item before submission. It stays in the record, counted nowhere. Withdrawing only ever reduces cover, so one person may do it. */
export async function withdrawSecurityItem(
  tenant: TenantCode,
  applicationId: string,
  itemId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    const book = await hydrate(tenant);
    const ctx = tenantContext(tenant);
    if (!ctx.ok) return ctx;
    const r = book.records.get(applicationId);
    if (r === undefined) return notFound(applicationId);
    const open = securityOpen(r);
    if (!open.ok) return open;
    const item =
      r.security.collateral.find((i) => i.itemId === itemId) ??
      r.security.guarantees.find((i) => i.guaranteeId === itemId);
    if (item === undefined) return fail('SECURITY_ITEM_NOT_FOUND', 'No such item in the security register', { itemId });
    if (item.withdrawnBy !== undefined) return fail('SECURITY_ITEM_WITHDRAWN', 'This item is already withdrawn');
    const at = developmentAttestation().epochSeconds;
    updateSecurityItem(r, itemId, { withdrawnBy: actor });
    recordEvent(book, r, {
      eventType: 'SECURITY_WITHDRAWN',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: { itemId },
    });
    return ok(view(r, ctx.value.currency));
  });
}

export interface SecurityStatus {
  readonly position: SecurityPosition;
  /** The variant's collateral requirements as the catalogue labels them. */
  readonly labels: Readonly<Record<string, { readonly en: string; readonly ar: string }>>;
  readonly haircutsPerTenThousand: Readonly<Record<string, number>>;
  readonly maxValuationAgeDays: number;
  readonly policyRef: string;
}

async function securityOf(tenant: TenantCode, r: BusinessRecord, at: bigint): Promise<Result<SecurityStatus>> {
  const policy = loadSecurityPolicy(tenant);
  if (!policy.ok) return policy;
  const product = await productFor(tenant, r.application.productCode, r.application.variantCode, developmentAttestation());
  if (!product.ok) return product;
  const required = product.value.variant.collateral;
  return ok({
    position: securityPosition(
      r.security,
      r.application.requested,
      required.map((c) => c.code),
      r.application.applicant.owners,
      policy.value,
      at,
    ),
    labels: Object.fromEntries(required.map((c) => [c.code, { en: c.labelEn, ar: c.labelAr }])),
    haircutsPerTenThousand: policy.value.haircutsPerTenThousand,
    maxValuationAgeDays: policy.value.maxValuationAgeDays,
    policyRef: policy.value.policyRef,
  });
}

/** The register against the variant's requirements and the tenant's haircuts, at the current attested instant. */
export async function securityStatus(tenant: TenantCode, applicationId: string): Promise<Result<SecurityStatus>> {
  const book = await hydrate(tenant);
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  return securityOf(tenant, r, developmentAttestation().epochSeconds);
}

/**
 * Collateral cover for scoring. Where the confirmed register holds valued
 * collateral (a kind the policy lends against at all), the register decides,
 * and a stale valuation counts for nothing. Otherwise — a partner hand-over,
 * or only instruments such as a promissory note — the officer's keyed value.
 */
function collateralCoverageOf(tenant: TenantCode, record: BusinessRecord, at: bigint, keyed: Money): bigint {
  const requested = record.application.requested.minorUnits;
  const policy = loadSecurityPolicy(tenant);
  const confirmed = record.security.collateral.filter(
    (c) =>
      c.confirmedBy !== undefined &&
      c.withdrawnBy === undefined &&
      policy.ok &&
      policy.value.haircutsPerTenThousand[c.kind] < 10_000,
  );
  if (!policy.ok || confirmed.length === 0) return floorDiv(keyed.minorUnits * 10_000n, requested);
  const total = confirmed
    .filter((c) => valuationCurrent(c, policy.value, at))
    .reduce((sum, c) => sum + lendingValue(c, policy.value).minorUnits, 0n);
  return floorDiv(total * 10_000n, requested);
}

async function submitAt(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const readiness = readinessOf(r, ctx.value.currency);
  const checklist = await checklistOf(tenant, r, at);
  if (!checklist.ok) return checklist;
  const t = submitForAssessmentCore(
    r.application,
    {
      spreadComplete: readiness.spreadComplete,
      missingFigures: [...readiness.missingFigures, ...readiness.unverifiedFigures],
      checklistComplete: checklist.value.complete,
      missingDocuments: checklist.value.missing,
    },
    actor,
    at.epochSeconds,
  );
  if (!t.ok) return t;
  // After the figure and document gates: the inputs lock at submission and scoring needs them,
  // so a case submitted without them could never be assessed.
  if (r.inputs === undefined)
    return fail(
      'ASSESSMENT_INPUTS_MISSING',
      'Record the bureau result and the officer’s assessment inputs before submitting',
    );
  // The securities the variant requires, each recorded and confirmed by a second person.
  const security = await securityOf(tenant, r, at.epochSeconds);
  if (!security.ok) return security;
  if (!security.value.position.complete)
    return fail('SECURITY_INCOMPLETE', 'Every security the product requires is recorded and confirmed before submitting', {
      missing: security.value.position.requirements
        .filter((q) => !q.met)
        .map((q) => q.code)
        .join(','),
    });
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/** Submit for scoring: every required figure verified and every mandatory document present, or refused naming which. */
export async function submitForAssessment(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => submitAt(tenant, applicationId, actor, developmentAttestation()));
}

// =============================================================================
// Stage 6: assessment and decision
// =============================================================================

/**
 * Where each fact the fund's policy reads comes from. The derivations that
 * are a credit-policy choice rather than arithmetic are labelled ILLUSTRATIVE
 * until the fund's Credit function states its own.
 */
/** The bureau score's provenance, by how the inputs obtained it. */
const BUREAU_FACT_SOURCE: Readonly<Record<BureauSource, string>> = {
  KEYED_FROM_UPSTREAM_REPORT:
    'AECB commercial report snapshot, keyed MANUALLY from the stage-4 report (or an owner’s individual report) with its reference and consent id',
  AECB_RAIL_FIXTURE:
    'AECB commercial report fetched through the bureau rail under the business’s recorded consent — answered by the demonstration transport (FIXTURE)',
  AECB_RAIL_LIVE: 'AECB commercial report fetched through the bureau rail under the business’s recorded consent',
  SIMAH_RAIL_FIXTURE:
    'SIMAH commercial report fetched through the bureau rail under the business’s recorded consent — answered by the demonstration transport (FIXTURE)',
  SIMAH_RAIL_LIVE: 'SIMAH commercial report fetched through the bureau rail under the business’s recorded consent',
};

export const FACT_SOURCES: Readonly<Record<string, string>> = {
  bureauScore:
    'AECB commercial report snapshot, keyed MANUALLY from the stage-4 report with its reference and consent id (no live AECB call until that rail is verified)',
  dscrPerTenThousand: 'DEBT_SERVICE_COVER — verified NET_PROFIT ÷ TOTAL_DEBT_SERVICE, rounded down',
  currentRatioPerTenThousand: 'CURRENT_RATIO — verified CURRENT_ASSETS ÷ CURRENT_LIABILITIES, rounded down',
  salesGrowthPerTenThousand:
    'SALES_GROWTH — verified (ANNUAL_REVENUE − PRIOR_YEAR_REVENUE) ÷ PRIOR_YEAR_REVENUE, rounded down',
  ownerDbrPerTenThousand: 'OWNER_DEBT_BURDEN — verified MONTHLY_DEBT_OBLIGATIONS ÷ MONTHLY_GROSS_SALARY, rounded up',
  dbrBeforeLoanPerTenThousand:
    'ILLUSTRATIVE derivation — verified TOTAL_DEBT_SERVICE ÷ ANNUAL_REVENUE, rounded up (the business’s debt burden before this facility)',
  relevantExperienceYears: 'Officer assessment',
  equityContributionPerTenThousand: 'The applicant’s contribution on the application',
  sectorPriority: 'Officer assessment against the fund’s sector priority list',
  profitable: 'Verified NET_PROFIT above zero',
  auditedFinancialsAvailable: 'Officer assessment',
  yearsInOperation: 'The applicant’s years in operation as handed over (registry-verified upstream)',
  commitmentRatioPerTenThousand: 'Officer assessment',
  riskAnalysisScorePerTenThousand: 'Officer assessment',
  portfolioRepaymentPerTenThousand: 'Officer assessment',
  failedFilesRatePerTenThousand: 'Officer assessment',
  collateralCoveragePerTenThousand:
    'Confirmed security register lending value (else the keyed collateral value) ÷ requested amount, rounded down',
};

function factsFor(
  tenant: TenantCode,
  record: BusinessRecord,
  currency: CurrencyCode,
  at: bigint,
): Result<{ readonly facts: SmeAssessmentFacts; readonly ratios: readonly FinancialRatio[] }> {
  const inputs = record.inputs;
  if (inputs === undefined)
    return fail(
      'ASSESSMENT_INPUTS_MISSING',
      'Record the bureau snapshot and the officer’s assessment inputs before scoring',
    );
  const spread = completeSpread(
    currentFigures(record).map((f) => f.figure),
    FULL_SPREAD_METRICS,
    currency,
  );
  if (!spread.ok) return spread;
  const all = computeRatios(spread.value);
  const ratios: FinancialRatio[] = [];
  for (const code of ['DEBT_SERVICE_COVER', 'CURRENT_RATIO', 'SALES_GROWTH', 'OWNER_DEBT_BURDEN'] as const) {
    const r = all[code];
    if (!r.ok) return r;
    ratios.push(r.value);
  }
  const ratio = (code: FinancialRatioCode): bigint =>
    (ratios.find((x) => x.code === code) as FinancialRatio).perTenThousand;
  const value = (m: FinancialMetric): bigint => spread.value.figures[m]?.verification.value.minorUnits ?? 0n;
  const revenue = value('ANNUAL_REVENUE');
  if (revenue <= 0n)
    return fail('RATIO_DENOMINATOR_ZERO', 'The debt burden before this facility needs a positive annual revenue', {
      ratio: 'DBR_BEFORE_LOAN',
    });
  const facts: SmeAssessmentFacts = {
    bureauScore: inputs.bureau.score,
    dscrPerTenThousand: ratio('DEBT_SERVICE_COVER'),
    currentRatioPerTenThousand: ratio('CURRENT_RATIO'),
    salesGrowthPerTenThousand: ratio('SALES_GROWTH'),
    ownerDbrPerTenThousand: ratio('OWNER_DEBT_BURDEN'),
    dbrBeforeLoanPerTenThousand: ceilDiv(value('TOTAL_DEBT_SERVICE') * 10_000n, revenue),
    relevantExperienceYears: inputs.relevantExperienceYears,
    equityContributionPerTenThousand: BigInt(record.application.contributionPerTenThousand),
    sectorPriority: inputs.sectorPriority,
    profitable: value('NET_PROFIT') > 0n,
    auditedFinancialsAvailable: inputs.auditedFinancialsAvailable,
    yearsInOperation: BigInt(record.application.applicant.yearsInOperation),
    commitmentRatioPerTenThousand: inputs.commitmentRatioPerTenThousand,
    riskAnalysisScorePerTenThousand: inputs.riskAnalysisScorePerTenThousand,
    portfolioRepaymentPerTenThousand: inputs.portfolioRepaymentPerTenThousand,
    failedFilesRatePerTenThousand: inputs.failedFilesRatePerTenThousand,
    collateralCoveragePerTenThousand: collateralCoverageOf(tenant, record, at, inputs.collateralValue),
  };
  return ok({ facts, ratios });
}

async function runAssessmentAt(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  if (r.application.status !== 'SUBMITTED')
    return fail('TRANSITION_NOT_ALLOWED', `Run the assessment is not possible from ${r.application.status}`, {
      status: r.application.status,
      action: 'Run the assessment',
    });
  // The officer who keyed and submitted the case does not also score it: the checker (or the system) runs it.
  if (actor === r.application.submittedBy)
    return reject(
      'OP-DETERMINACY',
      'FOUR_EYES_SELF_ASSESSMENT',
      'The officer who submitted the application does not run its assessment',
    );
  const policy = loadSmeAssessmentPolicy(tenant);
  if (!policy.ok) return policy;
  const derived = factsFor(tenant, r, ctx.value.currency, at.epochSeconds);
  if (!derived.ok) return derived;
  // Exactly the facts the policy reads: nothing it does not declare enters the trace.
  const facts: Record<string, SmeAssessmentFacts[string]> = {};
  for (const name of Object.keys(policy.value.facts)) {
    const v = derived.value.facts[name];
    if (v !== undefined) facts[name] = v;
  }
  const assessment = assessSme(policy.value, facts, r.application.requested);
  if (!assessment.ok) return assessment;
  const assessmentId = randomUUID();
  const cumulative = assessment.value.scorecard?.cumulativeScorePerTenThousand;
  const t = recordAssessment(
    r.application,
    {
      outcome: assessment.value.outcome,
      assessmentRef: assessmentId,
      ...(assessment.value.riskLevel === undefined ? {} : { riskLevel: assessment.value.riskLevel }),
      ...(cumulative === undefined ? {} : { cumulativeScore: Number(cumulative) }),
    },
    actor,
    at.epochSeconds,
  );
  if (!t.ok) return t;
  const factSources: Record<string, string> = {};
  for (const name of Object.keys(facts)) factSources[name] = FACT_SOURCES[name] ?? 'Not mapped';
  // The bureau score's provenance is the one the inputs recorded, so each run says how its score was obtained.
  const bureauSource = r.inputs?.bureau.source;
  if ('bureauScore' in factSources && bureauSource !== undefined)
    factSources['bureauScore'] = BUREAU_FACT_SOURCE[bureauSource];
  const run: AssessmentRun = {
    assessmentId,
    assessment: assessment.value,
    facts,
    factSources,
    ratios: derived.value.ratios,
    assessedBy: actor,
    assessedAtEpochSeconds: at.epochSeconds,
  };
  r.assessments.push(run);
  book.unsavedAssessments.push({
    assessmentId,
    applicationId,
    outcome: assessment.value.outcome,
    ...(assessment.value.riskLevel === undefined ? {} : { riskLevel: assessment.value.riskLevel }),
    ...(cumulative === undefined ? {} : { cumulativeScore: Number(cumulative) }),
    policyRef: assessment.value.policyRef,
    assessedAtEpochSeconds: at.epochSeconds,
    assessedBy: actor,
    trace: { assessment: run.assessment, facts: run.facts, factSources: run.factSources, ratios: run.ratios },
  });
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/**
 * Score a submitted application against the tenant's SME assessment policy:
 * facts in bigint from the verified ratios, the bureau snapshot, years in
 * operation, contribution and collateral coverage; the full trace recorded.
 * Routes to straight-through, the committee, or a decline. Run by the
 * checker or the system, never by the officer who submitted it.
 */
export async function runAssessment(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => runAssessmentAt(tenant, applicationId, actor, developmentAttestation()));
}

// -- the decision pack (UAE M4) -----------------------------------------------

const PACK_OPEN = new Set(['ASSESSED', 'IN_COMMITTEE']);

/** The pack changes while the decision is being prepared: assessed, before any approval is recorded. */
function packOpen(r: BusinessRecord): Result<true> {
  if (!PACK_OPEN.has(r.application.status) || r.pack.frozen !== undefined)
    return fail('DECISION_PACK_LOCKED', 'The decision pack changes only between assessment and approval', {
      status: r.application.status,
    });
  if ((r.application.committeeApprovals ?? []).length > 0)
    return fail(
      'DECISION_PACK_LOCKED',
      'A committee member has approved this pack; it no longer changes, so every member approves the same one',
    );
  return ok(true);
}

const latestRun = (r: BusinessRecord): AssessmentRun | undefined => r.assessments[r.assessments.length - 1];

function deviationsFor(r: BusinessRecord): readonly Deviation[] {
  const run = latestRun(r);
  return run === undefined ? [] : deviationsOf(run.assessment.reasons, r.pack.justifications);
}

function packDigestOf(r: BusinessRecord): string {
  return packDigest({
    applicationId: r.application.applicationId,
    assessmentRef: latestRun(r)?.assessmentId ?? '',
    deviations: deviationsFor(r),
    conditions: r.pack.conditions,
    covenants: r.pack.covenants,
  });
}

/** The cap from the risk band: how many conditions and covenants the facility may carry. */
function packCapacity(r: BusinessRecord): Result<number> {
  const max = latestRun(r)?.assessment.terms?.maxConditions;
  return max === undefined
    ? fail('RISK_BAND_REQUIRED', 'The assessment placed the case in no risk band, so its conditions cannot be bounded')
    : ok(max);
}

function freezePack(book: TenantBook, r: BusinessRecord, at: bigint): void {
  if (r.application.status !== 'APPROVED' || r.pack.frozen !== undefined) return;
  const digest = packDigestOf(r);
  r.pack.frozen = { digest, atEpochSeconds: at };
  const live = <T extends { readonly withdrawnBy?: string }>(xs: readonly T[]) => xs.filter((x) => x.withdrawnBy === undefined);
  recordEvent(book, r, {
    eventType: 'DECISION_PACK_FROZEN',
    fromStage: null,
    toStage: null,
    actor: 'system',
    atEpochSeconds: at,
    detail: {
      digest,
      deviations: String(deviationsFor(r).length),
      conditions: String(live(r.pack.conditions).length),
      covenants: String(live(r.pack.covenants).length),
    },
  });
}

type PackChange = (r: BusinessRecord, book: TenantBook, at: bigint) => Result<true>;

async function changePack(
  tenant: TenantCode,
  applicationId: string,
  change: PackChange,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    const book = await hydrate(tenant);
    const ctx = tenantContext(tenant);
    if (!ctx.ok) return ctx;
    const r = book.records.get(applicationId);
    if (r === undefined) return notFound(applicationId);
    const open = packOpen(r);
    if (!open.ok) return open;
    const done = change(r, book, developmentAttestation().epochSeconds);
    if (!done.ok) return done;
    return ok(view(r, ctx.value.currency));
  });
}

const nextPackId = (prefix: 'CON' | 'COV', taken: number): string => `${prefix}-${String(taken + 1).padStart(3, '0')}`;

/** Credit attaches a condition precedent or subsequent, in both languages, within the risk band's cap. */
export async function addCondition(
  tenant: TenantCode,
  applicationId: string,
  entry: ConditionEntry,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return changePack(tenant, applicationId, (r, book, at) => {
    const policy = loadDecisionPackPolicy(tenant);
    if (!policy.ok) return policy;
    const c = validateCondition(entry, policy.value);
    if (!c.ok) return c;
    const cap = packCapacity(r);
    if (!cap.ok) return cap;
    if (attachedCount(r.pack.conditions, r.pack.covenants) >= cap.value)
      return fail('CONDITIONS_ABOVE_RISK_MAXIMUM', 'The risk band allows no more conditions and covenants', {
        maxConditions: String(cap.value),
      });
    const conditionId = nextPackId('CON', r.pack.conditions.length);
    r.pack.conditions.push({ ...c.value, conditionId, addedBy: actor, addedAtEpochSeconds: at });
    recordEvent(book, r, {
      eventType: 'CONDITION_ADDED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: {
        itemId: conditionId,
        kind: c.value.kind,
        textEn: c.value.textEn,
        textAr: c.value.textAr,
        ...(c.value.dueDaysAfterDisbursement === undefined
          ? {}
          : { dueDaysAfterDisbursement: String(c.value.dueDaysAfterDisbursement) }),
      },
    });
    return ok(true);
  });
}

/** Credit attaches a covenant from the institution's templates; the template is snapshotted as it stands. */
export async function addCovenant(
  tenant: TenantCode,
  applicationId: string,
  templateCode: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return changePack(tenant, applicationId, (r, book, at) => {
    const policy = loadDecisionPackPolicy(tenant);
    if (!policy.ok) return policy;
    const t = covenantTemplate(policy.value, templateCode);
    if (!t.ok) return t;
    if (r.pack.covenants.some((c) => c.withdrawnBy === undefined && c.template.code === templateCode))
      return fail('COVENANT_DUPLICATE', 'This covenant is already attached');
    const cap = packCapacity(r);
    if (!cap.ok) return cap;
    if (attachedCount(r.pack.conditions, r.pack.covenants) >= cap.value)
      return fail('CONDITIONS_ABOVE_RISK_MAXIMUM', 'The risk band allows no more conditions and covenants', {
        maxConditions: String(cap.value),
      });
    const covenantId = nextPackId('COV', r.pack.covenants.length);
    r.pack.covenants.push({ covenantId, template: t.value, addedBy: actor, addedAtEpochSeconds: at });
    const tpl = t.value;
    recordEvent(book, r, {
      eventType: 'COVENANT_ADDED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: {
        itemId: covenantId,
        code: tpl.code,
        kind: tpl.kind,
        ...(tpl.metric === undefined ? {} : { metric: tpl.metric }),
        ...(tpl.minimumPerTenThousand === undefined ? {} : { minimumPerTenThousand: String(tpl.minimumPerTenThousand) }),
        ...(tpl.frequency === undefined ? {} : { frequency: tpl.frequency }),
        labelEn: tpl.labelEn,
        labelAr: tpl.labelAr,
      },
    });
    return ok(true);
  });
}

/** Withdraw a condition or covenant before approval. It stays on record, attached nowhere. */
export async function withdrawPackItem(
  tenant: TenantCode,
  applicationId: string,
  itemId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return changePack(tenant, applicationId, (r, book, at) => {
    if (!withdrawPackItemIn(r, itemId, actor))
      return fail('PACK_ITEM_NOT_FOUND', 'No such condition or covenant on the pack', { itemId });
    recordEvent(book, r, {
      eventType: 'PACK_ITEM_WITHDRAWN',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: { itemId },
    });
    return ok(true);
  });
}

/** Credit states why a deviation is acceptable. A later justification replaces the earlier; every version is an event. */
export async function justifyDeviation(
  tenant: TenantCode,
  applicationId: string,
  code: string,
  text: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return changePack(tenant, applicationId, (r, book, at) => {
    if (!deviationsFor(r).some((d) => d.code === code))
      return fail('DEVIATION_NOT_FOUND', 'The assessment records no such deviation', { code });
    const t = validateJustification(text);
    if (!t.ok) return t;
    r.pack.justifications[code] = { text: t.value, by: actor, atEpochSeconds: at };
    recordEvent(book, r, {
      eventType: 'DEVIATION_JUSTIFIED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: { code, text: t.value },
    });
    return ok(true);
  });
}

export interface DecisionPackStatus {
  readonly deviations: readonly Deviation[];
  readonly conditions: readonly Condition[];
  readonly covenants: readonly Covenant[];
  readonly attached: number;
  /** Absent when the assessment placed the case in no risk band. */
  readonly maxConditions?: number;
  readonly templates: readonly { readonly code: string; readonly labelEn: string; readonly labelAr: string }[];
  readonly maxSubsequentDueDays: number;
  readonly policyRef: string;
  /** Conditions precedent the register suggests: a charge recorded as pending registration. */
  readonly suggested: readonly { readonly textEn: string; readonly textAr: string }[];
  readonly editable: boolean;
  /** The digest as the pack stands; equal to `frozen.digest` once approved, unless something changed after. */
  readonly digest: string;
  readonly frozen?: FrozenPack;
}

export async function decisionPack(tenant: TenantCode, applicationId: string): Promise<Result<DecisionPackStatus>> {
  const book = await hydrate(tenant);
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const policy = loadDecisionPackPolicy(tenant);
  if (!policy.ok) return policy;
  const cap = packCapacity(r);
  const pending = r.security.collateral.filter(
    (c) => c.withdrawnBy === undefined && c.confirmedBy !== undefined && c.charge === 'PENDING',
  );
  const already = new Set(r.pack.conditions.filter((c) => c.withdrawnBy === undefined).map((c) => c.textEn));
  return ok({
    deviations: deviationsFor(r),
    conditions: [...r.pack.conditions],
    covenants: [...r.pack.covenants],
    attached: attachedCount(r.pack.conditions, r.pack.covenants),
    ...(cap.ok ? { maxConditions: cap.value } : {}),
    templates: policy.value.covenantTemplates.map((t) => ({ code: t.code, labelEn: t.labelEn, labelAr: t.labelAr })),
    maxSubsequentDueDays: policy.value.maxSubsequentDueDays,
    policyRef: policy.value.policyRef,
    suggested: pending
      .map((c) => ({
        textEn: `Charge over ${c.description} (${c.itemId}) registered, with the registry's reference`,
        textAr: `تسجيل الرهن على ${c.description} (${c.itemId}) مع مرجع جهة التسجيل`,
      }))
      .filter((x) => !already.has(x.textEn)),
    editable: packOpen(r).ok,
    digest: packDigestOf(r),
    ...(r.pack.frozen === undefined ? {} : { frozen: r.pack.frozen }),
  });
}

/** The pack's live conditions and covenants as the offer letter states them, in both languages. */
function packConditionsForLetter(r: BusinessRecord): readonly { readonly en: string; readonly ar: string }[] {
  const conditions = r.pack.conditions
    .filter((c) => c.withdrawnBy === undefined)
    .map((c) =>
      c.kind === 'PRECEDENT'
        ? { en: `Before first drawdown: ${c.textEn}`, ar: `قبل السحب الأول: ${c.textAr}` }
        : {
            en: `Within ${String(c.dueDaysAfterDisbursement ?? 0)} days after first drawdown: ${c.textEn}`,
            ar: `خلال ${arabicIndic(String(c.dueDaysAfterDisbursement ?? 0))} يوماً من السحب الأول: ${c.textAr}`,
          },
    );
  const covenants = r.pack.covenants
    .filter((c) => c.withdrawnBy === undefined)
    .map((c) => ({ en: `Covenant: ${c.template.labelEn}`, ar: `تعهّد: ${c.template.labelAr}` }));
  return [...conditions, ...covenants];
}

const arabicIndic = (s: string): string => s.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[Number(d)] ?? d);

async function approveAt(
  tenant: TenantCode,
  applicationId: string,
  approver: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const t = approveStraightThroughCore(r.application, approver, at.epochSeconds);
  if (!t.ok) return t;
  apply(book, r, t.value);
  freezePack(book, r, at.epochSeconds);
  return ok(view(r, ctx.value.currency));
}

/** A straight-through case approved by a checker who is not the submitting officer. */
export async function approveStraightThrough(
  tenant: TenantCode,
  applicationId: string,
  approver: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => approveAt(tenant, applicationId, approver, developmentAttestation()));
}

/**
 * A committee decision. On approval the member may enter the approved amount
 * (minor units, always in the tenant's currency — never a currency from
 * input) and tenor; either left out takes the default the screen shows
 * (`committeeApprovalDefaults`). The figures are checked in the domain.
 */
export interface CommitteeDecision {
  readonly decidedBy: string;
  readonly approved: boolean;
  readonly reason: string;
  readonly approvedAmountMinorUnits?: bigint;
  readonly approvedTenorMonths?: number;
}

/**
 * The limits a committee approval is checked against: the risk band from the
 * latest assessment run on record (its terms as the tenant's credit policy
 * gave them) and the variant's bounds from the tenant's catalogue. Undefined
 * limits — no risk band on the latest run — means the application cannot be
 * approved (RISK_BAND_REQUIRED, from the domain); a missing product is the
 * product's own refusal.
 */
async function approvalLimitsFor(
  tenant: TenantCode,
  record: BusinessRecord,
  at: TsaInstant,
): Promise<Result<ApprovalLimits | undefined>> {
  const app = record.application;
  const product = await productFor(tenant, app.productCode, app.variantCode, at);
  if (!product.ok) return product;
  const run = record.assessments[record.assessments.length - 1];
  const band = run?.assessment.terms;
  const level = run?.assessment.riskLevel;
  if (
    run === undefined ||
    band === undefined ||
    level === undefined ||
    run.assessmentId !== app.assessment?.assessmentRef
  )
    return ok(undefined);
  const v = product.value.variant;
  return ok({
    riskLevel: level,
    riskBandMaxAmount: band.maxFinancing,
    riskBandMinContributionPerTenThousand: band.minEquityContributionPerTenThousand,
    variantCode: v.code,
    minAmount: product.value.terms.minAmount,
    variantMaxAmount: v.maxAmount,
    variantMinMonths: v.minMonths,
    variantMaxMonths: v.maxMonths,
    variantMinContributionPerTenThousand: v.minContributionPerTenThousand,
    variantMaxContributionPerTenThousand: v.maxContributionPerTenThousand,
  });
}

/** What the committee screen pre-fills, and the limits it states beside the inputs. Computed here, never in the page. */
export interface CommitteeApprovalDefaults {
  readonly amount: Money;
  readonly tenorMonths: number;
  readonly limits: ApprovalLimits;
  /** The tenant's delegation of authority for these terms: how many different members must approve. */
  readonly approvalsRequired: number;
  /** Approvals already recorded; when there are any, the terms above are theirs and a further approval concurs. */
  readonly approvals: readonly CommitteeApproval[];
}

/** How many approvals the tenant's delegation of authority needs for `amount` in `riskLevel`; a policy that does not load is the policy's refusal. */
function approvalsRequiredFor(tenant: TenantCode, amount: Money, riskLevel: string): Result<number> {
  const policy = loadSmeAssessmentPolicy(tenant);
  if (!policy.ok) return policy;
  return ok(committeeApprovalsRequired(policy.value.delegationOfAuthority, amount, riskLevel));
}

/**
 * The committee screen's defaults for an application in committee: the lower
 * of the requested amount and the risk band's maximum, the lower of the
 * requested tenor and the variant's maximum. Undefined when there is nothing
 * to default from (not in committee, or no risk band).
 */
export async function committeeApprovalDefaults(
  tenant: TenantCode,
  applicationId: string,
): Promise<CommitteeApprovalDefaults | undefined> {
  const book = await hydrate(tenant);
  const r = book.records.get(applicationId);
  if (r === undefined || r.application.status !== 'IN_COMMITTEE') return undefined;
  const limits = await approvalLimitsFor(tenant, r, developmentAttestation());
  if (!limits.ok || limits.value === undefined) return undefined;
  const approvals = r.application.committeeApprovals ?? [];
  const first = approvals[0];
  const terms =
    first === undefined
      ? defaultApprovedTerms(r.application, limits.value)
      : { amount: first.amount, tenorMonths: first.tenorMonths };
  const required = approvalsRequiredFor(tenant, terms.amount, limits.value.riskLevel);
  if (!required.ok) return undefined;
  return { ...terms, limits: limits.value, approvalsRequired: required.value, approvals };
}

async function decideAt(
  tenant: TenantCode,
  applicationId: string,
  decision: CommitteeDecision,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  // A decline needs no limits; an approval is checked against them (in the domain, after four eyes and the reason).
  let limits: ApprovalLimits | undefined;
  let approvalsRequired: number | undefined;
  const currency = ctx.value.currency;
  if (decision.approved && r.application.status === 'IN_COMMITTEE') {
    const found = await approvalLimitsFor(tenant, r, at);
    if (!found.ok) return found;
    limits = found.value;
    if (limits !== undefined) {
      // The quorum for the amount being approved: the member's figure, else the default the domain will take.
      const amount =
        decision.approvedAmountMinorUnits === undefined
          ? defaultApprovedTerms(r.application, limits).amount
          : money(decision.approvedAmountMinorUnits, currency);
      const required = approvalsRequiredFor(tenant, amount, limits.riskLevel);
      if (!required.ok) return required;
      approvalsRequired = required.value;
    }
  }
  const t = decideInCommitteeCore(
    r.application,
    {
      decidedBy: decision.decidedBy,
      approved: decision.approved,
      reason: decision.reason,
      terms: {
        ...(decision.approvedAmountMinorUnits === undefined
          ? {}
          : { amount: money(decision.approvedAmountMinorUnits, currency) }),
        ...(decision.approvedTenorMonths === undefined ? {} : { tenorMonths: decision.approvedTenorMonths }),
      },
    },
    at.epochSeconds,
    {
      tenantCurrency: currency,
      ...(limits === undefined ? {} : { limits }),
      ...(approvalsRequired === undefined ? {} : { approvalsRequired }),
    },
  );
  if (!t.ok) return t;
  // After the domain's own checks (status, four eyes, reason, limits), so their refusals come first.
  if (decision.approved) {
    const deviations = deviationsFor(r);
    const unjustified = deviations.filter((d) => d.justification === undefined).map((d) => d.code);
    if (unjustified.length > 0)
      return fail('DEVIATIONS_UNJUSTIFIED', 'Every deviation from policy is justified in the decision pack before approval', {
        deviations: unjustified.join(','),
      });
    // Whoever argued for an exception does not also approve it.
    if (deviations.some((d) => d.justification?.by === decision.decidedBy))
      return reject(
        'OP-DETERMINACY',
        'FOUR_EYES_SELF_JUSTIFICATION',
        'A committee member who justified a deviation does not approve the case',
      );
  }
  apply(book, r, t.value);
  freezePack(book, r, at.epochSeconds);
  return ok(view(r, currency));
}

async function recordCreditNotesAt(
  tenant: TenantCode,
  applicationId: string,
  recordedBy: string,
  text: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const t = recordCreditNotesCore(r.application, { recordedBy, text }, at.epochSeconds);
  if (!t.ok) return t;
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/** The analyst's credit report notes for the committee; each version is kept in the event log. */
export async function recordCreditNotes(
  tenant: TenantCode,
  applicationId: string,
  recordedBy: string,
  text: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    recordCreditNotesAt(tenant, applicationId, recordedBy, text, developmentAttestation()),
  );
}

/**
 * The credit committee's decision, by a member who is not the submitting
 * officer, with its reason; an approval records the approved amount and tenor
 * (the request stays as it was).
 */
export async function decideInCommittee(
  tenant: TenantCode,
  applicationId: string,
  decision: CommitteeDecision,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => decideAt(tenant, applicationId, decision, developmentAttestation()));
}

// =============================================================================
// Stage 7: offer, send, sign, disburse
// =============================================================================

export interface OfferOptions {
  /** ISO dates. Defaults: disbursement 14 days after the offer date; first due the 1st of a month at least 15 days later. ILLUSTRATIVE. */
  readonly disbursementDate?: string;
  readonly firstDueDate?: string;
  readonly paymentDay?: number;
}

async function generateOfferAt(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
  options: OfferOptions,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const app = r.application;
  // Once sent, a new letter version may still be generated (a resend needs one); signed and later, no.
  if (app.status !== 'APPROVED' && app.status !== 'OFFER_SENT')
    return fail('TRANSITION_NOT_ALLOWED', `Generate the offer is not possible from ${app.status}`, {
      status: app.status,
      action: 'Generate the offer',
    });
  // The offer is on what was approved, never on what was requested (they differ when the committee approved less).
  const approved = approvedTermsOf(app);
  if (approved === undefined) return fail('APPROVED_TERMS_MISSING', 'The application carries no approved terms');
  const facility = approved.amount;
  if (app.requested.currency !== ctx.value.currency || facility.currency !== ctx.value.currency)
    return fail('CURRENCY_NOT_TENANTS', 'The application is not in the tenant’s base currency');

  const product = await productFor(tenant, app.productCode, app.variantCode, at);
  if (!product.ok) return product;
  const spread = completeSpread(
    currentFigures(r).map((f) => f.figure),
    FULL_SPREAD_METRICS,
    ctx.value.currency,
  );
  if (!spread.ok) return spread;
  const inputs = r.inputs;
  if (inputs === undefined)
    return fail(
      'ASSESSMENT_INPUTS_MISSING',
      'The size classification needs the employee count from the assessment inputs',
    );
  const business = toBusinessFacts(spread.value, {
    fullTimeEmployees: inputs.fullTimeEmployees,
    sector: app.applicant.sector,
  });
  if (!business.ok) return business;
  const definition = loadSmeDefinition(ctx.value.profile.code);
  if (!definition.ok) return definition;

  const datePolicy = loadOfferDatePolicy(tenant);
  if (!datePolicy.ok) return datePolicy;
  const offerDate = localDate(at.epochSeconds, ctx.value.profile);
  const offerDays = daysOfIso(offerDate) ?? 0n;
  const disbursementDate =
    options.disbursementDate ?? isoOfDays(offerDays + datePolicy.value.defaultDisbursementAfterOfferDays);
  const firstDueDate =
    options.firstDueDate ?? defaultFirstDue(disbursementDate, datePolicy.value.minFirstDueAfterDisbursementDays);
  const paymentDay = options.paymentDay ?? Number(firstDueDate.slice(8, 10));
  const validUntil = isoOfDays(offerDays + datePolicy.value.offerValidityDays);
  const dates = checkOfferDates(datePolicy.value, offerDate, disbursementDate, firstDueDate);
  if (!dates.ok) return dates;
  const tenorDays = approved.tenorMonths * 30;

  // A benchmark-linked product (the Saudi SME products: SAIBOR + margin) is priced from the published benchmark;
  // without it the quote is refused, never priced from a stale or guessed rate.
  const rule = product.value.entry.pricingRule;
  const benchmark = rule.kind === 'BENCHMARK_PLUS_MARGIN' ? await publishedBenchmark(tenant, rule.benchmarkCode, at) : undefined;
  const pricing = resolvePricingInputs(rule, {
    principal: facility,
    tenorDays,
    asOfEpochSeconds: at.epochSeconds,
    ...(benchmark === undefined ? {} : { benchmark }),
  });
  if (!pricing.ok) return pricing;
  // The module's "requested" amount and tenor are what the institution offers: the approved terms.
  const module = product.value.module;
  const quote = (module.quote as (t: unknown, r: Parameters<typeof smeTermConventional.quote>[1]) => ReturnType<typeof smeTermConventional.quote> | ReturnType<typeof smeTermIslamic.quote>)(product.value.terms, {
    tenantId: tenant,
    programmeId: product.value.variant.documentChecklistRef ?? 'sme-direct-lending',
    counterpartyId: app.applicationId,
    requestedAmount: facility,
    requestedTenorDays: tenorDays,
    asOf: at,
    pricing: pricing.value,
    regulatory: { smeDefinition: definition.value },
    affordability: { business: business.value },
    preferences: {
      variant: app.variantCode,
      purpose: app.purpose,
      graceMonths: String(app.graceMonths),
      contributionPerTenThousand: String(app.contributionPerTenThousand),
      yearsInOperation: String(app.applicant.yearsInOperation),
      disbursementDate,
      firstDueDate,
      paymentDay: String(paymentDay),
    },
  });
  if (!quote.ok) return quote;
  const q = quote.value;
  const offer = buildOffer(module as typeof smeTermConventional, q as never, at);
  if (!offer.ok) return offer;

  // A term loan charges interest on the facility; a Tawarruq sells a commodity for a deferred price, its profit the charge.
  const islamic = 'deferredSalePrice' in q;
  const totalCharge = islamic ? q.profitAmount : q.interestAmount;
  const totalPayable = islamic ? q.deferredSalePrice : money(facility.minorUnits + totalCharge.minorUnits, facility.currency);
  const letter = buildOfferLetter({
    jurisdiction: { code: ctx.value.profile.code, contractualCalendars: ctx.value.profile.contractualCalendars },
    applicationReference: app.applicationId,
    applicantBusinessName: {
      en: app.applicant.businessNameEn,
      ar: app.applicant.businessNameAr ?? app.applicant.businessNameEn,
    },
    productVariantName: { en: q.variantNameEn, ar: q.variantNameAr },
    family: module.descriptor.family,
    facilityAmount: facility,
    tenorMonths: q.months,
    graceMonths: q.graceMonths,
    rateBp: q.rateSnapshot.rate.bp,
    // The APR the platform computed (core/pricing/apr.ts via buildOffer); the letter states it, never computes it.
    aprBp: offer.value.apr.bp,
    equityContributionPerTenThousand: BigInt(q.contributionPerTenThousand),
    offerDate,
    validUntil,
    totals: {
      instalment: q.monthlyInstalment,
      totalCharge,
      totalPayable,
    },
    institutionLegalName: { en: ctx.value.legalNameEn, ar: ctx.value.legalNameAr },
    signatories: [
      { party: 'LENDER', role: { en: 'Authorised Signatory', ar: 'المفوّض بالتوقيع' } },
      islamic
        ? { party: 'BORROWER', role: { en: 'Authorised Signatory of the Customer (Purchaser)', ar: 'المفوّض بالتوقيع عن العميل (المشتري)' } }
        : { party: 'BORROWER', role: { en: 'Authorised Signatory of the Borrower', ar: 'المفوّض بالتوقيع عن المقترض' } },
    ],
    conditions: [...q.collateral.map((c) => ({ en: c.labelEn, ar: c.labelAr })), ...packConditionsForLetter(r)],
  }, ummAlQura);
  if (!letter.ok) return letter;

  const terms: OfferTerms = {
    productCode: app.productCode,
    variantCode: app.variantCode,
    months: q.months,
    graceMonths: q.graceMonths,
    facilityAmount: facility,
    monthlyInstalment: q.monthlyInstalment,
    totalInterest: totalCharge,
    totalPayable,
    rateBp: q.rateSnapshot.rate.bp,
    rateBasis: q.rateSnapshot.rate.basis,
    ratePeriod: q.rateSnapshot.rate.period,
    rateSourceRef: q.rateSnapshot.sourceRef,
    aprBp: offer.value.apr.bp,
    disbursementDate,
    firstDueDate,
    paymentDay,
    offerDate,
    validUntil,
  };
  // The same letter twice is one version: the hash is the identity.
  const already = r.offers.find((o) => o.letter.version === letter.value.version);
  if (already === undefined) {
    const offerId = randomUUID();
    const run: OfferRun = {
      offerId,
      letter: letter.value,
      terms,
      schedule: q.datedSchedule,
      createdBy: actor,
      createdAtEpochSeconds: at.epochSeconds,
    };
    r.offers.push(run);
    book.unsavedOffers.push({
      offerId,
      applicationId,
      letterVersion: letter.value.version,
      currency: facility.currency,
      facilityMinorUnits: facility.minorUnits,
      createdBy: actor,
      letter: { letter: run.letter, terms: run.terms, createdAtEpochSeconds: run.createdAtEpochSeconds },
      schedule: run.schedule,
    });
    recordEvent(book, r, {
      eventType: 'OFFER_GENERATED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at.epochSeconds,
      detail: { letterVersion: letter.value.version, offerId },
    });
  }
  return ok(view(r, ctx.value.currency));
}

/**
 * Quote the approved application through the conventional SME module with
 * the tenant's catalogue entry and the dated ACT/365 schedule, and build the
 * bilingual Facility Offer Letter. Its content hash is its version.
 */
export async function generateOffer(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
  options: OfferOptions = {},
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    // A new offer is new business: the installation's licence must permit the product (ADR 0006).
    const facts = await licenceFacts(tenant, applicationId);
    if (facts !== undefined) {
      const licence = await licencePermits({ productCode: facts.productCode });
      if (!licence.ok) return licence;
    }
    return generateOfferAt(tenant, applicationId, actor, options, developmentAttestation());
  });
}

function latestOfferOf(r: BusinessRecord): Result<OfferRun> {
  const latest = r.offers[r.offers.length - 1];
  return latest === undefined ? fail('OFFER_NOT_GENERATED', 'Generate the offer letter first') : ok(latest);
}

/** Exactly what `sendOffer` would send: the email and SMS for the latest letter, to masked recipients. */
export async function previewNotifications(
  tenant: TenantCode,
  applicationId: string,
): Promise<Result<OfferNotifications>> {
  const book = await hydrate(tenant);
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const latest = latestOfferOf(r);
  if (!latest.ok) return latest;
  return previewOfferNotifications(latest.value.letter, r.contact);
}

async function sendOfferAt(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const latest = latestOfferOf(r);
  if (!latest.ok) return latest;
  const letter = latest.value.letter;
  // The same letter version, already sent: a second 'Confirm & Send' is a no-op, never a second notification.
  if (r.application.status === 'OFFER_SENT' && r.application.offer?.letterVersion === letter.version)
    return ok(view(r, ctx.value.currency));
  const notices = buildOfferNotifications(letter, r.contact);
  if (!notices.ok) return notices;
  const channels = [
    ...(notices.value.email === undefined ? [] : ['EMAIL']),
    ...(notices.value.sms === undefined ? [] : ['SMS']),
  ];
  const t = recordOfferSent(r.application, { letterVersion: letter.version, channels }, actor, at.epochSeconds);
  if (!t.ok) return t;

  // The send is an external side effect: queued on the outbox, keyed on the letter version so one version is sent once.
  const queued = queueSideEffects([
    {
      eventId: randomUUID(),
      tenantId: tenant,
      kind: 'NOTIFICATION',
      subjectRef: applicationId,
      idempotencyKey: `${applicationId}:offer:${letter.version}`,
      correlationId: applicationId,
      payload: {
        recipientKind: 'COUNTERPARTY',
        recipientRef: r.contact.partyRef,
        event: 'OFFER_ISSUED',
        channels: channels.join(','),
        letterReference: letter.reference,
        letterVersion: letter.version,
      },
    },
  ]);
  if (!queued.ok) return queued;
  commitSideEffects(book, queued.value);
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/**
 * Validate a batch of side effects against everything this process has
 * queued, without recording any: the caller commits them together with the
 * state change, or not at all.
 */
function queueSideEffects(events: readonly OutboxEvent[]): Result<Outbox> {
  let outbox = state.outbox;
  for (const e of events) {
    const next = enqueue(outbox, e);
    if (!next.ok) return next;
    outbox = next.value;
  }
  return ok(outbox);
}

/** Record validated side effects: on the process's outbox, and on the book so the next flush writes them in the same transaction as the change. */
function commitSideEffects(book: TenantBook, outbox: Outbox): void {
  const known = new Set(state.outbox.events.map((e) => e.eventId));
  const added = outbox.events.filter((e) => !known.has(e.eventId));
  state.outbox = outbox;
  book.unsavedOutbox.push(...added);
}

/**
 * Send the latest letter: records OFFER_SENT with the channels used and
 * queues an OFFER_ISSUED notification on the transactional outbox (written in
 * the same transaction as the send); the delivery adapter resolves the
 * destination from the party reference. Sending the same letter version again
 * is a no-op; a resend needs a new letter version.
 */
export async function sendOffer(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => sendOfferAt(tenant, applicationId, actor, developmentAttestation()));
}

// -- closing (UAE M5a): signing, conditions precedent, payee ------------------

/** Between approval and disbursement: the window in which closing steps are recorded. */
const CLOSING_OPEN = new Set(['APPROVED', 'OFFER_SENT', 'SIGNED']);

/** The payee may also be corrected after disbursement, while a tranche's payment has failed. */
function payeeOpen(r: BusinessRecord): Result<true> {
  if (r.application.status === 'DISBURSED' && (r.closing.tranches ?? []).some((t) => t.status === 'FAILED')) return ok(true);
  return closingOpen(r);
}

function closingOpen(r: BusinessRecord): Result<true> {
  return CLOSING_OPEN.has(r.application.status)
    ? ok(true)
    : fail('CLOSING_LOCKED', 'Closing steps are recorded between approval and disbursement', {
        status: r.application.status,
      });
}

/** The live conditions precedent of the pack the decision froze. */
const conditionsPrecedent = (r: BusinessRecord): readonly Condition[] =>
  r.pack.conditions.filter((c) => c.kind === 'PRECEDENT' && c.withdrawnBy === undefined);

/** Conditions precedent not yet evidenced and verified by a second person. */
export function outstandingConditionsPrecedent(view: BusinessApplicationView): readonly Condition[] {
  return view.pack.conditions.filter(
    (c) => c.kind === 'PRECEDENT' && c.withdrawnBy === undefined && view.closing.cps[c.conditionId]?.verifiedBy === undefined,
  );
}

type ClosingChange = (r: BusinessRecord, book: TenantBook, ctx: TenantContext, at: bigint) => Promise<Result<true>> | Result<true>;

async function closingChangeAt(
  tenant: TenantCode,
  applicationId: string,
  at: bigint,
  change: ClosingChange,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const done = await change(r, book, ctx.value, at);
  if (!done.ok) return done;
  return ok(view(r, ctx.value.currency));
}

const closingChange = (tenant: TenantCode, applicationId: string, change: ClosingChange) =>
  withTenantLock(tenant, () => closingChangeAt(tenant, applicationId, developmentAttestation().epochSeconds, change));

/** A signing intent opened at the identity service, on the letter version that was sent. */
export async function recordSigningStarted(
  tenant: TenantCode,
  applicationId: string,
  started: { readonly transactionRef: string; readonly letterVersion: string; readonly expiresAtEpochSeconds: bigint; readonly source: 'LIVE' | 'FIXTURE' },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, _ctx, at) => {
    if (r.application.status !== 'OFFER_SENT')
      return fail('TRANSITION_NOT_ALLOWED', 'Signing opens once the offer has been sent', { status: r.application.status });
    if (started.letterVersion !== r.application.offer?.letterVersion)
      return fail('SIGNED_LETTER_NOT_SENT_LETTER', 'Signing is opened on the letter version that was sent');
    if (!REF_SHAPE.test(started.transactionRef))
      return fail('SIGNING_REF_INVALID', 'The identity service returned no usable reference; nothing was recorded');
    r.closing.signing = { ...started, startedBy: actor };
    recordEvent(book, r, {
      eventType: 'SIGNING_STARTED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: {
        transactionRef: started.transactionRef,
        letterVersion: started.letterVersion,
        expiresAtEpoch: started.expiresAtEpochSeconds.toString(),
        source: started.source,
      },
    });
    return ok(true);
  });
}

/** The signing intent ended without a signature (refused, cancelled, expired): it is cleared so a new one can open. */
export async function recordSigningEnded(
  tenant: TenantCode,
  applicationId: string,
  code: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, _ctx, at) => {
    if (r.closing.signing === undefined) return fail('SIGNING_NOT_STARTED', 'No signing is in progress');
    delete r.closing.signing;
    recordEvent(book, r, { eventType: 'SIGNING_ENDED', fromStage: null, toStage: null, actor, atEpochSeconds: at, detail: { code } });
    return ok(true);
  });
}

/**
 * The identity service confirmed the signature: the application is SIGNED on
 * the letter version the intent was opened on, and the signer's assertion is
 * recorded by reference. An intent past its window signs nothing.
 */
export async function recordSignatureConfirmed(
  tenant: TenantCode,
  applicationId: string,
  signer: SignerRecord,
  actor: string,
  /** The identity service's prefix on the signature reference: uaepass, nafath. */
  railPrefix: 'uaepass' | 'nafath' = 'uaepass',
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    const book = await hydrate(tenant);
    const ctx = tenantContext(tenant);
    if (!ctx.ok) return ctx;
    const r = book.records.get(applicationId);
    if (r === undefined) return notFound(applicationId);
    const signing = r.closing.signing;
    if (signing === undefined) return fail('SIGNING_NOT_STARTED', 'Open the signing first');
    const at = developmentAttestation();
    if (at.epochSeconds > signing.expiresAtEpochSeconds)
      return fail('SIGNING_EXPIRED', 'The signing window has passed; open a new one');
    if (!REF_SHAPE.test(signer.assertionId) || !REF_SHAPE.test(signer.identityRef))
      return fail('SIGNING_REF_INVALID', 'The identity service returned no usable reference; nothing was recorded');
    const signed = await signAt(
      tenant,
      applicationId,
      { letterVersion: signing.letterVersion, signatureRef: `${railPrefix}:${signer.assertionId}` },
      actor,
      at,
    );
    if (!signed.ok) return signed;
    delete r.closing.signing;
    r.closing.signer = signer;
    recordEvent(book, r, {
      eventType: 'SIGNER_VERIFIED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at.epochSeconds,
      detail: { assertionId: signer.assertionId, identityRef: signer.identityRef, source: signer.source },
    });
    return ok(view(r, ctx.value.currency));
  });
}

async function satisfyConditionAt(
  tenant: TenantCode,
  applicationId: string,
  conditionId: string,
  evidenceRef: string,
  actor: string,
  at: bigint,
): Promise<Result<BusinessApplicationView>> {
  return closingChangeAt(tenant, applicationId, at, (r, book) => {
    const open = closingOpen(r);
    if (!open.ok) return open;
    if (!conditionsPrecedent(r).some((c) => c.conditionId === conditionId))
      return fail('CONDITION_NOT_FOUND', 'No such condition precedent on the approved pack', { conditionId });
    if (r.closing.cps[conditionId]?.verifiedBy !== undefined)
      return fail('CONDITION_ALREADY_VERIFIED', 'This condition precedent is already verified');
    const evidence = evidenceOnFile(r, evidenceRef);
    if (!evidence.ok) return evidence;
    if (!REF_SHAPE.test(evidenceRef)) return fail('SECURITY_EVIDENCE_NOT_ON_FILE', 'Name the evidence document on the application');
    r.closing.cps[conditionId] = { evidenceRef, satisfiedBy: actor, satisfiedAtEpochSeconds: at };
    recordEvent(book, r, {
      eventType: 'CP_SATISFIED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: { conditionId, evidenceRef },
    });
    return ok(true);
  });
}

/** The officer evidences a condition precedent with a document on the application. */
export async function satisfyCondition(
  tenant: TenantCode,
  applicationId: string,
  conditionId: string,
  evidenceRef: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    satisfyConditionAt(tenant, applicationId, conditionId, evidenceRef, actor, developmentAttestation().epochSeconds),
  );
}

async function verifyConditionAt(
  tenant: TenantCode,
  applicationId: string,
  conditionId: string,
  verifier: string,
  at: bigint,
): Promise<Result<BusinessApplicationView>> {
  return closingChangeAt(tenant, applicationId, at, (r, book) => {
    const open = closingOpen(r);
    if (!open.ok) return open;
    const cp = r.closing.cps[conditionId];
    if (cp === undefined) return fail('CONDITION_NOT_SATISFIED', 'Evidence this condition precedent first');
    if (cp.verifiedBy !== undefined) return fail('CONDITION_ALREADY_VERIFIED', 'This condition precedent is already verified');
    if (verifier === cp.satisfiedBy)
      return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_CONFIRMATION', 'Whoever evidenced a condition does not verify it');
    r.closing.cps[conditionId] = { ...cp, verifiedBy: verifier };
    recordEvent(book, r, {
      eventType: 'CP_VERIFIED',
      fromStage: null,
      toStage: null,
      actor: verifier,
      atEpochSeconds: at,
      detail: { conditionId },
    });
    return ok(true);
  });
}

/** A second person verifies the evidence for a condition precedent. */
export async function verifyCondition(
  tenant: TenantCode,
  applicationId: string,
  conditionId: string,
  verifier: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    verifyConditionAt(tenant, applicationId, conditionId, verifier, developmentAttestation().epochSeconds),
  );
}

async function recordPayeeAt(
  tenant: TenantCode,
  applicationId: string,
  entry: { readonly iban: string; readonly accountName: string; readonly evidenceRef: string },
  actor: string,
  at: bigint,
): Promise<Result<BusinessApplicationView>> {
  return closingChangeAt(tenant, applicationId, at, (r, book, ctx) => {
    const open = payeeOpen(r);
    if (!open.ok) return open;
    const iban = validateIban(entry.iban, ctx.profile.code);
    if (!iban.ok) return iban;
    const name = entry.accountName.trim();
    if (name.length < 2 || name.length > 140) return fail('PAYEE_NAME_INVALID', 'Give the account holder’s name, 2 to 140 characters');
    if (identityNumberIn({ accountName: name }) !== undefined)
      return fail('IDENTITY_NUMBER_IN_FREE_TEXT', 'No identity number belongs in a payee record');
    const evidence = evidenceOnFile(r, entry.evidenceRef);
    if (!evidence.ok) return evidence;
    r.closing.payee = { iban: iban.value, accountName: name, evidenceRef: entry.evidenceRef, recordedBy: actor, recordedAtEpochSeconds: at };
    recordEvent(book, r, {
      eventType: 'PAYEE_RECORDED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: { iban: iban.value, accountName: name, evidenceRef: entry.evidenceRef },
    });
    return ok(true);
  });
}

/** The officer records the account the facility is paid into, proven by a document on the application. A new record needs confirming again. */
export async function recordPayee(
  tenant: TenantCode,
  applicationId: string,
  entry: { readonly iban: string; readonly accountName: string; readonly evidenceRef: string },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => recordPayeeAt(tenant, applicationId, entry, actor, developmentAttestation().epochSeconds));
}

async function confirmPayeeAt(
  tenant: TenantCode,
  applicationId: string,
  confirmer: string,
  at: bigint,
): Promise<Result<BusinessApplicationView>> {
  return closingChangeAt(tenant, applicationId, at, (r, book) => {
    const open = payeeOpen(r);
    if (!open.ok) return open;
    const payee = r.closing.payee;
    if (payee === undefined) return fail('PAYEE_NOT_RECORDED', 'Record the payee account first');
    if (payee.confirmedBy !== undefined) return fail('PAYEE_ALREADY_CONFIRMED', 'The payee account is already confirmed');
    if (confirmer === payee.recordedBy)
      return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_CONFIRMATION', 'Whoever recorded the payee account does not confirm it');
    r.closing.payee = { ...payee, confirmedBy: confirmer };
    recordEvent(book, r, {
      eventType: 'PAYEE_CONFIRMED',
      fromStage: null,
      toStage: null,
      actor: confirmer,
      atEpochSeconds: at,
      detail: { ibanMasked: maskIban(payee.iban) },
    });
    return ok(true);
  });
}

/** A second person confirms the payee account against its evidence. */
export async function confirmPayee(
  tenant: TenantCode,
  applicationId: string,
  confirmer: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => confirmPayeeAt(tenant, applicationId, confirmer, developmentAttestation().epochSeconds));
}

/** The most tranches a facility is drawn in. */
const MAX_TRANCHES = 12;

/** The letter the borrower signed (or, before signing, the one sent or latest): its terms fix the facility amount. */
const offerInForce = (r: BusinessRecord) =>
  r.offers.find((o) => o.letter.version === r.application.offer?.letterVersion) ?? r.offers[r.offers.length - 1];

/** The officer plans the drawdowns: amounts that add up to the facility exactly, dates in order. Changes only before the first release. */
export async function planTranches(
  tenant: TenantCode,
  applicationId: string,
  plan: readonly { readonly amountMinorUnits: bigint; readonly plannedDate?: string }[],
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, ctx, at) => {
    const open = closingOpen(r);
    if (!open.ok) return open;
    if ((r.closing.tranches ?? []).some((t) => t.releases > 0))
      return fail('TRANCHES_LOCKED', 'The drawdown plan changes only before the first release');
    if (isTawarruq(r.application.productCode))
      return fail('TRANCHES_NOT_PERMITTED', 'A Tawarruq pays its proceeds once; it is not drawn in tranches');
    const offer = offerInForce(r);
    if (offer === undefined) return fail('OFFER_NOT_GENERATED', 'Generate the offer first; its facility amount is what the plan divides');
    if (plan.length < 1 || plan.length > MAX_TRANCHES)
      return fail('TRANCHES_INVALID', 'A facility is drawn in 1 to 12 tranches', { max: String(MAX_TRANCHES) });
    if (plan.some((t) => t.amountMinorUnits <= 0n)) return fail('TRANCHES_INVALID', 'Every tranche is a positive amount');
    const facility = offer.terms.facilityAmount;
    const total = plan.reduce((sum, t) => sum + t.amountMinorUnits, 0n);
    if (total !== facility.minorUnits)
      return fail('TRANCHES_NOT_FACILITY', 'The tranches add up to the facility amount exactly', {
        facilityMinorUnits: facility.minorUnits.toString(),
        plannedMinorUnits: total.toString(),
      });
    const dates = plan.map((t) => t.plannedDate ?? '');
    for (const d of dates)
      if (d !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return fail('TRANCHES_INVALID', 'A tranche date is yyyy-mm-dd');
    const given = dates.filter((d) => d !== '');
    if (given.some((d, i) => i > 0 && d < (given[i - 1] ?? '')))
      return fail('TRANCHES_INVALID', 'Tranche dates run in order');
    if (given[0] !== undefined && given[0] < offer.terms.disbursementDate)
      return fail('TRANCHES_INVALID', 'No tranche is planned before the offer’s disbursement date', {
        disbursementDate: offer.terms.disbursementDate,
      });
    r.closing.tranches = plan.map((t, i) => ({
      trancheId: `T${String(i + 1)}`,
      amount: money(t.amountMinorUnits, ctx.currency),
      ...(t.plannedDate === undefined || t.plannedDate === '' ? {} : { plannedDate: t.plannedDate }),
      status: 'PLANNED' as const,
      releases: 0,
    }));
    recordEvent(book, r, {
      eventType: 'TRANCHES_PLANNED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: { amounts: plan.map((t) => t.amountMinorUnits.toString()).join(','), dates: dates.join(',') },
    });
    return ok(true);
  });
}

export type PaymentResultStatus = 'ACCEPTED' | 'SETTLED' | 'REJECTED' | 'RETURNED';

/**
 * The bank's status for one instruction, by its idempotency key: settled, or
 * failed (rejected, returned). The same result twice changes nothing. A
 * failed tranche can be released again once the payee has been recorded and
 * confirmed afresh.
 */
export async function recordPaymentResult(
  tenant: TenantCode,
  applicationId: string,
  result: {
    readonly idempotencyKey: string;
    readonly status: PaymentResultStatus;
    readonly instructionRef?: string;
    readonly reasonCode?: string;
    readonly source: 'LIVE' | 'FIXTURE';
  },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () =>
    closingChangeAt(tenant, applicationId, developmentAttestation().epochSeconds, (r, book, _ctx, at) => {
      const tranche = (r.closing.tranches ?? []).find((t) => t.idempotencyKey === result.idempotencyKey);
      if (tranche === undefined)
        return fail('PAYMENT_NOT_FOUND', 'No released tranche carries that instruction key', { applicationId });
      if (!['ACCEPTED', 'SETTLED', 'REJECTED', 'RETURNED'].includes(result.status))
        return fail('PAYMENT_STATUS_INVALID', 'A payment status is accepted, settled, rejected or returned');
      if (result.instructionRef !== undefined && !REF_SHAPE.test(result.instructionRef))
        return fail('PAYMENT_STATUS_INVALID', 'The bank’s reference is not usable');
      if (result.reasonCode !== undefined && !/^[A-Z0-9]{2,8}$/.test(result.reasonCode))
        return fail('PAYMENT_STATUS_INVALID', 'A reason is the bank’s ISO 20022 reason code');
      const next = applyPaymentResult(tranche, result.status, result.instructionRef, result.reasonCode, at);
      if (next.status === tranche.status && next.instructionRef === tranche.instructionRef) return ok(true);
      if (tranche.status === 'FAILED') return ok(true);
      updateTranche(r, tranche.trancheId, () => next);
      if (next.status === 'FAILED') withdrawPayeeConfirmation(r);
      recordEvent(book, r, {
        eventType: 'PAYMENT_RESULT_RECORDED',
        fromStage: null,
        toStage: null,
        actor,
        atEpochSeconds: at,
        detail: {
          trancheId: tranche.trancheId,
          idempotencyKey: result.idempotencyKey,
          status: result.status,
          ...(result.instructionRef === undefined ? {} : { instructionRef: result.instructionRef }),
          ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
          source: result.source,
        },
      });
      return ok(true);
    }),
  );
}

// -- booking in the loan system (UAE M6) ---------------------------------------

/**
 * The loan as the loan system booked it: its account number, contract and
 * customer references. Once only: a booked loan is not booked again. Recorded
 * against the disbursed application (the row is closed; this is an event).
 */
export async function recordLoanBooked(
  tenant: TenantCode,
  applicationId: string,
  booking: {
    readonly loanAccountNumber: string;
    readonly contractRef: string;
    readonly customerRef: string;
    readonly productCode: string;
    readonly source: 'LIVE' | 'FIXTURE';
  },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, _ctx, at) => {
    if (r.application.status !== 'DISBURSED')
      return fail('TRANSITION_NOT_ALLOWED', 'A loan is booked once it has been disbursed', { status: r.application.status });
    if (r.booking !== undefined) return fail('LOAN_ALREADY_BOOKED', 'This loan is already booked in the loan system');
    for (const v of [booking.loanAccountNumber, booking.contractRef, booking.customerRef])
      if (!REF_SHAPE.test(v)) return fail('LOAN_BOOKING_REF_INVALID', 'The loan system returned no usable reference; nothing was recorded');
    r.booking = { ...booking, bookedBy: actor, bookedAtEpochSeconds: at };
    recordEvent(book, r, {
      eventType: 'LOAN_BOOKED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: { ...booking },
    });
    return ok(true);
  });
}

/** What the loan system is told: the signed offer's terms and the borrower, for one disbursed application. */
export async function bookingTermsOf(
  tenant: TenantCode,
  applicationId: string,
): Promise<
  Result<{
    readonly view: BusinessApplicationView;
    readonly terms: OfferTerms;
  }>
> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const signed = r.offers.find((o) => o.letter.version === r.application.offer?.letterVersion);
  if (signed === undefined) return fail('OFFER_NOT_GENERATED', 'The signed letter version is not on record');
  return ok({ view: view(r, ctx.value.currency), terms: signed.terms });
}

// -- Tawarruq execution (KSA K4) ------------------------------------------------

export type TawarruqStep =
  | { readonly step: 'COMMODITY_PURCHASED'; readonly lot: CommodityLot }
  | { readonly step: 'SOLD_TO_CUSTOMER'; readonly saleDocumentRef: string }
  | { readonly step: 'TITLE_TRANSFERRED'; readonly transferRef: string }
  | { readonly step: 'PROCEEDS_REALISED'; readonly saleRef: string; readonly proceeds: Money; readonly agencyRef?: string };

/**
 * The module's view of this Tawarruq: its core rebuilt from the signed offer
 * and the approval's evidence. Only the quote's commodity cost and deferred
 * price are read by the execution functions; the rest of the quote was fixed
 * into the signed letter.
 */
function tawarruqCoreOf(r: BusinessRecord, tenant: TenantCode, terms: OfferTerms, brokerRef: string, agencyPermitted: boolean): Result<SmeIslamicCore> {
  const signature = r.application.signature;
  if (signature === undefined) return fail('TAWARRUQ_BEFORE_SIGNATURE', 'The commodity is bought only once the customer has signed');
  const registry = r.application.applicant.upstreamVerificationRefs.find((x) => /^(wathq|ner)[:-]/.test(x)) ?? r.application.applicant.registrationRef;
  const quote = { commodityCost: terms.facilityAmount, deferredSalePrice: terms.totalPayable } as unknown as SmeIslamicQuote;
  return ok({
    transactionId: r.application.applicationId,
    tenantId: tenant,
    applicantRef: r.contact.partyRef,
    quote,
    brokerRef,
    agency: { permitted: agencyPermitted },
    bureauEnquiryRef: r.inputs?.bureau.reportRef ?? '',
    consentId: r.inputs?.bureau.consentId ?? '',
    businessRegistryRef: registry,
    guaranteeRequired: false,
    correlationId: r.application.applicationId,
    // The customer's signature opens the execution: every step is attested after it.
    openedAt: restoreAttestedInstant({ epochSeconds: signature.atEpochSeconds, tokenDigest: 'signature', authorityId: 'signature' }),
  });
}

/** The broker and agency terms of the tenant's Tawarruq catalogue entry. */
export async function tawarruqTermsOf(
  tenant: TenantCode,
  applicationId: string,
): Promise<Result<{ readonly brokerRef: string; readonly commodityCode: string; readonly agencyPermitted: boolean; readonly view: BusinessApplicationView; readonly offer: OfferTerms }>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  if (!isTawarruq(r.application.productCode)) return fail('NOT_TAWARRUQ', 'This application is not a Tawarruq');
  const product = await productFor(tenant, r.application.productCode, r.application.variantCode, developmentAttestation());
  if (!product.ok) return product;
  const t = product.value.terms as Parameters<typeof smeTermIslamic.quote>[0];
  const signed = r.offers.find((o) => o.letter.version === r.application.offer?.letterVersion);
  if (signed === undefined) return fail('OFFER_NOT_GENERATED', 'The signed letter version is not on record');
  return ok({ brokerRef: t.brokerRef, commodityCode: t.commodityCode, agencyPermitted: t.agencyPermitted, view: view(r, ctx.value.currency), offer: signed.terms });
}

/**
 * Record one Tawarruq step, validated by the module's execution functions in
 * order — the purchase at exactly the quoted cost (SH-03), the sale on a signed
 * instrument, title, the onward sale (agency only where the board permits,
 * SH-18) — each attested strictly after the one before. A step out of order is
 * refused by construction: there is no state to apply it to.
 */
export async function recordTawarruqStep(
  tenant: TenantCode,
  applicationId: string,
  step: TawarruqStep,
  source: 'LIVE' | 'FIXTURE',
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  const terms = await tawarruqTermsOf(tenant, applicationId);
  if (!terms.ok) return terms;
  return withTenantLock(tenant, async () => {
    const book = await hydrate(tenant);
    const ctx = tenantContext(tenant);
    if (!ctx.ok) return ctx;
    const r = book.records.get(applicationId);
    if (r === undefined) return notFound(applicationId);
    if (r.application.status !== 'SIGNED')
      return fail('TRANSITION_NOT_ALLOWED', 'The commodity steps run between signature and disbursement', { status: r.application.status });
    const core = tawarruqCoreOf(r, tenant, terms.value.offer, terms.value.brokerRef, terms.value.agencyPermitted);
    if (!core.ok) return core;
    const draft = openTawarruq(core.value);
    if (!draft.ok) return draft;
    const at = developmentAttestation();
    const t = r.closing.tawarruq;
    let next: TawarruqRecord;
    let detail: Record<string, string>;
    if (step.step === 'COMMODITY_PURCHASED') {
      if (t !== undefined) return fail('TAWARRUQ_STEP_OUT_OF_ORDER', 'The commodity is already bought');
      const done = purchaseCommodity(draft.value, step.lot, at);
      if (!done.ok) return done;
      next = { state: 'COMMODITY_PURCHASED', lot: step.lot, purchasedAt: at, source };
      detail = {
        lotRef: step.lot.lotRef,
        commodityCode: step.lot.commodityCode,
        quantity: step.lot.quantity,
        unit: step.lot.unit,
        priceMinorUnits: step.lot.price.minorUnits.toString(),
        brokerConfirmedAt: step.lot.confirmedAtEpochSeconds.toString(),
        source,
      };
    } else if (step.step === 'SOLD_TO_CUSTOMER') {
      if (t?.state !== 'COMMODITY_PURCHASED') return fail('TAWARRUQ_STEP_OUT_OF_ORDER', 'The commodity is sold to the customer once bought');
      if (!r.documents.some((d) => d.documentRef === step.saleDocumentRef))
        return fail('SECURITY_EVIDENCE_NOT_ON_FILE', 'The signed deferred-sale instrument is a document on the application');
      const done = sellToCustomer({ state: 'COMMODITY_PURCHASED', core: core.value, lot: t.lot, purchasedAt: t.purchasedAt }, step.saleDocumentRef, at);
      if (!done.ok) return done;
      next = { ...t, state: 'SOLD_TO_CUSTOMER', saleDocumentRef: step.saleDocumentRef, soldAt: at };
      detail = { saleDocumentRef: step.saleDocumentRef };
    } else if (step.step === 'TITLE_TRANSFERRED') {
      if (t?.state !== 'SOLD_TO_CUSTOMER' || t.soldAt === undefined || t.saleDocumentRef === undefined)
        return fail('TAWARRUQ_STEP_OUT_OF_ORDER', 'Title passes once the commodity is sold to the customer');
      const done = transferTitle(
        { state: 'SOLD_TO_CUSTOMER', core: core.value, lot: t.lot, purchasedAt: t.purchasedAt, soldAt: t.soldAt, saleDocumentRef: t.saleDocumentRef },
        step.transferRef,
        at,
      );
      if (!done.ok) return done;
      next = { ...t, state: 'TITLE_TRANSFERRED', transferRef: step.transferRef, transferredAt: at };
      detail = { transferRef: step.transferRef };
    } else {
      if (t?.state !== 'TITLE_TRANSFERRED' || t.soldAt === undefined || t.transferRef === undefined || t.transferredAt === undefined)
        return fail('TAWARRUQ_STEP_OUT_OF_ORDER', 'The commodity is sold on once title has passed');
      if (step.proceeds.currency !== ctx.value.currency) return fail('CURRENCY_NOT_TENANTS', 'The proceeds are in the tenant’s currency');
      const done = realiseProceeds(
        { state: 'TITLE_TRANSFERRED', core: core.value, lot: t.lot, soldAt: t.soldAt, transferRef: t.transferRef, transferredAt: t.transferredAt },
        { saleRef: step.saleRef, proceeds: step.proceeds, ...(step.agencyRef === undefined ? {} : { agencyRef: step.agencyRef }) },
        at,
      );
      if (!done.ok) return done;
      next = { ...t, state: 'PROCEEDS_REALISED', saleRef: step.saleRef, proceeds: step.proceeds, ...(step.agencyRef === undefined ? {} : { agencyRef: step.agencyRef }), realisedAt: at };
      detail = { saleRef: step.saleRef, proceedsMinorUnits: step.proceeds.minorUnits.toString(), ...(step.agencyRef === undefined ? {} : { agencyRef: step.agencyRef }) };
    }
    r.closing.tawarruq = next;
    recordEvent(book, r, {
      eventType: 'TAWARRUQ_STEP',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at.epochSeconds,
      detail: { step: step.step, atEpoch: at.epochSeconds.toString(), tokenDigest: at.tokenDigest, authority: at.authorityId, ...detail },
    });
    return ok(view(r, ctx.value.currency));
  });
}

// -- servicing (S1): repayments and the position ---------------------------------

/** The signed schedule as instalments: interest (term loan) or profit (Tawarruq) is the charge. */
function scheduleOf(r: BusinessRecord) {
  const signed = r.offers.find((o) => o.letter.version === r.application.offer?.letterVersion);
  return signed?.schedule.rows.map((row) => ({ number: row.number, dueDate: row.dueDate, principal: row.principal, charge: row.interest }));
}

/** The position as of today in the tenant's time zone, from confirmed repayments only; undefined before disbursement. */
function servicingOf(r: BusinessRecord): ServicingView | undefined {
  if (r.application.status !== 'DISBURSED') return undefined;
  const ctx = tenantContext(r.application.tenantId as TenantCode);
  if (!ctx.ok) return undefined;
  const today = localDate(developmentAttestation().epochSeconds, ctx.value.profile);
  // An approved restructuring supersedes the signed schedule from its effective date: what was owed then, re-spread,
  // and only receipts from that day count against it.
  const current = [...r.servicing.restructures].reverse().find((x) => x.approvedBy !== undefined);
  const schedule = current?.rows ?? scheduleOf(r);
  if (schedule === undefined) return undefined;
  const confirmed = r.servicing.repayments.filter((x) => x.confirmedBy !== undefined);
  const position = facilityPosition(
    schedule,
    current === undefined ? confirmed : confirmed.filter((x) => x.receivedOn >= current.effectiveDate),
    today,
    ctx.value.currency,
  );
  return {
    repayments: [...r.servicing.repayments],
    collections: [...r.servicing.collections],
    bureauReports: [...r.servicing.bureauReports],
    lateCharges: [...r.servicing.lateCharges],
    ...(r.servicing.hardship === undefined ? {} : { hardship: r.servicing.hardship }),
    restructures: [...r.servicing.restructures],
    position,
    ...(r.portfolio === undefined
      ? {}
      : {
          reconciliation: {
            loanSystemDaysPastDue: r.portfolio.daysPastDue,
            sanadDaysPastDue: position.daysPastDue,
            matches: r.portfolio.daysPastDue === position.daysPastDue,
          },
        }),
  };
}

async function recordRepaymentAt(
  tenant: TenantCode,
  applicationId: string,
  entry: {
    readonly amountMinorUnits: bigint;
    readonly receivedOn: string;
    readonly reference: string;
    readonly channel: RepaymentChannel;
    readonly source: 'LIVE' | 'FIXTURE';
  },
  actor: string,
  at: bigint,
): Promise<Result<BusinessApplicationView>> {
  return closingChangeAt(tenant, applicationId, at, (r, book, ctx) => {
    if (r.application.status !== 'DISBURSED')
      return fail('TRANSITION_NOT_ALLOWED', 'Repayments are recorded against a disbursed facility', { status: r.application.status });
    if (entry.amountMinorUnits <= 0n) return fail('REPAYMENT_AMOUNT_INVALID', 'A repayment is a positive amount');
    const received = civilDay(entry.receivedOn);
    const today = civilDay(localDate(at, ctx.profile)) ?? 0;
    const disbursedOn = r.application.disbursement === undefined ? undefined : civilDay(localDate(r.application.disbursement.atEpochSeconds, ctx.profile));
    if (received === undefined || received > today || (disbursedOn !== undefined && received < disbursedOn))
      return fail('REPAYMENT_DATE_INVALID', 'A repayment is dated between disbursement and today');
    if (!REF_SHAPE.test(entry.reference)) return fail('REPAYMENT_REF_INVALID', 'A repayment is recorded by the channel’s reference');
    const identity = identityNumberIn({ reference: entry.reference });
    if (identity !== undefined) return identity;
    // The channel's reference is the receipt's identity: the same receipt twice is one receipt.
    if (r.servicing.repayments.some((x) => x.reference === entry.reference && x.channel === entry.channel))
      return fail('REPAYMENT_DUPLICATE', 'This receipt is already recorded');
    const repaymentId = `RP-${String(r.servicing.repayments.length + 1).padStart(4, '0')}`;
    // A rail's receipt is confirmed by the rail; a manual one waits for a second person.
    const confirmedBy = entry.channel === 'MANUAL' ? undefined : `rail:${entry.channel.toLowerCase()}`;
    const amount = money(entry.amountMinorUnits, ctx.currency);
    r.servicing.repayments.push({
      repaymentId,
      receivedOn: entry.receivedOn,
      amount,
      reference: entry.reference,
      channel: entry.channel,
      recordedBy: actor,
      ...(confirmedBy === undefined ? {} : { confirmedBy }),
      source: entry.source,
    });
    recordEvent(book, r, {
      eventType: 'REPAYMENT_RECORDED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: {
        repaymentId,
        receivedOn: entry.receivedOn,
        amountMinorUnits: amount.minorUnits.toString(),
        reference: entry.reference,
        channel: entry.channel,
        source: entry.source,
        ...(confirmedBy === undefined ? {} : { confirmedBy }),
      },
    });
    return ok(true);
  });
}

/** Record a receipt: a manual one by finance (confirmed by a second person before it counts), or a rail's. */
export async function recordRepayment(
  tenant: TenantCode,
  applicationId: string,
  entry: {
    readonly amountMinorUnits: bigint;
    readonly receivedOn: string;
    readonly reference: string;
    readonly channel: RepaymentChannel;
    readonly source: 'LIVE' | 'FIXTURE';
  },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => recordRepaymentAt(tenant, applicationId, entry, actor, developmentAttestation().epochSeconds));
}

/** A second person confirms a manual receipt against the bank statement before it counts. */
export async function confirmRepayment(
  tenant: TenantCode,
  applicationId: string,
  repaymentId: string,
  confirmer: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, _ctx, at) => {
    const i = r.servicing.repayments.findIndex((x) => x.repaymentId === repaymentId);
    const rp = r.servicing.repayments[i];
    if (rp === undefined) return fail('REPAYMENT_NOT_FOUND', 'No such repayment on the facility', { repaymentId });
    if (rp.confirmedBy !== undefined) return fail('REPAYMENT_ALREADY_CONFIRMED', 'This repayment is already confirmed');
    if (confirmer === rp.recordedBy)
      return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_CONFIRMATION', 'Whoever recorded a receipt does not confirm it');
    r.servicing.repayments[i] = { ...rp, confirmedBy: confirmer };
    recordEvent(book, r, {
      eventType: 'REPAYMENT_CONFIRMED',
      fromStage: null,
      toStage: null,
      actor: confirmer,
      atEpochSeconds: at,
      detail: { repaymentId },
    });
    queueSettlementIfRepaid(book, r, tenant, at);
    return ok(true);
  });
}

// -- servicing (S2): collections and bureau reporting -----------------------------

/** How many days ahead of its due date an instalment is presented for collection. */
const COLLECTION_LEAD_DAYS = 7;

/**
 * Present the instalments due within the lead window, and any overdue and
 * unpaid, for collection: a SADAD bill in Saudi Arabia, a direct collection
 * from the payee account through the partner bank in the UAE. Each is its own
 * idempotent outbox instruction; an instalment already presented and not
 * returned is not presented again.
 */
export async function presentCollections(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    const book = await hydrate(tenant);
    const ctx = tenantContext(tenant);
    if (!ctx.ok) return ctx;
    const r = book.records.get(applicationId);
    if (r === undefined) return notFound(applicationId);
    const servicing = servicingOf(r);
    if (servicing === undefined)
      return fail('TRANSITION_NOT_ALLOWED', 'Instalments are collected on a disbursed facility', { status: r.application.status });
    if (r.servicing.hardship !== undefined)
      return fail('HARDSHIP_HOLD', 'Collections are paused while the customer is in hardship');
    const saudi = ctx.value.profile.code === 'SA';
    const payee = r.closing.payee;
    if (!saudi && payee?.confirmedBy === undefined)
      return fail('PAYEE_NOT_CONFIRMED', 'A direct collection debits the confirmed account; none is on record');
    const today = civilDay(servicing.position.asOf) ?? 0;
    const due = servicing.position.instalments.filter(
      (i) =>
        i.outstanding.minorUnits > 0n &&
        (civilDay(i.dueDate) ?? 0) <= today + COLLECTION_LEAD_DAYS &&
        !r.servicing.collections.some((c) => c.instalmentNumber === i.number && c.result !== 'RETURNED'),
    );
    if (due.length === 0) return fail('NOTHING_TO_COLLECT', 'No instalment is due for collection now');
    const at = developmentAttestation().epochSeconds;
    const base = { tenantId: tenant, subjectRef: applicationId, correlationId: applicationId };
    const channel: CollectionRecord['channel'] = saudi ? 'SADAD' : 'PARTNER_BANK';
    const planned = due.map((i) => {
      const attempts = r.servicing.collections.filter((c) => c.instalmentNumber === i.number).length;
      const key = `business:${applicationId}:collect:I${String(i.number)}${attempts > 0 ? `:R${String(attempts)}` : ''}`;
      return { i, key };
    });
    const queued = queueSideEffects(
      planned.map(({ i, key }) =>
        saudi
          ? {
              ...base,
              eventId: key,
              kind: 'BILL_PRESENT' as const,
              idempotencyKey: key,
              payload: { payerRef: r.contact.partyRef, minorUnits: i.outstanding.minorUnits.toString(), currency: i.outstanding.currency, dueDateGregorian: i.dueDate },
            }
          : {
              ...base,
              eventId: key,
              kind: 'PAYMENT_COLLECT' as const,
              idempotencyKey: key,
              payload: {
                payerRef: r.contact.partyRef,
                payerIban: payee?.iban ?? '',
                minorUnits: i.outstanding.minorUnits.toString(),
                currency: i.outstanding.currency,
              },
            },
      ),
    );
    if (!queued.ok) return queued;
    commitSideEffects(book, queued.value);
    for (const { i, key } of planned) {
      r.servicing.collections.push({ instalmentNumber: i.number, idempotencyKey: key, channel, amount: i.outstanding, dueDate: i.dueDate, presentedBy: actor, presentedAtEpochSeconds: at });
      recordEvent(book, r, {
        eventType: 'COLLECTION_PRESENTED',
        fromStage: null,
        toStage: null,
        actor,
        atEpochSeconds: at,
        detail: { instalment: String(i.number), idempotencyKey: key, channel, amountMinorUnits: i.outstanding.minorUnits.toString(), dueDate: i.dueDate },
      });
    }
    return ok(view(r, ctx.value.currency));
  });
}

/**
 * The channel's result for a presented instalment. PAID becomes a receipt,
 * confirmed by the rail, at the amount actually paid; RETURNED frees the
 * instalment to be presented again. The same result twice changes nothing.
 */
export async function recordCollectionResult(
  tenant: TenantCode,
  applicationId: string,
  result: {
    readonly idempotencyKey: string;
    readonly status: 'PAID' | 'RETURNED';
    readonly amountMinorUnits?: bigint;
    readonly reference: string;
    readonly receivedOn: string;
    readonly source: 'LIVE' | 'FIXTURE';
  },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    const at = developmentAttestation().epochSeconds;
    const book = await hydrate(tenant);
    const r = book.records.get(applicationId);
    if (r === undefined) return notFound(applicationId);
    const c = r.servicing.collections.find((x) => x.idempotencyKey === result.idempotencyKey);
    if (c === undefined) return fail('COLLECTION_NOT_FOUND', 'No presented instalment carries that key', { applicationId });
    if (c.result !== undefined) {
      const ctx = tenantContext(tenant);
      return ctx.ok ? ok(view(r, ctx.value.currency)) : ctx;
    }
    if (result.status === 'PAID') {
      const paid = await recordRepaymentAt(
        tenant,
        applicationId,
        {
          amountMinorUnits: result.amountMinorUnits ?? c.amount.minorUnits,
          receivedOn: result.receivedOn,
          reference: result.reference,
          channel: c.channel,
          source: result.source,
        },
        actor,
        at,
      );
      if (!paid.ok) return paid;
    }
    return closingChangeAt(tenant, applicationId, at, (rec, b) => {
      const i = rec.servicing.collections.findIndex((x) => x.idempotencyKey === result.idempotencyKey);
      if (i >= 0) rec.servicing.collections[i] = { ...(rec.servicing.collections[i] as CollectionRecord), result: result.status };
      recordEvent(b, rec, {
        eventType: 'COLLECTION_RESULT',
        fromStage: null,
        toStage: null,
        actor,
        atEpochSeconds: at,
        detail: { idempotencyKey: result.idempotencyKey, result: result.status, reference: result.reference, source: result.source },
      });
      queueSettlementIfRepaid(b, rec, tenant, at);
      return ok(true);
    });
  });
}

/** Once the facility is repaid in full, the bureau is told it is settled — once. */
function queueSettlementIfRepaid(book: TenantBook, r: BusinessRecord, tenant: TenantCode, at: bigint): void {
  if (r.servicing.settledReported === true) return;
  const s = servicingOf(r);
  if (s === undefined || s.position.outstandingTotal.minorUnits > 0n) return;
  const key = `business:${r.application.applicationId}:bureau:settled`;
  const queued = queueSideEffects([
    {
      tenantId: tenant,
      subjectRef: r.application.applicationId,
      correlationId: r.application.applicationId,
      eventId: key,
      kind: 'BUREAU_REPORT',
      idempotencyKey: key,
      payload: { facilityRef: r.application.applicationId, event: 'SETTLED', minorUnits: s.position.totalPaid.minorUnits.toString(), asOfEpochSeconds: at.toString() },
    },
  ]);
  if (!queued.ok) return;
  commitSideEffects(book, queued.value);
  r.servicing.settledReported = true;
  recordEvent(book, r, { eventType: 'BUREAU_SETTLED_REPORTED', fromStage: null, toStage: null, actor: 'system', atEpochSeconds: at, detail: {} });
}

/**
 * The month's status to the credit bureau (SIMAH, AECB): in arrears with the
 * days-past-due bucket, or current with the instalments paid. Once per month,
 * keyed on it.
 */
export async function reportToBureau(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    const book = await hydrate(tenant);
    const ctx = tenantContext(tenant);
    if (!ctx.ok) return ctx;
    const r = book.records.get(applicationId);
    if (r === undefined) return notFound(applicationId);
    const s = servicingOf(r);
    if (s === undefined) return fail('TRANSITION_NOT_ALLOWED', 'The bureau is told about a disbursed facility', { status: r.application.status });
    const month = s.position.asOf.slice(0, 7);
    if (r.servicing.bureauReports.includes(month)) return fail('BUREAU_ALREADY_REPORTED', 'This month’s status is already reported', { month });
    const at = developmentAttestation().epochSeconds;
    const key = `business:${applicationId}:bureau:${month}`;
    const inArrears = s.position.daysPastDue > 0;
    const queued = queueSideEffects([
      {
        tenantId: tenant,
        subjectRef: applicationId,
        correlationId: applicationId,
        eventId: key,
        kind: 'BUREAU_REPORT',
        idempotencyKey: key,
        payload: {
          facilityRef: applicationId,
          event: inArrears ? 'ARREARS' : 'INSTALMENT_PAID',
          minorUnits: (inArrears ? s.position.arrears : s.position.outstandingTotal).minorUnits.toString(),
          daysPastDue: String(s.position.daysPastDue),
          asOfEpochSeconds: at.toString(),
        },
      },
    ]);
    if (!queued.ok) return queued;
    commitSideEffects(book, queued.value);
    r.servicing.bureauReports.push(month);
    recordEvent(book, r, {
      eventType: 'BUREAU_STATUS_REPORTED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: { month, event: inArrears ? 'ARREARS' : 'INSTALMENT_PAID', daysPastDue: String(s.position.daysPastDue) },
    });
    return ok(view(r, ctx.value.currency));
  });
}

// -- servicing (S3): late charges, hardship, restructuring -------------------------

const reasonOk = (text: string): Result<string> => {
  const t = text.trim();
  if (t.length < 10 || t.length > 500) return fail('SERVICING_REASON_REQUIRED', 'State the reason in 10 to 500 characters');
  if (containsIdentityNumber(t)) return fail('IDENTITY_NUMBER_IN_FREE_TEXT', 'No identity number belongs in a reason');
  return ok(t);
};

/** Charge each instalment overdue beyond the grace days, once; for an Islamic facility, as a charity obligation. */
export async function assessLateCharges(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, ctx, at) => {
    const s = servicingOf(r);
    if (s === undefined) return fail('TRANSITION_NOT_ALLOWED', 'Late charges apply to a disbursed facility', { status: r.application.status });
    if (r.servicing.hardship !== undefined) return fail('HARDSHIP_HOLD', 'No late charge is assessed while the customer is in hardship');
    const policy = loadServicingPolicy(tenant);
    if (!policy.ok) return policy;
    const due = lateChargesDue(
      s.position,
      policy.value,
      new Set(r.servicing.lateCharges.map((c) => c.instalmentNumber)),
      isTawarruq(r.application.productCode),
      ctx.currency,
    );
    if (due.length === 0) return fail('NO_LATE_CHARGE_DUE', 'No instalment is overdue beyond the grace days and not yet charged');
    for (const c of due) {
      r.servicing.lateCharges.push({ ...c, assessedBy: actor, assessedAtEpochSeconds: at });
      recordEvent(book, r, {
        eventType: 'LATE_CHARGE_ASSESSED',
        fromStage: null,
        toStage: null,
        actor,
        atEpochSeconds: at,
        detail: { instalment: String(c.instalmentNumber), amountMinorUnits: c.amount.minorUnits.toString(), treatment: c.treatment },
      });
    }
    return ok(true);
  });
}

/** A second person waives a late charge, with the reason. */
export async function waiveLateCharge(
  tenant: TenantCode,
  applicationId: string,
  instalmentNumber: number,
  reason: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, _ctx, at) => {
    const i = r.servicing.lateCharges.findIndex((c) => c.instalmentNumber === instalmentNumber && c.waivedBy === undefined);
    const c = r.servicing.lateCharges[i];
    if (c === undefined) return fail('LATE_CHARGE_NOT_FOUND', 'No such late charge outstanding');
    if (actor === c.assessedBy) return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_WAIVER', 'Whoever assessed a charge does not waive it');
    const why = reasonOk(reason);
    if (!why.ok) return why;
    r.servicing.lateCharges[i] = { ...c, waivedBy: actor, waiverReason: why.value };
    recordEvent(book, r, { eventType: 'LATE_CHARGE_WAIVED', fromStage: null, toStage: null, actor, atEpochSeconds: at, detail: { instalment: String(instalmentNumber), reason: why.value } });
    return ok(true);
  });
}

/** Place the customer in hardship: collections and late charges pause. Lifted by a second person. */
export async function setHardship(
  tenant: TenantCode,
  applicationId: string,
  reason: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, _ctx, at) => {
    if (r.application.status !== 'DISBURSED') return fail('TRANSITION_NOT_ALLOWED', 'Hardship applies to a disbursed facility', { status: r.application.status });
    if (r.servicing.hardship !== undefined) return fail('HARDSHIP_ALREADY_SET', 'The customer is already in hardship');
    const why = reasonOk(reason);
    if (!why.ok) return why;
    r.servicing.hardship = { reason: why.value, setBy: actor, setAtEpochSeconds: at };
    recordEvent(book, r, { eventType: 'HARDSHIP_SET', fromStage: null, toStage: null, actor, atEpochSeconds: at, detail: { reason: why.value } });
    return ok(true);
  });
}

export async function liftHardship(tenant: TenantCode, applicationId: string, actor: string): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, _ctx, at) => {
    const h = r.servicing.hardship;
    if (h === undefined) return fail('HARDSHIP_NOT_SET', 'The customer is not in hardship');
    if (actor === h.setBy) return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_CONFIRMATION', 'Whoever placed the hold does not lift it');
    delete r.servicing.hardship;
    recordEvent(book, r, { eventType: 'HARDSHIP_LIFTED', fromStage: null, toStage: null, actor, atEpochSeconds: at, detail: {} });
    return ok(true);
  });
}

/**
 * Propose a restructuring from today: what is owed — arrears included —
 * re-spread over the new instalments. A term loan is re-amortised at its
 * signed rate; an Islamic facility's outstanding price is re-spread with its
 * total unchanged. It takes effect only once approved by a second person.
 */
export async function proposeRestructure(
  tenant: TenantCode,
  applicationId: string,
  terms: { readonly firstDueDate: string; readonly numberOfPayments: number; readonly reason: string },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, ctx, at) => {
    const s = servicingOf(r);
    if (s === undefined) return fail('TRANSITION_NOT_ALLOWED', 'A disbursed facility is restructured', { status: r.application.status });
    if (r.servicing.restructures.some((x) => x.approvedBy === undefined))
      return fail('RESTRUCTURE_PENDING', 'A restructuring is already awaiting approval');
    const why = reasonOk(terms.reason);
    if (!why.ok) return why;
    const policy = loadServicingPolicy(tenant);
    if (!policy.ok) return policy;
    const signed = r.offers.find((o) => o.letter.version === r.application.offer?.letterVersion);
    if (signed === undefined) return fail('OFFER_NOT_GENERATED', 'The signed letter version is not on record');
    const effectiveDate = s.position.asOf;
    const paymentDay = Number(terms.firstDueDate.slice(8, 10));
    const outstandingPrincipal = s.position.outstandingPrincipal;
    const outstandingCharge = money(s.position.outstandingTotal.minorUnits - outstandingPrincipal.minorUnits, ctx.currency);
    const t = { effectiveDate, firstDueDate: terms.firstDueDate, numberOfPayments: terms.numberOfPayments, paymentDay };
    const rows = isTawarruq(r.application.productCode)
      ? respreadPrice(outstandingPrincipal, outstandingCharge, t, policy.value.restructuring.maxPayments)
      : reamortise(outstandingPrincipal, signed.terms.rateBp, t, policy.value.restructuring.maxPayments);
    if (!rows.ok) return rows;
    const totalAfter = money(rows.value.reduce((a, x) => a + x.principal.minorUnits + x.charge.minorUnits, 0n), ctx.currency);
    const restructureId = `RS-${String(r.servicing.restructures.length + 1).padStart(3, '0')}`;
    r.servicing.restructures.push({
      restructureId,
      effectiveDate,
      rows: rows.value,
      outstandingBefore: s.position.outstandingTotal,
      totalAfter,
      proposedBy: actor,
      reason: why.value,
    });
    recordEvent(book, r, {
      eventType: 'RESTRUCTURE_PROPOSED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: {
        restructureId,
        effectiveDate,
        rows: rows.value.map((x) => `${String(x.number)}|${x.dueDate}|${x.principal.minorUnits.toString()}|${x.charge.minorUnits.toString()}`).join(';'),
        outstandingBefore: s.position.outstandingTotal.minorUnits.toString(),
        totalAfter: totalAfter.minorUnits.toString(),
        reason: why.value,
      },
    });
    return ok(true);
  });
}

/** A second person approves the proposed restructuring; it then supersedes the schedule from its effective date. */
export async function approveRestructure(
  tenant: TenantCode,
  applicationId: string,
  restructureId: string,
  approver: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, _ctx, at) => {
    const i = r.servicing.restructures.findIndex((x) => x.restructureId === restructureId);
    const rs = r.servicing.restructures[i];
    if (rs === undefined) return fail('RESTRUCTURE_NOT_FOUND', 'No such restructuring', { restructureId });
    if (rs.approvedBy !== undefined) return fail('RESTRUCTURE_ALREADY_APPROVED', 'This restructuring is already approved');
    if (approver === rs.proposedBy) return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_APPROVAL', 'Whoever proposed a restructuring does not approve it');
    r.servicing.restructures[i] = { ...rs, approvedBy: approver };
    recordEvent(book, r, { eventType: 'RESTRUCTURE_APPROVED', fromStage: null, toStage: null, actor: approver, atEpochSeconds: at, detail: { restructureId } });
    return ok(true);
  });
}

// -- offer letter PDFs ------------------------------------------------------------

/**
 * Record a rendered PDF of one of the application's letter versions. The same
 * PDF twice is one record. It may be rendered at any stage once the letter
 * exists: the record is an event, the application row is untouched.
 */
export async function recordOfferPdf(
  tenant: TenantCode,
  applicationId: string,
  pdf: { readonly letterVersion: string; readonly sha256Hex: string; readonly byteLength: number; readonly storage: 'LIVE' | 'FIXTURE' },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return closingChange(tenant, applicationId, (r, book, _ctx, at) => {
    if (!r.offers.some((o) => o.letter.version === pdf.letterVersion))
      return fail('OFFER_NOT_GENERATED', 'No such letter version on the application');
    if (!/^[0-9a-f]{64}$/.test(pdf.sha256Hex)) return fail('DOCUMENT_CONTENT_INVALID', 'A PDF is recorded by the hash of its bytes');
    if (r.letterPdfs.some((x) => x.sha256Hex === pdf.sha256Hex)) return ok(true);
    r.letterPdfs.push({ ...pdf, renderedBy: actor, renderedAtEpochSeconds: at });
    recordEvent(book, r, {
      eventType: 'OFFER_PDF_RENDERED',
      fromStage: null,
      toStage: null,
      actor,
      atEpochSeconds: at,
      detail: { letterVersion: pdf.letterVersion, sha256: pdf.sha256Hex, byteLength: String(pdf.byteLength), storage: pdf.storage },
    });
    return ok(true);
  });
}

async function signAt(
  tenant: TenantCode,
  applicationId: string,
  signature: { readonly letterVersion: string; readonly signatureRef?: string },
  actor: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  // Fixture: the UAE Pass signing intent's reference until that adapter is verified (adapters/uae/uae-pass/README.md).
  const signatureRef = signature.signatureRef ?? `uaepass-fixture:sign:${applicationId}`;
  const t = recordSignedCore(
    r.application,
    { signatureRef, letterVersion: signature.letterVersion },
    actor,
    at.epochSeconds,
  );
  if (!t.ok) return t;
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/**
 * Record the applicant's signature, on the letter version that was sent and
 * no other. The signature reference is a UAE Pass fixture reference until
 * that rail is verified.
 */
export async function recordSigned(
  tenant: TenantCode,
  applicationId: string,
  signature: { readonly letterVersion: string; readonly signatureRef?: string },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => signAt(tenant, applicationId, signature, actor, developmentAttestation()));
}

async function disburseAt(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
  paymentRef: string | undefined,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const app = r.application;
  // Four eyes on money out: whoever approved the facility (or submitted it) does not also release the payment.
  const approver = r.events.find(
    (e) => e.eventType === 'APPROVED_STRAIGHT_THROUGH' || e.eventType === 'COMMITTEE_APPROVED',
  )?.actor;
  if (actor === approver || actor === app.submittedBy)
    return reject(
      'OP-DETERMINACY',
      'FOUR_EYES_DISBURSEMENT',
      'Disbursement is released by a principal other than the approver and the submitting officer',
    );
  // Every condition precedent on the approved pack, evidenced and verified by a second person.
  const outstanding = conditionsPrecedent(r).filter((c) => r.closing.cps[c.conditionId]?.verifiedBy === undefined);
  if (outstanding.length > 0)
    return fail('CONDITIONS_PRECEDENT_OUTSTANDING', 'Every condition precedent is met and verified before drawdown', {
      conditions: outstanding.map((c) => c.conditionId).join(','),
    });
  // The account paid into: recorded, proven and confirmed by a second person; and not released by whoever recorded it.
  const payee = r.closing.payee;
  if (payee?.confirmedBy === undefined)
    return fail('PAYEE_NOT_CONFIRMED', 'The payee account is recorded and confirmed by a second person before disbursement');
  if (actor === payee.recordedBy)
    return reject('OP-DETERMINACY', 'FOUR_EYES_PAYEE', 'Whoever recorded the payee account does not release the payment');
  // The first release moves the application to DISBURSED; later tranches are paid against it, the row unchanged.
  const first = app.status === 'SIGNED';
  if (!first && app.status !== 'DISBURSED')
    return fail('TRANSITION_NOT_ALLOWED', 'Disbursement follows the borrower’s signature', { status: app.status });
  // Fixture: the partner bank's payment instruction reference until that adapter is verified (adapters/uae/partner-bank/README.md).
  const reference = paymentRef ?? `partner-bank-fixture:pay:${applicationId}`;
  const t = first ? recordDisbursedCore(app, reference, actor, at.epochSeconds) : undefined;
  if (t !== undefined && !t.ok) return t;
  const signed = r.offers.find((o) => o.letter.version === app.offer?.letterVersion);
  if (signed === undefined) return fail('OFFER_NOT_GENERATED', 'The signed letter version is not on record');

  // A Tawarruq pays the customer the proceeds of the onward sale, once, after the commodity steps (SI-3 to SI-5, SI-11).
  if (isTawarruq(app.productCode)) {
    const tw = r.closing.tawarruq;
    if (tw?.state !== 'PROCEEDS_REALISED' || tw.proceeds === undefined)
      return fail('TAWARRUQ_INCOMPLETE', 'The commodity is bought, sold to the customer, title passed and sold on before the proceeds are paid');
    r.closing.tranches ??= [{ trancheId: 'T1', amount: tw.proceeds, status: 'PLANNED', releases: 0 }];
  }
  // The tranche to pay: the first not yet paid, in plan order — or, after a failure, that one again.
  r.closing.tranches ??= [
    { trancheId: 'T1', amount: signed.terms.facilityAmount, status: 'PLANNED', releases: 0 },
  ];
  const tranches = r.closing.tranches;
  const index = tranches.findIndex((x) => x.status === 'PLANNED' || x.status === 'FAILED');
  const tranche = tranches[index];
  if (tranche === undefined) return fail('NO_TRANCHE_TO_RELEASE', 'Every tranche of the facility has been released');

  // Money goes out on or after the date the borrower signed for (the first tranche) or the date planned for this one.
  const plannedDate = tranche.plannedDate ?? signed.terms.disbursementDate;
  const actualDate = localDate(at.epochSeconds, ctx.value.profile);
  if (actualDate < plannedDate) {
    return fail(
      'DISBURSEMENT_BEFORE_PLANNED_DATE',
      'The disbursement is recorded on or after the planned disbursement date in the signed offer',
      { plannedDate, actualDate },
    );
  }

  // The payment instruction to the partner bank (and, with the first, the bureau's facility-opened report), keyed on the
  // application and the tranche: queued with the change and written in its transaction.
  const key = `business:${applicationId}`;
  const n = index + 1;
  const trancheKey = `${n === 1 ? `${key}:disburse` : `${key}:disburse:T${String(n)}`}${tranche.releases > 0 ? `:R${String(tranche.releases)}` : ''}`;
  const base = { tenantId: tenant, subjectRef: applicationId, correlationId: applicationId };
  const queued = queueSideEffects([
    {
      ...base,
      eventId: trancheKey,
      kind: 'PAYMENT_DISBURSE',
      idempotencyKey: trancheKey,
      payload: {
        // The jurisdiction's money-movement rail: the institution's payments hub in Saudi Arabia, the partner bank in the UAE.
        rail: ctx.value.profile.code === 'SA' ? 'PAYMENTS_HUB' : 'PARTNER_BANK',
        beneficiaryRef: applicationId,
        beneficiaryIban: payee.iban,
        paymentRef: reference,
        trancheId: tranche.trancheId,
        minorUnits: String(tranche.amount.minorUnits),
        currency: tranche.amount.currency,
      },
    },
    ...(first && tranche.releases === 0
      ? [
          {
            ...base,
            eventId: `${key}:bureau`,
            kind: 'BUREAU_REPORT' as const,
            idempotencyKey: `${key}:bureau`,
            payload: {
              facilityRef: applicationId,
              event: 'OPENED',
              minorUnits: String(signed.terms.totalPayable.minorUnits),
            },
          },
        ]
      : []),
  ]);
  if (!queued.ok) return queued;
  commitSideEffects(book, queued.value);
  if (t !== undefined) apply(book, r, t.value);
  updateTranche(r, tranche.trancheId, (x) => ({
    ...x,
    status: 'RELEASED',
    releases: x.releases + 1,
    idempotencyKey: trancheKey,
    releasedBy: actor,
  }));
  recordEvent(book, r, {
    eventType: 'TRANCHE_RELEASED',
    fromStage: null,
    toStage: null,
    actor,
    atEpochSeconds: at.epochSeconds,
    detail: { trancheId: tranche.trancheId, idempotencyKey: trancheKey, minorUnits: tranche.amount.minorUnits.toString() },
  });
  return ok(view(r, ctx.value.currency));
}

/**
 * Record the disbursement by its payment reference (a partner-bank fixture
 * reference until that rail is verified), released by a finance principal
 * distinct from the approver; queues the payment instruction and the bureau's
 * facility-opened report on the outbox in the same transaction.
 */
export async function recordDisbursed(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
  paymentRef?: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, async () => {
    // Booking the facility. The borrower's signature is the acceptance: one signed before the licence's grace
    // ended is booked whatever the licence's state now; one signed after is refused (ADR 0006 §4).
    const facts = await licenceFacts(tenant, applicationId);
    if (facts !== undefined) {
      const licence = await licencePermits({
        productCode: facts.productCode,
        ...(facts.signedAtEpochSeconds === undefined
          ? {}
          : { booking: { offerAcceptedAtEpochSeconds: facts.signedAtEpochSeconds } }),
      });
      if (!licence.ok) return licence;
    }
    return disburseAt(tenant, applicationId, actor, paymentRef, developmentAttestation());
  });
}

// =============================================================================
// Stages 8–9, withdrawal
// =============================================================================

async function portfolioAt(
  tenant: TenantCode,
  applicationId: string,
  status: { readonly daysPastDue: number; readonly arrearsMinorUnits: bigint },
  actor: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  if (r.application.status !== 'DISBURSED')
    return fail('TRANSITION_NOT_ALLOWED', 'Portfolio status is recorded for a disbursed facility', {
      status: r.application.status,
    });
  if (!Number.isSafeInteger(status.daysPastDue) || status.daysPastDue < 0)
    return fail('DAYS_PAST_DUE_INVALID', 'Days past due is a whole, non-negative count');
  if (status.arrearsMinorUnits < 0n) return fail('ARREARS_NEGATIVE', 'Arrears are not negative');
  // Days past due accrue from the first due date of the signed offer: more of them than days since then is not a status, it is an error.
  const signed = r.offers.find((o) => o.letter.version === r.application.offer?.letterVersion);
  const firstDue = signed === undefined ? undefined : daysOfIso(signed.terms.firstDueDate);
  const observed = daysOfIso(localDate(at.epochSeconds, ctx.value.profile)) ?? 0n;
  if (status.daysPastDue > 0 && (firstDue === undefined || BigInt(status.daysPastDue) > observed - firstDue)) {
    return fail(
      'DAYS_PAST_DUE_IMPOSSIBLE',
      'Days past due cannot exceed the days since the first instalment fell due',
      { firstDueDate: signed?.terms.firstDueDate ?? '' },
    );
  }
  const arrears = money(status.arrearsMinorUnits, ctx.value.currency);
  r.portfolio = { daysPastDue: status.daysPastDue, arrears, recordedBy: actor, asOfEpochSeconds: at.epochSeconds };
  const stage = status.daysPastDue > 0 ? 9 : 8;
  recordEvent(book, r, {
    eventType: 'PORTFOLIO_STATUS_RECORDED',
    fromStage: r.application.stage,
    toStage: stage,
    actor,
    atEpochSeconds: at.epochSeconds,
    detail: { daysPastDue: String(status.daysPastDue), arrearsMinorUnits: arrears.minorUnits.toString() },
  });
  return ok(view(r, ctx.value.currency));
}

/**
 * The loan system's report on a disbursed facility: days past due and
 * arrears. Above zero days the application shows at stage 9 (collections).
 * Recorded as an event: the application row is closed once disbursed.
 */
export async function recordPortfolioStatus(
  tenant: TenantCode,
  applicationId: string,
  status: { readonly daysPastDue: number; readonly arrearsMinorUnits: bigint },
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => portfolioAt(tenant, applicationId, status, actor, developmentAttestation()));
}

async function withdrawAt(
  tenant: TenantCode,
  applicationId: string,
  reason: string,
  actor: string,
  at: TsaInstant,
): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId);
  if (r === undefined) return notFound(applicationId);
  const t = withdraw(r.application, reason, actor, at.epochSeconds);
  if (!t.ok) return t;
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/** Withdraw an open application, saying why. The reason is free text and carries no identity number. */
export async function withdrawApplication(
  tenant: TenantCode,
  applicationId: string,
  reason: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  return withTenantLock(tenant, () => withdrawAt(tenant, applicationId, reason, actor, developmentAttestation()));
}

// =============================================================================
// ILLUSTRATIVE seed — the UAE fund's development book
// =============================================================================

/**
 * ILLUSTRATIVE. Eight invented businesses and owners — none is a real person
 * or company — spread across stages 5 to 9 so every screen has something to
 * show. Amounts are AED; figures, scores and assessments are chosen to
 * exercise each route, not drawn from any applicant. Each application is
 * walked through the same functions an officer uses, with back-dated
 * development instants, so the seed is the real state machine's output.
 */
const SEED_TENANT: TenantCode = 'sme-fund-ae';

type SeedReach = 'PROPOSED' | 'PARTLY_VERIFIED' | 'SUBMITTED' | 'ASSESSED' | 'OFFER_SENT' | 'DISBURSED';

interface SeedSpec {
  readonly applicationId: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly sector: 'TRADING' | 'SERVICES' | 'MANUFACTURING';
  readonly years: number;
  readonly owner: string;
  readonly variant: string;
  readonly purpose: string;
  readonly requestedAed: bigint;
  readonly tenorMonths: number;
  readonly graceMonths: number;
  readonly contribution: number;
  readonly receivedDaysAgo: bigint;
  /** Dirhams. */
  readonly figures: {
    readonly revenue: bigint;
    readonly prior: bigint;
    readonly profit: bigint;
    readonly debtService: bigint;
    readonly assets: bigint;
    readonly liabilities: bigint;
    readonly salary: bigint;
    readonly obligations: bigint;
  };
  readonly bureauScore: bigint;
  readonly employees: number;
  readonly experience: bigint;
  readonly sectorPriority: 'PRIORITY' | 'NON_PRIORITY';
  readonly collateralAed: bigint;
  readonly reach: SeedReach;
  readonly daysPastDue?: number;
  /**
   * How many days ago the walk ends (default 0, today). A facility in
   * arrears must have been disbursed, and its first instalment fallen due,
   * long enough ago for its days past due to have accrued by today.
   */
  readonly walkEndsDaysAgo?: bigint;
}

const SEEDS: readonly SeedSpec[] = [
  {
    applicationId: 'FR-00005101',
    nameEn: 'Qamar Lantern Crafts LLC',
    nameAr: 'قمر لصناعة الفوانيس ذ.م.م',
    sector: 'MANUFACTURING',
    years: 3,
    owner: 'Hessa R. Example',
    variant: 'SMALL_LOAN',
    purpose: 'EQUIPMENT',
    requestedAed: 250_000n,
    tenorMonths: 24,
    graceMonths: 0,
    contribution: 2_000,
    receivedDaysAgo: 1n,
    figures: {
      revenue: 1_800_000n,
      prior: 1_650_000n,
      profit: 320_000n,
      debtService: 40_000n,
      assets: 600_000n,
      liabilities: 380_000n,
      salary: 35_000n,
      obligations: 6_000n,
    },
    bureauScore: 742n,
    employees: 14,
    experience: 5n,
    sectorPriority: 'PRIORITY',
    collateralAed: 300_000n,
    reach: 'PROPOSED',
  },
  {
    applicationId: 'FR-00005102',
    nameEn: 'Sandglass Analytics FZ-LLC',
    nameAr: 'ساندغلاس للتحليلات م.م.ح',
    sector: 'SERVICES',
    years: 4,
    owner: 'Omar K. Example',
    variant: 'ADVANCED_TECH_AI',
    purpose: 'TECHNOLOGY_DEVELOPMENT',
    requestedAed: 600_000n,
    tenorMonths: 48,
    graceMonths: 6,
    contribution: 2_500,
    receivedDaysAgo: 3n,
    figures: {
      revenue: 3_200_000n,
      prior: 2_700_000n,
      profit: 640_000n,
      debtService: 70_000n,
      assets: 1_100_000n,
      liabilities: 700_000n,
      salary: 48_000n,
      obligations: 9_500n,
    },
    bureauScore: 768n,
    employees: 22,
    experience: 6n,
    sectorPriority: 'PRIORITY',
    collateralAed: 750_000n,
    reach: 'PARTLY_VERIFIED',
  },
  {
    applicationId: 'FR-00005103',
    nameEn: 'Twelve Palms Bakery LLC',
    nameAr: 'مخبز النخلات الاثنتي عشرة ذ.م.م',
    sector: 'TRADING',
    years: 6,
    owner: 'Mariam S. Example',
    variant: 'WORKING_CAPITAL',
    purpose: 'INVENTORY',
    requestedAed: 300_000n,
    tenorMonths: 12,
    graceMonths: 0,
    contribution: 2_000,
    receivedDaysAgo: 4n,
    figures: {
      revenue: 4_500_000n,
      prior: 4_100_000n,
      profit: 760_000n,
      debtService: 90_000n,
      assets: 1_300_000n,
      liabilities: 820_000n,
      salary: 40_000n,
      obligations: 7_000n,
    },
    bureauScore: 731n,
    employees: 30,
    experience: 8n,
    sectorPriority: 'NON_PRIORITY',
    collateralAed: 380_000n,
    reach: 'SUBMITTED',
  },
  {
    applicationId: 'FR-00005104',
    nameEn: 'Blue Dhow Logistics LLC',
    nameAr: 'الداو الأزرق للخدمات اللوجستية ذ.م.م',
    sector: 'SERVICES',
    years: 7,
    owner: 'Khalid A. Example',
    variant: 'EXPANSION',
    purpose: 'BUSINESS_EXPANSION',
    requestedAed: 1_200_000n,
    tenorMonths: 60,
    graceMonths: 6,
    contribution: 2_500,
    receivedDaysAgo: 9n,
    figures: {
      revenue: 7_400_000n,
      prior: 6_800_000n,
      profit: 980_000n,
      debtService: 120_000n,
      assets: 2_600_000n,
      liabilities: 1_700_000n,
      salary: 52_000n,
      obligations: 12_000n,
    },
    bureauScore: 756n,
    employees: 41,
    experience: 9n,
    sectorPriority: 'NON_PRIORITY',
    collateralAed: 1_500_000n,
    reach: 'ASSESSED',
  },
  {
    applicationId: 'FR-00005105',
    nameEn: 'Saltmarsh Fit-Out Works LLC',
    nameAr: 'سولت مارش لأعمال التجهيز ذ.م.م',
    sector: 'SERVICES',
    years: 5,
    owner: 'Noura M. Example',
    variant: 'FIXED_ASSETS',
    purpose: 'PREMISES_FIT_OUT',
    requestedAed: 450_000n,
    tenorMonths: 36,
    graceMonths: 3,
    contribution: 2_500,
    receivedDaysAgo: 6n,
    figures: {
      revenue: 3_900_000n,
      prior: 3_500_000n,
      profit: 720_000n,
      debtService: 55_000n,
      assets: 1_250_000n,
      liabilities: 760_000n,
      salary: 45_000n,
      obligations: 5_500n,
    },
    bureauScore: 781n,
    employees: 26,
    experience: 7n,
    sectorPriority: 'PRIORITY',
    collateralAed: 600_000n,
    reach: 'ASSESSED',
  },
  {
    applicationId: 'FR-00005106',
    nameEn: 'Lumen Date Farms LLC',
    nameAr: 'لومن لمزارع التمور ذ.م.م',
    sector: 'TRADING',
    years: 8,
    owner: 'Saeed H. Example',
    variant: 'SMALL_LOAN',
    purpose: 'WORKING_CAPITAL',
    requestedAed: 400_000n,
    tenorMonths: 36,
    graceMonths: 0,
    contribution: 2_000,
    receivedDaysAgo: 14n,
    figures: {
      revenue: 5_200_000n,
      prior: 4_800_000n,
      profit: 820_000n,
      debtService: 60_000n,
      assets: 1_600_000n,
      liabilities: 950_000n,
      salary: 42_000n,
      obligations: 6_500n,
    },
    bureauScore: 774n,
    employees: 33,
    experience: 10n,
    sectorPriority: 'PRIORITY',
    collateralAed: 520_000n,
    reach: 'OFFER_SENT',
  },
  {
    applicationId: 'FR-00005107',
    nameEn: 'Ibex Robotics Lab FZ-LLC',
    nameAr: 'آيبكس لمختبرات الروبوتات م.م.ح',
    sector: 'SERVICES',
    years: 4,
    owner: 'Layla F. Example',
    variant: 'ADVANCED_TECH_AI',
    purpose: 'EQUIPMENT',
    requestedAed: 480_000n,
    tenorMonths: 36,
    graceMonths: 3,
    contribution: 2_000,
    receivedDaysAgo: 40n,
    figures: {
      revenue: 3_600_000n,
      prior: 3_100_000n,
      profit: 700_000n,
      debtService: 50_000n,
      assets: 1_200_000n,
      liabilities: 700_000n,
      salary: 50_000n,
      obligations: 8_000n,
    },
    bureauScore: 790n,
    employees: 19,
    experience: 6n,
    sectorPriority: 'PRIORITY',
    collateralAed: 620_000n,
    reach: 'DISBURSED',
  },
  {
    applicationId: 'FR-00005108',
    nameEn: 'Mangrove Thread Textiles LLC',
    nameAr: 'خيوط المانغروف للمنسوجات ذ.م.م',
    sector: 'MANUFACTURING',
    years: 9,
    owner: 'Rashid T. Example',
    variant: 'FIXED_ASSETS',
    purpose: 'EQUIPMENT',
    requestedAed: 420_000n,
    tenorMonths: 48,
    graceMonths: 0,
    contribution: 2_000,
    receivedDaysAgo: 120n,
    figures: {
      revenue: 4_800_000n,
      prior: 4_400_000n,
      profit: 760_000n,
      debtService: 65_000n,
      assets: 1_500_000n,
      liabilities: 900_000n,
      salary: 38_000n,
      obligations: 6_000n,
    },
    bureauScore: 752n,
    employees: 48,
    experience: 11n,
    sectorPriority: 'NON_PRIORITY',
    collateralAed: 560_000n,
    reach: 'DISBURSED',
    daysPastDue: 34,
    walkEndsDaysAgo: 40n,
  },
];

// The illustrative seed's instants are the host clock's, written only where the seed itself is permitted.
const seedInstant = (epochSeconds: bigint): TsaInstant => hostClockInstant(epochSeconds);

/**
 * The seed's securities: whatever the variant requires, recorded by the
 * officer and confirmed by the checker, plus a cash deposit topping the
 * register's lending value up to the seed's collateral amount — so the
 * register reproduces the cover each illustrative case was designed with.
 */
async function seedSecurity(
  tenant: TenantCode,
  id: string,
  officer: string,
  checker: string,
  at: bigint,
  collateralMinor: bigint,
): Promise<void> {
  const r = bookOf(tenant).records.get(id);
  const policy = loadSecurityPolicy(tenant);
  if (r === undefined || !policy.ok) return;
  const status = await securityOf(tenant, r, at);
  if (!status.ok) return;
  const valuedAt = at - DAY;
  let lent = 0n;
  const collateral = async (kind: CollateralEntry['kind'], description: string, value: bigint) => {
    const v = await recordCollateralAt(
      tenant,
      id,
      { kind, description, marketValueMinorUnits: value, valuedAtEpochSeconds: valuedAt, valuerRef: `valuer-ILLUS-${id.slice(-4)}`, charge: 'NOT_APPLICABLE' },
      officer,
      at,
    );
    if (v.ok) {
      const item = v.value.security.collateral.at(-1);
      if (item !== undefined) {
        lent += lendingValue(item, policy.value).minorUnits;
        await confirmSecurityItemAt(tenant, id, item.itemId, checker, at);
      }
    }
  };
  for (const req of status.value.position.requirements) {
    const rule = policy.value.requirements[req.code];
    if (rule?.kind === 'GUARANTEE_FROM_EACH_OWNER') {
      for (const ref of req.missingOwners) {
        const g = await recordGuaranteeAt(tenant, id, { guarantorKind: 'PERSONAL', guarantorRef: ref, guarantorName: '' }, officer, at);
        const made = g.ok ? g.value.security.guarantees.at(-1) : undefined;
        if (made !== undefined) await confirmSecurityItemAt(tenant, id, made.guaranteeId, checker, at);
      }
    } else if (rule?.kind === 'COLLATERAL') {
      const value = rule.collateralKind === 'FINANCED_ASSET' ? collateralMinor : r.application.requested.minorUnits;
      await collateral(rule.collateralKind, `ILLUSTRATIVE ${rule.collateralKind.toLowerCase().replace(/_/g, ' ')}`, value);
    }
  }
  if (collateralMinor > lent) await collateral('CASH_DEPOSIT', 'ILLUSTRATIVE cash deposit under lien', collateralMinor - lent);
}

async function seedIllustrativeBook(tenant: TenantCode): Promise<void> {
  const now = developmentAttestation().epochSeconds;
  const officer = SEED_PRINCIPALS.officer;
  const checker = SEED_PRINCIPALS.checker;
  const ctx = tenantContext(tenant);
  const datePolicy = loadOfferDatePolicy(tenant);
  if (!ctx.ok || !datePolicy.ok) return;
  const profile = ctx.value.profile;
  for (const s of SEEDS) {
    const t0 = now - s.receivedDaysAgo * DAY;
    // Steps are spaced between receipt and the walk's end (today unless the seed says otherwise), so every instant is in the past.
    const span = (s.receivedDaysAgo - (s.walkEndsDaysAgo ?? 0n)) * DAY;
    const step = (n: bigint): TsaInstant => seedInstant(t0 + (span * n) / 12n + n * MINUTE);
    const handed = await handOverAt(
      tenant,
      {
        applicationId: s.applicationId,
        upstreamRef: `upstream-${s.applicationId}`,
        applicant: {
          businessNameEn: s.nameEn,
          businessNameAr: s.nameAr,
          registrationRef: `TL-ILLUS-${s.applicationId.slice(-4)}`,
          sector: s.sector,
          yearsInOperation: s.years,
          owners: [{ displayName: s.owner, ref: `owner-ILLUS-${s.applicationId.slice(-4)}` }],
          upstreamVerificationRefs: [
            `uaepass:assert-ILLUS-${s.applicationId.slice(-4)}`,
            `icp:verify-ILLUS-${s.applicationId.slice(-4)}`,
            `ner:licence-ILLUS-${s.applicationId.slice(-4)}`,
            `aecb:consent-ILLUS-${s.applicationId.slice(-4)}`,
          ],
        },
        productCode: 'sme-term-conventional',
        variantCode: s.variant,
        purpose: s.purpose,
        requestedMinorUnits: s.requestedAed * 100n,
        tenorMonths: s.tenorMonths,
        graceMonths: s.graceMonths,
        contributionPerTenThousand: s.contribution,
        contact: {
          partyRef: `owner-ILLUS-${s.applicationId.slice(-4)}`,
          emailMasked: 'o***@example.com',
          mobileMasked: '+971 50 XXX XXXX',
        },
      },
      'upstream-record-dev-01',
      seedInstant(t0),
    );
    if (!handed.ok) continue;
    const id = s.applicationId;
    const f = s.figures;
    const statement = `doc-ILLUS-${id.slice(-4)}-AUDITED_FINANCIALS_2Y`;
    // Read figures through the system path (statement OCR, rails); the one keyed figure by the officer.
    const read = await ingestReadFiguresAt(
      tenant,
      id,
      [
        {
          metric: 'ANNUAL_REVENUE',
          periodLabel: 'FY2025',
          minorUnits: f.revenue * 100n,
          sourceKind: 'OCR',
          sourceRef: statement,
        },
        {
          metric: 'PRIOR_YEAR_REVENUE',
          periodLabel: 'FY2024',
          minorUnits: f.prior * 100n,
          sourceKind: 'OCR',
          sourceRef: statement,
        },
        {
          metric: 'NET_PROFIT',
          periodLabel: 'FY2025',
          minorUnits: f.profit * 100n,
          sourceKind: 'OCR',
          sourceRef: statement,
        },
        {
          metric: 'TOTAL_DEBT_SERVICE',
          periodLabel: 'FY2025',
          minorUnits: f.debtService * 100n,
          sourceKind: 'RAIL',
          sourceRef: `aecb:report-ILLUS-${id.slice(-4)}`,
        },
        {
          metric: 'CURRENT_ASSETS',
          periodLabel: 'FY2025',
          minorUnits: f.assets * 100n,
          sourceKind: 'OCR',
          sourceRef: statement,
        },
        {
          metric: 'CURRENT_LIABILITIES',
          periodLabel: 'FY2025',
          minorUnits: f.liabilities * 100n,
          sourceKind: 'OCR',
          sourceRef: statement,
        },
        {
          metric: 'MONTHLY_GROSS_SALARY',
          periodLabel: '2026-09',
          minorUnits: f.salary * 100n,
          sourceKind: 'RAIL',
          sourceRef: `mohre:wps-ILLUS-${id.slice(-4)}`,
        },
      ],
      READ_FIGURE_SOURCES.ocr,
      step(1n),
    );
    const proposed = read.ok
      ? await proposeFiguresAt(
          tenant,
          id,
          [
            {
              metric: 'MONTHLY_DEBT_OBLIGATIONS',
              periodLabel: '2026-09',
              minorUnits: f.obligations * 100n,
              sourceKind: 'OFFICER_ENTRY',
              sourceRef: `doc-ILLUS-${id.slice(-4)}-PERSONAL_BUREAU_REPORT`,
            },
          ],
          officer,
          step(1n),
        )
      : read;
    if (!proposed.ok || s.reach === 'PROPOSED') {
      await presentDocumentAt(
        tenant,
        id,
        { documentType: 'TRADE_LICENCE', documentRef: `doc-ILLUS-${id.slice(-4)}-TRADE_LICENCE` },
        officer,
        step(1n),
      );
      continue;
    }

    // Verify: the officer-keyed figure by the checker (four eyes); the read figures by the officer.
    const toVerify = proposed.value.figures.filter((v) => !isVerified(v.figure));
    const limit = s.reach === 'PARTLY_VERIFIED' ? 4 : toVerify.length;
    for (const v of toVerify.slice(0, limit)) {
      const verifier = v.figure.sourceKind === 'OFFICER_ENTRY' ? checker : officer;
      await verifyFigureAt(tenant, id, v.figureId, verifier, undefined, step(2n));
    }

    // Documents: every item of the variant's checklist, by reference, presented by the officer and validated by the checker.
    const checklist = await checklistOf(tenant, bookOf(tenant).records.get(id) as BusinessRecord, step(2n));
    if (checklist.ok) {
      const items =
        s.reach === 'PARTLY_VERIFIED'
          ? checklist.value.checklist.items.slice(0, 5)
          : checklist.value.checklist.items.filter((i) => i.required);
      for (const item of items) {
        const documentRef = `doc-ILLUS-${id.slice(-4)}-${item.documentType}`;
        await presentDocumentAt(tenant, id, { documentType: item.documentType, documentRef }, officer, step(2n));
        await validateDocumentAt(tenant, id, documentRef, 'VALID', checker, step(2n));
      }
    }
    if (s.reach === 'PARTLY_VERIFIED') continue;

    await recordAssessmentInputsAt(
      tenant,
      id,
      {
        bureau: {
          reportRef: `aecb:report-ILLUS-${id.slice(-4)}`,
          consentId: `aecb:consent-ILLUS-${id.slice(-4)}`,
          score: s.bureauScore,
        },
        fullTimeEmployees: s.employees,
        relevantExperienceYears: s.experience,
        sectorPriority: s.sectorPriority,
        auditedFinancialsAvailable: true,
        commitmentRatioPerTenThousand: 10_200n,
        riskAnalysisScorePerTenThousand: 7_400n,
        portfolioRepaymentPerTenThousand: 8_600n,
        failedFilesRatePerTenThousand: 800n,
        collateralValueMinorUnits: s.collateralAed * 100n,
      },
      officer,
      step(3n),
    );
    await seedSecurity(tenant, id, officer, checker, step(3n).epochSeconds, s.collateralAed * 100n);
    const submitted = await submitAt(tenant, id, officer, step(4n));
    if (!submitted.ok || s.reach === 'SUBMITTED') continue;

    const assessed = await runAssessmentAt(tenant, id, checker, step(5n));
    if (!assessed.ok) continue;
    // Credit justifies each deviation the assessment recorded; the committee (another person) then approves.
    if (assessed.value.application.status === 'IN_COMMITTEE') {
      const rec = bookOf(tenant).records.get(id);
      if (rec !== undefined)
        for (const d of deviationsFor(rec)) {
          const text = 'ILLUSTRATIVE — mitigated by the confirmed security and the owners’ personal guarantees';
          const at = step(5n).epochSeconds;
          rec.pack.justifications[d.code] = { text, by: checker, atEpochSeconds: at };
          recordEvent(bookOf(tenant), rec, {
            eventType: 'DEVIATION_JUSTIFIED',
            fromStage: null,
            toStage: null,
            actor: checker,
            atEpochSeconds: at,
            detail: { code: d.code, text },
          });
        }
    }
    if (s.reach === 'ASSESSED') continue;

    const status = assessed.value.application.status;
    const decided =
      status === 'ASSESSED'
        ? await approveAt(tenant, id, checker, step(6n))
        : status === 'IN_COMMITTEE'
          ? await decideAt(
              tenant,
              id,
              {
                decidedBy: SEED_PRINCIPALS.committee,
                approved: true,
                reason: 'ILLUSTRATIVE — within risk-aligned terms; collateral cover adequate',
              },
              step(6n),
            )
          : undefined;
    if (decided === undefined || !decided.ok) continue;

    // A facility the seed disburses is offered for disbursement on the day it is paid out — never paid before its planned
    // date. One in arrears falls first due at the policy's earliest, so its days past due accrue from a date in the past.
    const disbursementDays = daysOfIso(localDate(step(10n).epochSeconds, profile)) ?? 0n;
    const firstDueDays = disbursementDays + datePolicy.value.minFirstDueAfterDisbursementDays;
    const offerOptions: OfferOptions =
      s.reach !== 'DISBURSED'
        ? {}
        : {
            disbursementDate: isoOfDays(disbursementDays),
            ...(s.daysPastDue === undefined ? {} : { firstDueDate: isoOfDays(firstDueDays) }),
          };
    const offered = await generateOfferAt(tenant, id, officer, offerOptions, step(7n));
    if (!offered.ok) continue;
    const sent = await sendOfferAt(tenant, id, officer, step(8n));
    if (!sent.ok || s.reach === 'OFFER_SENT') continue;

    const version = sent.value.latestOffer?.letter.version ?? '';
    const signed = await signAt(tenant, id, { letterVersion: version }, officer, step(9n));
    if (!signed.ok) continue;
    // The payee account: recorded by the officer against a document on file, confirmed by the checker.
    // AE07 0331 2345 6789 0123 456 is the published example UAE IBAN — synthetic, it pays no one.
    const evidence = signed.value.documents[0]?.documentRef;
    if (evidence !== undefined) {
      await recordPayeeAt(tenant, id, { iban: 'AE070331234567890123456', accountName: s.nameEn, evidenceRef: evidence }, officer, step(9n).epochSeconds);
      await confirmPayeeAt(tenant, id, checker, step(9n).epochSeconds);
    }
    const disbursed = await disburseAt(tenant, id, SEED_PRINCIPALS.finance, undefined, step(10n));
    if (!disbursed.ok) continue;
    if (s.daysPastDue !== undefined) {
      // Observed on the day the arrears reach the seed's days past due, counted from the first due date — never after today.
      const todayDays = daysOfIso(localDate(now, profile)) ?? 0n;
      const observedDays =
        firstDueDays + BigInt(s.daysPastDue) < todayDays ? firstDueDays + BigInt(s.daysPastDue) : todayDays;
      const daysPastDue = Number(observedDays - firstDueDays);
      if (daysPastDue <= 0) continue;
      const observedAt = observedDays * DAY + 12n * HOUR - (OFFSET_SECONDS[profile.timeZone] ?? 0n);
      const instalment = disbursed.value.latestOffer?.terms.monthlyInstalment.minorUnits ?? 0n;
      await portfolioAt(
        tenant,
        id,
        { daysPastDue, arrearsMinorUnits: instalment },
        'loan-system-fixture',
        seedInstant(observedAt < now ? observedAt : now),
      );
    }
  }
}
