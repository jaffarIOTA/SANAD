'use server';

/**
 * Server actions for the SME business-application screens (stages 5–9).
 *
 * Thin, like `actions.ts`: parse the form, call the service, settle the change
 * to the database, redirect back with a notice code — or, on a refusal, with
 * the control code and the reason code only. No free text travels in the URL:
 * the screens render a refusal from their own reason-code maps, so nothing a
 * link carries is ever shown as the institution's words. None of them
 * contains a rule.
 *
 * Who acts is the signed-in principal, read from the sealed session on the
 * server by `authorise()` — never from the form (BE-09). Each act needs an
 * authority (authority.ts): the officer's acts MAKER; verifying a figure,
 * validating a document and running the assessment CHECKER; a straight-through
 * approval CHECKER or SENIOR_CHECKER; a committee decision CREDIT_COMMITTEE;
 * releasing disbursement FINANCE. The service's own four-eyes checks then
 * compare people: whoever keyed a figure, presented a document, submitted or
 * approved is a different signed-in person from whoever checks it.
 *
 * What a figure is never comes from the form either: everything keyed here is
 * OFFICER_ENTRY (figures read by OCR or a rail enter only through the
 * service's ingestion path, which no action calls).
 *
 * The tenant is the signed-in principal's own, which must be active in the
 * deployment jurisdiction (ADR 0005); a form field naming a tenant is not read.
 * Currency never comes from a form.
 */

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { FinancialMetric } from '@sanad/core/applicant/financials.ts';
import type { TenantCode } from '@sanad/config/loader.ts';
import type { Result } from '@sanad/core/kernel/result.ts';

import type { WorkbenchAct } from './authority.ts';
import { fetchBankStatements, fetchBureauReport } from './business-rails.ts';
import { uploadBusinessDocument } from './business-storage.ts';
import { confirmSigning, startSigning } from './business-signing.ts';
import { recordFixtureCollectionResult, recordFixturePaymentResult } from './business-payments.ts';
import { bookInLoanSystem } from './business-booking.ts';
import { renderOfferPdf, sealSignedLetter } from './business-letter-pdf.ts';
import { readFiguresFromStatement } from './business-statement-reading.ts';
import {
  buyCommodity,
  sellCommodityOnBehalf,
  sellCommodityToCustomer,
  transferCommodityTitle,
} from './business-tawarruq.ts';
import {
  approveStraightThrough,
  confirmBankStatementFacts,
  confirmSecurityItem,
  confirmPayee,
  confirmRepayment,
  planTranches,
  presentCollections,
  reportToBureau,
  approveRestructure,
  assessLateCharges,
  liftHardship,
  proposeRestructure,
  setHardship,
  waiveLateCharge,
  recordRepayment,
  recordPayee,
  satisfyCondition,
  verifyCondition,
  addCondition,
  addCovenant,
  justifyDeviation,
  withdrawPackItem,
  recordCollateral,
  recordGuarantee,
  withdrawSecurityItem,
  decideInCommittee,
  recordCreditNotes,
  generateOffer,
  mutateBusiness,
  presentDocument,
  proposeFigures,
  recordAssessmentInputs,
  recordDisbursed,
  recordPortfolioStatus,
  recordSigned,
  runAssessment,
  sendOffer,
  submitForAssessment,
  validateDocument,
  verifyFigure,
  withdrawApplication,
} from './business.ts';
import { authorise, localeSegmentOf } from './session.ts';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

interface Context {
  readonly locale: string;
  readonly tenant: TenantCode;
  readonly applicationId: string;
  readonly path: string;
  /** The signed-in principal's id: who performs this act. */
  readonly actor: string;
}

/** A refusal goes back as codes only: the control and the reason. The screen words it from its own maps. */
const refusalQuery = (control: string, reason: string): string => new URLSearchParams({ control, reason }).toString();

