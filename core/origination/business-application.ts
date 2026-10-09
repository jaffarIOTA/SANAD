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
  | 'RECEIVED'
  | 'SPREADING'
  | 'SUBMITTED'
  | 'ASSESSED'
  | 'IN_COMMITTEE'
  | 'APPROVED'
  | 'DECLINED'
  | 'OFFER_SENT'
  | 'SIGNED'
  | 'DISBURSED'
  | 'WITHDRAWN';

export const STAGE_OF: Readonly<Record<BusinessStatus, BusinessStage>> = {
  RECEIVED: 5,
  SPREADING: 5,
  SUBMITTED: 5,
  ASSESSED: 6,
  IN_COMMITTEE: 6,
  APPROVED: 6,
  DECLINED: 6,
  OFFER_SENT: 7,
  SIGNED: 7,
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
  readonly assessment?: {
    readonly outcome: AssessmentOutcome;
    readonly riskLevel?: string;
    readonly cumulativeScore?: number;
    readonly assessmentRef: string;
  };
  readonly committee?: {
    readonly decidedBy: string;
    readonly approved: boolean;
    readonly reason: string;
    readonly atEpochSeconds: bigint;
  };
  /**
   * What was approved, recorded by the decision that approved it: the amount
   * and tenor the offer is quoted on. `requested` and `tenorMonths` are never
   * overwritten — they stay the applicant's request. Absent on a record
   * decided before approved terms were recorded: read it through
   * `approvedTermsOf`, never directly.
   */
  readonly approvedTerms?: ApprovedTerms;
  readonly offer?: {
    readonly letterVersion: string;
    readonly sentAtEpochSeconds: bigint;
    readonly channels: readonly string[];
  };
  readonly signature?: { readonly signatureRef: string; readonly atEpochSeconds: bigint };
  readonly disbursement?: { readonly paymentRef: string; readonly atEpochSeconds: bigint };
  readonly withdrawal?: { readonly reason: string; readonly atEpochSeconds: bigint };
}

export type AssessmentOutcome = 'STRAIGHT_THROUGH' | 'COMMITTEE' | 'DECLINE' | 'REFER';

/**
 * How the approved terms came to be:
 *   STRAIGHT_THROUGH_AS_REQUESTED  a straight-through approval; it applies only when the request already qualifies
 *   COMMITTEE                      entered by the committee member and checked against the limits recorded with them
 *   RECORDED_BEFORE_APPROVED_TERMS a decision recorded before approved terms existed; read as the request (see `approvedTermsOf`)
 */
export type ApprovedTermsBasis = 'STRAIGHT_THROUGH_AS_REQUESTED' | 'COMMITTEE' | 'RECORDED_BEFORE_APPROVED_TERMS';

/**
 * The limits a committee approval is checked against, snapshotted with it so
 * the check can be reproduced: the risk band the assessment placed the
 * application in (the tenant's credit policy) and the product variant's
 * bounds (the tenant's catalogue). Plain data: this module knows no product.
 */
export interface ApprovalLimits {
  readonly riskLevel: string;
  readonly riskBandMaxAmount: Money;
  readonly riskBandMinContributionPerTenThousand: number;
  readonly variantCode: string;
  /** The product's minimum amount; a variant carries no minimum of its own. */
  readonly minAmount: Money;
  readonly variantMaxAmount: Money;
  readonly variantMinMonths: number;
  readonly variantMaxMonths: number;
  readonly variantMinContributionPerTenThousand: number;
  readonly variantMaxContributionPerTenThousand: number;
}

export interface ApprovedTerms {
  readonly amount: Money;
  readonly tenorMonths: number;
  readonly basis: ApprovedTermsBasis;
  /** Present for a committee approval: what the figures were checked against. */
  readonly limits?: ApprovalLimits;
}

/** What a committee member enters. Either figure left out takes its default (`defaultApprovedTerms`). */
export interface ProposedTerms {
  readonly amount?: Money;
  readonly tenorMonths?: number;
}

/** What the caller knows that the application does not: the tenant's currency and the limits (absent when the assessment placed it in no risk band). */
export interface ApprovalContext {
  readonly tenantCurrency: CurrencyCode;
  readonly limits?: ApprovalLimits;
}

export interface StageEvent {
  readonly eventType: string;
  readonly fromStage: BusinessStage | null;
  readonly toStage: BusinessStage;
  readonly actor: string;
  readonly atEpochSeconds: bigint;
  readonly detail: Readonly<Record<string, string>>;
}

