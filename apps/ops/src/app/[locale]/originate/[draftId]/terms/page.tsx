/**
 * Step 2 — the terms.
 *
 * The programme and the tenor. Note what is not here: an amount, which was
 * settled by the trade, and a rate, which does not exist. The tenor must be
 * determinate in days (SH-03); an open-ended term is gharar.
 */

import { notFound } from 'next/navigation';

import { Card, ControlRejection } from '@sanad/design/primitives.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { CHANNEL_POLICIES } from '@sanad/core/origination/channel.ts';

import { chooseTermsAction } from '../../../../../server/actions.ts';
import { findClearedInvoice } from '../../../../../server/invoices.ts';
import { findDraft } from '../../../../../server/store.ts';
import { Steps } from '../../Steps.tsx';

const LABEL = 'block text-sm font-medium text-ink';
const INPUT = 'mt-1 block w-full min-h-tap rounded-card border border-line bg-surface px-3 text-base text-ink';

export default async function TermsPage({
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

  const draft = findDraft(draftId);
  const invoice = draft?.invoiceUuid === undefined ? undefined : findClearedInvoice(draft.invoiceUuid);
  if (draft === undefined || invoice === undefined) notFound();

  const arabic = locale === 'ar-SA';
  const numerals = defaultNumerals(locale);
  const needsMandate = CHANNEL_POLICIES[draft.channel].requiresMerchantMandate;

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <Steps current="terms" arabic={arabic} />
      <div>
        <h1 className="text-xl font-semibold">{arabic ? 'الشروط' : 'The terms'}</h1>
        <p className="mt-1 text-sm text-ink-quiet">
          {arabic ? invoice.goodsDescriptionAr : invoice.goodsDescription} · <bdi>{formatMinorUnits(invoice.amount, numerals)}</bdi> SAR
        </p>
      </div>

      {control !== undefined ? (
        <ControlRejection control={control} explanation={message ?? ''} controlLabel={arabic ? 'الضابط' : 'Control'} />
      ) : null}

      <Card>
        <form action={chooseTermsAction} className="flex flex-col gap-4">
          <input type="hidden" name="locale" value={segment} />
          <input type="hidden" name="draftId" value={draftId} />

          <label className={LABEL}>
            {arabic ? 'البرنامج' : 'Programme'}
            <select name="programmeId" defaultValue={draft.programmeId ?? 'prg-0001'} className={INPUT}>
              <option value="prg-0001">{arabic ? 'وصل — تمويل الموزعين' : 'Wasl — distributor finance'}</option>
            </select>
          </label>

          <label className={LABEL}>
            {arabic ? 'المدة بالأيام' : 'Tenor, in days'}
            <input name="tenorDays" type="number" inputMode="numeric" min={1} max={365} step={1} required defaultValue={draft.tenorDays ?? 90} className={INPUT} />
            <span className="mt-1 block text-xs text-ink-quiet">
              {arabic ? 'مدة محددة. لا توجد مدة مفتوحة.' : 'A determinate term. There is no open-ended option.'}
            </span>
          </label>

          {needsMandate ? (
            <>
              <label className={LABEL}>
                {arabic ? 'معرّف الوسيط' : 'Aggregator'}
                <input name="aggregatorId" required defaultValue={draft.aggregatorId ?? ''} className={INPUT} />
              </label>
              <label className={LABEL}>
                {arabic ? 'مرجع تفويض التاجر' : 'Merchant’s mandate reference'}
                <input name="merchantMandateRef" required defaultValue={draft.merchantMandateRef ?? ''} className={INPUT} />
                <span className="mt-1 block text-xs text-ink-quiet">
                  {arabic ? 'تفويض من التاجر نفسه، لا من الوسيط.' : 'From the merchant, not from the aggregator.'}
                </span>
              </label>
            </>
          ) : null}

          <div className="flex items-center justify-between">
            <a href={`/${segment}/originate/${draftId}/trade`} className="text-sm text-brand-deep underline">{arabic ? 'رجوع' : 'Back'}</a>
            <button type="submit" className="inline-flex min-h-tap items-center rounded-card bg-brand-strong px-5 text-sm font-semibold text-on-brand hover:bg-brand-deep">
              {arabic ? 'التالي: المراجعة' : 'Next: review'}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
