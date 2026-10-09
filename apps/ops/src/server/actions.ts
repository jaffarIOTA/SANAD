'use server';

/**
 * Server actions for the workbench.
 *
 * Thin. Every one of these parses the form, hands it to the domain, and turns
 * a rejection into something a person can read. None of them contains a rule.
 *
 * The principal is the signed-in member of staff, read from the sealed session
 * on the server by `authorise()` — never taken from the form, because "who is
 * approving this" must not be something the browser can assert (BE-09). With
 * no session an action sends the browser to sign in; without the authority
 * the act needs (authority.ts) it is refused with a typed reason. The tenant a
 * request is keyed under is the principal's own.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ServicingOutcome } from '@sanad/core/origination/request.ts';
import type { OriginationChannel } from '@sanad/core/origination/channel.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

import { licenceRefusalText } from '@sanad/core/licensing/explain.ts';
import { newBusinessPermitted } from '@sanad/origination/licensing.ts';

import { authorise, localeSegmentOf } from './session.ts';
import { requestPrincipal } from './staff.ts';
import { findClearedInvoice, unavailableReason } from './invoices.ts';
import { tsaInstant as attest } from '@sanad/core/time/tsa.ts';
import {
  applyServicingOutcome,
  attachDocument,
  discardDraft,
  expireOverdue,
  failServicing,
  provideInformation,
  requestInformation,
  retryServicing,
  reviseAndResubmit,
  financedInvoices,
  findDraft,
  flushStore,
  startDraft,
  updateDraft,
  approveRequest,
  declineRequest,
  keyRequest,
  returnRequest,
  submit,
} from './store.ts';

const field = (form: FormData, name: string): string => String(form.get(name) ?? '').trim();
/** The locale segment, from a fixed list: a form never supplies a path. */
const localeOf = (form: FormData): string => localeSegmentOf(field(form, 'locale') || 'en');
const requestPath = (locale: string, requestId: string): string =>
  `/${locale}/requests/${encodeURIComponent(requestId)}`;

/**
 * Every action that changed the book ends here before it redirects: the
 * change is written to the database first, so the page the browser is sent to
 * never reports something that is not durable. A failed write throws, and the
 * action fails rather than redirecting to a success.
 */
async function settle(locale: string, requestId?: string): Promise<void> {
  await flushStore();
  revalidatePath(`/${locale}`);
  revalidatePath(`/${locale}/originate`);
  if (requestId !== undefined) revalidatePath(`/${locale}/requests/${requestId}`);
}

/** Carry a domain refusal back to the page, control code intact. */
function failTo(path: string, control: string, message: string): never {
  const query = new URLSearchParams({ control, message });
  redirect(`${path}?${query.toString()}`);
}

/**
 * Stand in for the servicing platform answering.
 *
 * Production receives this from the core banking adapter. Here it is a button,
 * so the two-stage flow can be walked.
 */
export async function servicingRespondAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const requestId = field(form, 'requestId');
  await authorise(locale, 'SERVICING_STAND_IN', requestPath(locale, requestId));
  const decision = field(form, 'decision') as ServicingOutcome['decision'];
  const reasonCode = field(form, 'reasonCode');

  const outcome: ServicingOutcome = {
    decision,
    reference: `svc_${requestId}`,
    ...(reasonCode === '' ? {} : { reasonCode }),
    respondedAt: tsaInstant({
      verified: true,
      genTimeEpochSeconds: BigInt(Math.floor(Date.now() / 1000)),
      tokenDigest: 'development-substitute',
      authorityId: 'development',
    }),
  };

  const result = applyServicingOutcome(requestId, outcome);
  if (!result.ok) {
    failTo(`/${locale}/requests/${requestId}`, result.error.control, result.error.detail);
  }

  await settle(locale, requestId);
  redirect(`/${locale}/requests/${requestId}`);
}