export interface Transition {
  readonly application: BusinessApplication;
  readonly event: StageEvent;
}

const bad = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

/**
 * The identity-number shapes of both jurisdictions:
 *
 *   - the UAE national identity card number, 784-YYYY-NNNNNNN-N (fifteen
 *     digits), with dashes, spaces or no separators;
 *   - the Saudi national id and iqama, ten digits starting 1 (citizen) or 2
 *     (resident), as a run of exactly ten digits — not part of a longer run.
 */
const AE_IDENTITY_NUMBER = /\d{3}[- ]?\d{4}[- ]?\d{7}[- ]?\d/;
const SA_IDENTITY_NUMBER = /(?<!\d)[12]\d{9}(?!\d)/;
const IDENTITY_NUMBERS: readonly RegExp[] = [AE_IDENTITY_NUMBER, SA_IDENTITY_NUMBER];

/**
 * Whether any string anywhere in a value — nested objects and arrays
 * included — carries an identity-number shape. Strings are tested one by one
 * (never a serialisation of the whole, which would join adjacent digits), and
 * numbers and bigints are amounts, not text, so they are not tested. Keys
 * named in `skipKeys` (an amount carried as a digit string on the wire) are
 * passed over.
 *
 * Applied to every free-text and reference input the service accepts, not
 * only the hand-over: reasons, document references, figure source references,
 * bureau references, signature and payment references.
 */
export function containsIdentityNumber(value: unknown, skipKeys: ReadonlySet<string> = new Set()): boolean {
  if (typeof value === 'string') return IDENTITY_NUMBERS.some((p) => p.test(value));
  if (Array.isArray(value)) return value.some((v) => containsIdentityNumber(v, skipKeys));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => !skipKeys.has(k) && containsIdentityNumber(v, skipKeys),
    );
  }
  return false;
}
const nonEmpty = (s: string | undefined): s is string => s !== undefined && s.trim().length > 0;

function move(
  app: BusinessApplication,
  to: BusinessStatus,
  patch: Partial<BusinessApplication>,
  eventType: string,
  actor: string,
  at: bigint,
  detail: Readonly<Record<string, string>> = {},
): Transition {
  const application: BusinessApplication = { ...app, ...patch, status: to, stage: STAGE_OF[to] };
  return {
    application,
    event: { eventType, fromStage: app.stage, toStage: application.stage, actor, atEpochSeconds: at, detail },
  };
}

