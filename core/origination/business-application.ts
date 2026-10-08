/**
 * A business (SME) application through stages 5 to 9 of the direct-lending
 * journey, as a state machine whose transitions accept only their
 * predecessors (ADR 0005; the core banking partner's journey, shared 2026-10-08).
 *
 *   Stages 1–4  upstream: application, needs assessment, product application,
 *               verification — the government portal and the core banking
 *               platform's customer record. Sanad receives the application at 5.
 *   Stage 5     credit assessment: financial figures verified one by one, the
 *               document checklist complete, then submitted for scoring.
 *   Stage 6     decisioning: knock-outs and score route it straight through,
 *               to the credit committee, or to a decline.
 *   Stage 7     contract & disbursement: offer letter sent, signed, disbursed.
 *   Stage 8–9   portfolio management and collections: recorded hand-off to
 *               the loan management system.
 *
 * Pure and clock-free: every instant is an argument. A refusal is a typed
 * Result, never a throw. Four eyes: the committee member deciding may not be
 * the officer who submitted; the officer who submitted may not approve a
 * straight-through case on their own.
 */

import { type CurrencyCode, type Money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

export type BusinessStage = 5 | 6 | 7 | 8 | 9;
export type BusinessStatus =
  | 'RECEIVED' | 'SPREADING' | 'SUBMITTED' | 'ASSESSED' | 'IN_COMMITTEE' | 'APPROVED'
  | 'DECLINED' | 'OFFER_SENT' | 'SIGNED' | 'DISBURSED' | 'WITHDRAWN';

export const STAGE_OF: Readonly<Record<BusinessStatus, BusinessStage>> = {
  RECEIVED: 5, SPREADING: 5, SUBMITTED: 5,
  ASSESSED: 6, IN_COMMITTEE: 6, APPROVED: 6, DECLINED: 6,
  OFFER_SENT: 7, SIGNED: 7,
  DISBURSED: 8,
  WITHDRAWN: 5,
};

/** The applicant as Sanad holds it: the business and references. No identity number. */
export interface BusinessApplicant {
  readonly businessNameEn: string;
  readonly businessNameAr?: string;
  /** The trade licence / commercial registration reference as the registry rail verified it. */
  readonly registrationRef: string;
  readonly sector: string;
  readonly yearsInOperation: number;
  /** Owners by display name and reference only. */
  readonly owners: readonly { readonly displayName: string; readonly ref: string }[];
  /** What upstream verified at stage 4, by reference (identity, registry, bureau consent). */
  readonly upstreamVerificationRefs: readonly string[];
}

export interface BusinessApplication {
  readonly applicationId: string;
  readonly upstreamRef: string;
  readonly tenantId: string;
  readonly status: BusinessStatus;
  readonly stage: BusinessStage;
  readonly applicant: BusinessApplicant;
  readonly productCode: string;
  readonly variantCode: string;
  readonly purpose: string;
  readonly requested: Money;
  readonly tenorMonths: number;
  readonly graceMonths: number;
  readonly contributionPerTenThousand: number;
  readonly receivedAtEpochSeconds: bigint;
  readonly submittedBy?: string;
  readonly submittedAtEpochSeconds?: bigint;
  readonly assessment?: { readonly outcome: AssessmentOutcome; readonly riskLevel?: string; readonly cumulativeScore?: number; readonly assessmentRef: string };
  readonly committee?: { readonly decidedBy: string; readonly approved: boolean; readonly reason: string; readonly atEpochSeconds: bigint };
  readonly offer?: { readonly letterVersion: string; readonly sentAtEpochSeconds: bigint; readonly channels: readonly string[] };
  readonly signature?: { readonly signatureRef: string; readonly atEpochSeconds: bigint };
  readonly disbursement?: { readonly paymentRef: string; readonly atEpochSeconds: bigint };
  readonly withdrawal?: { readonly reason: string; readonly atEpochSeconds: bigint };
}

export type AssessmentOutcome = 'STRAIGHT_THROUGH' | 'COMMITTEE' | 'DECLINE' | 'REFER';

export interface StageEvent {
  readonly eventType: string;
  readonly fromStage: BusinessStage | null;
  readonly toStage: BusinessStage;
  readonly actor: string;
  readonly atEpochSeconds: bigint;
  readonly detail: Readonly<Record<string, string>>;
}

export interface Transition { readonly application: BusinessApplication; readonly event: StageEvent }

const bad = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> => reject('OP-DETERMINACY', reason, detail, context);
const nonEmpty = (s: string | undefined): s is string => s !== undefined && s.trim().length > 0;

function move(app: BusinessApplication, to: BusinessStatus, patch: Partial<BusinessApplication>, eventType: string, actor: string, at: bigint, detail: Readonly<Record<string, string>> = {}): Transition {
  const application: BusinessApplication = { ...app, ...patch, status: to, stage: STAGE_OF[to] };
  return { application, event: { eventType, fromStage: app.stage, toStage: application.stage, actor, atEpochSeconds: at, detail } };
}

function expect(app: BusinessApplication, allowed: readonly BusinessStatus[], action: string): Result<true> {
  return allowed.includes(app.status) ? ok(true) : bad('TRANSITION_NOT_ALLOWED', `${action} is not possible from ${app.status}`, { status: app.status, action });
}

// -- Stage 5: hand-over, spreading, submission ------------------------------------

export interface HandoverInput {
  readonly applicationId: string;
  readonly upstreamRef: string;
  readonly tenantId: string;
  readonly applicant: BusinessApplicant;
  readonly productCode: string;
  readonly variantCode: string;
  readonly purpose: string;
  readonly requested: Money;
  readonly tenorMonths: number;
  readonly graceMonths: number;
  readonly contributionPerTenThousand: number;
}

/**
 * Receive an application from upstream at stage 5. The currency must be the
 * tenant's base currency: the caller passes it from the tenant's onboarding,
 * never from the payload.
 */
export function receiveHandover(input: HandoverInput, tenantCurrency: CurrencyCode, actor: string, at: bigint): Result<Transition> {
  if (!/^[A-Z]{2,4}-[0-9]{6,10}$/.test(input.applicationId)) return bad('APPLICATION_ID_MALFORMED', 'applicationId is a prefix and digits, e.g. FR-00005061');
  if (!nonEmpty(input.upstreamRef)) return bad('UPSTREAM_REF_REQUIRED', 'The upstream reference makes the hand-over idempotent');
  if (input.requested.currency !== tenantCurrency) return bad('CURRENCY_NOT_TENANTS', 'The amount is in the tenant’s base currency', { expected: tenantCurrency, given: input.requested.currency });
  if (input.requested.minorUnits <= 0n) return bad('AMOUNT_NOT_POSITIVE', 'The requested amount must be positive');
  if (!Number.isInteger(input.tenorMonths) || input.tenorMonths <= 0) return bad('TENOR_INVALID', 'tenorMonths is a positive whole number');
  if (!Number.isInteger(input.graceMonths) || input.graceMonths < 0 || input.graceMonths >= input.tenorMonths) return bad('GRACE_INVALID', 'graceMonths is a whole number below the tenor');
  if (!Number.isInteger(input.contributionPerTenThousand) || input.contributionPerTenThousand < 0 || input.contributionPerTenThousand > 10_000) return bad('CONTRIBUTION_INVALID', 'contributionPerTenThousand is in [0, 10000]');
  if (!nonEmpty(input.applicant.businessNameEn) || !nonEmpty(input.applicant.registrationRef)) return bad('APPLICANT_INCOMPLETE', 'The business name and registration reference are required');
  if (input.applicant.upstreamVerificationRefs.length === 0) return bad('UPSTREAM_VERIFICATION_MISSING', 'Stage 4 verification references are required before stage 5');
  if (/[0-9]{3}-?[0-9]{4}-?[0-9]{7}-?[0-9]/.test(JSON.stringify(input.applicant))) return bad('IDENTITY_NUMBER_IN_PAYLOAD', 'An identity number does not belong in the application record; send a reference');
  const application: BusinessApplication = { ...input, status: 'RECEIVED', stage: 5, receivedAtEpochSeconds: at };
  return ok({ application, event: { eventType: 'HANDED_OVER', fromStage: null, toStage: 5, actor, atEpochSeconds: at, detail: { upstreamRef: input.upstreamRef } } });
}

export function startSpreading(app: BusinessApplication, actor: string, at: bigint): Result<Transition> {
  const e = expect(app, ['RECEIVED'], 'Start the financial analysis'); if (!e.ok) return e;
  return ok(move(app, 'SPREADING', {}, 'SPREADING_STARTED', actor, at));
}

/** Submit for scoring: only with every required figure verified and every mandatory document present. */
export function submitForAssessment(app: BusinessApplication, readiness: { readonly spreadComplete: boolean; readonly missingFigures: readonly string[]; readonly checklistComplete: boolean; readonly missingDocuments: readonly string[] }, actor: string, at: bigint): Result<Transition> {
  const e = expect(app, ['RECEIVED', 'SPREADING'], 'Submit for assessment'); if (!e.ok) return e;
  if (!readiness.spreadComplete) return bad('FIGURES_NOT_VERIFIED', 'Every required figure is verified before scoring', { missing: readiness.missingFigures.join(',') });
  if (!readiness.checklistComplete) return bad('DOCUMENTS_MISSING', 'Every mandatory document is present before scoring', { missing: readiness.missingDocuments.join(',') });
  return ok(move(app, 'SUBMITTED', { submittedBy: actor, submittedAtEpochSeconds: at }, 'SUBMITTED_FOR_ASSESSMENT', actor, at));
}

// -- Stage 6: decisioning ------------------------------------------------------------

export function recordAssessment(app: BusinessApplication, result: { readonly outcome: AssessmentOutcome; readonly riskLevel?: string; readonly cumulativeScore?: number; readonly assessmentRef: string }, actor: string, at: bigint): Result<Transition> {
  const e = expect(app, ['SUBMITTED'], 'Record the assessment'); if (!e.ok) return e;
  if (!nonEmpty(result.assessmentRef)) return bad('ASSESSMENT_REF_REQUIRED', 'The assessment run is referenced');
  const assessment = { outcome: result.outcome, assessmentRef: result.assessmentRef, ...(result.riskLevel === undefined ? {} : { riskLevel: result.riskLevel }), ...(result.cumulativeScore === undefined ? {} : { cumulativeScore: result.cumulativeScore }) };
  const to: BusinessStatus = result.outcome === 'DECLINE' ? 'DECLINED' : result.outcome === 'COMMITTEE' || result.outcome === 'REFER' ? 'IN_COMMITTEE' : 'ASSESSED';
  return ok(move(app, to, { assessment }, 'ASSESSED', actor, at, { outcome: result.outcome, assessmentRef: result.assessmentRef }));
}

/** A straight-through case is approved by a checker who is not the submitting officer. */
export function approveStraightThrough(app: BusinessApplication, approver: string, at: bigint): Result<Transition> {
  const e = expect(app, ['ASSESSED'], 'Approve straight through'); if (!e.ok) return e;
  if (app.assessment?.outcome !== 'STRAIGHT_THROUGH') return bad('NOT_STRAIGHT_THROUGH', 'Only a straight-through assessment is approved without the committee');
  if (approver === app.submittedBy) return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_APPROVAL', 'The officer who submitted may not approve');
  return ok(move(app, 'APPROVED', {}, 'APPROVED_STRAIGHT_THROUGH', approver, at));
}

export function decideInCommittee(app: BusinessApplication, decision: { readonly decidedBy: string; readonly approved: boolean; readonly reason: string }, at: bigint): Result<Transition> {
  const e = expect(app, ['IN_COMMITTEE'], 'Decide in committee'); if (!e.ok) return e;
  if (decision.decidedBy === app.submittedBy) return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_APPROVAL', 'The officer who submitted may not decide in committee');
  if (decision.reason.trim().length < 3) return bad('COMMITTEE_REASON_REQUIRED', 'A committee decision records its reason');
  const committee = { decidedBy: decision.decidedBy, approved: decision.approved, reason: decision.reason, atEpochSeconds: at };
  return ok(move(app, decision.approved ? 'APPROVED' : 'DECLINED', { committee }, decision.approved ? 'COMMITTEE_APPROVED' : 'COMMITTEE_DECLINED', decision.decidedBy, at, { reason: decision.reason }));
}

// -- Stage 7: contract & disbursement --------------------------------------------------

export function recordOfferSent(app: BusinessApplication, offer: { readonly letterVersion: string; readonly channels: readonly string[] }, actor: string, at: bigint): Result<Transition> {
  const e = expect(app, ['APPROVED', 'OFFER_SENT'], 'Send the offer letter'); if (!e.ok) return e;
  if (!/^[0-9a-f]{64}$/.test(offer.letterVersion)) return bad('LETTER_VERSION_MALFORMED', 'The letter is identified by its content hash');
  if (offer.channels.length === 0) return bad('CHANNEL_REQUIRED', 'At least one notification channel');
  return ok(move(app, 'OFFER_SENT', { offer: { letterVersion: offer.letterVersion, channels: offer.channels, sentAtEpochSeconds: at } }, 'OFFER_SENT', actor, at, { letterVersion: offer.letterVersion, channels: offer.channels.join(',') }));
}

/** Signed: the signature must be on the letter version that was sent. */
export function recordSigned(app: BusinessApplication, signature: { readonly signatureRef: string; readonly letterVersion: string }, actor: string, at: bigint): Result<Transition> {
  const e = expect(app, ['OFFER_SENT'], 'Record the signature'); if (!e.ok) return e;
  if (app.offer === undefined || signature.letterVersion !== app.offer.letterVersion) return bad('SIGNED_LETTER_NOT_SENT_LETTER', 'The signature is on a different letter from the one sent');
  if (!nonEmpty(signature.signatureRef)) return bad('SIGNATURE_REF_REQUIRED', 'The signing service’s reference is required');
  return ok(move(app, 'SIGNED', { signature: { signatureRef: signature.signatureRef, atEpochSeconds: at } }, 'SIGNED', actor, at, { signatureRef: signature.signatureRef }));
}

export function recordDisbursed(app: BusinessApplication, paymentRef: string, actor: string, at: bigint): Result<Transition> {
  const e = expect(app, ['SIGNED'], 'Record the disbursement'); if (!e.ok) return e;
  if (!nonEmpty(paymentRef)) return bad('PAYMENT_REF_REQUIRED', 'The payment instruction’s reference is required');
  return ok(move(app, 'DISBURSED', { disbursement: { paymentRef, atEpochSeconds: at } }, 'DISBURSED', actor, at, { paymentRef }));
}

export function withdraw(app: BusinessApplication, reason: string, actor: string, at: bigint): Result<Transition> {
  const e = expect(app, ['RECEIVED', 'SPREADING', 'SUBMITTED', 'ASSESSED', 'IN_COMMITTEE', 'APPROVED', 'OFFER_SENT'], 'Withdraw'); if (!e.ok) return e;
  if (reason.trim().length < 3) return bad('WITHDRAWAL_REASON_REQUIRED', 'A withdrawal says why');
  const application: BusinessApplication = { ...app, status: 'WITHDRAWN', withdrawal: { reason, atEpochSeconds: at } };
  return ok({ application, event: { eventType: 'WITHDRAWN', fromStage: app.stage, toStage: app.stage, actor, atEpochSeconds: at, detail: { reason } } });
}