async function contextOf(form: FormData, act: WorkbenchAct): Promise<Context> {
  const locale = localeSegmentOf(field(form, 'locale') || 'en');
  const applicationId = field(form, 'applicationId');
  // The screen to return to: one of the application's own sub-screens, from a fixed list — never a path from the form.
  const screen = field(form, 'screen');
  const suffix = screen === 'assessment' || screen === 'offer' || screen === 'decision' ? `/${screen}` : '';
  const path =
    applicationId === '' ? `/${locale}/business` : `/${locale}/business/${encodeURIComponent(applicationId)}${suffix}`;
  // No session: to sign in. No authority for this act: back with AUTHORITY_REQUIRED. Tenant not active: to sign in.
  const staff = await authorise(locale, act, path);
  return { locale, tenant: staff.tenantId, applicationId, path, actor: staff.principalId };
}

/**
 * Make the change and save it as one unit under the tenant's lock, then send
 * the browser back with a notice. A refusal — the service's, or the save's
 * (STALE_APPLICATION, PERSISTENCE_FAILED: nothing was written) — goes back
 * with its codes only; the domain's detail stays on the server.
 */
async function finish<T>(
  ctx: Context,
  change: () => Promise<Result<T>>,
  notice: string | ((value: T) => string),
): Promise<never> {
  const result = await mutateBusiness(ctx.tenant, change);
  revalidatePath(`/${ctx.locale}/business`);
  if (ctx.applicationId !== '') revalidatePath(ctx.path);
  if (!result.ok) {
    // A licence refusal travels as LICENCE_<why>, so the screen words the specific reason from its own map.
    const why = result.error.context?.['licenceReason'];
    const reason =
      result.error.control === 'OP-LICENCE' && typeof why === 'string' ? `LICENCE_${why}` : result.error.reason;
    redirect(`${ctx.path}?${refusalQuery(result.error.control, reason)}`);
  }
  const said = typeof notice === 'string' ? notice : notice(result.value);
  redirect(`${ctx.path}?${new URLSearchParams({ notice: said }).toString()}`);
}

/** A refusal made here, before the service is called: the reason code is what travels; the detail never leaves the server. */
function refused(reason: string, detail: string): () => Promise<Result<never>> {
  return () => Promise.resolve({ ok: false, error: { control: 'OP-DETERMINACY', reason, detail } });
}

/** A whole number of minor units from a digit string, or from a major-unit amount with up to two decimals. No float. */
function minorUnits(raw: string): bigint | undefined {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(raw.replace(/,/g, ''));
  if (m === null) return undefined;
  return BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

const wholeBigint = (raw: string): bigint | undefined => (/^\d{1,9}$/.test(raw) ? BigInt(raw) : undefined);

// -- Stage 5 -------------------------------------------------------------------

/**
 * One figure per submission: metric, period, amount (major units) and the
 * document it was keyed from. Always OFFICER_ENTRY by the signed-in officer — a
 * `sourceKind` field on the form is ignored.
 */
export async function proposeFigureAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const amount = minorUnits(field(form, 'amount'));
  if (amount === undefined)
    return finish(ctx, refused('AMOUNT_MALFORMED', 'Enter the amount as a number with at most two decimals'), '');
  const negative = field(form, 'negative') === 'true';
  return finish(
    ctx,
    () =>
      proposeFigures(
        ctx.tenant,
        ctx.applicationId,
        [
          {
            metric: field(form, 'metric') as FinancialMetric,
            periodLabel: field(form, 'periodLabel'),
            minorUnits: negative ? -amount : amount,
            sourceRef: field(form, 'sourceRef'),
          },
        ],
        ctx.actor,
      ),
    'FIGURE_PROPOSED',
  );
}

/**
 * Verify a figure, or correct it, as the signed-in checker. The service
 * refuses the person who keyed it; a correction is recorded as the verifier's
 * own keyed figure, which a different person then verifies.
 */
export async function verifyFigureAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_VERIFY');
  const corrected = field(form, 'correctedAmount');
  const correctedMinor = corrected === '' ? undefined : minorUnits(corrected);
  if (corrected !== '' && correctedMinor === undefined)
    return finish(
      ctx,
      refused('AMOUNT_MALFORMED', 'Enter the corrected amount as a number with at most two decimals'),
      '',
    );
  const figureId = field(form, 'figureId');
  return finish(
    ctx,
    () => verifyFigure(ctx.tenant, ctx.applicationId, figureId, ctx.actor, correctedMinor),
    correctedMinor === undefined ? 'FIGURE_VERIFIED' : 'FIGURE_CORRECTED',
  );
}

