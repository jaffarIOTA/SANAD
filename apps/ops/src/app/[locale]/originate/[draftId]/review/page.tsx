/**
 * Step 3 — review, then submit.
 *
 * Everything the operator chose, on one screen, before the domain gets to
 * refuse it. Submitting does not create credit: it creates a request that a
 * second person reviews, and on the external channels one the servicing
 * platform answers on first.
 *
 * The profit amount is not shown because it does not exist yet. It is fixed
 * once, at quotation, before the sale is offered — and showing a provisional
 * figure here would be showing a number nobody has decided.
 */

import { notFound } from 'next/navigation';

import { Card, ControlRejection, DualDate } from '@sanad/design/primitives.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { CHANNEL_POLICIES } from '@sanad/core/origination/channel.ts';

import { submitDraftAction } from '../../../../../server/actions.ts';
import { findClearedInvoice } from '../../../../../server/invoices.ts';
import { findDraft } from '../../../../../server/store.ts';
import { Steps } from '../../Steps.tsx';

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2 last:border-b-0">
      <span className="text-sm text-ink-quiet">{label}</span>
      <span className="text-sm text-ink">{children}</span>
    </div>
  );
}

export default async function ReviewPage({
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
  if (draft === undefined || invoice === undefined || draft.tenorDays === undefined) notFound();

  const arabic = locale === 'ar-SA';
  const numerals = defaultNumerals(locale);
  const policy = CHANNEL_POLICIES[draft.channel];

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <Steps current="review" arabic={arabic} />
      <div>
        <h1 className="text-xl font-semibold">{arabic ? 'المراجعة والإرسال' : 'Review and submit'}</h1>
      </div>

      {control !== undefined ? (
        <ControlRejection control={control} explanation={message ?? ''} controlLabel={arabic ? 'الضابط' : 'Control'} />
      ) : null}

      <Card>
        <h2 className="text-sm font-medium text-ink">{arabic ? 'الصفقة' : 'The trade'}</h2>
        <div className="mt-2">
          <Row label={arabic ? 'البضاعة' : 'Goods'}>{arabic ? invoice.goodsDescriptionAr : invoice.goodsDescription}</Row>
          <Row label={arabic ? 'البائع' : 'Seller'}>{invoice.issuerName} <span className="identifier text-ink-quiet">{invoice.issuerCr}</span></Row>
          <Row label={arabic ? 'المشتري' : 'Buyer'}>{invoice.recipientName} <span className="identifier text-ink-quiet">{invoice.recipientCr}</span></Row>
          <Row label={arabic ? 'الفاتورة' : 'Invoice'}><span className="identifier">{invoice.invoiceNumber}</span></Row>
          <Row label={arabic ? 'تاريخ الإصدار' : 'Issued'}><DualDate gregorian={invoice.issuedGregorian} hijri={invoice.issuedHijri} locale={locale} /></Row>
          <Row label={arabic ? 'التكلفة' : 'Cost'}>
            <span className="text-amount font-semibold tabular-nums"><bdi>{formatMinorUnits(invoice.amount, numerals)}</bdi></span> <span className="text-ink-quiet">SAR</span>
          </Row>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-medium text-ink">{arabic ? 'الشروط' : 'The terms'}</h2>
        <div className="mt-2">
          <Row label={arabic ? 'البرنامج' : 'Programme'}>{arabic ? 'وصل — تمويل الموزعين' : 'Wasl — distributor finance'}</Row>
          <Row label={arabic ? 'المدة' : 'Tenor'}>{draft.tenorDays} {arabic ? 'يوماً' : 'days'}</Row>
          <Row label={arabic ? 'القناة' : 'Channel'}>{draft.channel.replaceAll('_', ' ').toLowerCase()}</Row>
          {draft.merchantMandateRef !== undefined ? (
            <Row label={arabic ? 'تفويض التاجر' : 'Merchant mandate'}><span className="identifier">{draft.merchantMandateRef}</span></Row>
          ) : null}
        </div>
        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-quiet">
          {arabic
            ? 'مبلغ الربح يُحدَّد مرة واحدة عند التسعير، قبل عرض البيع. لا يوجد رقم لعرضه هنا لأنه لم يُقرَّر بعد.'
            : 'The profit amount is fixed once, at quotation, before the sale is offered. There is no figure to show here because nobody has decided it yet.'}
        </p>
      </Card>

      <Card>
        <p className="text-sm text-ink">
          {policy.requiresServicingDecision
            ? arabic ? 'سيُستشار نظام الخدمة أولاً، ثم يراجعه شخص ثانٍ.' : 'The servicing platform is consulted first; a second person then reviews it.'
            : arabic ? 'سيراجعه شخص ثانٍ. الاعتماد يفتح معاملة في حالة مسودة، ولا يتجاوز أي بوابة.' : 'A second person reviews it. Approval opens a transaction in DRAFT; it passes no gate.'}
        </p>
        <form action={submitDraftAction} className="mt-4 flex items-center justify-between">
          <input type="hidden" name="locale" value={segment} />
          <input type="hidden" name="draftId" value={draftId} />
          <a href={`/${segment}/originate/${draftId}/terms`} className="text-sm text-brand-deep underline">{arabic ? 'رجوع' : 'Back'}</a>
          <button type="submit" className="inline-flex min-h-tap items-center rounded-card bg-brand-strong px-5 text-sm font-semibold text-on-brand hover:bg-brand-deep">
            {arabic ? 'إرسال للمراجعة' : 'Submit for review'}
          </button>
        </form>
      </Card>
    </div>
  );
}
