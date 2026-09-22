/**
 * Key an origination request.
 *
 * The maker's screen. Note what it does not have: a free-text "how much do
 * you want" divorced from a trade. Every request names an invoice, and the
 * amount is the amount of that trade (BR-D01, FP-02). The field is here
 * because a maker keying from a paper file needs to enter it; validating that
 * it matches the cleared invoice is trade validation's job, downstream, and it
 * will refuse a mismatch regardless of what was typed.
 *
 * Submitting does not create credit. It creates a request that a second person
 * reviews — and on the external channels, one the servicing platform answers
 * on first.
 */

import { notFound } from 'next/navigation';

import { Card, ControlRejection } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { CHANNEL_POLICIES } from '@sanad/core/origination/channel.ts';

/**
 * The channels an operator can actually key.
 *
 * `PARTNER_API` and `COUNTERPARTY_SELF` are absent on purpose. Each channel
 * declares the identification it accepts, and neither of those accepts a staff
 * principal — a partner system authenticates as itself, a counterparty as a
 * verified signatory. Offering them in this dropdown would let an operator
 * choose a channel the domain then refuses, which is a worse experience than
 * not offering it and tells them nothing about why.
 *
 * `EMBEDDED_AGGREGATOR` stays, because operations keying a nomination on an
 * aggregator's behalf is a real fallback — the identification recorded is
 * still the aggregator's, with the merchant's mandate.
 */
const KEYABLE_CHANNELS = ['MAKER_CHECKER', 'EMBEDDED_AGGREGATOR'] as const;

import { keyAndSubmitAction } from '../../../server/actions.ts';

const LABEL = 'block text-sm font-medium text-ink';
const INPUT =
  'mt-1 block w-full min-h-tap rounded-card border border-line bg-surface px-3 text-base text-ink';

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
        <a href={`/${segment}`} className="text-sm text-brand-deep underline">
          {arabic ? 'رجوع إلى لوحة العمليات' : 'Back to dashboard'}
        </a>
        <h1 className="mt-2 text-xl font-semibold">
          {arabic ? 'إنشاء طلب تمويل' : 'Key an origination request'}
        </h1>
        <p className="mt-1 text-sm text-ink-quiet">
          {arabic
            ? 'يبدأ كل طلب من صفقة حقيقية. الإرسال لا ينشئ تمويلًا — بل طلبًا يراجعه شخص آخر.'
            : 'Every request starts from a real trade. Submitting does not create credit — it creates a request that a second person reviews.'}
        </p>
        <p className="mt-1 text-xs text-ink-quiet">
          {arabic
            ? 'طلبات الشركاء تصل عبر الواجهة البرمجية، وطلبات العملاء عبر بوابتهم. لا تُدخَل من هنا.'
            : 'Partner requests arrive over the API and counterparty requests through their own portal. Neither is keyed here.'}
        </p>
      </div>

      {control !== undefined ? (
        <ControlRejection
          control={control}
          explanation={message ?? ''}
          controlLabel={arabic ? 'الضابط' : 'Control'}
        />
      ) : null}

      <Card>
        <form action={keyAndSubmitAction} className="flex flex-col gap-4">
          <input type="hidden" name="locale" value={segment} />

          <div>
            <label className={LABEL} htmlFor="channel">
              {arabic ? 'القناة' : 'Channel'}
            </label>
            <select id="channel" name="channel" className={INPUT} defaultValue="MAKER_CHECKER">
              {KEYABLE_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {channel.replaceAll('_', ' ').toLowerCase()}
                  {CHANNEL_POLICIES[channel].requiresServicingDecision
                    ? ' — servicing responds first'
                    : ''}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="counterparty">
                {arabic ? 'العميل' : 'Counterparty'}
              </label>
              <input id="counterparty" name="counterparty" className={INPUT} required />
            </div>
            <div>
              <label className={LABEL} htmlFor="programmeId">
                {arabic ? 'البرنامج' : 'Programme'}
              </label>
              <input id="programmeId" name="programmeId" className={INPUT} defaultValue="prg-0001" />
            </div>
          </div>

          <fieldset className="rounded-card border border-line p-3">
            <legend className="px-1 text-sm font-medium">
              {arabic ? 'الصفقة' : 'The trade'}
            </legend>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={LABEL} htmlFor="invoiceNumber">
                  {arabic ? 'رقم الفاتورة' : 'Invoice number'}
                </label>
                <input id="invoiceNumber" name="invoiceNumber" className={INPUT} required />
              </div>
              <div>
                <label className={LABEL} htmlFor="invoiceUuid">
                  {arabic ? 'معرّف الفاتورة' : 'Invoice identifier'}
                </label>
                <input
                  id="invoiceUuid"
                  name="invoiceUuid"
                  className={INPUT}
                  defaultValue="3cf5d9a2-0000-4000-8000-000000000002"
                  required
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="issuerCr">
                  {arabic ? 'سجل البائع' : 'Seller registration'}
                </label>
                <input id="issuerCr" name="issuerCr" className={INPUT} defaultValue="1010000002" />
              </div>
              <div>
                <label className={LABEL} htmlFor="recipientCr">
                  {arabic ? 'سجل المشتري' : 'Recipient registration'}
                </label>
                <input
                  id="recipientCr"
                  name="recipientCr"
                  className={INPUT}
                  defaultValue="7001000001"
                />
              </div>
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL} htmlFor="amount">
                {arabic ? 'المبلغ (ر.س)' : 'Amount (SAR)'}
              </label>
              <input
                id="amount"
                name="amount"
                inputMode="decimal"
                className={INPUT}
                placeholder="185000.00"
                required
              />
              <p className="mt-1 text-xs text-ink-quiet">
                {arabic
                  ? 'يُحوَّل إلى وحدات صغرى صحيحة دون أي حساب عشري.'
                  : 'Converted to whole minor units without any floating point arithmetic.'}
              </p>
            </div>
            <div>
              <label className={LABEL} htmlFor="tenorDays">
                {arabic ? 'المدة (يوم)' : 'Tenor (days)'}
              </label>
              <input
                id="tenorDays"
                name="tenorDays"
                type="number"
                min="1"
                className={INPUT}
                defaultValue="90"
                required
              />
            </div>
          </div>

          <fieldset className="rounded-card border border-dashed border-line p-3">
            <legend className="px-1 text-sm font-medium">
              {arabic ? 'التمويل المدمج فقط' : 'Embedded channel only'}
            </legend>
            <p className="mb-3 text-xs text-ink-quiet">
              {arabic
                ? 'ترشّح المنصة التاجر، ولا تُقرّ نيابة عنه. التفويض مطلوب من التاجر نفسه.'
                : 'An aggregator introduces a merchant; it does not consent for them. The mandate must come from the merchant.'}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={LABEL} htmlFor="aggregatorId">
                  {arabic ? 'معرّف المنصة' : 'Aggregator'}
                </label>
                <input id="aggregatorId" name="aggregatorId" className={INPUT} />
              </div>
              <div>
                <label className={LABEL} htmlFor="merchantMandateRef">
                  {arabic ? 'مرجع تفويض التاجر' : 'Merchant mandate reference'}
                </label>
                <input id="merchantMandateRef" name="merchantMandateRef" className={INPUT} />
              </div>
            </div>
          </fieldset>

          <button
            type="submit"
            className="min-h-tap rounded-card bg-brand-strong px-5 text-base font-semibold text-on-brand hover:bg-brand-deep"
          >
            {arabic ? 'إرسال للمراجعة' : 'Submit for review'}
          </button>
        </form>
      </Card>
    </div>
  );
}