/** The officer presents a document by reference; it is PENDING until a checker — another person — validates it. */
export async function presentDocumentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () =>
      presentDocument(
        ctx.tenant,
        ctx.applicationId,
        { documentType: field(form, 'documentType'), documentRef: field(form, 'documentRef') },
        ctx.actor,
      ),
    'DOCUMENT_PRESENTED',
  );
}

/**
 * The officer uploads a document's file. The bytes go to the tenant's object
 * store, the application records their hash, and the document is PENDING
 * until a checker — another person — validates it, as a referenced one is.
 * The file's name and the browser's declared type are not read.
 */
export async function uploadDocumentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const file = form.get('file');
  if (!(file instanceof Blob) || file.size === 0)
    return finish(ctx, refused('UPLOAD_EMPTY', 'Choose a file to upload'), '');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return finish(
    ctx,
    () =>
      uploadBusinessDocument(
        ctx.tenant,
        ctx.applicationId,
        field(form, 'documentType'),
        bytes,
        ctx.actor,
        randomUUID(),
      ),
    'DOCUMENT_UPLOADED',
  );
}

/**
 * The officer asks the document engine to read an uploaded statement. The form
 * carries the document reference only: every value proposed comes from the
 * document as read, through the system's ingestion principal, and is verified
 * by a person before it is used.
 */
export async function readStatementAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () => readFiguresFromStatement(ctx.tenant, ctx.applicationId, field(form, 'documentRef'), randomUUID()),
    'STATEMENT_READ',
  );
}

/** The checker validates a presented document: decision VALID or INVALID. */
export async function validateDocumentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_VERIFY');
  const decision = field(form, 'decision');
  if (decision !== 'VALID' && decision !== 'INVALID')
    return finish(ctx, refused('DOCUMENT_DECISION_INVALID', 'A document is validated as VALID or INVALID'), '');
  return finish(
    ctx,
    () => validateDocument(ctx.tenant, ctx.applicationId, field(form, 'documentRef'), decision, ctx.actor),
    decision === 'VALID' ? 'DOCUMENT_VALIDATED' : 'DOCUMENT_REJECTED',
  );
}

export async function recordAssessmentInputsAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  // A fetched bureau report sends no bureau fields: the service uses what was fetched.
  const keyedScore = field(form, 'bureauScore');
  const score = keyedScore === '' ? undefined : wholeBigint(keyedScore);
  if (keyedScore !== '' && score === undefined)
    return finish(ctx, refused('INPUT_MALFORMED', 'The bureau score is a whole number'), '');
  const numbers = {
    experience: wholeBigint(field(form, 'relevantExperienceYears')),
    commitment: wholeBigint(field(form, 'commitmentRatioPerTenThousand')),
    risk: wholeBigint(field(form, 'riskAnalysisScorePerTenThousand')),
    portfolio: wholeBigint(field(form, 'portfolioRepaymentPerTenThousand')),
    failed: wholeBigint(field(form, 'failedFilesRatePerTenThousand')),
    collateral: minorUnits(field(form, 'collateralValue')),
  };
  const employees = field(form, 'fullTimeEmployees');
  if (Object.values(numbers).some((v) => v === undefined) || !/^\d{1,6}$/.test(employees)) {
    return finish(
      ctx,
      refused('INPUT_MALFORMED', 'Every assessment input is a whole number; the collateral value an amount'),
      '',
    );
  }
  return finish(
    ctx,
    () =>
      recordAssessmentInputs(
        ctx.tenant,
        ctx.applicationId,
        {
          ...(score === undefined
            ? {}
            : {
                bureau: {
                  reportRef: field(form, 'bureauReportRef'),
                  consentId: field(form, 'bureauConsentId'),
                  score,
                },
              }),
          fullTimeEmployees: Number.parseInt(employees, 10),
          relevantExperienceYears: numbers.experience as bigint,
          sectorPriority: field(form, 'sectorPriority'),
          auditedFinancialsAvailable: field(form, 'auditedFinancialsAvailable') === 'true',
          commitmentRatioPerTenThousand: numbers.commitment as bigint,
          riskAnalysisScorePerTenThousand: numbers.risk as bigint,
          portfolioRepaymentPerTenThousand: numbers.portfolio as bigint,
          failedFilesRatePerTenThousand: numbers.failed as bigint,
          collateralValueMinorUnits: numbers.collateral as bigint,
        },
        ctx.actor,
      ),
    'INPUTS_RECORDED',
  );
}

