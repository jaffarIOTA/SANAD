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
 * once per process, changes are marked, and `flushBusiness()` writes them in
 * one transaction before the response that reports them (the server actions
 * and the hand-over API settle before they answer).
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

import { type TenantCode, loadDocumentChecklist, loadJurisdictionProfile, loadProductCatalogue, loadSmeAssessmentPolicy, loadSmeDefinition, loadTenantOnboarding } from '@sanad/config/loader.ts';
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
import { type SmeAssessment, type SmeAssessmentFacts, assessSme } from '@sanad/core/decisioning/sme-assessment.ts';
import { type DocumentChecklist, type ItemReport, type PresentedDocument, blockingItems, checklistReport, isChecklistComplete } from '@sanad/core/documents/checklist.ts';
import { type OfferLetter, buildOfferLetter } from '@sanad/core/documents/offer-letter.ts';
import type { JurisdictionProfile } from '@sanad/core/jurisdiction/profile.ts';
import { type CurrencyCode, type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type OfferNotificationRecipient, type OfferNotifications, buildOfferNotifications, isMaskedEmail, isMaskedMobile, previewOfferNotifications } from '@sanad/core/notifications/offer-notification.ts';
import {
  type BusinessApplicant,
  type BusinessApplication,
  type BusinessStage,
  type StageEvent,
  type Transition,
  approveStraightThrough as approveStraightThroughCore,
  containsIdentityNumber,
  decideInCommittee as decideInCommitteeCore,
  receiveHandover,
  recordAssessment,
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
import type { ProductCatalogue } from '@sanad/core/products/catalogue.ts';
import { buildOffer } from '@sanad/core/products/offer.ts';
import { type TsaInstant, tsaInstant } from '@sanad/core/time/tsa.ts';
import { resolveProductCatalogue } from '@sanad/origination/catalogue.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { smeTermConventional } from '@sanad/products/sme-term-conventional/index.ts';
import type { SmeVariant } from '@sanad/products/sme-term-conventional/variants.ts';

import { postgresOutboxStore } from '../../../../services/outbox/src/postgres-store.ts';
import { type ApplicationEvent, type ApplicationVersion, type FigureRow, type PersistedAssessment, type PersistedOffer, illustrativeSeedPermitted, loadBusinessBook, saveBusinessChanges } from './business-persistence.ts';
import { persistencePool, persistenceUrl } from './persistence.ts';
import { CHECKER, MAKER } from './session.ts';
import { developmentAttestation } from './store.ts';

export type { ApplicationEvent, FigureRow } from './business-persistence.ts';
export type { SmeVariant } from '@sanad/products/sme-term-conventional/variants.ts';

// =============================================================================
// Roles and the pipeline
// =============================================================================

/**
 * The development principals the business screens act as. Distinct people, so
 * four eyes is exercised rather than asserted: the officer keys figures,
 * presents documents, records the assessment inputs and submits; the checker
 * verifies keyed figures, validates documents, runs the assessment and
 * approves straight-through cases; the committee member decides referred
 * cases; the finance principal releases disbursement — never the approver.
 */
export const BUSINESS_ROLES = {
  officer: MAKER.principalId,
  checker: CHECKER.principalId,
  committee: 'stf-committee-01',
  finance: 'stf-finance-01',
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
  { stage: 1, titleEn: 'Application', titleAr: 'الطلب', owner: 'UPSTREAM', targetSeconds: 10n * MINUTE, targetEn: '~10 minutes', targetAr: 'نحو 10 دقائق' },
  { stage: 2, titleEn: 'Needs assessment', titleAr: 'تقييم الاحتياجات', owner: 'UPSTREAM', targetSeconds: 10n * MINUTE, targetEn: '~10 minutes', targetAr: 'نحو 10 دقائق' },
  { stage: 3, titleEn: 'Product application', titleAr: 'طلب المنتج', owner: 'UPSTREAM', targetSeconds: 20n * MINUTE, targetEn: '~20 minutes', targetAr: 'نحو 20 دقيقة' },
  { stage: 4, titleEn: 'Verification', titleAr: 'التحقق', owner: 'UPSTREAM', targetSeconds: 48n * HOUR, targetEn: 'up to 48 hours', targetAr: 'حتى 48 ساعة' },
  { stage: 5, titleEn: 'Credit assessment', titleAr: 'التقييم الائتماني', owner: 'SANAD', targetSeconds: 5n * DAY, targetEn: 'up to 5 days', targetAr: 'حتى 5 أيام' },
  { stage: 6, titleEn: 'Decisioning (credit committee)', titleAr: 'القرار (لجنة الائتمان)', owner: 'SANAD', targetSeconds: 10n * DAY, targetEn: 'up to 10 days', targetAr: 'حتى 10 أيام' },
  { stage: 7, titleEn: 'Contract & disbursement', titleAr: 'العقد والصرف', owner: 'SANAD', targetSeconds: 5n * DAY, targetEn: 'up to 5 days', targetAr: 'حتى 5 أيام' },
  { stage: 8, titleEn: 'Portfolio management', titleAr: 'إدارة المحفظة', owner: 'SANAD', targetEn: 'ongoing', targetAr: 'مستمر' },
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
  readonly bureau: { readonly reportRef: string; readonly consentId: string; readonly score: bigint; readonly source: 'AECB_FIXTURE' };
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

export type AssessmentInputsEntry = Omit<AssessmentInputs, 'recordedBy' | 'recordedAtEpochSeconds' | 'collateralValue' | 'bureau'> & {
  readonly bureau: { readonly reportRef: string; readonly consentId: string; readonly score: bigint };
  readonly collateralValueMinorUnits: bigint;
};

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
  /** The rate snapshot, integer basis points, and its source reference. Shown, never applied here. */
  readonly rateBp: bigint;
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
  /** 9 when the loan system reports arrears; the application's stage otherwise. */
  readonly displayStage: BusinessStage;
  readonly currency: CurrencyCode;
  readonly contact: OfferNotificationRecipient;
  /** The current figure per metric, superseded rows left out. */
  readonly figures: readonly FigureView[];
  readonly documents: readonly BusinessDocument[];
  readonly assessmentInputs?: AssessmentInputs;
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

// =============================================================================
// State
// =============================================================================

interface BusinessRecord {
  application: BusinessApplication;
  contact: OfferNotificationRecipient;
  figures: FigureRow[];
  documents: BusinessDocument[];
  inputs?: AssessmentInputs;
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
const state: BusinessState = (scope[KEY] ??= { books: new Map(), outbox: emptyOutbox(), outboxStore: inMemoryOutboxStore(), outboxOnDatabase: false });

function bookOf(tenant: TenantCode): TenantBook {
  let book = state.books.get(tenant);
  if (book === undefined) {
    book = { records: new Map(), hydrated: false, seeded: false, dirty: new Set(), unsavedFigures: [], unsavedAssessments: [], unsavedOffers: [], unsavedEvents: [], unsavedOutbox: [] };
    state.books.set(tenant, book);
  }
  return book;
}

/** The database pool the book is written to, if any. */
const poolOf = (): Pool | undefined => state.pool ?? persistencePool();

/** Set while the illustrative seed runs for a tenant: the seed's own calls must not wait on the hydration that started it. */
const seeding = new AsyncLocalStorage<string>();

/** Where the business book lives: the database when one is configured, this process's memory otherwise. */
export const businessBacking = (): 'POSTGRESQL' | 'MEMORY' => (persistenceUrl() === undefined ? 'MEMORY' : 'POSTGRESQL');

// =============================================================================
// Small helpers
// =============================================================================

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> => reject('OP-DETERMINACY', reason, detail, context);
const notFound = (applicationId: string): Result<never> => fail('BUSINESS_APPLICATION_NOT_FOUND', 'No business application with that id for this institution', { applicationId });

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;

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
  return ok({ currency: onboarding.value.baseCurrency, profile: profile.value, legalNameEn: onboarding.value.legalNameEn, legalNameAr: onboarding.value.legalNameAr });
}

/** The tenant's catalogue: the approved revision in force when a database is configured, the checked-in file otherwise. */
async function catalogueFor(tenant: TenantCode, at: TsaInstant): Promise<Result<ProductCatalogue>> {
  if (persistenceUrl() === undefined) return loadProductCatalogue(tenant);
  return (await resolveProductCatalogue(tenant, at.epochSeconds)).catalogue;
}

interface ProductContext {
  readonly entry: ProductCatalogue['entries'][number];
  readonly variant: SmeVariant;
  readonly terms: Parameters<typeof smeTermConventional.quote>[0];
}

/**
 * The catalogue entry, its parsed term sheet and the variant. Only the
 * conventional SME module is quoted here: the Islamic module is disabled in
 * the fund's catalogue until its board ruling is recorded (a hand-over for it
 * is refused, not quietly priced as conventional).
 */
async function productFor(tenant: TenantCode, productCode: string, variantCode: string, at: TsaInstant): Promise<Result<ProductContext>> {
  const catalogue = await catalogueFor(tenant, at);
  if (!catalogue.ok) return catalogue;
  const entry = catalogue.value.entries.find((e) => e.productCode === productCode);
  if (entry === undefined || !entry.enabled) return fail('PRODUCT_NOT_IN_CATALOGUE', 'The product is not enabled in this institution’s catalogue', { productCode });
  if (productCode !== smeTermConventional.descriptor.code) return fail('PRODUCT_NOT_QUOTED_HERE', 'Business applications are quoted through the conventional SME module only', { productCode });
  const terms = smeTermConventional.validateTerms(entry.terms);
  if (!terms.ok) return terms;
  const variant = terms.value.variants.find((v) => v.code === variantCode);
  if (variant === undefined) return fail('VARIANT_UNKNOWN', 'No such variant of this product', { variantCode });
  return ok({ entry, variant, terms: terms.value });
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
const isoOfDays = (days: bigint): string => { const c = civilFromDays(days); return `${pad(c.y, 4)}-${pad(c.m, 2)}-${pad(c.d, 2)}`; };
function daysOfIso(iso: string): bigint | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m === null ? undefined : daysFromCivil(BigInt(m[1] ?? '0'), BigInt(m[2] ?? '0'), BigInt(m[3] ?? '0'));
}

/** The calendar date of an instant in the jurisdiction's time zone. */
function localDate(at: bigint, profile: JurisdictionProfile): string {
  const local = at + (OFFSET_SECONDS[profile.timeZone] ?? 0n);
  return isoOfDays(local >= 0n ? local / DAY : (local - DAY + 1n) / DAY);
}

/** The first of a month at least fifteen days after the disbursement date: the default first due date, paying on the 1st. */
function defaultFirstDue(disbursement: string): string {
  const days = daysOfIso(disbursement) ?? 0n;
  const c = civilFromDays(days);
  let y = c.y; let m = c.m + 1n;
  if (m > 12n) { m = 1n; y += 1n; }
  let candidate = daysFromCivil(y, m, 1n);
  if (candidate - days < 15n) { m += 1n; if (m > 12n) { m = 1n; y += 1n; } candidate = daysFromCivil(y, m, 1n); }
  return isoOfDays(candidate);
}

/** ILLUSTRATIVE defaults until the fund's operations manual states its own. */
const DEFAULT_DISBURSEMENT_AFTER_OFFER_DAYS = 14n;
const DEFAULT_OFFER_VALIDITY_DAYS = 30n;

/**
 * ILLUSTRATIVE bounds on the dates an officer may choose for an offer, until
 * the tenant's credit policy states its own (they belong in its policy
 * configuration, not here): disbursement on or after the offer date and
 * within 60 days of it; the first instalment 15 to 45 days after disbursement.
 */
export const OFFER_DATE_BOUNDS = { maxDisbursementAfterOfferDays: 60n, minFirstDueAfterDisbursementDays: 15n, maxFirstDueAfterDisbursementDays: 45n } as const;

/** The offer's dates against the bounds, each refusal typed. */
export function checkOfferDates(offerDate: string, disbursementDate: string, firstDueDate: string): Result<true> {
  const offer = daysOfIso(offerDate);
  const disbursement = daysOfIso(disbursementDate);
  const firstDue = daysOfIso(firstDueDate);
  if (offer === undefined || disbursement === undefined || firstDue === undefined || isoOfDays(disbursement) !== disbursementDate || isoOfDays(firstDue) !== firstDueDate) {
    return fail('OFFER_DATE_MALFORMED', 'Dates are calendar dates as YYYY-MM-DD', { disbursementDate, firstDueDate });
  }
  if (disbursement < offer) return fail('DISBURSEMENT_BEFORE_OFFER', 'The disbursement date is on or after the offer date', { offerDate, disbursementDate });
  if (disbursement - offer > OFFER_DATE_BOUNDS.maxDisbursementAfterOfferDays) return fail('DISBURSEMENT_TOO_FAR', 'The disbursement date is within 60 days of the offer date (ILLUSTRATIVE bound)', { offerDate, disbursementDate });
  if (firstDue - disbursement < OFFER_DATE_BOUNDS.minFirstDueAfterDisbursementDays) return fail('FIRST_DUE_TOO_SOON', 'The first instalment falls at least 15 days after disbursement (ILLUSTRATIVE bound)', { disbursementDate, firstDueDate });
  if (firstDue - disbursement > OFFER_DATE_BOUNDS.maxFirstDueAfterDisbursementDays) return fail('FIRST_DUE_TOO_LATE', 'The first instalment falls at most 45 days after disbursement (ILLUSTRATIVE bound)', { disbursementDate, firstDueDate });
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

function recordEvent(book: TenantBook, record: BusinessRecord, e: Omit<ApplicationEvent, 'eventId' | 'sequence'>): ApplicationEvent {
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
  recordEvent(book, record, { eventType: s.eventType, fromStage: s.fromStage, toStage: s.toStage, actor: s.actor, atEpochSeconds: s.atEpochSeconds, detail: s.detail });
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
  const inCollections = record.application.status === 'DISBURSED' && record.portfolio !== undefined && record.portfolio.daysPastDue > 0;
  return {
    application: record.application,
    displayStage: inCollections ? 9 : record.application.stage,
    currency,
    contact: record.contact,
    figures: currentFigures(record).map((f) => ({ figureId: f.rowId, figure: f.figure, ...(f.supersedes === undefined ? {} : { supersedes: f.supersedes }) })),
    documents: [...record.documents],
    ...(record.inputs === undefined ? {} : { assessmentInputs: record.inputs }),
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
  if (book.records.size === 0 && !book.seeded && tenant === SEED_TENANT && (pool === undefined || await illustrativeSeedPermitted(pool))) {
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
    book.records.set(application.applicationId, { application, contact: { partyRef: firstOwner }, figures: [], documents: [], assessments: [], offers: [], events: [], ...(stored === undefined ? {} : { stored }) });
  }
  for (const f of persisted.figures) {
    const r = book.records.get(f.applicationId);
    if (r !== undefined) r.figures.push({ rowId: f.rowId, figure: f.figure, createdBy: f.createdBy, ...(f.supersedes === undefined ? {} : { supersedes: f.supersedes }) });
  }
  for (const a of persisted.assessments) {
    const r = book.records.get(a.applicationId);
    const trace = a.trace as Omit<AssessmentRun, 'assessmentId' | 'assessedBy' | 'assessedAtEpochSeconds'>;
    if (r !== undefined) r.assessments.push({ ...trace, assessmentId: a.assessmentId, assessedBy: a.assessedBy, assessedAtEpochSeconds: a.assessedAtEpochSeconds });
  }
  for (const o of persisted.offers) {
    const r = book.records.get(o.applicationId);
    const held = o.letter as { readonly letter: OfferLetter; readonly terms: OfferTerms; readonly createdAtEpochSeconds: bigint };
    if (r !== undefined) r.offers.push({ offerId: o.offerId, letter: held.letter, terms: held.terms, schedule: o.schedule as DatedSchedule, createdBy: o.createdBy, createdAtEpochSeconds: held.createdAtEpochSeconds });
  }
  for (const r of book.records.values()) r.offers.sort((a, b) => (a.createdAtEpochSeconds < b.createdAtEpochSeconds ? -1 : a.createdAtEpochSeconds > b.createdAtEpochSeconds ? 1 : 0));
  for (const e of persisted.events) {
    const r = book.records.get(e.applicationId);
    if (r === undefined) continue;
    const { applicationId: _a, ...event } = e;
    r.events.push(event);
    replayEvent(r, event);
  }
}

/** Rebuilds what is recorded only as an event: contact, documents, assessment inputs, portfolio status. */
function replayEvent(r: BusinessRecord, e: ApplicationEvent): void {
  const d = e.detail;
  switch (e.eventType) {
    case 'CONTACT_RECORDED':
      r.contact = { partyRef: d['partyRef'] ?? r.contact.partyRef, ...(d['emailMasked'] === undefined ? {} : { emailMasked: d['emailMasked'] }), ...(d['mobileMasked'] === undefined ? {} : { mobileMasked: d['mobileMasked'] }) };
      return;
    case 'DOCUMENT_PRESENTED':
      r.documents.push({
        documentType: d['documentType'] ?? '',
        documentRef: d['documentRef'] ?? '',
        validationStatus: (d['validationStatus'] ?? 'PENDING') as BusinessDocument['validationStatus'],
        capturedAt: tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(d['capturedAtEpoch'] ?? '0'), tokenDigest: d['capturedTokenDigest'] ?? '', authorityId: d['capturedAuthority'] ?? '' }),
        presentedBy: e.actor,
      });
      return;
    case 'DOCUMENT_VALIDATED':
      markValidated(r, d['documentRef'] ?? '', (d['validationStatus'] ?? 'PENDING') as BusinessDocument['validationStatus'], e.actor);
      return;
    case 'ASSESSMENT_INPUTS_RECORDED':
      r.inputs = {
        bureau: { reportRef: d['bureauReportRef'] ?? '', consentId: d['bureauConsentId'] ?? '', score: BigInt(d['bureauScore'] ?? '0'), source: 'AECB_FIXTURE' },
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
    case 'PORTFOLIO_STATUS_RECORDED':
      r.portfolio = { daysPastDue: Number.parseInt(d['daysPastDue'] ?? '0', 10), arrears: money(BigInt(d['arrearsMinorUnits'] ?? '0'), r.application.requested.currency), recordedBy: e.actor, asOfEpochSeconds: e.atEpochSeconds };
      return;
    default:
      return;
  }
}

/** The most recent presentation of a document reference takes the checker's status. */
function markValidated(r: BusinessRecord, documentRef: string, status: BusinessDocument['validationStatus'], validator: string): void {
  for (let i = r.documents.length - 1; i >= 0; i -= 1) {
    const doc = r.documents[i];
    if (doc !== undefined && doc.documentRef === documentRef) {
      r.documents[i] = { ...doc, validationStatus: status, validatedBy: validator };
      return;
    }
  }
}

function isUuid(s: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }

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
      for (const e of events) mapped.push(isUuid(e.tenantId) ? e : { ...e, tenantId: await tenantUuidByCode(pool, e.tenantId) });
      await durable.append(mapped);
    },
  };
  state.outboxOnDatabase = true;
}

