/**
 * Checkout: the merchant's basket is the amount. The shopper signs in,
 * sees the disclosure for exactly that basket under the tenant's BNPL terms,
 * and accepts — or is refused with the control that refused. Every state
 * change is the domain's, saved through the store, which queues the
 * merchant's webhook event.
 */

import { notFound, redirect } from 'next/navigation';

import { identify, offer as offerSession, refuse as refuseSession, type CheckoutSession } from '@sanad/core/checkout/session.ts';
import { Disclosure } from '@sanad/design/Disclosure.tsx';
import { Card, ControlRejection } from '@sanad/design/primitives.tsx';
import { formatMinorUnits, defaultNumerals } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { resolveProductCatalogue } from '@sanad/origination/catalogue.ts';

import { quoteFor, maturityDates, TENANT } from '../../../../server/engine.ts';
import { explain } from '../../../../server/explain.ts';
import { currentSession } from '../../../../server/session.ts';
import { findSession, saveSession } from '../../../../server/checkout-store.ts';
import { developmentAttestation, findOffer, nextId, saveOffer } from '../../../../server/store.ts';
import { checkoutAcceptAction } from './actions.ts';

export default async function CheckoutPage({ params, searchParams }: { readonly params: Promise<{ readonly locale: string; readonly sessionId: string }>; readonly searchParams: Promise<{ readonly refused?: string; readonly control?: string }> }) {
  const { locale: segment, sessionId } = await params;
  const { refused, control } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const numerals = defaultNumerals(locale);
  let session = findSession(sessionId);
  if (session === undefined) notFound();
  const identity = await currentSession();
  if (identity === undefined) redirect(`/${segment}?next=${encodeURIComponent(`/${segment}/checkout/${sessionId}`)}`);
  const at = developmentAttestation();

  // Advance the session as far as the facts allow, on the server, before rendering.
  if (session.state === 'CREATED') {
    const identified = identify(session, identity.applicantRef, identity.identityAssertionId, at);
    if (!identified.ok) { session = expireOrRefuse(session, identified.error.control, identified.error.reason); } else { session = identified.value; saveSession(session); }
  }
  if (session.state === 'IDENTIFIED') {
    const quoted = quoteFor('bnpl', session.core.basket.minorUnits, 4, identity.applicantRef, at, (await resolveProductCatalogue(TENANT, at.epochSeconds)).catalogue);
    if (!quoted.ok) { session = refuseSession(session, quoted.error.control, quoted.error.reason); saveSession(session); }
    else {
      const offerId = nextId('ofr');
      const dates = maturityDates(at, quoted.value.offer.quote.tenorDays);
      saveOffer({ offerId, tenantId: TENANT, applicantRef: identity.applicantRef, productCode: 'bnpl', offer: quoted.value.offer, maturityDateGregorian: dates.gregorian, maturityDateHijri: dates.hijri, expiresAtEpochSeconds: session.core.expiresAtEpochSeconds });
      const offered = offerSession(session, offerId, quoted.value.offer.disclosureVersion, at);
      if (offered.ok) { session = offered.value; saveSession(session); }
    }
  }

  const stored = session.state === 'OFFERED' || session.state === 'ACCEPTED' || session.state === 'BOOKED' ? findOffer(session.offerId) : undefined;
  if (session.state === 'BOOKED') redirect(`${session.core.returnUrl}${session.core.returnUrl.includes('?') ? '&' : '?'}sessionId=${sessionId}&state=BOOKED`);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="text-sm text-ink-quiet">{arabic ? 'الدفع لاحقاً لطلبك' : 'Pay later for your order'} <span className="identifier">{session.core.merchantOrderRef}</span></p>
        <h1 className="mt-1 text-h1 font-semibold text-heading"><bdi className="tabular-nums">{formatMinorUnits(session.core.basket, numerals)}</bdi> <span className="text-base font-normal text-ink-quiet">SAR</span></h1>
      </div>
      {refused !== undefined ? <ControlRejection control={control ?? 'OP-DETERMINACY'} explanation={explain(refused, arabic)} controlLabel={arabic ? 'الضابط' : 'Control'} /> : null}
      {session.state === 'REFUSED' ? (
        <>
          <ControlRejection control={session.control} explanation={explain(session.reason, arabic)} controlLabel={arabic ? 'الضابط' : 'Control'} />
          <a href={session.core.cancelUrl} className="text-center text-sm text-brand">{arabic ? 'العودة إلى المتجر' : 'Back to the shop'}</a>
        </>
      ) : session.state === 'CANCELLED' || session.state === 'EXPIRED' ? (
        <Card><p className="text-sm text-ink">{arabic ? 'انتهت هذه الجلسة. عُد إلى المتجر وابدأ من جديد.' : 'This session has ended. Go back to the shop and start again.'}</p></Card>
      ) : stored !== undefined && session.state === 'OFFERED' ? (
        <>
          <Disclosure offer={stored.offer} locale={locale} />
          <Card>
            <form action={checkoutAcceptAction} className="flex flex-col gap-4">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="sessionId" value={sessionId} />
              <input type="hidden" name="disclosureVersion" value={stored.offer.disclosureVersion} />
              <label className="flex items-start gap-3 text-sm text-ink">
                <input type="checkbox" name="confirm" value="yes" className="mt-1 size-5 accent-brand" />
                <span>{arabic ? 'قرأت الإفصاح وأفهم أنني أدفع قيمة المشتريات على أربعة أقساط بلا أي تكلفة إضافية.' : 'I have read the disclosure and understand I pay the purchase amount in four instalments at no extra cost.'}</span>
              </label>
              <button type="submit" className="press inline-flex min-h-tap items-center justify-center rounded-pill bg-brand px-6 text-base font-semibold text-white hover:bg-brand-deep">{arabic ? 'أقبل وأُكمل الشراء' : 'Accept and complete the purchase'}</button>
              <a href={session.core.cancelUrl} className="text-center text-sm text-ink-quiet">{arabic ? 'إلغاء والعودة إلى المتجر' : 'Cancel and go back to the shop'}</a>
            </form>
          </Card>
        </>
      ) : (
        <Card><p className="text-sm text-ink-quiet">{arabic ? 'جارٍ التحضير…' : 'Preparing…'}</p></Card>
      )}
    </div>
  );
}

function expireOrRefuse(session: CheckoutSession, control: string, reason: string): CheckoutSession {
  if (session.state === 'CREATED' || session.state === 'IDENTIFIED' || session.state === 'OFFERED') {
    const next = session.state === 'CREATED' ? { ...session, state: 'REFUSED' as const, control, reason } : refuseSession(session, control, reason);
    saveSession(next);
    return next;
  }
  return session;
}