/** Fetch the business's commercial bureau report under its intake consent. */
export async function fetchBureauReportAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(ctx, () => fetchBureauReport(ctx.tenant, ctx.applicationId, ctx.actor), 'BUREAU_REPORT_FETCHED');
}

/** Read the business's bank statements through Open Finance under its intake consent. */
export async function fetchBankStatementsAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(ctx, () => fetchBankStatements(ctx.tenant, ctx.applicationId, ctx.actor), 'BANK_STATEMENTS_FETCHED');
}

/** A checker other than the fetching officer confirms the bank-statement facts. */
export async function confirmBankStatementsAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_VERIFY');
  return finish(
    ctx,
    () => confirmBankStatementFacts(ctx.tenant, ctx.applicationId, ctx.actor),
    'BANK_STATEMENTS_CONFIRMED',
  );
}

export async function submitForAssessmentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(ctx, () => submitForAssessment(ctx.tenant, ctx.applicationId, ctx.actor), 'SUBMITTED');
}

// -- Stage 6 -------------------------------------------------------------------

/** Run by a checker: the officer who submitted the case does not score it (the service refuses the same person). */
export async function runAssessmentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_ASSESS');
  return finish(ctx, () => runAssessment(ctx.tenant, ctx.applicationId, ctx.actor), 'ASSESSED');
}

export async function approveStraightThroughAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_APPROVE');
  return finish(ctx, () => approveStraightThrough(ctx.tenant, ctx.applicationId, ctx.actor), 'APPROVED');
}

/**
 * The committee's decision. On approval, the approved amount (major units,
 * the tenant's currency — no currency field is read) and tenor in months; a
 * field left empty takes the server's default. Only the shape is checked
 * here; whether the figures are allowed is the service's decision.
 */
export async function committeeDecisionAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_COMMITTEE');
  const approved = field(form, 'approved') === 'true';
  const rawAmount = approved ? field(form, 'approvedAmount') : '';
  const rawTenor = approved ? field(form, 'approvedTenorMonths') : '';
  const amount = rawAmount === '' ? undefined : minorUnits(rawAmount);
  if (rawAmount !== '' && amount === undefined)
    return finish(
      ctx,
      refused('APPROVED_AMOUNT_MALFORMED', 'Enter the approved amount as a number with at most two decimals'),
      '',
    );
  if (rawTenor !== '' && !/^\d{1,3}$/.test(rawTenor))
    return finish(ctx, refused('APPROVED_TENOR_MALFORMED', 'Enter the approved tenor as a whole number of months'), '');
  return finish(
    ctx,
    () =>
      decideInCommittee(ctx.tenant, ctx.applicationId, {
        decidedBy: ctx.actor,
        approved,
        reason: field(form, 'reason'),
        ...(amount === undefined ? {} : { approvedAmountMinorUnits: amount }),
        ...(rawTenor === '' ? {} : { approvedTenorMonths: Number.parseInt(rawTenor, 10) }),
      }),
    // An approval short of the delegation of authority's quorum is recorded, not yet a decision.
    (v) =>
      !approved
        ? 'COMMITTEE_DECLINED'
        : v.application.status === 'APPROVED'
          ? 'COMMITTEE_APPROVED'
          : 'COMMITTEE_APPROVAL_RECORDED',
  );
}

/** The analyst's credit report notes for the committee. */
export async function creditNotesAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_CREDIT_NOTES');
  return finish(
    ctx,
    () => recordCreditNotes(ctx.tenant, ctx.applicationId, ctx.actor, field(form, 'creditNotes')),
    'CREDIT_NOTES_RECORDED',
  );
}

// -- Stage 7 -------------------------------------------------------------------

export async function generateOfferAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const disbursementDate = field(form, 'disbursementDate');
  const firstDueDate = field(form, 'firstDueDate');
  return finish(
    ctx,
    () =>
      generateOffer(ctx.tenant, ctx.applicationId, ctx.actor, {
        ...(disbursementDate === '' ? {} : { disbursementDate }),
        ...(firstDueDate === '' ? {} : { firstDueDate }),
      }),
    'OFFER_GENERATED',
  );
}

