'use server';

import { redirect } from 'next/navigation';

import { accept as acceptSession, book as bookSession } from '@sanad/core/checkout/session.ts';
import { book as bookBnpl } from '@sanad/products/bnpl/execution.ts';
import { bnpl } from '@sanad/products/bnpl/index.ts';
import type { BnplQuote } from '@sanad/products/bnpl/pricing.ts';
import type { BnplTerms } from '@sanad/products/bnpl/terms.ts';
import { resolveProductCatalogue } from '@sanad/origination/catalogue.ts';
import { newBusinessRefusal } from '@sanad/origination/licensing.ts';
import { entryFor } from '@sanad/core/products/catalogue.ts';

import { findSession, outboxStore, saveSession } from '../../../../server/checkout-store.ts';
import { flushConsumerStore, syncConsumerStore } from '../../../../server/durable.ts';
import { recordConsumerLoan } from '@sanad/origination/consumer-loans.ts';

import { demonstrationMandateRef, offeredChannels } from '../../../../server/collection.ts';
import { TENANT, maturityDates } from '../../../../server/engine.ts';
import { persistencePool } from '../../../../server/persistence.ts';
import { currentSession } from '../../../../server/session.ts';
import { accept, developmentAttestation, findOffer, nextId } from '../../../../server/store.ts';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** The plan's interval as the terms set it, and the first due date: the schedule's first offset from acceptance. */
function cadenceOf(
  terms: Pick<BnplTerms, 'intervalDays' | 'intervalMonths'>,
  quote: BnplQuote,
  at: Parameters<typeof maturityDates>[0],
): { intervalDays: number; firstDueDate: string } | { intervalMonths: number; firstDueDate: string } {
  const first = quote.schedule_.instalments[0]?.at ?? {
    months: terms.intervalMonths ?? 0,
    days: terms.intervalDays ?? 0,
  };
  const firstDueDate = maturityDates(at, first).gregorian;
  return terms.intervalMonths !== undefined
    ? { intervalMonths: terms.intervalMonths, firstDueDate }
    : { intervalDays: terms.intervalDays ?? 0, firstDueDate };
}

/** Accept the disclosure shown, record it, book the BNPL facility, and send the shopper back to the shop. */
export async function checkoutAcceptAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const sessionId = field(form, 'sessionId');
  const back = `/${locale}/checkout/${sessionId}`;
  const fail = (reason: string, control: string): never =>
    redirect(`${back}?refused=${encodeURIComponent(reason)}&control=${encodeURIComponent(control)}`);
  const identity = await currentSession();
  if (identity === undefined) redirect(`/${locale}?next=${encodeURIComponent(back)}`);
  await syncConsumerStore();
  const session = findSession(sessionId);
  if (session === undefined || session.state !== 'OFFERED' || session.applicantRef !== identity.applicantRef)
    fail('OFFER_NOT_FOUND', 'OP-DETERMINACY');
  if (session === undefined || session.state !== 'OFFERED') return;
  if (field(form, 'confirm') !== 'yes') fail('CONFIRMATION_REQUIRED', 'OP-DETERMINACY');
  const at = developmentAttestation();
  // How the instalments are paid: one of the channels offered here, never one the jurisdiction does not carry.
  const channel = (await offeredChannels(at.epochSeconds)).find((c) => c.channel === field(form, 'collectionChannel'));
  if (channel === undefined) return fail('COLLECTION_CHANNEL_NOT_OFFERED', 'OP-DETERMINACY');
  // Booking the facility, accepted now: permitted while the licence is valid or in grace, refused after grace
  // ended (ADR 0006 §4) — checked before the acceptance is recorded, so nothing is half done.
  const licence = await newBusinessRefusal({
    productCode: 'bnpl',
    booking: { offerAcceptedAtEpochSeconds: at.epochSeconds },
  });
  if (licence !== undefined) return fail(licence.reason, licence.control);
  const recorded = accept({
    offerId: session.offerId,
    identityAssertionId: identity.identityAssertionId,
    localeShown: locale === 'ar' ? 'ar-SA' : 'en-SA',
    disclosureVersionShown: field(form, 'disclosureVersion'),
    at,
  });
  if (!recorded.ok) return fail(recorded.error.reason, recorded.error.control);
  const accepted = acceptSession(session, recorded.value.acceptanceId, field(form, 'disclosureVersion'), at);
  if (!accepted.ok) return fail(accepted.error.reason, accepted.error.control);
  saveSession(accepted.value);

  // Book the facility: the module's execute (bureau enquiry, consent and the eligibility facts are development
  // stand-ins here; in production they come from the bureau, the consent store and the identity rail) and book.
  const stored = findOffer(session.offerId);
  const catalogue = (await resolveProductCatalogue(TENANT, at.epochSeconds)).catalogue;
  const entry = catalogue.ok ? entryFor(catalogue.value, 'bnpl', 'prg-0001', at.epochSeconds) : undefined;
  const terms = entry !== undefined && entry.ok ? bnpl.validateTerms(entry.value.terms) : undefined;
  if (stored === undefined || terms === undefined || !terms.ok) return fail('PRODUCT_NOT_ENABLED', 'OP-DETERMINACY');
  const draft = bnpl.execute(
    terms.value,
    { state: 'APPROVED', core: { tenantId: TENANT } } as never,
    stored.offer.quote as BnplQuote,
    {
      transactionId: nextId('txn'),
      applicantRef: identity.applicantRef,
      merchantRef: session.core.merchantId,
      bureauEnquiryRef: `dev-bureau-${identity.applicantRef}`,
      consentId: `dev-consent-${identity.applicantRef}`,
      eligibility: { ageHijriYears: 30, residentInKingdom: true, identityVerificationRef: identity.identityRef },
      openedAt: at,
      correlationId: session.core.correlationId,
    },
  );
  if (!draft.ok) return fail(draft.error.reason, draft.error.control);
  const booked = bookBnpl(draft.value, developmentAttestation());
  if (!booked.ok) return fail(booked.error.reason, booked.error.control);
  saveSession(bookSession(accepted.value, draft.value.core.transactionId, booked.value.bookedAt));
  // The acceptance and the booked session are durable first; then the loan as accepted, with the channel
  // its instalments are collected through (booked in the loan system and serviced there, by
  // services/origination/src/consumer-loan-servicing.ts); then the booking's effects — merchant
  // settlement, bureau report — go to the same durable outbox the session events use. Only then is the
  // shopper sent back to the shop as BOOKED.
  await flushConsumerStore();
  const pool = persistencePool();
  if (pool !== undefined) {
    const quote = stored.offer.quote as BnplQuote;
    await recordConsumerLoan(pool, TENANT, {
      loanRef: draft.value.core.transactionId,
      productCode: 'bnpl',
      applicantRef: identity.applicantRef,
      originRef: sessionId,
      merchantRef: session.core.merchantId,
      principalMinorUnits: quote.basket.minorUnits,
      currency: quote.basket.currency,
      rateBp: 0n,
      aprBp: stored.offer.apr.bp,
      numberOfInstalments: terms.value.numberOfInstalments,
      ...cadenceOf(terms.value, quote, at),
      collectionChannel: channel.channel,
      collectionMandateRef: demonstrationMandateRef(channel.channel, identity.applicantRef),
      correlationId: session.core.correlationId,
      createdBy: identity.applicantRef,
    });
  }
  await outboxStore().append(booked.value.outbox.events);
  redirect(
    `${session.core.returnUrl}${session.core.returnUrl.includes('?') ? '&' : '?'}sessionId=${sessionId}&state=BOOKED`,
  );
}
