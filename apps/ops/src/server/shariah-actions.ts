'use server';

/**
 * Server actions for the Shariah approvals register (Wasl W6a).
 *
 * Thin: parse the form, call the register's service, redirect back with a
 * notice code — or, on a refusal, the control and reason codes only, which
 * the page words from its own map. Who acts is the signed-in principal
 * (`authorise()`), never the form; the tenant is theirs. Proposing and
 * confirming each need a Shariah reviewer, and the service refuses the same
 * person doing both.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { TenantCode } from '@sanad/config/loader.ts';
import { type Result, reject } from '@sanad/core/kernel/result.ts';
import type { ApprovalChange } from '@sanad/core/shariah/approvals.ts';
import { INCIDENT_SEVERITIES, type IncidentAction, type IncidentSeverity } from '@sanad/core/shariah/incidents.ts';
import { decideApprovalChange, proposeApprovalChange } from '@sanad/origination/shariah/approvals.ts';
import { actOnIncident, raiseObservation } from '@sanad/origination/shariah/incidents.ts';
import { WASL_PRODUCT, getTransaction } from '@sanad/origination/wasl/book.ts';
import { runShariahReview } from '@sanad/origination/wasl/compliance.ts';

import { authorise, localeSegmentOf } from './session.ts';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** One entry per line or comma, trimmed, blanks dropped. */
const listOf = (form: FormData, name: string, max: number): readonly string[] =>
  field(form, name)
    .split(/[\n,،]/)
    .map((s) => s.trim().slice(0, 200))
    .filter((s) => s.length > 0)
    .slice(0, max);

const PATH = (locale: string) => `/${locale}/shariah/approvals`;

async function finish(locale: string, change: () => Promise<Result<unknown>>, notice: string): Promise<never> {
  const result = await change();
  revalidatePath(PATH(locale));
  const query = result.ok
    ? new URLSearchParams({ notice })
    : new URLSearchParams({ control: result.error.control, reason: result.error.reason });
  redirect(`${PATH(locale)}?${query.toString()}`);
}

/** A Shariah reviewer proposes recording an approval the board issued. */
export async function proposeApprovalRecordAction(form: FormData): Promise<void> {
  const locale = localeSegmentOf(field(form, 'locale') || 'en');
  const staff = await authorise(locale, 'SHARIAH_APPROVAL_PROPOSE', PATH(locale));
  const review = field(form, 'reviewOrExpiry');
  const change: ApprovalChange = {
    kind: 'RECORD',
    terms: {
      approvalRef: field(form, 'approvalRef').slice(0, 80),
      approvingBody: field(form, 'approvingBody').slice(0, 200),
      members: listOf(form, 'members', 21),
      effectiveFrom: field(form, 'effectiveFrom').slice(0, 10),
      ...(review === '' ? {} : { reviewOrExpiry: review.slice(0, 10) }),
      productCodes: form
        .getAll('productCodes')
        .filter((v): v is string => typeof v === 'string')
        .slice(0, 10),
      templateVersionIds: listOf(form, 'templateVersionIds', 51),
    },
  };
  return finish(
    locale,
    () =>
      proposeApprovalChange(staff.tenantId as TenantCode, staff.principalId, {
        change,
        reason: field(form, 'reason').slice(0, 1000),
      }),
    'APPROVAL_CHANGE_PROPOSED',
  );
}

/** A Shariah reviewer proposes suspending, reinstating, withdrawing or renewing a recorded approval. */
export async function proposeApprovalStatusAction(form: FormData): Promise<void> {
  const locale = localeSegmentOf(field(form, 'locale') || 'en');
  const staff = await authorise(locale, 'SHARIAH_APPROVAL_PROPOSE', PATH(locale));
  const approvalRef = field(form, 'approvalRef').slice(0, 80);
  const kind = field(form, 'kind');
  const change: ApprovalChange | undefined =
    kind === 'RENEW'
      ? { kind, approvalRef, reviewOrExpiry: field(form, 'reviewOrExpiry').slice(0, 10) }
      : kind === 'SUSPEND' || kind === 'REINSTATE' || kind === 'WITHDRAW'
        ? { kind, approvalRef }
        : undefined;
  if (change === undefined) redirect(PATH(locale));
  return finish(
    locale,
    () =>
      proposeApprovalChange(staff.tenantId as TenantCode, staff.principalId, {
        change,
        reason: field(form, 'reason').slice(0, 1000),
      }),
    'APPROVAL_CHANGE_PROPOSED',
  );
}