/** Sending the same letter version twice is a no-op in the service; a resend needs a new version. */
export async function sendOfferAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(ctx, () => sendOffer(ctx.tenant, ctx.applicationId, ctx.actor), 'OFFER_SENT');
}

/** Stands in for the UAE Pass signing callback: records a fixture signature on the letter version the form names. */
export async function recordSignedAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () => recordSigned(ctx.tenant, ctx.applicationId, { letterVersion: field(form, 'letterVersion') }, ctx.actor),
    'SIGNED',
  );
}

/** Stands in for the partner bank's payment confirmation: records a fixture payment reference. Released by a finance user, never the approver. */
export async function recordDisbursedAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  return finish(ctx, () => recordDisbursed(ctx.tenant, ctx.applicationId, ctx.actor), 'DISBURSED');
}

// -- Stages 8–9, withdrawal ------------------------------------------------------

export async function recordPortfolioStatusAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const days = field(form, 'daysPastDue');
  const arrears = minorUnits(field(form, 'arrears') || '0');
  if (!/^\d{1,5}$/.test(days) || arrears === undefined)
    return finish(ctx, refused('INPUT_MALFORMED', 'Days past due is a whole number; arrears an amount'), '');
  return finish(
    ctx,
    () =>
      recordPortfolioStatus(
        ctx.tenant,
        ctx.applicationId,
        { daysPastDue: Number.parseInt(days, 10), arrearsMinorUnits: arrears },
        ctx.actor,
      ),
    'PORTFOLIO_RECORDED',
  );
}

export async function withdrawApplicationAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () => withdrawApplication(ctx.tenant, ctx.applicationId, field(form, 'reason'), ctx.actor),
    'WITHDRAWN',
  );
}

// -- The security register (UAE M3) -------------------------------------------------------

/** A civil date (YYYY-MM-DD) as epoch seconds at 00:00 UTC; undefined if it is not a real date. */
function civilDateSeconds(raw: string): bigint | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m === null) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return undefined;
  return BigInt(ms / 1000);
}

/** The officer records a collateral item: kind, description, market value, valuation date and valuer, charge. */
export async function recordCollateralAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const value = minorUnits(field(form, 'marketValue'));
  if (value === undefined) return finish(ctx, refused('AMOUNT_MALFORMED', 'The market value is an amount'), '');
  const valuedAt = civilDateSeconds(field(form, 'valuedOn'));
  if (valuedAt === undefined) return finish(ctx, refused('DATE_MALFORMED', 'The valuation date is a date'), '');
  const evidenceRef = field(form, 'evidenceRef');
  const chargeRef = field(form, 'chargeRef');
  return finish(
    ctx,
    () =>
      recordCollateral(
        ctx.tenant,
        ctx.applicationId,
        {
          kind: field(form, 'kind'),
          description: field(form, 'description'),
          marketValueMinorUnits: value,
          valuedAtEpochSeconds: valuedAt,
          valuerRef: field(form, 'valuerRef'),
          ...(evidenceRef === '' ? {} : { evidenceRef }),
          charge: field(form, 'charge'),
          ...(chargeRef === '' ? {} : { chargeRef }),
        },
        ctx.actor,
      ),
    'COLLATERAL_RECORDED',
  );
}

/** The officer records a guarantee: an owner's personal guarantee, or a company's. Limited when a limit is given. */
export async function recordGuaranteeAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const kind = field(form, 'guarantorKind');
  const rawLimit = field(form, 'limit');
  const limit = rawLimit === '' ? undefined : minorUnits(rawLimit);
  if (rawLimit !== '' && limit === undefined)
    return finish(ctx, refused('AMOUNT_MALFORMED', 'The guarantee limit is an amount'), '');
  const deedRef = field(form, 'deedRef');
  return finish(
    ctx,
    () =>
      recordGuarantee(
        ctx.tenant,
        ctx.applicationId,
        {
          guarantorKind: kind,
          guarantorRef: field(form, kind === 'PERSONAL' ? 'ownerRef' : 'companyRef'),
          guarantorName: field(form, 'companyName'),
          ...(limit === undefined ? {} : { limitMinorUnits: limit }),
          ...(deedRef === '' ? {} : { deedRef }),
        },
        ctx.actor,
      ),
    'GUARANTEE_RECORDED',
  );
}