function expect(app: BusinessApplication, allowed: readonly BusinessStatus[], action: string): Result<true> {
  return allowed.includes(app.status)
    ? ok(true)
    : bad('TRANSITION_NOT_ALLOWED', `${action} is not possible from ${app.status}`, { status: app.status, action });
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
export function receiveHandover(
  input: HandoverInput,
  tenantCurrency: CurrencyCode,
  actor: string,
  at: bigint,
): Result<Transition> {
  if (!/^[A-Z]{2,4}-[0-9]{6,10}$/.test(input.applicationId))
    return bad('APPLICATION_ID_MALFORMED', 'applicationId is a prefix and digits, e.g. FR-00005061');
  if (!nonEmpty(input.upstreamRef))
    return bad('UPSTREAM_REF_REQUIRED', 'The upstream reference makes the hand-over idempotent');
  if (input.requested.currency !== tenantCurrency)
    return bad('CURRENCY_NOT_TENANTS', 'The amount is in the tenant’s base currency', {
      expected: tenantCurrency,
      given: input.requested.currency,
    });
  if (input.requested.minorUnits <= 0n) return bad('AMOUNT_NOT_POSITIVE', 'The requested amount must be positive');
  if (!Number.isInteger(input.tenorMonths) || input.tenorMonths <= 0)
    return bad('TENOR_INVALID', 'tenorMonths is a positive whole number');
  if (!Number.isInteger(input.graceMonths) || input.graceMonths < 0 || input.graceMonths >= input.tenorMonths)
    return bad('GRACE_INVALID', 'graceMonths is a whole number below the tenor');
  if (
    !Number.isInteger(input.contributionPerTenThousand) ||
    input.contributionPerTenThousand < 0 ||
    input.contributionPerTenThousand > 10_000
  )
    return bad('CONTRIBUTION_INVALID', 'contributionPerTenThousand is in [0, 10000]');
  if (!nonEmpty(input.applicant.businessNameEn) || !nonEmpty(input.applicant.registrationRef))
    return bad('APPLICANT_INCOMPLETE', 'The business name and registration reference are required');
  if (input.applicant.upstreamVerificationRefs.length === 0)
    return bad('UPSTREAM_VERIFICATION_MISSING', 'Stage 4 verification references are required before stage 5');
  // The whole hand-over, not only the applicant: an identity number in the upstream reference or a product field is refused too.
  if (containsIdentityNumber(input))
    return bad(
      'IDENTITY_NUMBER_IN_PAYLOAD',
      'An identity number does not belong in the application record; send a reference',
    );
  const application: BusinessApplication = { ...input, status: 'RECEIVED', stage: 5, receivedAtEpochSeconds: at };
  return ok({
    application,
    event: {
      eventType: 'HANDED_OVER',
      fromStage: null,
      toStage: 5,
      actor,
      atEpochSeconds: at,
      detail: { upstreamRef: input.upstreamRef },
    },
  });
}

export function startSpreading(app: BusinessApplication, actor: string, at: bigint): Result<Transition> {
  const e = expect(app, ['RECEIVED'], 'Start the financial analysis');
  if (!e.ok) return e;
  return ok(move(app, 'SPREADING', {}, 'SPREADING_STARTED', actor, at));
}

/** Submit for scoring: only with every required figure verified and every mandatory document present. */
export function submitForAssessment(
  app: BusinessApplication,
  readiness: {
    readonly spreadComplete: boolean;
    readonly missingFigures: readonly string[];
    readonly checklistComplete: boolean;
    readonly missingDocuments: readonly string[];
  },
  actor: string,
  at: bigint,
): Result<Transition> {
  const e = expect(app, ['RECEIVED', 'SPREADING'], 'Submit for assessment');
  if (!e.ok) return e;
  if (!readiness.spreadComplete)
    return bad('FIGURES_NOT_VERIFIED', 'Every required figure is verified before scoring', {
      missing: readiness.missingFigures.join(','),
    });
  if (!readiness.checklistComplete)
    return bad('DOCUMENTS_MISSING', 'Every mandatory document is present before scoring', {
      missing: readiness.missingDocuments.join(','),
    });
  return ok(
    move(app, 'SUBMITTED', { submittedBy: actor, submittedAtEpochSeconds: at }, 'SUBMITTED_FOR_ASSESSMENT', actor, at),
  );
}

// -- Stage 6: decisioning ------------------------------------------------------------

export function recordAssessment(
  app: BusinessApplication,
  result: {
    readonly outcome: AssessmentOutcome;
    readonly riskLevel?: string;
    readonly cumulativeScore?: number;
    readonly assessmentRef: string;
  },
  actor: string,
  at: bigint,
): Result<Transition> {
  const e = expect(app, ['SUBMITTED'], 'Record the assessment');
  if (!e.ok) return e;
  if (!nonEmpty(result.assessmentRef)) return bad('ASSESSMENT_REF_REQUIRED', 'The assessment run is referenced');
  const assessment = {
    outcome: result.outcome,
    assessmentRef: result.assessmentRef,
    ...(result.riskLevel === undefined ? {} : { riskLevel: result.riskLevel }),
    ...(result.cumulativeScore === undefined ? {} : { cumulativeScore: result.cumulativeScore }),
  };
  const to: BusinessStatus =
    result.outcome === 'DECLINE'
      ? 'DECLINED'
      : result.outcome === 'COMMITTEE' || result.outcome === 'REFER'
        ? 'IN_COMMITTEE'
        : 'ASSESSED';
  return ok(
    move(app, to, { assessment }, 'ASSESSED', actor, at, {
      outcome: result.outcome,
      assessmentRef: result.assessmentRef,
    }),
  );
}

/** A straight-through case is approved by a checker who is not the submitting officer. */
export function approveStraightThrough(app: BusinessApplication, approver: string, at: bigint): Result<Transition> {
  const e = expect(app, ['ASSESSED'], 'Approve straight through');
  if (!e.ok) return e;
  if (app.assessment?.outcome !== 'STRAIGHT_THROUGH')
    return bad('NOT_STRAIGHT_THROUGH', 'Only a straight-through assessment is approved without the committee');
  if (approver === app.submittedBy)
    return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_APPROVAL', 'The officer who submitted may not approve');
  // Straight through applies only when the request already qualifies, so what is approved is what was requested — recorded explicitly.
  const approvedTerms: ApprovedTerms = {
    amount: app.requested,
    tenorMonths: app.tenorMonths,
    basis: 'STRAIGHT_THROUGH_AS_REQUESTED',
  };
  return ok(
    move(
      app,
      'APPROVED',
      { approvedTerms },
      'APPROVED_STRAIGHT_THROUGH',
      approver,
      at,
      approvedDetail(app, approvedTerms),
    ),
  );
}

/** The event detail of an approval: requested and approved side by side, as digit strings. */
function approvedDetail(app: BusinessApplication, terms: ApprovedTerms): Readonly<Record<string, string>> {
  return {
    requestedMinorUnits: app.requested.minorUnits.toString(),
    requestedTenorMonths: String(app.tenorMonths),
    approvedMinorUnits: terms.amount.minorUnits.toString(),
    approvedTenorMonths: String(terms.tenorMonths),
    currency: terms.amount.currency,
  };
}

const minMoney = (a: Money, b: Money): Money => (a.minorUnits <= b.minorUnits ? a : b);

/**
 * The committee screen's defaults: the lower of the requested amount and the
 * risk band's maximum, and the lower of the requested tenor and the variant's
 * maximum. A default is a starting figure, not an approval: it is checked like
 * any figure the member enters.
 */
export function defaultApprovedTerms(
  app: BusinessApplication,
  limits: ApprovalLimits,
): { readonly amount: Money; readonly tenorMonths: number } {
  return {
    amount: minMoney(app.requested, limits.riskBandMaxAmount),
    tenorMonths: Math.min(app.tenorMonths, limits.variantMaxMonths),
  };
}

const limit = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-LIMIT', reason, detail, context);

/**
 * Checks a committee's approved amount and tenor against the request, the
 * risk band and the variant. Every refusal is typed: OP-DETERMINACY where a
 * figure is not a figure (not positive, not whole, not the tenant's currency,
 * limits for another variant), OP-LIMIT where it is a figure the limits do not
 * allow.
 *
 * Contribution: the application holds it as a share of the project cost
 * (per ten thousand, `contributionPerTenThousand`), not as a share of the
 * financing, so approving less financing does not change it. It is
 * re-checked as recorded against the band's minimum and the variant's band.
 */
export function checkApprovedTerms(
  app: BusinessApplication,
  proposed: { readonly amount: Money; readonly tenorMonths: number },
  limits: ApprovalLimits,
  tenantCurrency: CurrencyCode,
): Result<ApprovedTerms> {
  const limitAmounts = [limits.riskBandMaxAmount, limits.minAmount, limits.variantMaxAmount];
  if (limits.variantCode !== app.variantCode || limitAmounts.some((m) => m.currency !== tenantCurrency))
    return bad('APPROVAL_LIMITS_MISMATCH', 'The limits are not this application’s variant in the tenant’s currency', {
      variantCode: limits.variantCode,
    });
  const { amount, tenorMonths } = proposed;
  if (amount.currency !== tenantCurrency)
    return bad('APPROVED_CURRENCY_NOT_TENANTS', 'The approved amount is in the tenant’s base currency', {
      expected: tenantCurrency,
      given: amount.currency,
    });
  if (amount.minorUnits <= 0n) return bad('APPROVED_AMOUNT_NOT_POSITIVE', 'The approved amount must be positive');
  if (!Number.isSafeInteger(tenorMonths) || tenorMonths <= 0)
    return bad('APPROVED_TENOR_INVALID', 'The approved tenor is a positive whole number of months');
  const figures = {
    approvedMinorUnits: amount.minorUnits.toString(),
    approvedTenorMonths: String(tenorMonths),
  };
  if (amount.minorUnits > app.requested.minorUnits)
    return limit('APPROVED_AMOUNT_ABOVE_REQUESTED', 'The committee approves at most the amount requested', {
      ...figures,
      requestedMinorUnits: app.requested.minorUnits.toString(),
    });
  if (tenorMonths > app.tenorMonths)
    return limit('APPROVED_TENOR_ABOVE_REQUESTED', 'The committee approves at most the tenor requested', {
      ...figures,
      requestedTenorMonths: String(app.tenorMonths),
    });
  if (amount.minorUnits > limits.riskBandMaxAmount.minorUnits)
    return limit('APPROVED_AMOUNT_ABOVE_RISK_BAND', 'The approved amount is above the risk band’s maximum', {
      ...figures,
      riskLevel: limits.riskLevel,
      maxMinorUnits: limits.riskBandMaxAmount.minorUnits.toString(),
    });
  if (amount.minorUnits > limits.variantMaxAmount.minorUnits)
    return limit('APPROVED_AMOUNT_ABOVE_VARIANT', 'The approved amount is above the variant’s maximum', {
      ...figures,
      variantCode: limits.variantCode,
      maxMinorUnits: limits.variantMaxAmount.minorUnits.toString(),
    });
  if (amount.minorUnits < limits.minAmount.minorUnits)
    return limit('APPROVED_AMOUNT_BELOW_MINIMUM', 'The approved amount is below the product’s minimum', {
      ...figures,
      minMinorUnits: limits.minAmount.minorUnits.toString(),
    });
  if (tenorMonths < limits.variantMinMonths || tenorMonths > limits.variantMaxMonths)
    return limit('APPROVED_TENOR_OUTSIDE_VARIANT', 'The approved tenor is outside the variant’s tenor band', {
      ...figures,
      variantCode: limits.variantCode,
      minMonths: String(limits.variantMinMonths),
      maxMonths: String(limits.variantMaxMonths),
    });
  if (app.graceMonths >= tenorMonths)
    return limit('APPROVED_TENOR_NOT_ABOVE_GRACE', 'The approved tenor is longer than the grace period', {
      ...figures,
      graceMonths: String(app.graceMonths),
    });
  if (app.contributionPerTenThousand < limits.riskBandMinContributionPerTenThousand)
    return limit('CONTRIBUTION_BELOW_RISK_BAND', 'The owner’s contribution is below the risk band’s minimum', {
      riskLevel: limits.riskLevel,
      contributionPerTenThousand: String(app.contributionPerTenThousand),
      minPerTenThousand: String(limits.riskBandMinContributionPerTenThousand),
    });
  if (
    app.contributionPerTenThousand < limits.variantMinContributionPerTenThousand ||
    app.contributionPerTenThousand > limits.variantMaxContributionPerTenThousand
  )
    return limit('CONTRIBUTION_OUTSIDE_VARIANT', 'The owner’s contribution is outside the variant’s band', {
      variantCode: limits.variantCode,
      contributionPerTenThousand: String(app.contributionPerTenThousand),
      minPerTenThousand: String(limits.variantMinContributionPerTenThousand),
      maxPerTenThousand: String(limits.variantMaxContributionPerTenThousand),
    });
  return ok({ amount, tenorMonths, basis: 'COMMITTEE', limits });
}

/**
 * The credit committee's decision. An approval records the approved amount
 * and tenor, checked by `checkApprovedTerms`; a figure the member leaves out
 * takes its default. A decline records no terms. Four eyes and the reason are
 * checked first, so neither is masked by a terms refusal.
 */
export function decideInCommittee(
  app: BusinessApplication,
  decision: {
    readonly decidedBy: string;
    readonly approved: boolean;
    readonly reason: string;
    readonly terms?: ProposedTerms;
  },
  at: bigint,
  approval?: ApprovalContext,
): Result<Transition> {
  const e = expect(app, ['IN_COMMITTEE'], 'Decide in committee');
  if (!e.ok) return e;
  if (decision.decidedBy === app.submittedBy)
    return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_APPROVAL', 'The officer who submitted may not decide in committee');
  if (decision.reason.trim().length < 3)
    return bad('COMMITTEE_REASON_REQUIRED', 'A committee decision records its reason');
  if (containsIdentityNumber(decision.reason))
    return bad(
      'IDENTITY_NUMBER_IN_PAYLOAD',
      'An identity number does not belong in a committee reason; refer to the party by reference',
    );
  const committee = {
    decidedBy: decision.decidedBy,
    approved: decision.approved,
    reason: decision.reason,
    atEpochSeconds: at,
  };
  if (!decision.approved)
    return ok(
      move(app, 'DECLINED', { committee }, 'COMMITTEE_DECLINED', decision.decidedBy, at, { reason: decision.reason }),
    );

  if (approval === undefined)
    return bad('APPROVAL_CONTEXT_REQUIRED', 'An approval is checked against the tenant’s currency and limits');
  if (approval.limits === undefined)
    return bad(
      'RISK_BAND_REQUIRED',
      'An approval is checked against the risk band the assessment placed the application in; there is none',
    );
  const defaults = defaultApprovedTerms(app, approval.limits);
  const checked = checkApprovedTerms(
    app,
    {
      amount: decision.terms?.amount ?? defaults.amount,
      tenorMonths: decision.terms?.tenorMonths ?? defaults.tenorMonths,
    },
    approval.limits,
    approval.tenantCurrency,
  );
  if (!checked.ok) return checked;
  return ok(
    move(app, 'APPROVED', { committee, approvedTerms: checked.value }, 'COMMITTEE_APPROVED', decision.decidedBy, at, {
      reason: decision.reason,
      ...approvedDetail(app, checked.value),
    }),
  );
}

const APPROVED_ONWARDS: ReadonlySet<BusinessStatus> = new Set(['APPROVED', 'OFFER_SENT', 'SIGNED', 'DISBURSED']);

/**
 * The approved terms of an application, or undefined while it is undecided
 * or was declined.
 *
 * A decision recorded before approved terms were recorded (October 2026)
 * carries none. Such an application was offered on its request — that was the
 * only figure the service had — so its approved terms are read as the request,
 * with basis RECORDED_BEFORE_APPROVED_TERMS. The stored record is not
 * rewritten; the reading is derived each time. An application counts as
 * approved when the committee approved it, when it is APPROVED or later, or
 * when it was withdrawn after an offer was sent.
 */
export function approvedTermsOf(app: BusinessApplication): ApprovedTerms | undefined {
  if (app.approvedTerms !== undefined) return app.approvedTerms;
  const approved = app.committee?.approved === true || APPROVED_ONWARDS.has(app.status) || app.offer !== undefined;
  return approved
    ? { amount: app.requested, tenorMonths: app.tenorMonths, basis: 'RECORDED_BEFORE_APPROVED_TERMS' }
    : undefined;
}

// -- Stage 7: contract & disbursement --------------------------------------------------

export function recordOfferSent(
  app: BusinessApplication,
  offer: { readonly letterVersion: string; readonly channels: readonly string[] },
  actor: string,
  at: bigint,
): Result<Transition> {
  const e = expect(app, ['APPROVED', 'OFFER_SENT'], 'Send the offer letter');
  if (!e.ok) return e;
  if (!/^[0-9a-f]{64}$/.test(offer.letterVersion))
    return bad('LETTER_VERSION_MALFORMED', 'The letter is identified by its content hash');
  if (offer.channels.length === 0) return bad('CHANNEL_REQUIRED', 'At least one notification channel');
  return ok(
    move(
      app,
      'OFFER_SENT',
      { offer: { letterVersion: offer.letterVersion, channels: offer.channels, sentAtEpochSeconds: at } },
      'OFFER_SENT',
      actor,
      at,
      { letterVersion: offer.letterVersion, channels: offer.channels.join(',') },
    ),
  );
}

/** Signed: the signature must be on the letter version that was sent. */
export function recordSigned(
  app: BusinessApplication,
  signature: { readonly signatureRef: string; readonly letterVersion: string },
  actor: string,
  at: bigint,
): Result<Transition> {
  const e = expect(app, ['OFFER_SENT'], 'Record the signature');
  if (!e.ok) return e;
  if (app.offer === undefined || signature.letterVersion !== app.offer.letterVersion)
    return bad('SIGNED_LETTER_NOT_SENT_LETTER', 'The signature is on a different letter from the one sent');
  if (!nonEmpty(signature.signatureRef))
    return bad('SIGNATURE_REF_REQUIRED', 'The signing service’s reference is required');
  if (containsIdentityNumber(signature.signatureRef))
    return bad('IDENTITY_NUMBER_IN_PAYLOAD', 'An identity number does not belong in a signature reference');
  return ok(
    move(
      app,
      'SIGNED',
      { signature: { signatureRef: signature.signatureRef, atEpochSeconds: at } },
      'SIGNED',
      actor,
      at,
      { signatureRef: signature.signatureRef },
    ),
  );
}

export function recordDisbursed(
  app: BusinessApplication,
  paymentRef: string,
  actor: string,
  at: bigint,
): Result<Transition> {
  const e = expect(app, ['SIGNED'], 'Record the disbursement');
  if (!e.ok) return e;
  if (!nonEmpty(paymentRef)) return bad('PAYMENT_REF_REQUIRED', 'The payment instruction’s reference is required');
  if (containsIdentityNumber(paymentRef))
    return bad('IDENTITY_NUMBER_IN_PAYLOAD', 'An identity number does not belong in a payment reference');
  return ok(
    move(app, 'DISBURSED', { disbursement: { paymentRef, atEpochSeconds: at } }, 'DISBURSED', actor, at, {
      paymentRef,
    }),
  );
}

export function withdraw(app: BusinessApplication, reason: string, actor: string, at: bigint): Result<Transition> {
  const e = expect(
    app,
    ['RECEIVED', 'SPREADING', 'SUBMITTED', 'ASSESSED', 'IN_COMMITTEE', 'APPROVED', 'OFFER_SENT'],
    'Withdraw',
  );
  if (!e.ok) return e;
  if (reason.trim().length < 3) return bad('WITHDRAWAL_REASON_REQUIRED', 'A withdrawal says why');
  if (containsIdentityNumber(reason))
    return bad(
      'IDENTITY_NUMBER_IN_PAYLOAD',
      'An identity number does not belong in a withdrawal reason; refer to the party by reference',
    );
  const application: BusinessApplication = { ...app, status: 'WITHDRAWN', withdrawal: { reason, atEpochSeconds: at } };
  return ok({
    application,
    event: {
      eventType: 'WITHDRAWN',
      fromStage: app.stage,
      toStage: app.stage,
      actor,
      atEpochSeconds: at,
      detail: { reason },
    },
  });
}

// -- Offer date policy (tenant configuration) ----------------------------------------

/**
 * The bounds on the dates an officer may choose for an offer, and the
 * defaults when none is chosen — the tenant's credit policy, never a
 * constant. Whole days, as bigint.
 */
export interface OfferDatePolicy {
  readonly policyId: string;
  readonly version: string;
  /** Where the bounds come from; an illustrative policy says ILLUSTRATIVE here. */
  readonly policyRef: string;
  readonly maxDisbursementAfterOfferDays: bigint;
  readonly minFirstDueAfterDisbursementDays: bigint;
  readonly maxFirstDueAfterDisbursementDays: bigint;
  readonly defaultDisbursementAfterOfferDays: bigint;
  readonly offerValidityDays: bigint;
}

const OFFER_POLICY_DAYS = [
  'maxDisbursementAfterOfferDays',
  'minFirstDueAfterDisbursementDays',
  'maxFirstDueAfterDisbursementDays',
  'defaultDisbursementAfterOfferDays',
  'offerValidityDays',
] as const;

/** Parses an offer date policy from configuration; a malformed one is a refusal, never a default. */
export function parseOfferDatePolicy(raw: unknown): Result<OfferDatePolicy> {
  const malformed = (field: string): Result<never> =>
    bad('OFFER_POLICY_MALFORMED', 'The offer date policy is malformed', { field });
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return malformed('body');
  const r = raw as Record<string, unknown>;
  for (const k of ['policyId', 'version', 'policyRef'] as const)
    if (typeof r[k] !== 'string' || !nonEmpty(r[k])) return malformed(k);
  const days: Partial<Record<(typeof OFFER_POLICY_DAYS)[number], bigint>> = {};
  for (const k of OFFER_POLICY_DAYS) {
    const v = r[k];
    if (typeof v !== 'string' || !/^\d{1,4}$/.test(v)) return malformed(k);
    days[k] = BigInt(v);
  }
  const policy: OfferDatePolicy = {
    policyId: r['policyId'] as string,
    version: r['version'] as string,
    policyRef: r['policyRef'] as string,
    maxDisbursementAfterOfferDays: days.maxDisbursementAfterOfferDays ?? 0n,
    minFirstDueAfterDisbursementDays: days.minFirstDueAfterDisbursementDays ?? 0n,
    maxFirstDueAfterDisbursementDays: days.maxFirstDueAfterDisbursementDays ?? 0n,
    defaultDisbursementAfterOfferDays: days.defaultDisbursementAfterOfferDays ?? 0n,
    offerValidityDays: days.offerValidityDays ?? 0n,
  };
  if (policy.minFirstDueAfterDisbursementDays > policy.maxFirstDueAfterDisbursementDays)
    return malformed('minFirstDueAfterDisbursementDays');
  if (policy.defaultDisbursementAfterOfferDays > policy.maxDisbursementAfterOfferDays)
    return malformed('defaultDisbursementAfterOfferDays');
  if (policy.offerValidityDays === 0n) return malformed('offerValidityDays');
  return ok(policy);
}
