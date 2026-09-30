/**
 * Begin an origination request.
 *
 * This screen has no fields for the request itself. It exists to choose the
 * channel and start a journey whose first real step is choosing the trade —
 * because the Murabaha journey begins at the goods, never at an amount. The
 * amount-first products open in the consumer app, from their own module.
 */

import { notFound } from 'next/navigation';

import { BUTTON_PRIMARY, CHOICE_CARD, Card, ControlRejection } from '@sanad/design/primitives.tsx';
import { Icon } from '@sanad/design/icons.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { beginOriginationAction } from '../../../server/actions.ts';

/**
 * `PARTNER_API` and `COUNTERPARTY_SELF` are absent on purpose: neither accepts
 * a staff principal, so offering them would let an operator choose a channel
 * the domain then refuses.
 */
const KEYABLE = [
  { channel: 'MAKER_CHECKER', en: 'Keyed by an operator, approved by a second', ar: 'يُدخله موظف ويعتمده آخر' },
  { channel: 'EMBEDDED_AGGREGATOR', en: 'Nominated by an aggregator, on a merchant’s mandate', ar: 'يرشّحه وسيط بتفويض من التاجر' },
  { channel: 'AGENT_ASSISTED', en: 'Keyed by an authorised agent or relationship manager, within their limits', ar: 'يُدخله وكيل أو مدير علاقات مخوَّل ضمن حدوده' },
] as const;

export default async function OriginatePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly control?: string; readonly message?: string }>;
}) {
  const { locale: segment } = await params;
  const { control, message } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h2 className="text-h2 font-semibold text-heading">{arabic ? 'طلب تمويل جديد' : 'New origination request'}</h2>
        <p className="mt-1 text-[15px] text-ink-quiet">
          {arabic
            ? 'يبدأ الطلب باختيار الصفقة. المبلغ يُقرأ من الفاتورة ولا يُدخل يدوياً.'
            : 'A request starts with the trade. The amount is read from the invoice and is never typed.'}
        </p>
      </div>

      {control !== undefined ? (
        <ControlRejection control={control} explanation={message ?? ''} controlLabel={arabic ? 'الضابط' : 'Control'} />
      ) : null}

      <Card>
        <form action={beginOriginationAction} className="flex flex-col gap-6">
          <input type="hidden" name="locale" value={segment} />
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-3 text-[16px] text-ink">{arabic ? 'القناة' : 'Channel'}</legend>
            {KEYABLE.map((k, i) => (
              <label key={k.channel} className={CHOICE_CARD}>
                <input type="radio" name="channel" value={k.channel} defaultChecked={i === 0} className="mt-1 size-4 accent-brand-deep" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[16px] font-medium text-heading">{k.channel.replaceAll('_', ' ').toLowerCase()}</span>
                  <span className="text-[14px] text-ink-quiet">{arabic ? k.ar : k.en}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <div className="flex justify-end">
            <button type="submit" className={`${BUTTON_PRIMARY} gap-2`}>
              <Icon name="key-in" size={18} />
              {arabic ? 'اختيار الصفقة' : 'Choose the trade'}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
