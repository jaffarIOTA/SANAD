'use server';

/**
 * Server actions for the workbench.
 *
 * Thin. Every one of these parses the form, hands it to the domain, and turns
 * a rejection into something a person can read. None of them contains a rule.
 *
 * The principals come from `session.ts` and are resolved on the server, never
 * taken from the form, because "who is approving this" must not be something
 * the browser can assert (BE-09).
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ServicingOutcome } from '@sanad/core/origination/request.ts';
import type { OriginationChannel } from '@sanad/core/origination/channel.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

import { CHECKER, MAKER } from './session.ts';
import { findClearedInvoice, unavailableReason } from './invoices.ts';
import {
  applyServicingOutcome,
  discardDraft,
  financedInvoices,
  findDraft,
  startDraft,
  updateDraft,
  approveRequest,
  declineRequest,
  keyRequest,
  returnRequest,
  submit,
} from './store.ts';

const field = (form: FormData, name: string): string => String(form.get(name) ?? '').trim();

function refresh(locale: string, requestId?: string): void {
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
  const locale = field(form, 'locale') || 'en';
  const requestId = field(form, 'requestId');
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

  refresh(locale, requestId);
  redirect(`/${locale}/requests/${requestId}`);
}

export async function approveAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'en';
  const requestId = field(form, 'requestId');
  const justification = field(form, 'justification');

  const result = approveRequest(
    requestId,
    CHECKER,
    justification === '' ? undefined : justification,
  );
  if (!result.ok) {
    failTo(`/${locale}/requests/${requestId}`, result.error.control, result.error.detail);
  }

  refresh(locale, requestId);
  redirect(`/${locale}/requests/${requestId}`);
}

export async function returnAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'en';
  const requestId = field(form, 'requestId');

  const result = returnRequest(requestId, CHECKER, field(form, 'note'));
  if (!result.ok) {
    failTo(`/${locale}/requests/${requestId}`, result.error.control, result.error.detail);
  }

  refresh(locale, requestId);
  redirect(`/${locale}/requests/${requestId}`);
}

export async function rejectAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'en';
  const requestId = field(form, 'requestId');

  const result = declineRequest(requestId, CHECKER, field(form, 'reasonCode'));
  if (!result.ok) {
    failTo(`/${locale}/requests/${requestId}`, result.error.control, result.error.detail);
  }

  refresh(locale, requestId);
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

export async function beginOriginationAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'en';
  const channel = (field(form, 'channel') || 'MAKER_CHECKER') as OriginationChannel;

  const draft = startDraft(channel);
  redirect(`/${locale}/originate/${draft.draftId}/trade`);
}

/** Step 1 — choose the trade. Everything else follows from it. */
export async function chooseTradeAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'en';
  const draftId = field(form, 'draftId');
  const invoiceUuid = field(form, 'invoiceUuid');

  const invoice = findClearedInvoice(invoiceUuid);
  if (invoice === undefined) {
    failTo(
      `/${locale}/originate/${draftId}/trade`,
      'OP-DETERMINACY',
      'That invoice is not in the cleared set.',
    );
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
  const locale = field(form, 'locale') || 'en';
  const draftId = field(form, 'draftId');

  const tenorDays = Number.parseInt(field(form, 'tenorDays'), 10);
  if (!Number.isFinite(tenorDays) || tenorDays <= 0) {
    failTo(
      `/${locale}/originate/${draftId}/terms`,
      'SH-03',
      'A request must name a determinate tenor in days.',
    );
  }

  updateDraft(draftId, {
    programmeId: field(form, 'programmeId'),
    tenorDays,
    ...(field(form, 'merchantMandateRef') === ''
      ? {}
      : { merchantMandateRef: field(form, 'merchantMandateRef') }),
    ...(field(form, 'aggregatorId') === '' ? {} : { aggregatorId: field(form, 'aggregatorId') }),
  });

  redirect(`/${locale}/originate/${draftId}/review`);
}

/** Step 3 — review, then submit. This is where the domain gets to refuse. */
export async function submitDraftAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'en';
  const draftId = field(form, 'draftId');

  const draft = findDraft(draftId);
  if (draft?.invoiceUuid === undefined || draft.tenorDays === undefined) {
    redirect(`/${locale}/originate`);
  }

  const invoice = findClearedInvoice(draft.invoiceUuid);
  if (invoice === undefined) {
    failTo(`/${locale}/originate/${draftId}/review`, 'OP-DETERMINACY', 'The trade is no longer available.');
  }

  const keyed = keyRequest({
    tenantId: MAKER.tenantId,
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
    maker: MAKER,
    ...(draft.merchantMandateRef === undefined
      ? {}
      : { merchantMandateRef: draft.merchantMandateRef }),
    ...(draft.aggregatorId === undefined ? {} : { aggregatorId: draft.aggregatorId }),
  });

  if (!keyed.ok) {
    failTo(`/${locale}/originate/${draftId}/review`, keyed.error.control, keyed.error.detail);
  }

  const submitted = submit(keyed.value.requestId);
  if (!submitted.ok) {
    failTo(`/${locale}/originate/${draftId}/review`, submitted.error.control, submitted.error.detail);
  }

  discardDraft(draftId);
  refresh(locale, keyed.value.requestId);
  redirect(`/${locale}/requests/${keyed.value.requestId}`);
}
