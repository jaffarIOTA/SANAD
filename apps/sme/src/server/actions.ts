'use server';

/**
 * Server actions for the SME portal (Wasl W3).
 *
 * Thin: parse the form, call the portal service, redirect back with a notice
 * code — or, on a refusal, the control and reason codes only; the screens word
 * them from their own map. Who acts is the sealed session's signatory and the
 * distributor configuration says they sign for, never the form. A form never
 * names a tenant, a distributor or a path.
 */
import { redirect } from 'next/navigation';

import { localeFromSegment } from '@sanad/i18n/strings.ts';
import type { Result } from '@sanad/core/kernel/result.ts';

import { confirmAcceptance, confirmSignIn, startAcceptance, startSignIn } from './portal.ts';
import { currentSession, endSession } from './session.ts';

const field = (form: FormData, name: string): string => String(form.get(name) ?? '').trim();
/** The locale segment, from the fixed list: a form never supplies a path. */
const localeOf = (form: FormData): string => {
  const s = field(form, 'locale');
  return localeFromSegment(s) === undefined ? 'ar' : s;
};
const refOf = (form: FormData): string => {
  const r = field(form, 'transactionRef');
  return /^WT-\d{6,10}$/.test(r) ? r : '';
};

function back(path: string, r: Result<unknown>, notice: string): never {
  const q = r.ok ? { notice } : { control: r.error.control, reason: r.error.reason };
  redirect(`${path}?${new URLSearchParams(q).toString()}`);
}

export async function startSignInAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const r = await startSignIn(field(form, 'signatoryRef').slice(0, 64));
  back(`/${locale}/sign-in`, r, 'APPROVE_IN_APP');
}

export async function confirmSignInAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const r = await confirmSignIn();
  if (r.ok) redirect(`/${locale}`);
  back(`/${locale}/sign-in`, r, '');
}

export async function signOutAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  await endSession();
  redirect(`/${locale}/sign-in`);
}

/** Open the signature on an offer. Without a session: to sign in. */
export async function startAcceptanceAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const session = await currentSession();
  if (session === undefined) redirect(`/${locale}/sign-in`);
  const ref = refOf(form);
  const r = await startAcceptance(session, ref);
  back(`/${locale}/finance/${ref}`, r, 'APPROVE_SIGNATURE_IN_APP');
}

/** Confirm the signature and accept; the offer page then shows the obligation, or that booking follows. */
export async function confirmAcceptanceAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const session = await currentSession();
  if (session === undefined) redirect(`/${locale}/sign-in`);
  const ref = refOf(form);
  const r = await confirmAcceptance(session);
  if (r.ok)
    back(`/${locale}/finance/${r.value.transactionRef}`, r, r.value.booked ? 'ACCEPTED_AND_BOOKED' : 'ACCEPTED');
  back(`/${locale}/finance/${ref}`, r, '');
}
