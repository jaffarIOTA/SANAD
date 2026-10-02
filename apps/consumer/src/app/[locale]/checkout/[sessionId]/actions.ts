'use server';

import { redirect } from 'next/navigation';

import { accept as acceptSession, book as bookSession } from '@sanad/core/checkout/session.ts';
import { book as bookBnpl } from '@sanad/products/bnpl/execution.ts';
import { bnpl } from '@sanad/products/bnpl/index.ts';
import type { BnplQuote } from '@sanad/products/bnpl/pricing.ts';
import { loadProductCatalogue } from '@sanad/config/loader.ts';
import { entryFor } from '@sanad/core/products/catalogue.ts';

import { findSession, outboxStore, saveSession } from '../../../../server/checkout-store.ts';
import { TENANT } from '../../../../server/engine.ts';
import { currentSession } from '../../../../server/session.ts';
import { accept, developmentAttestation, findOffer, nextId } from '../../../../server/store.ts';

const field = (form: FormData, name: string): string => { const v = form.get(name); return typeof v === 'string' ? v.trim() : ''; };

/** Accept the disclosure shown, record it, book the BNPL facility, and send the shopper back to the shop. */
export async function checkoutAcceptAction(form: FormData): Promise<void> {
  const locale = field(form, 'locale') || 'ar';
  const sessionId = field(form, 'sessionId');
  const back = `/${locale}/checkout/${sessionId}`;
  const fail = (reason: string, control: string): never => redirect(`${back}?refused=${encodeURIComponent(reason)}&control=${encodeURIComponent(control)}`);
  const identity = await currentSession();
  if (identity === undefined) redirect(`/${locale}?next=${encodeURIComponent(back)}`);
  const session = findSession(sessionId);
  if (session === undefined || session.state !== 'OFFERED' || session.applicantRef !== identity.applicantRef) fail('OFFER_NOT_FOUND', 'OP-DETERMINACY');
  if (session === undefined || session.state !== 'OFFERED') return;
  if (field(form, 'confirm') !== 'yes') fail('CONFIRMATION_REQUIRED', 'OP-DETERMINACY');
  const at = developmentAttestation();
  const recorded = accept({ offerId: session.offerId, identityAssertionId: identity.identityAssertionId, localeShown: locale === 'ar' ? 'ar-SA' : 'en-SA', disclosureVersionShown: field(form, 'disclosureVersion'), at });
  if (!recorded.ok) return fail(recorded.error.reason, recorded.error.control);
  const accepted = acceptSession(session, recorded.value.acceptanceId, field(form, 'disclosureVersion'), at);
  if (!accepted.ok) return fail(accepted.error.reason, accepted.error.control);
  saveSession(accepted.value);

  // Book the facility: the module's execute (bureau enquiry, consent and the eligibility facts are development
  // stand-ins here; in production they come from the bureau, the consent store and the identity rail) and book.
  const stored = findOffer(session.offerId);
  const catalogue = loadProductCatalogue(TENANT);
  const entry = catalogue.ok ? entryFor(catalogue.value, 'bnpl', 'prg-0001', at.epochSeconds) : undefined;
  const terms = entry !== undefined && entry.ok ? bnpl.validateTerms(entry.value.terms) : undefined;
  if (stored === undefined || terms === undefined || !terms.ok) return fail('PRODUCT_NOT_ENABLED', 'OP-DETERMINACY');
  const draft = bnpl.execute(terms.value, { state: 'APPROVED', core: { tenantId: TENANT } } as never, stored.offer.quote as BnplQuote, { transactionId: nextId('txn'), applicantRef: identity.applicantRef, merchantRef: session.core.merchantId, bureauEnquiryRef: `dev-bureau-${identity.applicantRef}`, consentId: `dev-consent-${identity.applicantRef}`, eligibility: { ageHijriYears: 30, residentInKingdom: true, identityVerificationRef: identity.identityRef }, openedAt: at, correlationId: session.core.correlationId });
  if (!draft.ok) return fail(draft.error.reason, draft.error.control);
  const booked = bookBnpl(draft.value, developmentAttestation());
  if (!booked.ok) return fail(booked.error.reason, booked.error.control);
  // The booking's effects — merchant settlement, bureau report — go to the same durable outbox the session events use.
  await outboxStore().append(booked.value.outbox.events);
  saveSession(bookSession(accepted.value, draft.value.core.transactionId, booked.value.bookedAt));
  redirect(`${session.core.returnUrl}${session.core.returnUrl.includes('?') ? '&' : '?'}sessionId=${sessionId}&state=BOOKED`);
}