/**
 * Writes every change since the last flush, in one transaction per tenant —
 * the outbox rows those changes caused included, so a side effect is durable
 * exactly when its cause is. A failed write keeps the changes marked, so the
 * next flush retries them, and rethrows so the caller does not report a
 * change that is not durable.
 *
 * If another process changed an application since this one loaded it, nothing
 * of that tenant's batch is written: this process's working set for the
 * tenant is discarded (the next read reloads it from the database) and the
 * flush answers STALE_APPLICATION, so the caller reports a refusal rather than
 * a change that did not happen.
 *
 * In memory there is nothing to conflict with: the queued side effects go to
 * the in-memory outbox store in the same step as the marks are cleared.
 */
export async function flushBusiness(): Promise<Result<true>> {
  const pool = poolOf();
  let stale: Result<never> | undefined;
  if (pool !== undefined) {
    for (const [tenant, book] of [...state.books]) {
      const dirty = [...book.dirty].flatMap((id) => { const r = book.records.get(id); return r === undefined ? [] : [r]; });
      const applications = dirty.map((r) => ({ application: r.application, ...(r.stored === undefined ? {} : { expected: r.stored }) }));
      const figures = [...book.unsavedFigures];
      const assessments = [...book.unsavedAssessments];
      const offers = [...book.unsavedOffers];
      const events = [...book.unsavedEvents];
      const outbox = [...book.unsavedOutbox];
      const saved = await saveBusinessChanges(pool, tenant, { applications, figures, assessments, offers, events, outbox });
      if (saved.kind === 'STALE') {
        // Discard what this process holds for the tenant; the next read loads the current state.
        state.books.delete(tenant);
        const dropped = new Set(book.unsavedOutbox.map((e) => e.eventId));
        state.outbox = { events: state.outbox.events.filter((e) => !dropped.has(e.eventId)) };
        stale ??= fail('STALE_APPLICATION', 'The application was changed elsewhere since this screen loaded it; nothing was saved. Reload and try again', { applicationId: saved.applicationId });
        continue;
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
    }
    useDatabaseOutbox();
  } else {
    for (const book of state.books.values()) {
      const outbox = book.unsavedOutbox;
      book.dirty.clear(); book.unsavedFigures = []; book.unsavedAssessments = []; book.unsavedOffers = []; book.unsavedEvents = []; book.unsavedOutbox = [];
      if (outbox.length > 0) await state.outboxStore.append(outbox);
    }
  }
  return stale ?? ok(true);
}

/** Loads the tenant's book (once) and writes anything pending. Awaited by pages and routes before they read. */
export async function syncBusiness(tenant: TenantCode): Promise<void> {
  await hydrate(tenant);
  // A stale batch has already been discarded and is reloaded by the next read; the page shows the current state.
  const settled = await flushBusiness();
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
    .sort((a, b) => (a.application.receivedAtEpochSeconds > b.application.receivedAtEpochSeconds ? -1 : a.application.receivedAtEpochSeconds < b.application.receivedAtEpochSeconds ? 1 : 0));
}

export async function getApplication(tenant: TenantCode, applicationId: string): Promise<BusinessApplicationView | undefined> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant);
  const r = book.records.get(applicationId);
  return r === undefined || !ctx.ok ? undefined : view(r, ctx.value.currency);
}

