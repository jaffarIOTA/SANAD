/**
 * Step 1 — choose the trade.
 *
 * A list of cleared invoices, each with its goods, its parties and its
 * amount. The operator picks one. The amount is a property of what they
 * picked, and there is no box to type a different one into (§6).
 *
 * Unavailable invoices are shown, marked and unselectable — with the control
 * that makes them unavailable. Hiding them would be tidier and worse: an
 * operator who cannot see an invoice assumes it was never cleared and raises
 * a ticket against the wrong system.
 */

import { notFound } from 'next/navigation';

import { Card, ControlRejection, DualDate, Status } from '@sanad/design/primitives.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { chooseTradeAction } from '../../../../../server/actions.ts';
import { listClearedInvoices, unavailableReason } from '../../../../../server/invoices.ts';
import { financedInvoices, findDraft } from '../../../../../server/store.ts';
import { Steps } from '../../Steps.tsx';

const WHY: Readonly<Record<'SH-10' | 'SH-08', { en: string; ar: string }>> = {
  'SH-10': { en: 'already financed', ar: 'سبق تمويلها' },
  'SH-08': { en: 'same entity both sides', ar: 'الطرفان كيان واحد' },
};

export default async function TradePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly draftId: string }>;
  readonly searchParams: Promise<{ readonly control?: string; readonly message?: string }>;
}) {
  const { locale: segment, draftId } = await params;
  const { control, message } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  if (findDraft(draftId) === undefined) notFound();

  const arabic = locale === 'ar-SA';
  const numerals = defaultNumerals(locale);
  const financed = financedInvoices();
  const invoices = listClearedInvoices();

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <Steps current="trade" arabic={arabic} />
      <div>
        <h1 className="text-xl font-semibold">{arabic ? 'اختر الصفقة' : 'Choose the trade'}</h1>
        <p className="mt-1 text-sm text-ink-quiet">
          {arabic ? 'فواتير مُخلَّصة من هيئة الفوترة. المبلغ هو مبلغ الفاتورة.' : 'Cleared invoices from the e-invoicing authority. The amount is the invoice’s amount.'}
        </p>
      </div>

      {control !== undefined ? (
        <ControlRejection control={control} explanation={message ?? ''} controlLabel={arabic ? 'الضابط' : 'Control'} />
      ) : null}

      <form action={chooseTradeAction} className="flex flex-col gap-3">
        <input type="hidden" name="locale" value={segment} />
        <input type="hidden" name="draftId" value={draftId} />

        {invoices.map((inv) => {
          const why = unavailableReason(inv, financed);
          const disabled = why !== undefined;
          return (
            <Card key={inv.invoiceUuid} muted={disabled}>
              <label className={`flex items-start gap-3 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                <input type="radio" name="invoiceUuid" value={inv.invoiceUuid} disabled={disabled} required className="mt-1.5" />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">{arabic ? inv.goodsDescriptionAr : inv.goodsDescription}</span>
                    <span className="text-amount font-semibold tabular-nums">
                      <bdi>{formatMinorUnits(inv.amount, numerals)}</bdi> <span className="text-sm font-normal text-ink-quiet">SAR</span>
                    </span>
                  </span>
                  <span className="text-sm text-ink-quiet">
                    {inv.issuerName} <span aria-hidden>→</span> {inv.recipientName}
                  </span>
                  <span className="flex flex-wrap items-center gap-3 text-xs text-ink-quiet">
                    <span className="identifier">{inv.invoiceNumber}</span>
                    <DualDate gregorian={inv.issuedGregorian} hijri={inv.issuedHijri} locale={locale} />
                    {why !== undefined ? (
                      <Status tone="blocked" label={`${why.control} · ${arabic ? WHY[why.control].ar : WHY[why.control].en}`} />
                    ) : null}
                  </span>
                </span>
              </label>
            </Card>
          );
        })}

        <div className="flex items-center justify-between">
          <a href={`/${segment}/originate`} className="text-sm text-brand-deep underline">{arabic ? 'رجوع' : 'Back'}</a>
          <button type="submit" className="inline-flex min-h-tap items-center rounded-card bg-brand-strong px-5 text-sm font-semibold text-on-brand hover:bg-brand-deep">
            {arabic ? 'التالي: الشروط' : 'Next: the terms'}
          </button>
        </div>
      </form>
    </div>
  );
}
