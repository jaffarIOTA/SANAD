'use server';

/**
 * The consumer journey's actions. Each is a plain form post and a redirect,
 * so the journey works without JavaScript on the mid-range phone that is the
 * applicant's device. Every refusal travels back as a control code and is
 * rendered as a respectful explanation, never a generic decline.
 */

import { redirect } from 'next/navigation';

import { resolveProductCatalogue } from '@sanad/origination/catalogue.ts';
import { newBusinessRefusal } from '@sanad/origination/licensing.ts';

import { flushConsumerStore } from './durable.ts';
import { consumerIdentity } from './identity.ts';
import { TENANT, maturityDates, quoteFor } from './engine.ts';
import { clearSession, currentSession, startSession } from './session.ts';
import { accept, developmentAttestation, findOffer, nextId, saveOffer } from './store.ts';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const fail = (to: string, reason: string, control: string): never =>
  redirect(`${to}?refused=${encodeURIComponent(reason)}&control=${encodeURIComponent(control)}`);

export async function signInAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  // No identity provider here: refused before the form's reference is read (SR-005).
  const identity = await consumerIdentity(() => developmentAttestation().epochSeconds);
  if (identity === undefined) return fail(`/${locale}`, 'IDENTITY_PROVIDER_NOT_CONFIGURED', 'OP-DETERMINACY');
  const applicantRef = field(form, 'applicantRef');
  if (!/^[a-z0-9-]{3,40}$/.test(applicantRef)) fail(`/${locale}`, 'APPLICANT_REF_MALFORMED', 'OP-DETERMINACY');
  const started = await identity.startAuthentication({
    tenantId: TENANT,
    applicantRef,
    purpose: 'LOGIN',
    correlationId: nextId('cor'),
  });
  if (!started.ok || started.value.kind !== 'ANSWERED') fail(`/${locale}`, 'IDENTITY_UNAVAILABLE', 'OP-DETERMINACY');
  const confirmed =
    started.ok && started.value.kind === 'ANSWERED'
      ? await identity.confirmAuthentication({
          tenantId: TENANT,
          transactionRef: started.value.value.transactionRef,
          correlationId: nextId('cor'),
        })
      : undefined;
  if (confirmed === undefined || !confirmed.ok || confirmed.value.kind !== 'ANSWERED')
    return fail(`/${locale}`, 'IDENTITY_UNAVAILABLE', 'OP-DETERMINACY');
  await startSession({
    applicantRef,
    identityAssertionId: confirmed.value.value.assertionId,
    identityRef: confirmed.value.value.identityRef,
    authenticatedAtEpochSeconds: confirmed.value.value.authenticatedAtEpochSeconds,
  });
  const next = field(form, 'next');
  redirect(next.startsWith(`/${locale}/`) ? next : `/${locale}/apply`);
}

export async function signOutAction(form: FormData): Promise<void> {
  await clearSession();
  redirect(`/${field(form, 'locale') || 'ar'}`);
}

export async function quoteAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const session = await currentSession();
  if (session === undefined) redirect(`/${locale}`);
  const productCode = field(form, 'productCode');
  const amountMajor = Number.parseInt(field(form, 'amount').replace(/[^\d]/g, ''), 10);
  const months = Number.parseInt(field(form, 'months'), 10);
  if (!Number.isFinite(amountMajor) || amountMajor <= 0)
    fail(`/${locale}/apply`, 'AMOUNT_NOT_POSITIVE', 'OP-DETERMINACY');
  if (!Number.isFinite(months) || months <= 0) fail(`/${locale}/apply`, 'MONTHS_NOT_POSITIVE', 'OP-DETERMINACY');
  // A quote and a new offer are new business: the installation's licence must permit the product (ADR 0006).
  const licence = await newBusinessRefusal({ productCode });
  if (licence !== undefined) return fail(`/${locale}/apply`, licence.reason, licence.control);
  const at = developmentAttestation();
  const quoted = quoteFor(
    productCode,
    BigInt(amountMajor) * 100n,
    months,
    session.applicantRef,
    at,
    (await resolveProductCatalogue(TENANT, at.epochSeconds)).catalogue,
  );
  if (!quoted.ok) return fail(`/${locale}/apply`, quoted.error.reason, quoted.error.control);
  const dates = maturityDates(at, quoted.value.offer.quote.tenorDays);
  const offerId = nextId('ofr');
  saveOffer({
    offerId,
    tenantId: TENANT,
    applicantRef: session.applicantRef,
    productCode,
    offer: quoted.value.offer,
    maturityDateGregorian: dates.gregorian,
    maturityDateHijri: dates.hijri,
    expiresAtEpochSeconds: at.epochSeconds + 7n * 86_400n,
  });
  // The offer is durable before the customer is shown it.
  await flushConsumerStore();
  redirect(`/${locale}/offer/${offerId}`);
}

export async function acceptAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const offerId = field(form, 'offerId');
  const session = await currentSession();
  if (session === undefined) redirect(`/${locale}`);
  const offer = findOffer(offerId);
  if (offer === undefined || offer.applicantRef !== session.applicantRef)
    fail(`/${locale}/apply`, 'OFFER_NOT_FOUND', 'OP-DETERMINACY');
  if (field(form, 'confirm') !== 'yes') fail(`/${locale}/offer/${offerId}`, 'CONFIRMATION_REQUIRED', 'OP-DETERMINACY');
  const result = accept({
    offerId,
    identityAssertionId: session.identityAssertionId,
    localeShown: locale === 'ar' ? 'ar-SA' : 'en-SA',
    disclosureVersionShown: field(form, 'disclosureVersion'),
    at: developmentAttestation(),
  });
  if (!result.ok) return fail(`/${locale}/offer/${offerId}`, result.error.reason, result.error.control);
  // The acceptance is durable before the customer is told it was recorded. If the database refuses it
  // (the offer was accepted elsewhere a moment ago), this throws and no confirmation is shown.
  await flushConsumerStore();
  redirect(`/${locale}/offer/${offerId}/accepted`);
}
