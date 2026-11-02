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
import type { Result } from '@sanad/core/kernel/result.ts';
import type { ApprovalChange } from '@sanad/core/shariah/approvals.ts';
import { decideApprovalChange, proposeApprovalChange } from '@sanad/origination/shariah/approvals.ts';

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
