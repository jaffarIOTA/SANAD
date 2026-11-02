/**
 * One sale offer, or one concluded purchase, for the distributor (Wasl W3).
 *
 * The offer: cost and profit shown separately, as amounts, the sale price
 * fixed and never to change (SH-15), how it falls due in both calendars, and
 * when the offer lapses. Accepting is the signatory's act: a signature in the
 * national identity app bound to the offer instrument's hash, then the
 * acceptance. A concluded purchase shows what is owed and when.
 *
 * Signed in only, and only the signatory's own distributor's transactions —
 * another company's offer is not found, exactly as one that does not exist.
 * The server decides whether the offer is open; this page does not infer it.
 *
 * The offer instrument itself is read here as its figures and its hash; the
 * rendered document and an embedded viewer come with the document engine.
 */
import { notFound, redirect } from 'next/navigation';

import { Money, defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { Card, ControlRejection, DualDate } from '@sanad/design/primitives.tsx';
import { STRINGS, localeFromSegment } from '@sanad/i18n/strings.ts';
import { ummAlQura } from '@sanad/origination/hijri.ts';

import { confirmAcceptanceAction, startAcceptanceAction } from '../../../../server/actions.ts';
import { myTransaction } from '../../../../server/portal.ts';
import { currentSession, pendingKind } from '../../../../server/session.ts';
import { NOTICE, REFUSAL, STATE, say } from '../../words.ts';

const instant = (epochSeconds: bigint): string =>
  new Date(Number(epochSeconds) * 1000).toISOString().slice(0, 16).replace('T', ' ');

export default async function OfferPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly transactionRef: string }>;
  readonly searchParams: Promise<{ readonly control?: string; readonly reason?: string; readonly notice?: string }>;
}) {
  const { locale: segment, transactionRef } = await params;
  const { control, reason, notice } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const session = await currentSession();
  if (session === undefined) redirect(`/${segment}/sign-in`);
  const mine = await myTransaction(session, transactionRef);
  if (mine === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const s = STRINGS[locale];
  const numerals = defaultNumerals(locale);
  const tx = mine.view.transaction;
  const core = tx.core;
  const offerLeg = 'legs' in tx ? tx.legs.find((l) => l.legType === 'SALE_OFFER') : undefined;
  const acceptance = mine.view.events.find((e) => e.eventType === 'OFFER_ACCEPTED');
  const booked = mine.view.events.find((e) => e.eventType === 'OBLIGATION_BOOKED');
  const waiting = tx.state === 'SALE_OFFERED' && (await pendingKind()) === 'SIGN_OFFER';
  const said = say(NOTICE, notice, arabic);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <a href={`/${segment}`} className="text-sm text-brand-deep underline">
          {s.back}
        </a>
        <h1 className="mt-2 text-lg font-semibold">{s.murabahaOffer}</h1>
        <p className="mt-1 text-sm text-ink-quiet">
          <span className="identifier">{mine.view.transactionRef}</span> · {say(STATE, tx.state, arabic) ?? tx.state}
        </p>
      </div>

      {said === undefined ? null : (
        <p
          role="status"
          className="rounded-card border border-positive/30 bg-positive-wash px-4 py-3 text-sm text-positive"
        >
          {said}
        </p>
      )}
      {control === undefined ? null : (
        <ControlRejection
          control={control}
          explanation={say(REFUSAL, reason, arabic) ?? t('The offer could not be accepted.', 'تعذّر قبول العرض.')}
          controlLabel={t('Control', 'الضابط')}
        />
      )}

      <Card>
        <Money pricing={core.pricing} locale={locale} labels={{ cost: s.cost, profit: s.profit, total: s.total }} />
        <p className="mt-3 text-xs text-ink-quiet">{s.disclosureNote}</p>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">{t('When it falls due', 'مواعيد الاستحقاق')}</h2>
        {mine.schedule === undefined ? (
          <p className="mt-2 text-sm text-ink-quiet">{t('The schedule is not available.', 'الجدول غير متاح.')}</p>
        ) : (
          <ol className="mt-2 flex flex-col gap-2" data-schedule>
            {mine.schedule.map((i) => (
              <li key={i.sequenceNumber} className="flex items-start justify-between gap-3">
                <DualDate gregorian={i.dueDateGregorian} hijri={ummAlQura(i.dueDateGregorian)} locale={locale} />
                <span className="text-base tabular-nums text-ink">
                  <bdi>{formatMinorUnits(i.amount, numerals)}</bdi>{' '}
                  <span className="text-sm text-ink-quiet">{i.amount.currency}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {tx.state === 'SALE_OFFERED' ? (
        <Card>
          <p className="text-sm text-ink-quiet">
            {t('This offer lapses at', 'ينقضي هذا العرض في')}{' '}
            <bdi dir="ltr" className="identifier">
              {instant(tx.offerExpiresAtEpochSeconds)} UTC
            </bdi>
          </p>
          {offerLeg === undefined ? null : (
            <p className="mt-2 text-xs text-ink-quiet">
              {t('You sign this offer instrument:', 'توقّع على مستند العرض هذا:')}{' '}
              <bdi dir="ltr" className="identifier break-all">
                {offerLeg.contentHash}
              </bdi>
            </p>
          )}
          {waiting ? (
            <form action={confirmAcceptanceAction} className="mt-4">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="transactionRef" value={mine.view.transactionRef} />
              <p role="status" className="mb-3 text-sm text-ink">
                {say(NOTICE, 'APPROVE_SIGNATURE_IN_APP', arabic)}
              </p>
              <button
                type="submit"
                className="press min-h-tap w-full rounded-tile bg-brand-deep px-6 text-base font-medium text-white"
              >
                {t('I have signed — accept the offer', 'وقّعت — قبول العرض')}
              </button>
            </form>
          ) : (
            <form action={startAcceptanceAction} className="mt-4">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="transactionRef" value={mine.view.transactionRef} />
              <button
                type="submit"
                data-accept
                className="press min-h-tap w-full rounded-tile bg-brand-deep px-6 text-base font-medium text-white"
              >
                {t('Accept — sign with the national identity service', 'القبول — التوقيع عبر خدمة الهوية الوطنية')}
              </button>
            </form>
          )}
        </Card>
      ) : null}

      {acceptance === undefined ? null : (
        <Card>
          <h2 className="text-sm font-semibold text-ink">{t('Accepted', 'تم القبول')}</h2>
          <p className="mt-1 text-sm text-ink-quiet">
            <bdi dir="ltr" className="identifier">
              {instant(acceptance.occurredAtEpochSeconds)} UTC
            </bdi>{' '}
            · <span className="identifier">{acceptance.actor.replace(/^distributor:/, '')}</span>
          </p>
          <p className="mt-2 text-sm text-ink">
            {booked === undefined
              ? t('The bank books the amount due shortly.', 'يقيّد البنك المبلغ المستحق قريباً.')
              : t('The amount due is booked on the schedule above.', 'قُيّد المبلغ المستحق وفق الجدول أعلاه.')}
          </p>
        </Card>
      )}
    </div>
  );
}