export async function approveAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const requestId = field(form, 'requestId');
  const justification = field(form, 'justification');

  const staff = await authorise(locale, 'REVIEW', requestPath(locale, requestId));
  const result = approveRequest(requestId, requestPrincipal(staff), justification === '' ? undefined : justification);
  if (!result.ok) {
    failTo(`/${locale}/requests/${requestId}`, result.error.control, result.error.detail);
  }

  await settle(locale, requestId);
  redirect(`/${locale}/requests/${requestId}`);
}

export async function returnAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const requestId = field(form, 'requestId');

  const staff = await authorise(locale, 'REVIEW', requestPath(locale, requestId));
  const result = returnRequest(requestId, requestPrincipal(staff), field(form, 'note'));
  if (!result.ok) {
    failTo(`/${locale}/requests/${requestId}`, result.error.control, result.error.detail);
  }

  await settle(locale, requestId);
  redirect(`/${locale}/requests/${requestId}`);
}

export async function rejectAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const requestId = field(form, 'requestId');

  const staff = await authorise(locale, 'REVIEW', requestPath(locale, requestId));
  const result = declineRequest(requestId, requestPrincipal(staff), field(form, 'reasonCode'));
  if (!result.ok) {
    failTo(`/${locale}/requests/${requestId}`, result.error.control, result.error.detail);
  }

  await settle(locale, requestId);
  redirect(`/${locale}/requests/${requestId}`);
}

// -- The origination journey, step by step ------------------------------------
//
// Four steps, each its own URL, each a server action and a redirect. No
// client-side state machine: the journey works with JavaScript disabled, a
// step is a bookmark, and the back button does what it looks like it does.
//
// The order is the Shariah structure, not a form layout. The trade is chosen
// first because a Murabaha finances identified goods; the amount is read from
// the invoice and never keyed (§6).

/**
 * Starting an application is new business: the installation's licence must
 * permit it (ADR 0006). The workbench keys the trade-first Murabaha SCF
 * journey. A refusal goes back as OP-LICENCE with the explanation in the
 * screen's language — never a generic decline.
 */
async function requireLicence(locale: string, path: string): Promise<void> {
  const r = await newBusinessPermitted({ productCode: 'murabaha-scf' });
  if (r.ok) return;
  const words = licenceRefusalText(r.error.reason);
  failTo(path, 'OP-LICENCE', locale === 'ar' ? words.ar : words.en);
}

export async function beginOriginationAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const channel = (field(form, 'channel') || 'MAKER_CHECKER') as OriginationChannel;
  await authorise(locale, 'ORIGINATE', `/${locale}/originate`);
  await requireLicence(locale, `/${locale}/originate`);

  const draft = startDraft(channel);
  redirect(`/${locale}/originate/${draft.draftId}/trade`);
}

/** Step 1 — choose the trade. Everything else follows from it. */
export async function chooseTradeAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const draftId = field(form, 'draftId');
  const invoiceUuid = field(form, 'invoiceUuid');
  await authorise(locale, 'ORIGINATE', `/${locale}/originate/${encodeURIComponent(draftId)}/trade`);

  const invoice = findClearedInvoice(invoiceUuid);
  if (invoice === undefined) {
    failTo(`/${locale}/originate/${draftId}/trade`, 'OP-DETERMINACY', 'That invoice is not in the cleared set.');
  }

  // Refused here as well as in the domain. The domain is the control; this is
  // so an operator is told now rather than after keying a tenor.
  const unavailable = unavailableReason(invoice, financedInvoices());
  if (unavailable !== undefined) {
    failTo(
      `/${locale}/originate/${draftId}/trade`,
      unavailable.control,
      unavailable.control === 'SH-10'
        ? 'This invoice has already been financed and cannot be financed again.'
        : 'The buyer and the seller are the same registered entity.',
    );
  }

  if (updateDraft(draftId, { invoiceUuid }) === undefined) {
    redirect(`/${locale}/originate`);
  }
  redirect(`/${locale}/originate/${draftId}/terms`);
}