function readinessOf(record: BusinessRecord, currency: CurrencyCode): FigureReadiness {
  const current = currentFigures(record);
  const present = new Set(current.map((f) => f.figure.metric));
  const missingFigures = FULL_SPREAD_METRICS.filter((m) => !present.has(m));
  const unverifiedFigures = FULL_SPREAD_METRICS.filter((m) => present.has(m) && !current.some((f) => f.figure.metric === m && isVerified(f.figure)));
  const spread = completeSpread(current.map((f) => f.figure), FULL_SPREAD_METRICS, currency);
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
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  return ok(readinessOf(r, ctx.value.currency));
}

async function checklistOf(tenant: TenantCode, record: BusinessRecord, at: TsaInstant): Promise<Result<ChecklistStatus>> {
  const product = await productFor(tenant, record.application.productCode, record.application.variantCode, at);
  if (!product.ok) return product;
  const ref = product.value.variant.documentChecklistRef;
  if (ref === undefined) return fail('DOCUMENT_CHECKLIST_NOT_FOUND', 'The variant names no document checklist', { variantCode: record.application.variantCode });
  const checklist = loadDocumentChecklist(tenant, ref);
  if (!checklist.ok) return checklist;
  const report = checklistReport(checklist.value, record.documents, at);
  return ok({ checklist: checklist.value, report, complete: isChecklistComplete(report), missing: blockingItems(report).map((i) => i.item.documentType) });
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
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  return checklistOf(tenant, r, developmentAttestation());
}

// =============================================================================
// Stage 5: hand-over, figures, documents, inputs, submission
// =============================================================================

async function handOverAt(tenant: TenantCode, request: HandoverRequest, actor: string, at: TsaInstant): Promise<Result<{ readonly view: BusinessApplicationView; readonly created: boolean }>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const currency = ctx.value.currency;

  // No identity number anywhere in what was handed over — the contact and the upstream reference as much as the applicant.
  if (containsIdentityNumber(request)) return fail('IDENTITY_NUMBER_IN_PAYLOAD', 'An identity number does not belong in the application record; send a reference');

  // Idempotent on the upstream reference: the same hand-over twice is the same application.
  const existing = [...book.records.values()].find((r) => r.application.upstreamRef === request.upstreamRef);
  if (existing !== undefined) {
    if (existing.application.applicationId !== request.applicationId) return fail('UPSTREAM_REF_REUSED', 'This upstream reference already handed over a different application', { upstreamRef: request.upstreamRef });
    return ok({ view: view(existing, currency), created: false });
  }
  if (book.records.has(request.applicationId)) return fail('APPLICATION_ID_TAKEN', 'An application with this id was handed over under a different upstream reference', { applicationId: request.applicationId });

  const product = await productFor(tenant, request.productCode, request.variantCode, at);
  if (!product.ok) return product;
  if (!product.value.variant.purposes.some((p) => p.code === request.purpose)) return reject('OP-LIMIT', 'PURPOSE_NOT_ALLOWED', 'This variant does not finance that purpose', { variantCode: request.variantCode, purpose: request.purpose });

  const contact: OfferNotificationRecipient = request.contact ?? { partyRef: request.applicant.owners[0]?.ref ?? request.applicationId };
  if (!REF_SHAPE.test(contact.partyRef)) return fail('CONTACT_PARTY_REF_INVALID', 'The contact is a party reference');
  if (contact.emailMasked !== undefined && !isMaskedEmail(contact.emailMasked)) return fail('CONTACT_EMAIL_NOT_MASKED', 'An email address is carried masked only');
  if (contact.mobileMasked !== undefined && !isMaskedMobile(contact.mobileMasked)) return fail('CONTACT_MOBILE_NOT_MASKED', 'A mobile number is carried masked only');

  // The amount is in the tenant's currency. A stated currency is checked by the domain, never adopted.
  const stated = request.currency ?? currency;
  const t = receiveHandover({
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
  }, currency, actor, at.epochSeconds);
  if (!t.ok) return t;

  const record: BusinessRecord = { application: t.value.application, contact, figures: [], documents: [], assessments: [], offers: [], events: [] };
  book.records.set(request.applicationId, record);
  apply(book, record, t.value);
  recordEvent(book, record, {
    eventType: 'CONTACT_RECORDED', fromStage: null, toStage: null, actor, atEpochSeconds: at.epochSeconds,
    detail: { partyRef: contact.partyRef, ...(contact.emailMasked === undefined ? {} : { emailMasked: contact.emailMasked }), ...(contact.mobileMasked === undefined ? {} : { mobileMasked: contact.mobileMasked }) },
  });
  return ok({ view: view(record, currency), created: true });
}

/**
 * Receive an application from upstream at stage 5. Idempotent on
 * `upstreamRef`: a repeat returns the same application with `created: false`.
 */
export async function handOver(tenant: TenantCode, request: HandoverRequest, actor: string): Promise<Result<{ readonly view: BusinessApplicationView; readonly created: boolean }>> {
  return handOverAt(tenant, request, actor, developmentAttestation());
}

function startSpreadingIfReceived(book: TenantBook, record: BusinessRecord, actor: string, at: bigint): Result<true> {
  if (record.application.status !== 'RECEIVED') return ok(true);
  const t = startSpreading(record.application, actor, at);
  if (!t.ok) return t;
  apply(book, record, t.value);
  return ok(true);
}

const SPREAD_OPEN = new Set(['RECEIVED', 'SPREADING']);

async function proposeFiguresAt(tenant: TenantCode, applicationId: string, entries: readonly FigureProposalEntry[], actor: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  if (!SPREAD_OPEN.has(r.application.status)) return fail('TRANSITION_NOT_ALLOWED', 'Figures are proposed only while the application is in credit assessment', { status: r.application.status });
  if (entries.length === 0) return fail('FIGURES_EMPTY', 'Propose at least one figure');

  // Validate every proposal before recording any: a batch is recorded whole or not at all.
  const figures: FinancialFigure[] = [];
  for (const e of entries) {
    const f = proposeFigure({
      metric: e.metric, periodLabel: e.periodLabel, value: money(e.minorUnits, ctx.value.currency), sourceKind: e.sourceKind, sourceRef: e.sourceRef,
      ...(e.sourceKind === 'OFFICER_ENTRY' ? { enteredBy: actor } : {}), proposedAtEpochSeconds: at.epochSeconds,
    }, ctx.value.currency);
    if (!f.ok) return f;
    figures.push(f.value);
  }
  // A double submit of the same proposal is one proposal: an identical pending figure is not superseded by its twin.
  const fresh = figures.filter((figure) => !currentFigures(r).some((f) => isSamePendingProposal(f.figure, figure)));
  if (fresh.length === 0) return ok(view(r, ctx.value.currency));
  const started = startSpreadingIfReceived(book, r, actor, at.epochSeconds); if (!started.ok) return started;
  for (const figure of fresh) {
    // One current figure per metric: a new proposal supersedes the current one, verified or not.
    const current = currentFigures(r).find((f) => f.figure.metric === figure.metric);
    const rowId = randomUUID();
    addFigureRow(book, r, { rowId, figure, createdBy: figure.enteredBy ?? `${figure.sourceKind.toLowerCase()}:${figure.sourceRef}`.slice(0, 128), ...(current === undefined ? {} : { supersedes: current.rowId }) });
    recordEvent(book, r, { eventType: 'FIGURE_PROPOSED', fromStage: null, toStage: null, actor, atEpochSeconds: at.epochSeconds, detail: { figureId: rowId, metric: figure.metric, periodLabel: figure.periodLabel, sourceKind: figure.sourceKind, ...(current === undefined ? {} : { supersedes: current.rowId }) } });
  }
  return ok(view(r, ctx.value.currency));
}

