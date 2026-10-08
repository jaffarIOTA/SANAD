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
 * Who acts is resolved here, on the server, from the development roles —
 * never from the form (BE-09). The officer, the checker, the committee member
 * and the finance principal are distinct so four eyes is exercised, not
 * asserted: the officer keys figures, presents documents, records the
 * assessment inputs, submits, generates and sends; the checker verifies keyed
 * figures, validates documents, runs the assessment and approves
 * straight-through cases; the committee member decides referred cases; the
 * finance principal releases disbursement.
 *
 * What a figure is never comes from the form either: everything keyed here is
 * OFFICER_ENTRY (figures read by OCR or a rail enter only through the
 * service's ingestion path, which no action calls), and who verifies a figure
 * is decided from the stored figure, not from a hidden field.
 *
 * The tenant is the deployment's active tenant (ADR 0005). A form may name
 * one, and it is honoured only if it is active here; currency never comes
 * from a form.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { FinancialMetric } from '@sanad/core/applicant/financials.ts';
import type { TenantCode } from '@sanad/config/loader.ts';
import type { Result } from '@sanad/core/kernel/result.ts';

import {
  BUSINESS_ROLES,
  approveStraightThrough,
  decideInCommittee,
  generateOffer,
  getApplication,
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
import { workbenchJurisdiction } from './jurisdiction.ts';

const field = (form: FormData, name: string): string => String(form.get(name) ?? '').trim();

interface Context { readonly locale: string; readonly tenant: TenantCode; readonly applicationId: string; readonly path: string }

/** A refusal goes back as codes only: the control and the reason. The screen words it from its own maps. */
const refusalQuery = (control: string, reason: string): string => new URLSearchParams({ control, reason }).toString();

async function contextOf(form: FormData): Promise<Context> {
  const locale = field(form, 'locale') || 'en';
  const applicationId = field(form, 'applicationId');
  // The screen to return to: one of the application's own sub-screens, from a fixed list — never a path from the form.
  const screen = field(form, 'screen');
  const suffix = screen === 'assessment' || screen === 'offer' ? `/${screen}` : '';
  const path = applicationId === '' ? `/${locale}/business` : `/${locale}/business/${encodeURIComponent(applicationId)}${suffix}`;
  const requested = field(form, 'tenant');
  const j = await workbenchJurisdiction(requested === '' ? undefined : requested);
  if (j.tenant === undefined) redirect(`/${locale}/business?${refusalQuery('OP-DETERMINACY', 'NO_ACTIVE_TENANT')}`);
  return { locale, tenant: j.tenant, applicationId, path };
}

/**
 * Make the change and save it as one unit under the tenant's lock, then send
 * the browser back with a notice. A refusal — the service's, or the save's
 * (STALE_APPLICATION, PERSISTENCE_FAILED: nothing was written) — goes back
 * with its codes only; the domain's detail stays on the server.
 */
async function finish(ctx: Context, change: () => Promise<Result<unknown>>, notice: string): Promise<never> {
  const result = await mutateBusiness(ctx.tenant, change);
  revalidatePath(`/${ctx.locale}/business`);
  if (ctx.applicationId !== '') revalidatePath(ctx.path);
  if (!result.ok) redirect(`${ctx.path}?${refusalQuery(result.error.control, result.error.reason)}`);
  redirect(`${ctx.path}?${new URLSearchParams({ notice }).toString()}`);
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
 * document it was keyed from. Always OFFICER_ENTRY by the acting officer — a
 * `sourceKind` field on the form is ignored.
 */
export async function proposeFigureAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  const amount = minorUnits(field(form, 'amount'));
  if (amount === undefined) return finish(ctx, refused('AMOUNT_MALFORMED', 'Enter the amount as a number with at most two decimals'), '');
  const negative = field(form, 'negative') === 'true';
  return finish(ctx, () => proposeFigures(ctx.tenant, ctx.applicationId, [{
    metric: field(form, 'metric') as FinancialMetric,
    periodLabel: field(form, 'periodLabel'),
    minorUnits: negative ? -amount : amount,
    sourceRef: field(form, 'sourceRef'),
  }], BUSINESS_ROLES.officer), 'FIGURE_PROPOSED');
}

/**
 * Who verifies a figure, from the stored figure: a read figure (OCR, rail) by
 * the officer; a keyed figure by whichever of the officer and the checker did
 * not key it. The service enforces four eyes regardless.
 */
async function verifierFor(ctx: Context, figureId: string): Promise<string> {
  const v = await getApplication(ctx.tenant, ctx.applicationId);
  const figure = v?.figures.find((f) => f.figureId === figureId)?.figure;
  if (figure === undefined || figure.sourceKind !== 'OFFICER_ENTRY') return BUSINESS_ROLES.officer;
  return figure.enteredBy === BUSINESS_ROLES.checker ? BUSINESS_ROLES.officer : BUSINESS_ROLES.checker;
}

/**
 * Verify a figure, or correct it. A correction is recorded as the verifier's
 * own keyed figure, which a different principal then verifies.
 */
export async function verifyFigureAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  const corrected = field(form, 'correctedAmount');
  const correctedMinor = corrected === '' ? undefined : minorUnits(corrected);
  if (corrected !== '' && correctedMinor === undefined) return finish(ctx, refused('AMOUNT_MALFORMED', 'Enter the corrected amount as a number with at most two decimals'), '');
  const figureId = field(form, 'figureId');
  // The verifier is read from the stored figure inside the same locked unit as the verification.
  return finish(ctx, async () => verifyFigure(ctx.tenant, ctx.applicationId, figureId, await verifierFor(ctx, figureId), correctedMinor), correctedMinor === undefined ? 'FIGURE_VERIFIED' : 'FIGURE_CORRECTED');
}

/** The officer presents a document by reference; it is PENDING until the checker validates it. */
export async function presentDocumentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  return finish(ctx, () => presentDocument(ctx.tenant, ctx.applicationId, { documentType: field(form, 'documentType'), documentRef: field(form, 'documentRef') }, BUSINESS_ROLES.officer), 'DOCUMENT_PRESENTED');
}

