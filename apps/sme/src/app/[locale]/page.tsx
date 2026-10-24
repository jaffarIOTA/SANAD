/**
 * The distributor's Wasl (W3): the sale offers waiting for the signatory's
 * acceptance, and what the company owes on the sales it has concluded.
 *
 * Signed in only. Only the signatory's own distributor's transactions are
 * listed — the session names the distributor, from the bank's configuration —
 * and only from the offer onwards: what happens before the offer (the limit,
 * the purchase, the gates) is the bank's to do, and the offer is where the
 * distributor's part begins.
 *
 * Every figure is the domain's: cost, profit and the fixed sale price are the
 * transaction's own, never recomputed here, and no rate appears because none
 * exists (SH-01, SH-15).
 */
import { notFound, redirect } from 'next/navigation';

import { type NumeralSystem, defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { Card, DualDate, Status, type StatusTone } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { ummAlQura } from '@sanad/origination/hijri.ts';

import { signOutAction } from '../../server/actions.ts';
import { type DistributorTransaction, myTransactions } from '../../server/portal.ts';
import { currentSession } from '../../server/session.ts';
import { STATE, say } from './words.ts';

const TONE: Readonly<Record<string, StatusTone>> = {
  SALE_OFFERED: 'available',
  ACTIVE: 'settled',
  SETTLED: 'settled',
  OFFER_LAPSED: 'blocked',
  DELINQUENT: 'blocked',
};

function TransactionRow({
  m,
  segment,
  locale,
  numerals,
}: {
  readonly m: DistributorTransaction;
  readonly segment: string;
  readonly locale: 'ar-SA' | 'en-SA';
  readonly numerals: NumeralSystem;
}) {
  const core = m.view.transaction.core;
  const s = m.view.transaction.state;
  const arabic = locale === 'ar-SA';
  return (
    <a href={`/${segment}/finance/${m.view.transactionRef}`} className="block" data-transaction={m.view.transactionRef}>
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="identifier text-sm text-ink-quiet">{m.view.transactionRef}</p>
            <p className="mt-1 text-amount font-semibold tabular-nums text-ink">
              <bdi>{formatMinorUnits(core.pricing.salePriceAmount, numerals)}</bdi>{' '}
              <span className="text-sm text-ink-quiet">{core.pricing.salePriceAmount.currency}</span>
            </p>
            <div className="mt-2 text-sm text-ink-quiet">
              {arabic ? 'الاستحقاق' : 'Due'}{' '}
              <DualDate
                gregorian={core.maturityDateGregorian}
                hijri={ummAlQura(core.maturityDateGregorian)}
                locale={locale}
              />
            </div>
          </div>
          <Status tone={TONE[s] ?? 'progress'} label={say(STATE, s, arabic) ?? s} />
        </div>
      </Card>
    </a>
  );
}

export default async function DistributorHome({ params }: { readonly params: Promise<{ readonly locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const session = await currentSession();
  if (session === undefined) redirect(`/${segment}/sign-in`);
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const numerals = defaultNumerals(locale);
  const mine = await myTransactions(session);
  const offers = mine.filter((m) => m.view.transaction.state === 'SALE_OFFERED');
  const rest = mine.filter((m) => m.view.transaction.state !== 'SALE_OFFERED');
  const row = (m: DistributorTransaction) => (
    <TransactionRow key={m.view.transactionRef} m={m} segment={segment} locale={locale} numerals={numerals} />
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-quiet">
          {t('Signed in as', 'مسجّل باسم')} <span className="identifier">{session.signatoryRef}</span> ·{' '}
          {session.counterpartyId}
        </p>
        <form action={signOutAction}>
          <input type="hidden" name="locale" value={segment} />
          <button type="submit" className="text-sm text-brand-deep underline">
            {t('Sign out', 'تسجيل الخروج')}
          </button>
        </form>
      </div>

      <section className="flex flex-col gap-3" data-offers>
        <h1 className="text-lg font-semibold">{t('Offers awaiting your acceptance', 'عروض بانتظار قبولك')}</h1>
        {offers.length === 0 ? (
          <p className="text-sm text-ink-quiet">{t('No offer is waiting for you.', 'لا يوجد عرض بانتظارك.')}</p>
        ) : (
          offers.map(row)
        )}
      </section>

      <section className="flex flex-col gap-3" data-obligations>
        <h2 className="text-base font-semibold">{t('Your purchases', 'مشترياتك')}</h2>
        {rest.length === 0 ? (
          <p className="text-sm text-ink-quiet">{t('Nothing yet.', 'لا شيء بعد.')}</p>
        ) : (
          rest.map(row)
        )}
      </section>
    </div>
  );
}
