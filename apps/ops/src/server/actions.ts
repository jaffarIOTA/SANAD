'use server';

/**
 * Server actions for the workbench.
 *
 * Thin. Every one of these parses the form, hands it to the domain, and turns
 * a rejection into something a person can read. None of them contains a rule.
 *
 * Two things worth noting about the principals below. They are hard-coded to
 * development identities because there is no authentication yet — and they are
 * hard-coded *on the server*, never taken from the form, because "who is
 * approving this" must not be something the browser can assert (BE-09). When
 * enterprise SSO arrives, these become the authenticated principal and nothing
 * else changes.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { Principal, ServicingOutcome } from '@sanad/core/origination/request.ts';
import type { OriginationChannel } from '@sanad/core/origination/channel.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

import {
  applyServicingOutcome,
  approveRequest,
  declineRequest,
  keyRequest,
  returnRequest,
  submit,
} from './store.ts';

/** Development identities. Replaced by the authenticated principal. */
const MAKER: Principal = { principalId: 'stf-maker-01', tenantId: 'bank-a' };
const CHECKER: Principal = { principalId: 'stf-checker-01', tenantId: 'bank-a' };

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

export async function keyAndSubmitAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'en';

  // Minor units, parsed from a decimal string without touching a float. The
  // string is split on the point rather than multiplied by 100 (BE-06).
  const [major = '0', minor = ''] = field(form, 'amount').split('.');
  const digits = `${major.replace(/[^\d]/g, '') || '0'}${minor.padEnd(2, '0').slice(0, 2)}`;

  let amountMinorUnits: bigint;
  try {
    amountMinorUnits = BigInt(digits);
  } catch {
    failTo(`/${locale}/originate`, 'OP-DETERMINACY', 'The amount could not be read as a whole number of minor units.');
  }

  const channel = field(form, 'channel') as OriginationChannel;

  const keyed = keyRequest({
    tenantId: MAKER.tenantId,
    programmeId: field(form, 'programmeId'),
    counterpartyId: field(form, 'counterparty'),
    channel,
    invoiceUuid: field(form, 'invoiceUuid'),
    invoiceNumber: field(form, 'invoiceNumber'),
    issuerCr: field(form, 'issuerCr'),
    recipientCr: field(form, 'recipientCr'),
    amountMinorUnits,
    tenorDays: Number(field(form, 'tenorDays') || '0'),
    maker: MAKER,
    merchantMandateRef: field(form, 'merchantMandateRef'),
    aggregatorId: field(form, 'aggregatorId'),
  });

  if (!keyed.ok) {
    failTo(`/${locale}/originate`, keyed.error.control, keyed.error.detail);
  }

  const submitted = submit(keyed.value.requestId);
  if (!submitted.ok) {
    failTo(`/${locale}/originate`, submitted.error.control, submitted.error.detail);
  }

  refresh(locale, keyed.value.requestId);
  redirect(`/${locale}/requests/${keyed.value.requestId}`);
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