/** The checker validates a presented document: decision VALID or INVALID. */
export async function validateDocumentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  const decision = field(form, 'decision');
  if (decision !== 'VALID' && decision !== 'INVALID') return finish(ctx, refused('DOCUMENT_DECISION_INVALID', 'A document is validated as VALID or INVALID'), '');
  return finish(ctx, () => validateDocument(ctx.tenant, ctx.applicationId, field(form, 'documentRef'), decision, BUSINESS_ROLES.checker), decision === 'VALID' ? 'DOCUMENT_VALIDATED' : 'DOCUMENT_REJECTED');
}

export async function recordAssessmentInputsAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  const numbers = {
    score: wholeBigint(field(form, 'bureauScore')),
    experience: wholeBigint(field(form, 'relevantExperienceYears')),
    commitment: wholeBigint(field(form, 'commitmentRatioPerTenThousand')),
    risk: wholeBigint(field(form, 'riskAnalysisScorePerTenThousand')),
    portfolio: wholeBigint(field(form, 'portfolioRepaymentPerTenThousand')),
    failed: wholeBigint(field(form, 'failedFilesRatePerTenThousand')),
    collateral: minorUnits(field(form, 'collateralValue')),
  };
  const employees = field(form, 'fullTimeEmployees');
  if (Object.values(numbers).some((v) => v === undefined) || !/^\d{1,6}$/.test(employees)) {
    return finish(ctx, refused('INPUT_MALFORMED', 'Every assessment input is a whole number; the collateral value an amount'), '');
  }
  return finish(ctx, () => recordAssessmentInputs(ctx.tenant, ctx.applicationId, {
    bureau: { reportRef: field(form, 'bureauReportRef'), consentId: field(form, 'bureauConsentId'), score: numbers.score as bigint },
    fullTimeEmployees: Number.parseInt(employees, 10),
    relevantExperienceYears: numbers.experience as bigint,
    sectorPriority: field(form, 'sectorPriority'),
    auditedFinancialsAvailable: field(form, 'auditedFinancialsAvailable') === 'true',
    commitmentRatioPerTenThousand: numbers.commitment as bigint,
    riskAnalysisScorePerTenThousand: numbers.risk as bigint,
    portfolioRepaymentPerTenThousand: numbers.portfolio as bigint,
    failedFilesRatePerTenThousand: numbers.failed as bigint,
    collateralValueMinorUnits: numbers.collateral as bigint,
  }, BUSINESS_ROLES.officer), 'INPUTS_RECORDED');
}