function isSamePendingProposal(existing: FinancialFigure, proposed: FinancialFigure): boolean {
  return existing.status === 'PROPOSED'
    && existing.metric === proposed.metric
    && existing.periodLabel === proposed.periodLabel
    && existing.proposedValue.minorUnits === proposed.proposedValue.minorUnits
    && existing.proposedValue.currency === proposed.proposedValue.currency
    && existing.sourceKind === proposed.sourceKind
    && existing.sourceRef === proposed.sourceRef
    && existing.enteredBy === proposed.enteredBy;
}

/**
 * Record figures keyed by the acting officer. Whatever the caller says about
 * the source, a figure submitted through the workbench is OFFICER_ENTRY with
 * `enteredBy` the acting principal, so it is verified only by someone else.
 * Not yet usable: each is verified next. A proposal for a metric that already
 * has a figure supersedes it; an identical pending proposal is a no-op.
 */
export async function proposeFigures(tenant: TenantCode, applicationId: string, entries: readonly OfficerFigureEntry[], actor: string): Promise<Result<BusinessApplicationView>> {
  // Built field by field: a `sourceKind` smuggled onto an entry never reaches the recorder.
  const keyed: FigureProposalEntry[] = entries.map((e) => ({ metric: e.metric, periodLabel: e.periodLabel, minorUnits: e.minorUnits, sourceRef: e.sourceRef, sourceKind: 'OFFICER_ENTRY' }));
  return proposeFiguresAt(tenant, applicationId, keyed, actor, developmentAttestation());
}

/**
 * The system path for figures read from a statement (OCR) or a rail. Not
 * reachable from a workbench form: the server actions do not import it, and
 * it refuses an OFFICER_ENTRY. `source` is the ingesting system's principal.
 */
export async function ingestReadFigures(tenant: TenantCode, applicationId: string, entries: readonly ReadFigureEntry[], source: string): Promise<Result<BusinessApplicationView>> {
  return ingestReadFiguresAt(tenant, applicationId, entries, source, developmentAttestation());
}

async function ingestReadFiguresAt(tenant: TenantCode, applicationId: string, entries: readonly ReadFigureEntry[], source: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const read: FigureProposalEntry[] = [];
  for (const e of entries) {
    if (e.sourceKind !== 'OCR' && e.sourceKind !== 'RAIL') return fail('FIGURE_SOURCE_NOT_READ', 'Only figures read from a statement or a rail enter through ingestion', { metric: e.metric });
    read.push({ metric: e.metric, periodLabel: e.periodLabel, minorUnits: e.minorUnits, sourceRef: e.sourceRef, sourceKind: e.sourceKind });
  }
  return proposeFiguresAt(tenant, applicationId, read, source, at);
}

async function verifyFigureAt(tenant: TenantCode, applicationId: string, figureId: string, verifier: string, correctedMinorUnits: bigint | undefined, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  if (!SPREAD_OPEN.has(r.application.status)) return fail('TRANSITION_NOT_ALLOWED', 'Figures are verified only while the application is in credit assessment', { status: r.application.status });
  const row = currentFigures(r).find((f) => f.rowId === figureId);
  if (row === undefined) return fail('FIGURE_NOT_FOUND', 'No current figure with that id; it may have been superseded', { figureId });

  if (correctedMinorUnits !== undefined && correctedMinorUnits !== row.figure.proposedValue.minorUnits) {
    // A correction is not a verification: it is the verifier's own keyed figure, superseding the reading (both rows
    // kept), and like any keyed figure it is verified by a different principal before it is used.
    if (isVerified(row.figure)) return fail('FIGURE_ALREADY_VERIFIED', 'A verified figure is corrected by proposing a new one', { figureId });
    const corrected = proposeFigure({
      metric: row.figure.metric, periodLabel: row.figure.periodLabel, value: money(correctedMinorUnits, ctx.value.currency),
      sourceKind: 'OFFICER_ENTRY', sourceRef: row.figure.sourceRef, enteredBy: verifier, proposedAtEpochSeconds: at.epochSeconds,
    }, ctx.value.currency);
    if (!corrected.ok) return corrected;
    const rowId = randomUUID();
    addFigureRow(book, r, { rowId, figure: corrected.value, supersedes: row.rowId, createdBy: verifier });
    recordEvent(book, r, { eventType: 'FIGURE_CORRECTED', fromStage: null, toStage: null, actor: verifier, atEpochSeconds: at.epochSeconds, detail: { figureId: rowId, corrects: row.rowId, metric: row.figure.metric, sourceKind: 'OFFICER_ENTRY' } });
    return ok(view(r, ctx.value.currency));
  }

  const verified = verifyFigureCore(row.figure, { verifiedBy: verifier, verifiedAtEpochSeconds: at.epochSeconds }, ctx.value.currency);
  if (!verified.ok) return verified;
  const rowId = randomUUID();
  addFigureRow(book, r, { rowId, figure: verified.value, supersedes: row.rowId, createdBy: verifier });
  recordEvent(book, r, { eventType: 'FIGURE_VERIFIED', fromStage: null, toStage: null, actor: verifier, atEpochSeconds: at.epochSeconds, detail: { figureId: rowId, verifies: row.rowId, metric: verified.value.metric, corrected: String(verified.value.verification.correctedFromProposal) } });
  return ok(view(r, ctx.value.currency));
}

/**
 * An officer confirms or corrects a figure. A figure keyed in by an officer
 * is verified by a different officer (four eyes, core/applicant/financials.ts).
 * A correction (a different amount) is recorded as the verifier's own keyed
 * proposal, superseding the reading; a different principal then verifies it.
 */
export async function verifyFigure(tenant: TenantCode, applicationId: string, figureId: string, verifier: string, correctedMinorUnits?: bigint): Promise<Result<BusinessApplicationView>> {
  return verifyFigureAt(tenant, applicationId, figureId, verifier, correctedMinorUnits, developmentAttestation());
}

async function presentDocumentAt(tenant: TenantCode, applicationId: string, doc: { readonly documentType: string; readonly documentRef: string }, actor: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  if (!SPREAD_OPEN.has(r.application.status)) return fail('TRANSITION_NOT_ALLOWED', 'Documents are presented while the application is in credit assessment', { status: r.application.status });
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(doc.documentType)) return fail('DOCUMENT_TYPE_INVALID', 'A document type is a checklist code');
  if (!REF_SHAPE.test(doc.documentRef)) return fail('DOCUMENT_REF_INVALID', 'A document is presented by its reference, not its content');
  // A typed reference proves nothing about the document: it is PENDING until a different principal validates it.
  const status: BusinessDocument['validationStatus'] = 'PENDING';
  r.documents.push({ documentType: doc.documentType, documentRef: doc.documentRef, capturedAt: at, validationStatus: status, presentedBy: actor });
  recordEvent(book, r, {
    eventType: 'DOCUMENT_PRESENTED', fromStage: null, toStage: null, actor, atEpochSeconds: at.epochSeconds,
    detail: { documentType: doc.documentType, documentRef: doc.documentRef, validationStatus: status, capturedAtEpoch: at.epochSeconds.toString(), capturedTokenDigest: at.tokenDigest, capturedAuthority: at.authorityId },
  });
  return ok(view(r, ctx.value.currency));
}

/**
 * Present a document by reference, captured at the current attested instant.
 * It is PENDING — not counted by the checklist — until validated.
 */
export async function presentDocument(tenant: TenantCode, applicationId: string, doc: { readonly documentType: string; readonly documentRef: string }, actor: string): Promise<Result<BusinessApplicationView>> {
  return presentDocumentAt(tenant, applicationId, doc, actor, developmentAttestation());
}

async function validateDocumentAt(tenant: TenantCode, applicationId: string, documentRef: string, decision: 'VALID' | 'INVALID', validator: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  if (!SPREAD_OPEN.has(r.application.status)) return fail('TRANSITION_NOT_ALLOWED', 'Documents are validated while the application is in credit assessment', { status: r.application.status });
  if (decision !== 'VALID' && decision !== 'INVALID') return fail('DOCUMENT_DECISION_INVALID', 'A document is validated as VALID or INVALID');
  const doc = [...r.documents].reverse().find((d) => d.documentRef === documentRef);
  if (doc === undefined) return fail('DOCUMENT_NOT_FOUND', 'No document with that reference on this application', { documentRef });
  if (doc.validationStatus !== 'PENDING') return fail('DOCUMENT_ALREADY_VALIDATED', 'The document has already been validated; present it again to re-check it', { documentRef });
  if (doc.presentedBy === validator) return fail('FOUR_EYES_REQUIRED', 'A document is validated by a principal other than the one who presented it', { documentRef });
  markValidated(r, documentRef, decision, validator);
  recordEvent(book, r, { eventType: 'DOCUMENT_VALIDATED', fromStage: null, toStage: null, actor: validator, atEpochSeconds: at.epochSeconds, detail: { documentType: doc.documentType, documentRef, validationStatus: decision } });
  return ok(view(r, ctx.value.currency));
}

/**
 * The checker's check of a presented document: VALID (it now counts toward
 * the checklist) or INVALID. Never by the principal who presented it.
 */
export async function validateDocument(tenant: TenantCode, applicationId: string, documentRef: string, decision: 'VALID' | 'INVALID', validator: string): Promise<Result<BusinessApplicationView>> {
  return validateDocumentAt(tenant, applicationId, documentRef, decision, validator, developmentAttestation());
}

const PER_TEN_THOUSAND_MAX = 100_000n;