/** A different Shariah reviewer confirms or rejects a proposed change. */
export async function decideApprovalChangeAction(form: FormData): Promise<void> {
  const locale = localeSegmentOf(field(form, 'locale') || 'en');
  const staff = await authorise(locale, 'SHARIAH_APPROVAL_CONFIRM', PATH(locale));
  const confirm = field(form, 'decision') === 'CONFIRM';
  return finish(
    locale,
    () =>
      decideApprovalChange(staff.tenantId as TenantCode, staff.principalId, {
        changeId: field(form, 'changeId').slice(0, 64),
        confirm,
        note: field(form, 'note').slice(0, 1000),
      }),
    confirm ? 'APPROVAL_CHANGE_CONFIRMED' : 'APPROVAL_CHANGE_REJECTED',
  );
}

// -- Incidents (W6b-1) ------------------------------------------------------------------

const INCIDENTS = (locale: string) => `/${locale}/shariah/incidents`;

async function incidentFinish(
  locale: string,
  change: () => Promise<Result<unknown>>,
  notice: (value: unknown) => string,
): Promise<never> {
  const result = await change();
  revalidatePath(INCIDENTS(locale));
  const query = result.ok
    ? new URLSearchParams({ notice: notice(result.value) })
    : new URLSearchParams({ control: result.error.control, reason: result.error.reason });
  redirect(`${INCIDENTS(locale)}?${query.toString()}`);
}

const severityOf = (form: FormData): IncidentSeverity => {
  const s = field(form, 'severity');
  return (INCIDENT_SEVERITIES as readonly string[]).includes(s) ? (s as IncidentSeverity) : 'LOW';
};

/** Run the Shariah review of the live book now, as the daily cycle does each morning. */
export async function runShariahReviewAction(form: FormData): Promise<void> {
  const locale = localeSegmentOf(field(form, 'locale') || 'en');
  const staff = await authorise(locale, 'SHARIAH_INCIDENT_ACT', INCIDENTS(locale));
  return incidentFinish(
    locale,
    () => runShariahReview(staff.tenantId as TenantCode, staff.principalId),
    () => 'SHARIAH_REVIEW_RUN',
  );
}

/** A Shariah reviewer raises what they observed on a transaction. */
export async function raiseObservationAction(form: FormData): Promise<void> {
  const locale = localeSegmentOf(field(form, 'locale') || 'en');
  const staff = await authorise(locale, 'SHARIAH_INCIDENT_ACT', INCIDENTS(locale));
  const tenant = staff.tenantId as TenantCode;
  const subjectRef = field(form, 'transactionRef').slice(0, 40);
  return incidentFinish(
    locale,
    async () =>
      (await getTransaction(tenant, subjectRef)) === undefined
        ? reject('OP-DETERMINACY', 'TRANSACTION_NOT_FOUND', 'No such transaction')
        : raiseObservation(tenant, staff.principalId, {
            subjectRef,
            productCode: WASL_PRODUCT,
            severity: severityOf(form),
            observation: field(form, 'observation').slice(0, 2000),
          }),
    (raised) => (raised === undefined ? 'INCIDENT_ALREADY_RAISED' : 'INCIDENT_RAISED'),
  );
}

/** The incident's next step: triage, plan, remediate or close. */
export async function actOnIncidentAction(form: FormData): Promise<void> {
  const locale = localeSegmentOf(field(form, 'locale') || 'en');
  const staff = await authorise(locale, 'SHARIAH_INCIDENT_ACT', INCIDENTS(locale));
  const kind = field(form, 'kind');
  const text = (name: string) => field(form, name).slice(0, 2000);
  const action: IncidentAction | undefined =
    kind === 'TRIAGE'
      ? { kind, severity: severityOf(form), owner: text('owner') || staff.principalId, note: text('note') }
      : kind === 'PLAN'
        ? { kind, plan: text('plan') }
        : kind === 'REMEDIATE'
          ? { kind, note: text('note'), purificationRequired: form.get('purificationRequired') === 'on' }
          : kind === 'CLOSE'
            ? { kind, closureEvidence: text('closureEvidence') }
            : undefined;
  if (action === undefined) redirect(INCIDENTS(locale));
  return incidentFinish(
    locale,
    () =>
      actOnIncident(staff.tenantId as TenantCode, staff.principalId, field(form, 'incidentRef').slice(0, 20), action),
    () => 'INCIDENT_STEP_RECORDED',
  );
}