export async function submitForAssessmentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  return finish(ctx, () => submitForAssessment(ctx.tenant, ctx.applicationId, BUSINESS_ROLES.officer), 'SUBMITTED');
}

// -- Stage 6 -------------------------------------------------------------------

/** Run by the checker: the officer who submitted the case does not score it. */
export async function runAssessmentAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  return finish(ctx, () => runAssessment(ctx.tenant, ctx.applicationId, BUSINESS_ROLES.checker), 'ASSESSED');
}

export async function approveStraightThroughAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  return finish(ctx, () => approveStraightThrough(ctx.tenant, ctx.applicationId, BUSINESS_ROLES.checker), 'APPROVED');
}

export async function committeeDecisionAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  const approved = field(form, 'approved') === 'true';
  return finish(ctx, () => decideInCommittee(ctx.tenant, ctx.applicationId, { decidedBy: BUSINESS_ROLES.committee, approved, reason: field(form, 'reason') }), approved ? 'COMMITTEE_APPROVED' : 'COMMITTEE_DECLINED');
}

// -- Stage 7 -------------------------------------------------------------------

export async function generateOfferAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  const disbursementDate = field(form, 'disbursementDate');
  const firstDueDate = field(form, 'firstDueDate');
  return finish(ctx, () => generateOffer(ctx.tenant, ctx.applicationId, BUSINESS_ROLES.officer, {
    ...(disbursementDate === '' ? {} : { disbursementDate }),
    ...(firstDueDate === '' ? {} : { firstDueDate }),
  }), 'OFFER_GENERATED');
}

/** Sending the same letter version twice is a no-op in the service; a resend needs a new version. */
export async function sendOfferAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  return finish(ctx, () => sendOffer(ctx.tenant, ctx.applicationId, BUSINESS_ROLES.officer), 'OFFER_SENT');
}

/** Stands in for the UAE Pass signing callback: records a fixture signature on the letter version the form names. */
export async function recordSignedAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  return finish(ctx, () => recordSigned(ctx.tenant, ctx.applicationId, { letterVersion: field(form, 'letterVersion') }, BUSINESS_ROLES.officer), 'SIGNED');
}

/** Stands in for the partner bank's payment confirmation: records a fixture payment reference. Released by the finance principal. */
export async function recordDisbursedAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  return finish(ctx, () => recordDisbursed(ctx.tenant, ctx.applicationId, BUSINESS_ROLES.finance), 'DISBURSED');
}

// -- Stages 8–9, withdrawal ------------------------------------------------------

export async function recordPortfolioStatusAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  const days = field(form, 'daysPastDue');
  const arrears = minorUnits(field(form, 'arrears') || '0');
  if (!/^\d{1,5}$/.test(days) || arrears === undefined) return finish(ctx, refused('INPUT_MALFORMED', 'Days past due is a whole number; arrears an amount'), '');
  return finish(ctx, () => recordPortfolioStatus(ctx.tenant, ctx.applicationId, { daysPastDue: Number.parseInt(days, 10), arrearsMinorUnits: arrears }, BUSINESS_ROLES.officer), 'PORTFOLIO_RECORDED');
}

export async function withdrawApplicationAction(form: FormData): Promise<void> {
  const ctx = await contextOf(form);
  return finish(ctx, () => withdrawApplication(ctx.tenant, ctx.applicationId, field(form, 'reason'), BUSINESS_ROLES.officer), 'WITHDRAWN');
}