/** A checker — not whoever recorded it — confirms a collateral item or guarantee. */
export async function confirmSecurityAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_VERIFY');
  return finish(
    ctx,
    () => confirmSecurityItem(ctx.tenant, ctx.applicationId, field(form, 'itemId'), ctx.actor),
    'SECURITY_CONFIRMED',
  );
}

/** The officer withdraws an item before submission; it stays on record, counted nowhere. */
export async function withdrawSecurityAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () => withdrawSecurityItem(ctx.tenant, ctx.applicationId, field(form, 'itemId'), ctx.actor),
    'SECURITY_WITHDRAWN',
  );
}

// -- The decision pack (UAE M4) -----------------------------------------------------------

/** Credit attaches a condition precedent or subsequent, in both languages. */
export async function addConditionAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_CREDIT_NOTES');
  const kind = field(form, 'kind');
  const rawDue = field(form, 'dueDays');
  const due = rawDue === '' ? undefined : /^\d{1,4}$/.test(rawDue) ? Number(rawDue) : -1;
  return finish(
    ctx,
    () =>
      addCondition(
        ctx.tenant,
        ctx.applicationId,
        {
          kind,
          textEn: field(form, 'textEn'),
          textAr: field(form, 'textAr'),
          ...(due === undefined ? {} : { dueDaysAfterDisbursement: due }),
        },
        ctx.actor,
      ),
    'CONDITION_ADDED',
  );
}

/** Credit attaches a covenant from the institution's templates; no threshold is typed. */
export async function addCovenantAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_CREDIT_NOTES');
  return finish(
    ctx,
    () => addCovenant(ctx.tenant, ctx.applicationId, field(form, 'templateCode'), ctx.actor),
    'COVENANT_ADDED',
  );
}

export async function withdrawPackItemAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_CREDIT_NOTES');
  return finish(
    ctx,
    () => withdrawPackItem(ctx.tenant, ctx.applicationId, field(form, 'itemId'), ctx.actor),
    'PACK_ITEM_WITHDRAWN',
  );
}

/** Credit states the mitigant for a deviation the assessment recorded. */
export async function justifyDeviationAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_CREDIT_NOTES');
  return finish(
    ctx,
    () => justifyDeviation(ctx.tenant, ctx.applicationId, field(form, 'code'), field(form, 'justification'), ctx.actor),
    'DEVIATION_JUSTIFIED',
  );
}

// -- Closing (UAE M5a): signing, conditions precedent, payee ------------------------------

/** Open the signing intent at the identity service on the letter version that was sent. */
export async function startSigningAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(ctx, () => startSigning(ctx.tenant, ctx.applicationId, ctx.actor), 'SIGNING_STARTED');
}

/** Ask the identity service whether the signatory has signed; records the signature if so. */
export async function confirmSigningAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(ctx, () => confirmSigning(ctx.tenant, ctx.applicationId, ctx.actor), 'SIGNED_THROUGH_IDENTITY');
}

/** The officer evidences a condition precedent with a document on the application. */
export async function satisfyConditionAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () =>
      satisfyCondition(
        ctx.tenant,
        ctx.applicationId,
        field(form, 'conditionId'),
        field(form, 'evidenceRef'),
        ctx.actor,
      ),
    'CP_SATISFIED',
  );
}

/** A second person verifies a condition precedent's evidence. */
export async function verifyConditionAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_VERIFY');
  return finish(
    ctx,
    () => verifyCondition(ctx.tenant, ctx.applicationId, field(form, 'conditionId'), ctx.actor),
    'CP_VERIFIED',
  );
}

/** The officer records the payee account, proven by a document on the application. */
export async function recordPayeeAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () =>
      recordPayee(
        ctx.tenant,
        ctx.applicationId,
        { iban: field(form, 'iban'), accountName: field(form, 'accountName'), evidenceRef: field(form, 'evidenceRef') },
        ctx.actor,
      ),
    'PAYEE_RECORDED',
  );
}