/** Step 2 — the programme and the tenor. */
export async function chooseTermsAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const draftId = field(form, 'draftId');
  await authorise(locale, 'ORIGINATE', `/${locale}/originate/${encodeURIComponent(draftId)}/terms`);

  const tenorDays = Number.parseInt(field(form, 'tenorDays'), 10);
  if (!Number.isFinite(tenorDays) || tenorDays <= 0) {
    failTo(`/${locale}/originate/${draftId}/terms`, 'SH-03', 'A request must name a determinate tenor in days.');
  }

  updateDraft(draftId, {
    programmeId: field(form, 'programmeId'),
    tenorDays,
    ...(field(form, 'agentId') === '' ? {} : { agentId: field(form, 'agentId') }),
    ...(field(form, 'branchCode') === '' ? {} : { branchCode: field(form, 'branchCode') }),
    ...(field(form, 'merchantMandateRef') === '' ? {} : { merchantMandateRef: field(form, 'merchantMandateRef') }),
    ...(field(form, 'aggregatorId') === '' ? {} : { aggregatorId: field(form, 'aggregatorId') }),
  });

  redirect(`/${locale}/originate/${draftId}/review`);
}

/** Step 3 — review, then submit. This is where the domain gets to refuse. */
export async function submitDraftAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const draftId = field(form, 'draftId');
  // The maker is whoever is signed in, and the request is keyed under their tenant.
  const staff = await authorise(locale, 'ORIGINATE', `/${locale}/originate/${encodeURIComponent(draftId)}/review`);
  const maker = requestPrincipal(staff);
  // A draft started before the licence lapsed still does not become an application after it.
  await requireLicence(locale, `/${locale}/originate/${draftId}/review`);

  const draft = findDraft(draftId);
  if (draft?.invoiceUuid === undefined || draft.tenorDays === undefined) {
    redirect(`/${locale}/originate`);
  }

  const invoice = findClearedInvoice(draft.invoiceUuid);
  if (invoice === undefined) {
    failTo(`/${locale}/originate/${draftId}/review`, 'OP-DETERMINACY', 'The trade is no longer available.');
  }

  const keyed = keyRequest({
    tenantId: maker.tenantId,
    programmeId: draft.programmeId ?? 'prg-0001',
    // The counterparty is the invoice's recipient — the party who owes, and
    // who will owe us. Not a separate field somebody could disagree with.
    counterpartyId: invoice.recipientName,
    channel: draft.channel,
    invoiceUuid: invoice.invoiceUuid,
    invoiceNumber: invoice.invoiceNumber,
    issuerCr: invoice.issuerCr,
    recipientCr: invoice.recipientCr,
    // Read from the cleared invoice. There is no path by which an operator
    // types this.
    amountMinorUnits: invoice.amount.minorUnits,
    tenorDays: draft.tenorDays,
    maker,
    ...(draft.merchantMandateRef === undefined ? {} : { merchantMandateRef: draft.merchantMandateRef }),
    ...(draft.aggregatorId === undefined ? {} : { aggregatorId: draft.aggregatorId }),
    ...(draft.agentId === undefined ? {} : { agentId: draft.agentId }),
    ...(draft.branchCode === undefined ? {} : { branchCode: draft.branchCode }),
  });

  if (!keyed.ok) {
    failTo(`/${locale}/originate/${draftId}/review`, keyed.error.control, keyed.error.detail);
  }

  const submitted = submit(keyed.value.requestId);
  if (!submitted.ok) {
    failTo(`/${locale}/originate/${draftId}/review`, submitted.error.control, submitted.error.detail);
  }

  discardDraft(draftId);
  await settle(locale, keyed.value.requestId);
  redirect(`/${locale}/requests/${keyed.value.requestId}`);
}