async function recordAssessmentInputsAt(tenant: TenantCode, applicationId: string, entry: AssessmentInputsEntry, actor: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  // Locked at submission: what was scored is what was submitted, and nobody edits it between the two.
  if (!SPREAD_OPEN.has(r.application.status)) return fail('ASSESSMENT_INPUTS_LOCKED', 'Assessment inputs are recorded only before the application is submitted', { status: r.application.status });
  if (!REF_SHAPE.test(entry.bureau.reportRef)) return fail('BUREAU_REF_INVALID', 'The bureau report is recorded by its reference');
  if (!REF_SHAPE.test(entry.bureau.consentId)) return fail('BUREAU_CONSENT_MISSING', 'The bureau result is recorded with the consent id it was obtained under');
  // The consent must be one stage 4 recorded; a consent id typed here and nowhere else is not a consent.
  if (!r.application.applicant.upstreamVerificationRefs.includes(entry.bureau.consentId)) return fail('BUREAU_CONSENT_NOT_ON_RECORD', 'The bureau consent is not among the stage-4 verification references handed over');
  if (entry.bureau.score < 0n || entry.bureau.score > 10_000n) return fail('BUREAU_SCORE_INVALID', 'The bureau score is the bureau’s own whole number');
  if (!Number.isSafeInteger(entry.fullTimeEmployees) || entry.fullTimeEmployees < 0) return fail('EMPLOYEES_INVALID', 'Full-time employees is a whole, non-negative count');
  if (entry.relevantExperienceYears < 0n || entry.relevantExperienceYears > 80n) return fail('EXPERIENCE_INVALID', 'Relevant experience is a whole number of years');
  if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(entry.sectorPriority)) return fail('SECTOR_PRIORITY_INVALID', 'Sector priority is a code');
  for (const [name, v] of [['commitmentRatioPerTenThousand', entry.commitmentRatioPerTenThousand], ['riskAnalysisScorePerTenThousand', entry.riskAnalysisScorePerTenThousand], ['portfolioRepaymentPerTenThousand', entry.portfolioRepaymentPerTenThousand], ['failedFilesRatePerTenThousand', entry.failedFilesRatePerTenThousand]] as const) {
    if (v < 0n || v > PER_TEN_THOUSAND_MAX) return fail('INPUT_OUT_OF_RANGE', 'A per-ten-thousand input is between 0 and 100000', { input: name });
  }
  if (entry.collateralValueMinorUnits < 0n) return fail('COLLATERAL_NEGATIVE', 'The collateral value is not negative');
  const inputs: AssessmentInputs = {
    bureau: { reportRef: entry.bureau.reportRef, consentId: entry.bureau.consentId, score: entry.bureau.score, source: 'AECB_FIXTURE' },
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
    eventType: 'ASSESSMENT_INPUTS_RECORDED', fromStage: null, toStage: null, actor, atEpochSeconds: at.epochSeconds,
    detail: {
      bureauReportRef: inputs.bureau.reportRef, bureauConsentId: inputs.bureau.consentId, bureauScore: inputs.bureau.score.toString(), bureauSource: inputs.bureau.source,
      fullTimeEmployees: String(inputs.fullTimeEmployees), relevantExperienceYears: inputs.relevantExperienceYears.toString(), sectorPriority: inputs.sectorPriority,
      auditedFinancialsAvailable: String(inputs.auditedFinancialsAvailable), commitmentRatioPerTenThousand: inputs.commitmentRatioPerTenThousand.toString(),
      riskAnalysisScorePerTenThousand: inputs.riskAnalysisScorePerTenThousand.toString(), portfolioRepaymentPerTenThousand: inputs.portfolioRepaymentPerTenThousand.toString(),
      failedFilesRatePerTenThousand: inputs.failedFilesRatePerTenThousand.toString(), collateralValueMinorUnits: inputs.collateralValue.minorUnits.toString(),
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
export async function recordAssessmentInputs(tenant: TenantCode, applicationId: string, entry: AssessmentInputsEntry, actor: string): Promise<Result<BusinessApplicationView>> {
  return recordAssessmentInputsAt(tenant, applicationId, entry, actor, developmentAttestation());
}

async function submitAt(tenant: TenantCode, applicationId: string, actor: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  const readiness = readinessOf(r, ctx.value.currency);
  const checklist = await checklistOf(tenant, r, at);
  if (!checklist.ok) return checklist;
  const t = submitForAssessmentCore(r.application, {
    spreadComplete: readiness.spreadComplete,
    missingFigures: [...readiness.missingFigures, ...readiness.unverifiedFigures],
    checklistComplete: checklist.value.complete,
    missingDocuments: checklist.value.missing,
  }, actor, at.epochSeconds);
  if (!t.ok) return t;
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/** Submit for scoring: every required figure verified and every mandatory document present, or refused naming which. */
export async function submitForAssessment(tenant: TenantCode, applicationId: string, actor: string): Promise<Result<BusinessApplicationView>> {
  return submitAt(tenant, applicationId, actor, developmentAttestation());
}

// =============================================================================
// Stage 6: assessment and decision
// =============================================================================

/**
 * Where each fact the fund's policy reads comes from. The derivations that
 * are a credit-policy choice rather than arithmetic are labelled ILLUSTRATIVE
 * until the fund's Credit function states its own.
 */
export const FACT_SOURCES: Readonly<Record<string, string>> = {
  bureauScore: 'AECB commercial report snapshot, keyed MANUALLY from the stage-4 report with its reference and consent id (no live AECB call until that rail is verified)',
  dscrPerTenThousand: 'DEBT_SERVICE_COVER — verified NET_PROFIT ÷ TOTAL_DEBT_SERVICE, rounded down',
  currentRatioPerTenThousand: 'CURRENT_RATIO — verified CURRENT_ASSETS ÷ CURRENT_LIABILITIES, rounded down',
  salesGrowthPerTenThousand: 'SALES_GROWTH — verified (ANNUAL_REVENUE − PRIOR_YEAR_REVENUE) ÷ PRIOR_YEAR_REVENUE, rounded down',
  ownerDbrPerTenThousand: 'OWNER_DEBT_BURDEN — verified MONTHLY_DEBT_OBLIGATIONS ÷ MONTHLY_GROSS_SALARY, rounded up',
  dbrBeforeLoanPerTenThousand: 'ILLUSTRATIVE derivation — verified TOTAL_DEBT_SERVICE ÷ ANNUAL_REVENUE, rounded up (the business’s debt burden before this facility)',
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
  collateralCoveragePerTenThousand: 'Collateral value ÷ requested amount, rounded down',
};

function factsFor(record: BusinessRecord, currency: CurrencyCode): Result<{ readonly facts: SmeAssessmentFacts; readonly ratios: readonly FinancialRatio[] }> {
  const inputs = record.inputs;
  if (inputs === undefined) return fail('ASSESSMENT_INPUTS_MISSING', 'Record the bureau snapshot and the officer’s assessment inputs before scoring');
  const spread = completeSpread(currentFigures(record).map((f) => f.figure), FULL_SPREAD_METRICS, currency);
  if (!spread.ok) return spread;
  const all = computeRatios(spread.value);
  const ratios: FinancialRatio[] = [];
  for (const code of ['DEBT_SERVICE_COVER', 'CURRENT_RATIO', 'SALES_GROWTH', 'OWNER_DEBT_BURDEN'] as const) {
    const r = all[code];
    if (!r.ok) return r;
    ratios.push(r.value);
  }
  const ratio = (code: FinancialRatioCode): bigint => (ratios.find((x) => x.code === code) as FinancialRatio).perTenThousand;
  const value = (m: FinancialMetric): bigint => spread.value.figures[m]?.verification.value.minorUnits ?? 0n;
  const revenue = value('ANNUAL_REVENUE');
  if (revenue <= 0n) return fail('RATIO_DENOMINATOR_ZERO', 'The debt burden before this facility needs a positive annual revenue', { ratio: 'DBR_BEFORE_LOAN' });
  const requested = record.application.requested.minorUnits;
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
    collateralCoveragePerTenThousand: floorDiv(inputs.collateralValue.minorUnits * 10_000n, requested),
  };
  return ok({ facts, ratios });
}

async function runAssessmentAt(tenant: TenantCode, applicationId: string, actor: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  if (r.application.status !== 'SUBMITTED') return fail('TRANSITION_NOT_ALLOWED', `Run the assessment is not possible from ${r.application.status}`, { status: r.application.status, action: 'Run the assessment' });
  // The officer who keyed and submitted the case does not also score it: the checker (or the system) runs it.
  if (actor === r.application.submittedBy) return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_ASSESSMENT', 'The officer who submitted the application does not run its assessment');
  const policy = loadSmeAssessmentPolicy(tenant);
  if (!policy.ok) return policy;
  const derived = factsFor(r, ctx.value.currency);
  if (!derived.ok) return derived;
  // Exactly the facts the policy reads: nothing it does not declare enters the trace.
  const facts: Record<string, SmeAssessmentFacts[string]> = {};
  for (const name of Object.keys(policy.value.facts)) { const v = derived.value.facts[name]; if (v !== undefined) facts[name] = v; }
  const assessment = assessSme(policy.value, facts, r.application.requested);
  if (!assessment.ok) return assessment;
  const assessmentId = randomUUID();
  const cumulative = assessment.value.scorecard?.cumulativeScorePerTenThousand;
  const t = recordAssessment(r.application, {
    outcome: assessment.value.outcome,
    assessmentRef: assessmentId,
    ...(assessment.value.riskLevel === undefined ? {} : { riskLevel: assessment.value.riskLevel }),
    ...(cumulative === undefined ? {} : { cumulativeScore: Number(cumulative) }),
  }, actor, at.epochSeconds);
  if (!t.ok) return t;
  const factSources: Record<string, string> = {};
  for (const name of Object.keys(facts)) factSources[name] = FACT_SOURCES[name] ?? 'Not mapped';
  const run: AssessmentRun = { assessmentId, assessment: assessment.value, facts, factSources, ratios: derived.value.ratios, assessedBy: actor, assessedAtEpochSeconds: at.epochSeconds };
  r.assessments.push(run);
  book.unsavedAssessments.push({
    assessmentId, applicationId, outcome: assessment.value.outcome,
    ...(assessment.value.riskLevel === undefined ? {} : { riskLevel: assessment.value.riskLevel }),
    ...(cumulative === undefined ? {} : { cumulativeScore: Number(cumulative) }),
    policyRef: assessment.value.policyRef, assessedAtEpochSeconds: at.epochSeconds, assessedBy: actor,
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
export async function runAssessment(tenant: TenantCode, applicationId: string, actor: string): Promise<Result<BusinessApplicationView>> {
  return runAssessmentAt(tenant, applicationId, actor, developmentAttestation());
}

async function approveAt(tenant: TenantCode, applicationId: string, approver: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  const t = approveStraightThroughCore(r.application, approver, at.epochSeconds);
  if (!t.ok) return t;
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/** A straight-through case approved by a checker who is not the submitting officer. */
export async function approveStraightThrough(tenant: TenantCode, applicationId: string, approver: string): Promise<Result<BusinessApplicationView>> {
  return approveAt(tenant, applicationId, approver, developmentAttestation());
}

async function decideAt(tenant: TenantCode, applicationId: string, decision: { readonly decidedBy: string; readonly approved: boolean; readonly reason: string }, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  const t = decideInCommitteeCore(r.application, decision, at.epochSeconds);
  if (!t.ok) return t;
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/** The credit committee's decision, by a member who is not the submitting officer, with its reason. */
export async function decideInCommittee(tenant: TenantCode, applicationId: string, decision: { readonly decidedBy: string; readonly approved: boolean; readonly reason: string }): Promise<Result<BusinessApplicationView>> {
  return decideAt(tenant, applicationId, decision, developmentAttestation());
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

async function generateOfferAt(tenant: TenantCode, applicationId: string, actor: string, options: OfferOptions, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  const app = r.application;
  // Once sent, a new letter version may still be generated (a resend needs one); signed and later, no.
  if (app.status !== 'APPROVED' && app.status !== 'OFFER_SENT') return fail('TRANSITION_NOT_ALLOWED', `Generate the offer is not possible from ${app.status}`, { status: app.status, action: 'Generate the offer' });
  if (app.requested.currency !== ctx.value.currency) return fail('CURRENCY_NOT_TENANTS', 'The application is not in the tenant’s base currency');

  const product = await productFor(tenant, app.productCode, app.variantCode, at);
  if (!product.ok) return product;
  const spread = completeSpread(currentFigures(r).map((f) => f.figure), FULL_SPREAD_METRICS, ctx.value.currency);
  if (!spread.ok) return spread;
  const inputs = r.inputs;
  if (inputs === undefined) return fail('ASSESSMENT_INPUTS_MISSING', 'The size classification needs the employee count from the assessment inputs');
  const business = toBusinessFacts(spread.value, { fullTimeEmployees: inputs.fullTimeEmployees, sector: app.applicant.sector });
  if (!business.ok) return business;
  const definition = loadSmeDefinition(ctx.value.profile.code);
  if (!definition.ok) return definition;

  const offerDate = localDate(at.epochSeconds, ctx.value.profile);
  const offerDays = daysOfIso(offerDate) ?? 0n;
  const disbursementDate = options.disbursementDate ?? isoOfDays(offerDays + DEFAULT_DISBURSEMENT_AFTER_OFFER_DAYS);
  const firstDueDate = options.firstDueDate ?? defaultFirstDue(disbursementDate);
  const paymentDay = options.paymentDay ?? Number(firstDueDate.slice(8, 10));
  const validUntil = isoOfDays(offerDays + DEFAULT_OFFER_VALIDITY_DAYS);
  const dates = checkOfferDates(offerDate, disbursementDate, firstDueDate);
  if (!dates.ok) return dates;
  const tenorDays = app.tenorMonths * 30;

  const pricing = resolvePricingInputs(product.value.entry.pricingRule, { principal: app.requested, tenorDays, asOfEpochSeconds: at.epochSeconds });
  if (!pricing.ok) return pricing;
  const quote = smeTermConventional.quote(product.value.terms, {
    tenantId: tenant,
    programmeId: product.value.variant.documentChecklistRef ?? 'sme-direct-lending',
    counterpartyId: app.applicationId,
    requestedAmount: app.requested,
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
  const offer = buildOffer(smeTermConventional, q, at);
  if (!offer.ok) return offer;

  const totalCharge = q.interestAmount;
  const letter = buildOfferLetter({
    jurisdiction: { code: ctx.value.profile.code, contractualCalendars: ctx.value.profile.contractualCalendars },
    applicationReference: app.applicationId,
    applicantBusinessName: { en: app.applicant.businessNameEn, ar: app.applicant.businessNameAr ?? app.applicant.businessNameEn },
    productVariantName: { en: q.variantNameEn, ar: q.variantNameAr },
    family: smeTermConventional.descriptor.family,
    facilityAmount: app.requested,
    tenorMonths: q.months,
    graceMonths: q.graceMonths,
    rateBp: q.rateSnapshot.rate.bp,
    equityContributionPerTenThousand: BigInt(q.contributionPerTenThousand),
    offerDate,
    validUntil,
    totals: { instalment: q.monthlyInstalment, totalCharge, totalPayable: money(app.requested.minorUnits + totalCharge.minorUnits, app.requested.currency) },
    institutionLegalName: { en: ctx.value.legalNameEn, ar: ctx.value.legalNameAr },
    signatories: [
      { party: 'LENDER', role: { en: 'Authorised Signatory', ar: 'المفوّض بالتوقيع' } },
      { party: 'BORROWER', role: { en: 'Authorised Signatory of the Borrower', ar: 'المفوّض بالتوقيع عن المقترض' } },
    ],
    conditions: q.collateral.map((c) => ({ en: c.labelEn, ar: c.labelAr })),
  });
  if (!letter.ok) return letter;

  const terms: OfferTerms = {
    productCode: app.productCode, variantCode: app.variantCode, months: q.months, graceMonths: q.graceMonths, facilityAmount: app.requested,
    monthlyInstalment: q.monthlyInstalment, totalInterest: q.interestAmount, totalPayable: money(app.requested.minorUnits + totalCharge.minorUnits, app.requested.currency),
    rateBp: q.rateSnapshot.rate.bp, rateSourceRef: q.rateSnapshot.sourceRef, aprBp: offer.value.apr.bp,
    disbursementDate, firstDueDate, paymentDay, offerDate, validUntil,
  };
  // The same letter twice is one version: the hash is the identity.
  const already = r.offers.find((o) => o.letter.version === letter.value.version);
  if (already === undefined) {
    const offerId = randomUUID();
    const run: OfferRun = { offerId, letter: letter.value, terms, schedule: q.datedSchedule, createdBy: actor, createdAtEpochSeconds: at.epochSeconds };
    r.offers.push(run);
    book.unsavedOffers.push({ offerId, applicationId, letterVersion: letter.value.version, currency: app.requested.currency, facilityMinorUnits: app.requested.minorUnits, createdBy: actor, letter: { letter: run.letter, terms: run.terms, createdAtEpochSeconds: run.createdAtEpochSeconds }, schedule: run.schedule });
    recordEvent(book, r, { eventType: 'OFFER_GENERATED', fromStage: null, toStage: null, actor, atEpochSeconds: at.epochSeconds, detail: { letterVersion: letter.value.version, offerId } });
  }
  return ok(view(r, ctx.value.currency));
}

/**
 * Quote the approved application through the conventional SME module with
 * the tenant's catalogue entry and the dated ACT/365 schedule, and build the
 * bilingual Facility Offer Letter. Its content hash is its version.
 */
export async function generateOffer(tenant: TenantCode, applicationId: string, actor: string, options: OfferOptions = {}): Promise<Result<BusinessApplicationView>> {
  return generateOfferAt(tenant, applicationId, actor, options, developmentAttestation());
}

function latestOfferOf(r: BusinessRecord): Result<OfferRun> {
  const latest = r.offers[r.offers.length - 1];
  return latest === undefined ? fail('OFFER_NOT_GENERATED', 'Generate the offer letter first') : ok(latest);
}

/** Exactly what `sendOffer` would send: the email and SMS for the latest letter, to masked recipients. */
export async function previewNotifications(tenant: TenantCode, applicationId: string): Promise<Result<OfferNotifications>> {
  const book = await hydrate(tenant);
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  const latest = latestOfferOf(r); if (!latest.ok) return latest;
  return previewOfferNotifications(latest.value.letter, r.contact);
}

async function sendOfferAt(tenant: TenantCode, applicationId: string, actor: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  const latest = latestOfferOf(r); if (!latest.ok) return latest;
  const letter = latest.value.letter;
  // The same letter version, already sent: a second 'Confirm & Send' is a no-op, never a second notification.
  if (r.application.status === 'OFFER_SENT' && r.application.offer?.letterVersion === letter.version) return ok(view(r, ctx.value.currency));
  const notices = buildOfferNotifications(letter, r.contact);
  if (!notices.ok) return notices;
  const channels = [...(notices.value.email === undefined ? [] : ['EMAIL']), ...(notices.value.sms === undefined ? [] : ['SMS'])];
  const t = recordOfferSent(r.application, { letterVersion: letter.version, channels }, actor, at.epochSeconds);
  if (!t.ok) return t;

  // The send is an external side effect: queued on the outbox, keyed on the letter version so one version is sent once.
  const queued = queueSideEffects([{
    eventId: randomUUID(), tenantId: tenant, kind: 'NOTIFICATION', subjectRef: applicationId, idempotencyKey: `${applicationId}:offer:${letter.version}`, correlationId: applicationId,
    payload: { recipientKind: 'COUNTERPARTY', recipientRef: r.contact.partyRef, event: 'OFFER_ISSUED', channels: channels.join(','), letterReference: letter.reference, letterVersion: letter.version },
  }]);
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
export async function sendOffer(tenant: TenantCode, applicationId: string, actor: string): Promise<Result<BusinessApplicationView>> {
  return sendOfferAt(tenant, applicationId, actor, developmentAttestation());
}

async function signAt(tenant: TenantCode, applicationId: string, signature: { readonly letterVersion: string; readonly signatureRef?: string }, actor: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  // Fixture: the UAE Pass signing intent's reference until that adapter is verified (adapters/uae/uae-pass/README.md).
  const signatureRef = signature.signatureRef ?? `uaepass-fixture:sign:${applicationId}`;
  const t = recordSignedCore(r.application, { signatureRef, letterVersion: signature.letterVersion }, actor, at.epochSeconds);
  if (!t.ok) return t;
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/**
 * Record the applicant's signature, on the letter version that was sent and
 * no other. The signature reference is a UAE Pass fixture reference until
 * that rail is verified.
 */
export async function recordSigned(tenant: TenantCode, applicationId: string, signature: { readonly letterVersion: string; readonly signatureRef?: string }, actor: string): Promise<Result<BusinessApplicationView>> {
  return signAt(tenant, applicationId, signature, actor, developmentAttestation());
}

async function disburseAt(tenant: TenantCode, applicationId: string, actor: string, paymentRef: string | undefined, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  const app = r.application;
  // Four eyes on money out: whoever approved the facility (or submitted it) does not also release the payment.
  const approver = r.events.find((e) => e.eventType === 'APPROVED_STRAIGHT_THROUGH' || e.eventType === 'COMMITTEE_APPROVED')?.actor;
  if (actor === approver || actor === app.submittedBy) return reject('OP-DETERMINACY', 'FOUR_EYES_DISBURSEMENT', 'Disbursement is released by a principal other than the approver and the submitting officer');
  // Fixture: the partner bank's payment instruction reference until that adapter is verified (adapters/uae/partner-bank/README.md).
  const reference = paymentRef ?? `partner-bank-fixture:pay:${applicationId}`;
  const t = recordDisbursedCore(app, reference, actor, at.epochSeconds);
  if (!t.ok) return t;
  const signed = r.offers.find((o) => o.letter.version === app.offer?.letterVersion);
  if (signed === undefined) return fail('OFFER_NOT_GENERATED', 'The signed letter version is not on record');

  // The payment instruction to the partner bank and the bureau's facility-opened report, as products/sme-term-conventional/execution.ts
  // shapes them, keyed on the application: queued with the DISBURSED change and written in its transaction.
  const key = `business:${applicationId}`;
  const base = { tenantId: tenant, subjectRef: applicationId, correlationId: applicationId };
  const queued = queueSideEffects([
    { ...base, eventId: `${key}:disburse`, kind: 'PAYMENT_DISBURSE', idempotencyKey: `${key}:disburse`, payload: { rail: 'PARTNER_BANK', beneficiaryRef: applicationId, paymentRef: reference, minorUnits: String(signed.terms.facilityAmount.minorUnits), currency: signed.terms.facilityAmount.currency } },
    { ...base, eventId: `${key}:bureau`, kind: 'BUREAU_REPORT', idempotencyKey: `${key}:bureau`, payload: { facilityRef: applicationId, event: 'OPENED', minorUnits: String(signed.terms.totalPayable.minorUnits) } },
  ]);
  if (!queued.ok) return queued;
  commitSideEffects(book, queued.value);
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
}

/**
 * Record the disbursement by its payment reference (a partner-bank fixture
 * reference until that rail is verified), released by a finance principal
 * distinct from the approver; queues the payment instruction and the bureau's
 * facility-opened report on the outbox in the same transaction.
 */
export async function recordDisbursed(tenant: TenantCode, applicationId: string, actor: string, paymentRef?: string): Promise<Result<BusinessApplicationView>> {
  return disburseAt(tenant, applicationId, actor, paymentRef, developmentAttestation());
}

// =============================================================================
// Stages 8–9, withdrawal
// =============================================================================

async function portfolioAt(tenant: TenantCode, applicationId: string, status: { readonly daysPastDue: number; readonly arrearsMinorUnits: bigint }, actor: string, at: TsaInstant): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  if (r.application.status !== 'DISBURSED') return fail('TRANSITION_NOT_ALLOWED', 'Portfolio status is recorded for a disbursed facility', { status: r.application.status });
  if (!Number.isSafeInteger(status.daysPastDue) || status.daysPastDue < 0) return fail('DAYS_PAST_DUE_INVALID', 'Days past due is a whole, non-negative count');
  if (status.arrearsMinorUnits < 0n) return fail('ARREARS_NEGATIVE', 'Arrears are not negative');
  const arrears = money(status.arrearsMinorUnits, ctx.value.currency);
  r.portfolio = { daysPastDue: status.daysPastDue, arrears, recordedBy: actor, asOfEpochSeconds: at.epochSeconds };
  const stage = status.daysPastDue > 0 ? 9 : 8;
  recordEvent(book, r, { eventType: 'PORTFOLIO_STATUS_RECORDED', fromStage: r.application.stage, toStage: stage, actor, atEpochSeconds: at.epochSeconds, detail: { daysPastDue: String(status.daysPastDue), arrearsMinorUnits: arrears.minorUnits.toString() } });
  return ok(view(r, ctx.value.currency));
}

/**
 * The loan system's report on a disbursed facility: days past due and
 * arrears. Above zero days the application shows at stage 9 (collections).
 * Recorded as an event: the application row is closed once disbursed.
 */
export async function recordPortfolioStatus(tenant: TenantCode, applicationId: string, status: { readonly daysPastDue: number; readonly arrearsMinorUnits: bigint }, actor: string): Promise<Result<BusinessApplicationView>> {
  return portfolioAt(tenant, applicationId, status, actor, developmentAttestation());
}

export async function withdrawApplication(tenant: TenantCode, applicationId: string, reason: string, actor: string): Promise<Result<BusinessApplicationView>> {
  const book = await hydrate(tenant);
  const ctx = tenantContext(tenant); if (!ctx.ok) return ctx;
  const r = book.records.get(applicationId); if (r === undefined) return notFound(applicationId);
  const t = withdraw(r.application, reason, actor, developmentAttestation().epochSeconds);
  if (!t.ok) return t;
  apply(book, r, t.value);
  return ok(view(r, ctx.value.currency));
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
  readonly figures: { readonly revenue: bigint; readonly prior: bigint; readonly profit: bigint; readonly debtService: bigint; readonly assets: bigint; readonly liabilities: bigint; readonly salary: bigint; readonly obligations: bigint };
  readonly bureauScore: bigint;
  readonly employees: number;
  readonly experience: bigint;
  readonly sectorPriority: 'PRIORITY' | 'NON_PRIORITY';
  readonly collateralAed: bigint;
  readonly reach: SeedReach;
  readonly daysPastDue?: number;
}

const SEEDS: readonly SeedSpec[] = [
  { applicationId: 'FR-00005101', nameEn: 'Qamar Lantern Crafts LLC', nameAr: 'قمر لصناعة الفوانيس ذ.م.م', sector: 'MANUFACTURING', years: 3, owner: 'Hessa R. Example', variant: 'SMALL_LOAN', purpose: 'EQUIPMENT', requestedAed: 250_000n, tenorMonths: 24, graceMonths: 0, contribution: 2_000, receivedDaysAgo: 1n,
    figures: { revenue: 1_800_000n, prior: 1_650_000n, profit: 320_000n, debtService: 40_000n, assets: 600_000n, liabilities: 380_000n, salary: 35_000n, obligations: 6_000n }, bureauScore: 742n, employees: 14, experience: 5n, sectorPriority: 'PRIORITY', collateralAed: 300_000n, reach: 'PROPOSED' },
  { applicationId: 'FR-00005102', nameEn: 'Sandglass Analytics FZ-LLC', nameAr: 'ساندغلاس للتحليلات م.م.ح', sector: 'SERVICES', years: 4, owner: 'Omar K. Example', variant: 'ADVANCED_TECH_AI', purpose: 'TECHNOLOGY_DEVELOPMENT', requestedAed: 600_000n, tenorMonths: 48, graceMonths: 6, contribution: 2_500, receivedDaysAgo: 3n,
    figures: { revenue: 3_200_000n, prior: 2_700_000n, profit: 640_000n, debtService: 70_000n, assets: 1_100_000n, liabilities: 700_000n, salary: 48_000n, obligations: 9_500n }, bureauScore: 768n, employees: 22, experience: 6n, sectorPriority: 'PRIORITY', collateralAed: 750_000n, reach: 'PARTLY_VERIFIED' },
  { applicationId: 'FR-00005103', nameEn: 'Twelve Palms Bakery LLC', nameAr: 'مخبز النخلات الاثنتي عشرة ذ.م.م', sector: 'TRADING', years: 6, owner: 'Mariam S. Example', variant: 'WORKING_CAPITAL', purpose: 'INVENTORY', requestedAed: 300_000n, tenorMonths: 12, graceMonths: 0, contribution: 2_000, receivedDaysAgo: 4n,
    figures: { revenue: 4_500_000n, prior: 4_100_000n, profit: 760_000n, debtService: 90_000n, assets: 1_300_000n, liabilities: 820_000n, salary: 40_000n, obligations: 7_000n }, bureauScore: 731n, employees: 30, experience: 8n, sectorPriority: 'NON_PRIORITY', collateralAed: 380_000n, reach: 'SUBMITTED' },
  { applicationId: 'FR-00005104', nameEn: 'Blue Dhow Logistics LLC', nameAr: 'الداو الأزرق للخدمات اللوجستية ذ.م.م', sector: 'SERVICES', years: 7, owner: 'Khalid A. Example', variant: 'EXPANSION', purpose: 'BUSINESS_EXPANSION', requestedAed: 1_200_000n, tenorMonths: 60, graceMonths: 6, contribution: 2_500, receivedDaysAgo: 9n,
    figures: { revenue: 7_400_000n, prior: 6_800_000n, profit: 980_000n, debtService: 120_000n, assets: 2_600_000n, liabilities: 1_700_000n, salary: 52_000n, obligations: 12_000n }, bureauScore: 756n, employees: 41, experience: 9n, sectorPriority: 'NON_PRIORITY', collateralAed: 1_500_000n, reach: 'ASSESSED' },
  { applicationId: 'FR-00005105', nameEn: 'Saltmarsh Fit-Out Works LLC', nameAr: 'سولت مارش لأعمال التجهيز ذ.م.م', sector: 'SERVICES', years: 5, owner: 'Noura M. Example', variant: 'FIXED_ASSETS', purpose: 'PREMISES_FIT_OUT', requestedAed: 450_000n, tenorMonths: 36, graceMonths: 3, contribution: 2_500, receivedDaysAgo: 6n,
    figures: { revenue: 3_900_000n, prior: 3_500_000n, profit: 720_000n, debtService: 55_000n, assets: 1_250_000n, liabilities: 760_000n, salary: 45_000n, obligations: 5_500n }, bureauScore: 781n, employees: 26, experience: 7n, sectorPriority: 'PRIORITY', collateralAed: 600_000n, reach: 'ASSESSED' },
  { applicationId: 'FR-00005106', nameEn: 'Lumen Date Farms LLC', nameAr: 'لومن لمزارع التمور ذ.م.م', sector: 'TRADING', years: 8, owner: 'Saeed H. Example', variant: 'SMALL_LOAN', purpose: 'WORKING_CAPITAL', requestedAed: 400_000n, tenorMonths: 36, graceMonths: 0, contribution: 2_000, receivedDaysAgo: 14n,
    figures: { revenue: 5_200_000n, prior: 4_800_000n, profit: 820_000n, debtService: 60_000n, assets: 1_600_000n, liabilities: 950_000n, salary: 42_000n, obligations: 6_500n }, bureauScore: 774n, employees: 33, experience: 10n, sectorPriority: 'PRIORITY', collateralAed: 520_000n, reach: 'OFFER_SENT' },
  { applicationId: 'FR-00005107', nameEn: 'Ibex Robotics Lab FZ-LLC', nameAr: 'آيبكس لمختبرات الروبوتات م.م.ح', sector: 'SERVICES', years: 4, owner: 'Layla F. Example', variant: 'ADVANCED_TECH_AI', purpose: 'EQUIPMENT', requestedAed: 480_000n, tenorMonths: 36, graceMonths: 3, contribution: 2_000, receivedDaysAgo: 40n,
    figures: { revenue: 3_600_000n, prior: 3_100_000n, profit: 700_000n, debtService: 50_000n, assets: 1_200_000n, liabilities: 700_000n, salary: 50_000n, obligations: 8_000n }, bureauScore: 790n, employees: 19, experience: 6n, sectorPriority: 'PRIORITY', collateralAed: 620_000n, reach: 'DISBURSED' },
  { applicationId: 'FR-00005108', nameEn: 'Mangrove Thread Textiles LLC', nameAr: 'خيوط المانغروف للمنسوجات ذ.م.م', sector: 'MANUFACTURING', years: 9, owner: 'Rashid T. Example', variant: 'FIXED_ASSETS', purpose: 'EQUIPMENT', requestedAed: 420_000n, tenorMonths: 48, graceMonths: 0, contribution: 2_000, receivedDaysAgo: 120n,
    figures: { revenue: 4_800_000n, prior: 4_400_000n, profit: 760_000n, debtService: 65_000n, assets: 1_500_000n, liabilities: 900_000n, salary: 38_000n, obligations: 6_000n }, bureauScore: 752n, employees: 48, experience: 11n, sectorPriority: 'NON_PRIORITY', collateralAed: 560_000n, reach: 'DISBURSED', daysPastDue: 34 },
];

const seedInstant = (epochSeconds: bigint): TsaInstant => tsaInstant({ verified: true, genTimeEpochSeconds: epochSeconds, tokenDigest: 'development-substitute', authorityId: 'development' });

async function seedIllustrativeBook(tenant: TenantCode): Promise<void> {
  const now = developmentAttestation().epochSeconds;
  const officer = BUSINESS_ROLES.officer;
  const checker = BUSINESS_ROLES.checker;
  for (const s of SEEDS) {
    const t0 = now - s.receivedDaysAgo * DAY;
    // Steps are spaced within the days since receipt, so every instant is in the past.
    const span = s.receivedDaysAgo * DAY;
    const step = (n: bigint): TsaInstant => seedInstant(t0 + (span * n) / 12n + n * MINUTE);
    const handed = await handOverAt(tenant, {
      applicationId: s.applicationId, upstreamRef: `upstream-${s.applicationId}`,
      applicant: {
        businessNameEn: s.nameEn, businessNameAr: s.nameAr, registrationRef: `TL-ILLUS-${s.applicationId.slice(-4)}`, sector: s.sector, yearsInOperation: s.years,
        owners: [{ displayName: s.owner, ref: `owner-ILLUS-${s.applicationId.slice(-4)}` }],
        upstreamVerificationRefs: [`uaepass:assert-ILLUS-${s.applicationId.slice(-4)}`, `icp:verify-ILLUS-${s.applicationId.slice(-4)}`, `ner:licence-ILLUS-${s.applicationId.slice(-4)}`, `aecb:consent-ILLUS-${s.applicationId.slice(-4)}`],
      },
      productCode: 'sme-term-conventional', variantCode: s.variant, purpose: s.purpose, requestedMinorUnits: s.requestedAed * 100n,
      tenorMonths: s.tenorMonths, graceMonths: s.graceMonths, contributionPerTenThousand: s.contribution,
      contact: { partyRef: `owner-ILLUS-${s.applicationId.slice(-4)}`, emailMasked: 'o***@example.com', mobileMasked: '+971 50 XXX XXXX' },
    }, 'upstream-record-dev-01', seedInstant(t0));
    if (!handed.ok) continue;
    const id = s.applicationId;
    const f = s.figures;
    const statement = `doc-ILLUS-${id.slice(-4)}-AUDITED_FINANCIALS_2Y`;
    // Read figures through the system path (statement OCR, rails); the one keyed figure by the officer.
    const read = await ingestReadFiguresAt(tenant, id, [
      { metric: 'ANNUAL_REVENUE', periodLabel: 'FY2025', minorUnits: f.revenue * 100n, sourceKind: 'OCR', sourceRef: statement },
      { metric: 'PRIOR_YEAR_REVENUE', periodLabel: 'FY2024', minorUnits: f.prior * 100n, sourceKind: 'OCR', sourceRef: statement },
      { metric: 'NET_PROFIT', periodLabel: 'FY2025', minorUnits: f.profit * 100n, sourceKind: 'OCR', sourceRef: statement },
      { metric: 'TOTAL_DEBT_SERVICE', periodLabel: 'FY2025', minorUnits: f.debtService * 100n, sourceKind: 'RAIL', sourceRef: `aecb:report-ILLUS-${id.slice(-4)}` },
      { metric: 'CURRENT_ASSETS', periodLabel: 'FY2025', minorUnits: f.assets * 100n, sourceKind: 'OCR', sourceRef: statement },
      { metric: 'CURRENT_LIABILITIES', periodLabel: 'FY2025', minorUnits: f.liabilities * 100n, sourceKind: 'OCR', sourceRef: statement },
      { metric: 'MONTHLY_GROSS_SALARY', periodLabel: '2026-09', minorUnits: f.salary * 100n, sourceKind: 'RAIL', sourceRef: `mohre:wps-ILLUS-${id.slice(-4)}` },
    ], READ_FIGURE_SOURCES.ocr, step(1n));
    const proposed = read.ok
      ? await proposeFiguresAt(tenant, id, [{ metric: 'MONTHLY_DEBT_OBLIGATIONS', periodLabel: '2026-09', minorUnits: f.obligations * 100n, sourceKind: 'OFFICER_ENTRY', sourceRef: `doc-ILLUS-${id.slice(-4)}-PERSONAL_BUREAU_REPORT` }], officer, step(1n))
      : read;
    if (!proposed.ok || s.reach === 'PROPOSED') {
      await presentDocumentAt(tenant, id, { documentType: 'TRADE_LICENCE', documentRef: `doc-ILLUS-${id.slice(-4)}-TRADE_LICENCE` }, officer, step(1n));
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
      const items = s.reach === 'PARTLY_VERIFIED' ? checklist.value.checklist.items.slice(0, 5) : checklist.value.checklist.items.filter((i) => i.required);
      for (const item of items) {
        const documentRef = `doc-ILLUS-${id.slice(-4)}-${item.documentType}`;
        await presentDocumentAt(tenant, id, { documentType: item.documentType, documentRef }, officer, step(2n));
        await validateDocumentAt(tenant, id, documentRef, 'VALID', checker, step(2n));
      }
    }
    if (s.reach === 'PARTLY_VERIFIED') continue;

    await recordAssessmentInputsAt(tenant, id, {
      bureau: { reportRef: `aecb:report-ILLUS-${id.slice(-4)}`, consentId: `aecb:consent-ILLUS-${id.slice(-4)}`, score: s.bureauScore },
      fullTimeEmployees: s.employees, relevantExperienceYears: s.experience, sectorPriority: s.sectorPriority, auditedFinancialsAvailable: true,
      commitmentRatioPerTenThousand: 10_200n, riskAnalysisScorePerTenThousand: 7_400n, portfolioRepaymentPerTenThousand: 8_600n, failedFilesRatePerTenThousand: 800n,
      collateralValueMinorUnits: s.collateralAed * 100n,
    }, officer, step(3n));
    const submitted = await submitAt(tenant, id, officer, step(4n));
    if (!submitted.ok || s.reach === 'SUBMITTED') continue;

    const assessed = await runAssessmentAt(tenant, id, checker, step(5n));
    if (!assessed.ok || s.reach === 'ASSESSED') continue;

    const status = assessed.value.application.status;
    const decided = status === 'ASSESSED'
      ? await approveAt(tenant, id, checker, step(6n))
      : status === 'IN_COMMITTEE'
        ? await decideAt(tenant, id, { decidedBy: BUSINESS_ROLES.committee, approved: true, reason: 'ILLUSTRATIVE — within risk-aligned terms; collateral cover adequate' }, step(6n))
        : undefined;
    if (decided === undefined || !decided.ok) continue;

    const offered = await generateOfferAt(tenant, id, officer, {}, step(7n));
    if (!offered.ok) continue;
    const sent = await sendOfferAt(tenant, id, officer, step(8n));
    if (!sent.ok || s.reach === 'OFFER_SENT') continue;

    const version = sent.value.latestOffer?.letter.version ?? '';
    const signed = await signAt(tenant, id, { letterVersion: version }, officer, step(9n));
    if (!signed.ok) continue;
    const disbursed = await disburseAt(tenant, id, BUSINESS_ROLES.finance, undefined, step(10n));
    if (!disbursed.ok) continue;
    if (s.daysPastDue !== undefined) {
      const instalment = disbursed.value.latestOffer?.terms.monthlyInstalment.minorUnits ?? 0n;
      await portfolioAt(tenant, id, { daysPastDue: s.daysPastDue, arrearsMinorUnits: instalment }, 'loan-system-fixture', step(11n));
    }
  }
}