/** A second person confirms the payee account against its evidence. */
export async function confirmPayeeAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_VERIFY');
  return finish(ctx, () => confirmPayee(ctx.tenant, ctx.applicationId, ctx.actor), 'PAYEE_CONFIRMED');
}

// -- Tranches and payment results (UAE M5b) -----------------------------------------------

/**
 * The officer plans the drawdowns: one tranche per line, "amount" or
 * "amount, yyyy-mm-dd". Amounts in major units with up to two decimals; the
 * service checks they add up to the facility.
 */
export async function planTranchesAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const lines = field(form, 'plan')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const plan: { amountMinorUnits: bigint; plannedDate?: string }[] = [];
  for (const line of lines) {
    const [amount = '', date = ''] = line.split(',').map((x) => x.trim());
    const minor = minorUnits(amount);
    if (minor === undefined) return finish(ctx, refused('AMOUNT_MALFORMED', 'Each tranche starts with an amount'), '');
    plan.push({ amountMinorUnits: minor, ...(date === '' ? {} : { plannedDate: date }) });
  }
  return finish(ctx, () => planTranches(ctx.tenant, ctx.applicationId, plan, ctx.actor), 'TRANCHES_PLANNED');
}

/** On the synthetic site only: finance records the bank's result for the latest released tranche, marked Fixture. */
export async function recordFixturePaymentResultAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  const status = field(form, 'status');
  if (status !== 'SETTLED' && status !== 'REJECTED')
    return finish(ctx, refused('PAYMENT_STATUS_INVALID', 'A fixture result is settled or rejected'), '');
  return finish(
    ctx,
    () => recordFixturePaymentResult(ctx.tenant, ctx.applicationId, status, ctx.actor),
    'PAYMENT_RESULT_RECORDED',
  );
}

// -- Booking in the loan system (UAE M6) --------------------------------------------------

/** Finance books the disbursed loan in the loan system; the loan account number it returns is recorded. */
export async function bookLoanAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  return finish(ctx, () => bookInLoanSystem(ctx.tenant, ctx.applicationId, ctx.actor), 'LOAN_BOOKED');
}

// -- Tawarruq execution (KSA K4) ----------------------------------------------------------

/** Finance (treasury) buys the commodity from the board-approved broker at the quoted cost. */
export async function buyCommodityAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  return finish(ctx, () => buyCommodity(ctx.tenant, ctx.applicationId, ctx.actor), 'TAWARRUQ_COMMODITY_PURCHASED');
}

/** The institution sells the commodity to the customer on the signed deferred-sale instrument. */
export async function sellCommodityToCustomerAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  return finish(
    ctx,
    () => sellCommodityToCustomer(ctx.tenant, ctx.applicationId, field(form, 'saleDocumentRef'), ctx.actor),
    'TAWARRUQ_SOLD_TO_CUSTOMER',
  );
}

export async function transferCommodityTitleAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  return finish(
    ctx,
    () => transferCommodityTitle(ctx.tenant, ctx.applicationId, ctx.actor),
    'TAWARRUQ_TITLE_TRANSFERRED',
  );
}

/** The commodity is sold on for cash — as the customer's agent where the board permits, naming the appointment. */
export async function sellCommodityOnBehalfAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  const agencyRef = field(form, 'agencyRef');
  return finish(
    ctx,
    () => sellCommodityOnBehalf(ctx.tenant, ctx.applicationId, agencyRef === '' ? undefined : agencyRef, ctx.actor),
    'TAWARRUQ_PROCEEDS_REALISED',
  );
}

// -- Servicing (S1) ------------------------------------------------------------------------

/** Finance records a receipt it can see on the bank statement; a second person confirms it before it counts. */
export async function recordRepaymentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  const amount = minorUnits(field(form, 'amount'));
  if (amount === undefined) return finish(ctx, refused('AMOUNT_MALFORMED', 'The repayment is an amount'), '');
  return finish(
    ctx,
    () =>
      recordRepayment(
        ctx.tenant,
        ctx.applicationId,
        {
          amountMinorUnits: amount,
          receivedOn: field(form, 'receivedOn'),
          reference: field(form, 'reference'),
          channel: 'MANUAL',
          source: 'LIVE',
        },
        ctx.actor,
      ),
    'REPAYMENT_RECORDED',
  );
}

