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

import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Card,
  ControlRejection,
  DualDate,
  FIELD_INPUT,
  FIELD_LABEL,
} from '@sanad/design/primitives.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { CHANNEL_POLICIES } from '@sanad/core/origination/channel.ts';

import { submitDraftAction } from '../../../../../server/actions.ts';
import { pageStaff } from '../../../../../server/session.ts';
import { Gate, authorityRefusal } from '../../../Gate.tsx';
import { findClearedInvoice } from '../../../../../server/invoices.ts';
import { findDraft } from '../../../../../server/store.ts';
import { Steps } from '../../Steps.tsx';

/** A read-only kit field: the same shape as an input, so the review reads like the form it summarises. */
function Field({
  label,
  children,
  mono = false,
  wide = false,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly mono?: boolean;
  readonly wide?: boolean;
}) {
  return (
    <div className={wide ? 'md:col-span-2' : ''}>
      <span className={FIELD_LABEL}>{label}</span>
      <div
        className={`${FIELD_INPUT} flex h-auto min-h-[50px] flex-wrap items-center gap-x-2 py-3 ${mono ? 'identifier' : ''}`}
      >
        {children}
      </div>
    </div>
  );
}

export default async function ReviewPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly draftId: string }>;
  readonly searchParams: Promise<{
    readonly control?: string;
    readonly message?: string;
    readonly reason?: string;
    readonly needs?: string;
  }>;
}) {
  const { locale: segment, draftId } = await params;
  const { control, message, reason, needs } = await searchParams;
  const staff = await pageStaff(segment);
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();

  const draft = findDraft(draftId);
  const invoice = draft?.invoiceUuid === undefined ? undefined : findClearedInvoice(draft.invoiceUuid);
  if (draft === undefined || invoice === undefined || draft.tenorDays === undefined) notFound();

  const arabic = locale === 'ar-SA';
  const numerals = defaultNumerals(locale);
  const policy = CHANNEL_POLICIES[draft.channel];

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <Card>
        <Steps current="review" arabic={arabic} />
        <div className="mt-6">
          <h2 className="text-h2 font-semibold text-heading">{arabic ? 'المراجعة والإرسال' : 'Review and submit'}</h2>
        </div>

        {control !== undefined ? (
          <div className="mt-4">
            <ControlRejection
              control={control}
              explanation={authorityRefusal(reason, needs, arabic) ?? message ?? ''}
              controlLabel={arabic ? 'الضابط' : 'Control'}
            />
          </div>
        ) : null}

        <h3 className="mt-6 text-[16px] font-semibold text-heading">{arabic ? 'الصفقة' : 'The trade'}</h3>
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <Field label={arabic ? 'البضاعة' : 'Goods'} wide>
            {arabic ? invoice.goodsDescriptionAr : invoice.goodsDescription}
          </Field>
          <Field label={arabic ? 'البائع' : 'Seller'}>
            {invoice.issuerName} <span className="identifier text-ink-quiet">{invoice.issuerCr}</span>
          </Field>
          <Field label={arabic ? 'المشتري' : 'Buyer'}>
            {invoice.recipientName} <span className="identifier text-ink-quiet">{invoice.recipientCr}</span>
          </Field>
          <Field label={arabic ? 'الفاتورة' : 'Invoice'} mono>
            {invoice.invoiceNumber}
          </Field>
          <Field label={arabic ? 'تاريخ الإصدار' : 'Issued'}>
            <DualDate gregorian={invoice.issuedGregorian} hijri={invoice.issuedHijri} locale={locale} />
          </Field>
          <Field label={arabic ? 'التكلفة' : 'Cost'}>
            <span className="font-semibold tabular-nums">
              <bdi>{formatMinorUnits(invoice.amount, numerals)}</bdi>
            </span>{' '}
            <span className="text-xs text-ink-quiet">SAR</span>
          </Field>
        </div>

        <h3 className="mt-8 text-[16px] font-semibold text-heading">{arabic ? 'الشروط' : 'The terms'}</h3>
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <Field label={arabic ? 'البرنامج' : 'Programme'}>
            {arabic ? 'وصل — تمويل الموزعين' : 'Wasl — distributor finance'}
          </Field>
          <Field label={arabic ? 'المدة' : 'Tenor'}>
            <span className="tabular-nums">{draft.tenorDays}</span> {arabic ? 'يوماً' : 'days'}
          </Field>
          <Field label={arabic ? 'القناة' : 'Channel'}>{draft.channel.replaceAll('_', ' ').toLowerCase()}</Field>
          {draft.merchantMandateRef !== undefined ? (
            <Field label={arabic ? 'تفويض التاجر' : 'Merchant mandate'} mono>
              {draft.merchantMandateRef}
            </Field>
          ) : null}
        </div>
        <p className="mt-5 text-[13px] text-ink-quiet">
          {arabic
            ? 'مبلغ الربح يُحدَّد مرة واحدة عند التسعير، قبل عرض البيع. لا يوجد رقم لعرضه هنا لأنه لم يُقرَّر بعد.'
            : 'The profit amount is fixed once, at quotation, before the sale is offered. There is no figure to show here because nobody has decided it yet.'}
        </p>

        <div className="mt-8 rounded-tile bg-sunken p-5 text-[15px] text-ink">
          {policy.requiresServicingDecision
            ? arabic
              ? 'سيُستشار نظام الخدمة أولاً، ثم يراجعه شخص ثانٍ.'
              : 'The servicing platform is consulted first; a second person then reviews it.'
            : arabic
              ? 'سيراجعه شخص ثانٍ. الاعتماد يفتح معاملة في حالة مسودة، ولا يتجاوز أي بوابة.'
              : 'A second person reviews it. Approval opens a transaction in DRAFT; it passes no gate.'}
        </div>
        <Gate staff={staff} act="ORIGINATE" arabic={arabic}>
          <form action={submitDraftAction} className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <input type="hidden" name="locale" value={segment} />
            <input type="hidden" name="draftId" value={draftId} />
            <a href={`/${segment}/originate/${draftId}/terms`} className={BUTTON_SECONDARY}>
              {arabic ? 'رجوع' : 'Back'}
            </a>
            <button type="submit" className={BUTTON_PRIMARY}>
              {arabic ? 'إرسال للمراجعة' : 'Submit for review'}
            </button>
          </form>
        </Gate>
      </Card>
    </div>
  );
}