/**
 * Expire requests that have waited past the tenant's interval.
 *
 * A supervisor's action. The instant is attested — the development substitute
 * here, the timestamping authority in a deployed environment — and the domain
 * refuses anything that has not actually elapsed, so pressing this early
 * expires nothing.
 */
export async function expireOverdueAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  await authorise(locale, 'REVIEW', `/${locale}/queue`);
  const expired = expireOverdue(
    attest({
      verified: true,
      genTimeEpochSeconds: BigInt(Math.floor(Date.now() / 1000)),
      tokenDigest: 'development-substitute',
      authorityId: 'development',
    }),
  );
  await settle(locale);
  redirect(`/${locale}/queue?show=${expired.length > 0 ? 'decided' : 'breached'}&expired=${String(expired.length)}`);
}

// -- Lifecycle actions (BRD §11, §16, §21, MC-008/009, §15) --------------------

const back = (locale: string, requestId: string): string => `/${locale}/requests/${requestId}`;

export async function requestInformationAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const requestId = field(form, 'requestId');
  const items = field(form, 'items')
    .split('\n')
    .map((i) => i.trim())
    .filter((i) => i.length > 0);
  const staff = await authorise(locale, 'REVIEW', requestPath(locale, requestId));
  const result = requestInformation(
    requestId,
    requestPrincipal(staff),
    field(form, 'from') as 'COUNTERPARTY' | 'PARTNER' | 'DOCUMENTS',
    items,
  );
  if (!result.ok) failTo(back(locale, requestId), result.error.control, result.error.detail);
  await settle(locale, requestId);
  redirect(back(locale, requestId));
}

export async function provideInformationAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const requestId = field(form, 'requestId');
  await authorise(locale, 'ORIGINATE', requestPath(locale, requestId));
  const result = provideInformation(requestId);
  if (!result.ok) failTo(back(locale, requestId), result.error.control, result.error.detail);
  await settle(locale, requestId);
  redirect(back(locale, requestId));
}

/** Development stand-in for the adapter reporting the platform unreachable. */
export async function failServicingAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const requestId = field(form, 'requestId');
  await authorise(locale, 'SERVICING_STAND_IN', requestPath(locale, requestId));
  const result = failServicing(requestId, field(form, 'reason') || 'simulated: platform unreachable');
  if (!result.ok) failTo(back(locale, requestId), result.error.control, result.error.detail);
  await settle(locale, requestId);
  redirect(back(locale, requestId));
}

export async function retryServicingAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const requestId = field(form, 'requestId');
  const note = field(form, 'note');
  const staff = await authorise(locale, 'REVIEW', requestPath(locale, requestId));
  const result = retryServicing(
    requestId,
    field(form, 'mode') === 'manual' ? { by: requestPrincipal(staff), note } : undefined,
  );
  if (!result.ok) failTo(back(locale, requestId), result.error.control, result.error.detail);
  await settle(locale, requestId);
  redirect(back(locale, requestId));
}

export async function reviseAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const requestId = field(form, 'requestId');
  const tenor = Number.parseInt(field(form, 'tenorDays'), 10);
  await authorise(locale, 'ORIGINATE', requestPath(locale, requestId));
  const result = reviseAndResubmit(requestId, {
    ...(field(form, 'programmeId') === '' ? {} : { programmeId: field(form, 'programmeId') }),
    ...(Number.isFinite(tenor) && tenor > 0 ? { tenorDays: tenor } : {}),
  });
  if (!result.ok) failTo(back(locale, requestId), result.error.control, result.error.detail);
  await settle(locale, requestId);
  redirect(back(locale, requestId));
}

export async function attachDocumentAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const requestId = field(form, 'requestId');
  const staff = await authorise(locale, 'ORIGINATE', requestPath(locale, requestId));
  attachDocument(requestId, field(form, 'documentType'), staff.principalId);
  await settle(locale, requestId);
  redirect(back(locale, requestId));
}
