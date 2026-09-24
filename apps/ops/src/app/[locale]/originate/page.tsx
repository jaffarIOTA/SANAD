/**
 * Begin an origination request.
 *
 * This screen has no fields for the request itself. It exists to choose the
 * channel and start a journey whose first real step is choosing the trade —
 * because the journey begins at the goods, never at an amount (§6).
 */

import { notFound } from 'next/navigation';

import { Card, ControlRejection } from '@sanad/design/primitives.tsx';
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
    <div className="flex max-w-2xl flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">{arabic ? 'طلب تمويل جديد' : 'New origination request'}</h1>
        <p className="mt-1 text-sm text-ink-quiet">
          {arabic
            ? 'يبدأ الطلب باختيار الصفقة. المبلغ يُقرأ من الفاتورة ولا يُدخل يدوياً.'
            : 'A request starts with the trade. The amount is read from the invoice and is never typed.'}
        </p>
      </div>

      {control !== undefined ? (
        <ControlRejection control={control} explanation={message ?? ''} controlLabel={arabic ? 'الضابط' : 'Control'} />
      ) : null}

      <Card>
        <form action={beginOriginationAction} className="flex flex-col gap-4">
          <input type="hidden" name="locale" value={segment} />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-ink">{arabic ? 'القناة' : 'Channel'}</legend>
            {KEYABLE.map((k, i) => (
              <label key={k.channel} className="flex min-h-tap cursor-pointer items-start gap-3 rounded-card border border-line p-3 hover:bg-sunken">
                <input type="radio" name="channel" value={k.channel} defaultChecked={i === 0} className="mt-1" />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">{k.channel.replaceAll('_', ' ').toLowerCase()}</span>
                  <span className="text-xs text-ink-quiet">{arabic ? k.ar : k.en}</span>
                </span>
              </label>
            ))}
          </fieldset>

          <button type="submit" className="inline-flex min-h-tap items-center justify-center gap-2 rounded-card bg-brand-strong px-5 text-sm font-semibold text-on-brand hover:bg-brand-deep">
            <Icon name="key-in" size={16} />
            {arabic ? 'اختيار الصفقة' : 'Choose the trade'}
          </button>
        </form>
      </Card>
    </div>
  );
}