export async function confirmRepaymentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_VERIFY');
  return finish(
    ctx,
    () => confirmRepayment(ctx.tenant, ctx.applicationId, field(form, 'repaymentId'), ctx.actor),
    'REPAYMENT_CONFIRMED',
  );
}

// -- Servicing (S2): collections and the bureau --------------------------------------------

/** Finance presents the instalments due now (and any overdue) for collection through the jurisdiction's channel. */
export async function presentCollectionsAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  return finish(ctx, () => presentCollections(ctx.tenant, ctx.applicationId, ctx.actor), 'COLLECTIONS_PRESENTED');
}

/** On the synthetic site only: finance records the channel's result for the oldest presented instalment, marked Fixture. */
export async function recordFixtureCollectionResultAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  const status = field(form, 'status');
  if (status !== 'PAID' && status !== 'RETURNED')
    return finish(ctx, refused('PAYMENT_STATUS_INVALID', 'A fixture result is paid or returned'), '');
  return finish(
    ctx,
    () => recordFixtureCollectionResult(ctx.tenant, ctx.applicationId, status, ctx.actor),
    'COLLECTION_RESULT_RECORDED',
  );
}

/** Finance reports this month's status to the credit bureau. */
export async function reportToBureauAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  return finish(ctx, () => reportToBureau(ctx.tenant, ctx.applicationId, ctx.actor), 'BUREAU_STATUS_REPORTED');
}

// -- Servicing (S3): late charges, hardship, restructuring ---------------------------------

export async function assessLateChargesAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_DISBURSE');
  return finish(ctx, () => assessLateCharges(ctx.tenant, ctx.applicationId, ctx.actor), 'LATE_CHARGES_ASSESSED');
}

export async function waiveLateChargeAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_VERIFY');
  const n = /^\d{1,4}$/.test(field(form, 'instalment')) ? Number(field(form, 'instalment')) : -1;
  return finish(
    ctx,
    () => waiveLateCharge(ctx.tenant, ctx.applicationId, n, field(form, 'reason'), ctx.actor),
    'LATE_CHARGE_WAIVED',
  );
}

export async function setHardshipAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(
    ctx,
    () => setHardship(ctx.tenant, ctx.applicationId, field(form, 'reason'), ctx.actor),
    'HARDSHIP_SET',
  );
}

export async function liftHardshipAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_VERIFY');
  return finish(ctx, () => liftHardship(ctx.tenant, ctx.applicationId, ctx.actor), 'HARDSHIP_LIFTED');
}

/** The officer proposes a restructuring from today: the number of new instalments and the first due date. */
export async function proposeRestructureAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const n = /^\d{1,3}$/.test(field(form, 'numberOfPayments')) ? Number(field(form, 'numberOfPayments')) : -1;
  return finish(
    ctx,
    () =>
      proposeRestructure(
        ctx.tenant,
        ctx.applicationId,
        { firstDueDate: field(form, 'firstDueDate'), numberOfPayments: n, reason: field(form, 'reason') },
        ctx.actor,
      ),
    'RESTRUCTURE_PROPOSED',
  );
}

/** A checker (not the proposer) approves a restructuring. */
export async function approveRestructureAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_APPROVE');
  return finish(
    ctx,
    () => approveRestructure(ctx.tenant, ctx.applicationId, field(form, 'restructureId'), ctx.actor),
    'RESTRUCTURE_APPROVED',
  );
}

// -- Offer letter PDF ------------------------------------------------------------------------

/** The officer renders the letter version shown as a PDF through the document engine. */
export async function renderOfferPdfAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  const version = field(form, 'letterVersion');
  return finish(
    ctx,
    () =>
      renderOfferPdf(
        ctx.tenant,
        ctx.applicationId,
        /^[0-9a-f]{64}$/.test(version) ? version : undefined,
        ctx.actor,
        randomUUID(),
      ),
    'OFFER_PDF_RENDERED',
  );
}

/** The officer seals the signed letter's PDF with the institution's digital signature. */
export async function sealSignedLetterAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form, 'BUSINESS_OFFICER');
  return finish(ctx, () => sealSignedLetter(ctx.tenant, ctx.applicationId, ctx.actor, randomUUID()), 'LETTER_SEALED');
}
