/**
 * Offer & Contract — stage 7.
 *
 * Everything shown comes from the recorded offer run: the bilingual Facility
 * Offer Letter (its content hash is its version), the terms the product
 * module quoted, and the dated ACT/365 schedule — the first five and last
 * three instalments with the totals. Nothing is recomputed on this page.
 *
 * Confirm & Send records OFFER_SENT and queues the OFFER_ISSUED notification
 * on the transactional outbox; the previews are exactly what is sent, to
 * masked recipients. Signing (UAE Pass) and disbursement (the partner bank)
 * are recorded with fixture references until those rails are verified.
 */

import { notFound } from 'next/navigation';
import type { ReactElement, ReactNode } from 'react';

import type { OfferLetter } from '@sanad/core/documents/offer-letter.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import { Rate } from '@sanad/design/Rate.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import {
  generateOfferAction,
  recordDisbursedAction,
  recordPortfolioStatusAction,
  recordSignedAction,
  sendOfferAction,
} from '../../../../../server/business-actions.ts';
import { getApplication, previewNotifications, productVariants, syncBusiness } from '../../../../../server/business.ts';
import { formatPercent, scheduleExcerpt } from '../../../../../server/business-dashboard.ts';
import { staffJurisdiction } from '../../../../../server/jurisdiction.ts';
import { pageStaff } from '../../../../../server/session.ts';
import type { StaffPrincipal } from '../../../../../server/staff.ts';
import { Gate } from '../../../Gate.tsx';
import {
  ApplicationShell,
  BTN_PRIMARY,
  BTN_SECONDARY,
  Chip,
  DisabledAction,
  Field,
  FormContext,
  type Formatters,
  INPUT,
  Id,
  LETTER_ACTION,
  MetricTile,
  SEND_LABEL,
  SectionCard,
  TH,
  TH_END,
  formatters,
  splitOfferEmail,
} from '../../ui.tsx';

type Query = {
  readonly notice?: string;
  readonly control?: string;
  readonly reason?: string;
  readonly tenant?: string;
};

export default async function OfferPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly applicationId: string }>;
  readonly searchParams: Promise<Query>;
}) {
  const { locale: segment, applicationId: rawId } = await params;
  const query = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const applicationId = decodeURIComponent(rawId);
  // The signed-in person's own institution, and only if the deployment has it active.
  const staff = await pageStaff(segment);
  const j = await staffJurisdiction(staff.tenantId);
  if (j.tenant === undefined) notFound();
  await syncBusiness(j.tenant);
  const view = await getApplication(j.tenant, applicationId);
  if (view === undefined) notFound();
  const f = formatters(locale === 'ar-SA', view.currency);
  const { t } = f;
  const a = view.application;
  const offer = view.latestOffer;
  const base = `/${segment}/business/${encodeURIComponent(a.applicationId)}`;

  if (offer === undefined) {
    return (
      <ApplicationShell
        segment={segment}
        view={view}
        screen="offer"
        query={query}
        f={f}
        title={t('Offer & contract', 'العرض والعقد')}
      >
        <SectionCard title={t('No offer yet', 'لا يوجد عرض بعد')}>
          {a.status === 'APPROVED' ? (
            <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
              <form action={generateOfferAction} className="flex flex-wrap items-center justify-between gap-3">
                <FormContext segment={segment} applicationId={a.applicationId} screen="offer" />
                <p className="text-[13px] text-ink-quiet">
                  {t(
                    'Approved. The offer is quoted through the product module on the dated schedule.',
                    'معتمد. يُسعَّر العرض عبر وحدة المنتج على الجدول المؤرخ.',
                  )}
                </p>
                <button type="submit" className={BTN_PRIMARY}>
                  {t('Generate offer', 'إعداد العرض')}
                </button>
              </form>
            </Gate>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13px] text-ink-quiet">
                {t(
                  'An offer is generated once the application is approved at stage 6.',
                  `يُعدّ العرض بعد اعتماد الطلب في المرحلة ${f.n(6)}.`,
                )}
              </p>
              <a href={`${base}/assessment`} className={BTN_SECONDARY}>
                {t('Open credit assessment', 'فتح التقييم الائتماني')}
              </a>
            </div>
          )}
        </SectionCard>
      </ApplicationShell>
    );
  }

  const [variants, notices] = await Promise.all([
    productVariants(j.tenant),
    previewNotifications(j.tenant, applicationId),
  ]);
  const variant = variants.get(a.variantCode);
  const terms = offer.terms;
  const schedule = offer.schedule;
  const excerpt = scheduleExcerpt(schedule.rows, 5, 3);
  const name = f.arabic ? (a.applicant.businessNameAr ?? a.applicant.businessNameEn) : a.applicant.businessNameEn;

  return (
    <ApplicationShell
      segment={segment}
      view={view}
      screen="offer"
      query={query}
      f={f}
      title={t('Offer & contract', 'العرض والعقد')}
    >
      {/* -- Dark header card -------------------------------------------------------------------- */}
      <section className="flex flex-col gap-4 rounded-card bg-heading p-6 text-surface shadow-card sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-[12px] font-medium uppercase tracking-wide opacity-70">
            {t('Facility offer', 'عرض التمويل')}
          </p>
          <h2 className="mt-1 text-[22px] font-bold leading-tight">{name}</h2>
          <p className="mt-1 text-[14px] opacity-80">
            {variant === undefined ? a.variantCode : t(variant.nameEn, variant.nameAr)} ·{' '}
            <Id>{offer.letter.reference}</Id>
          </p>
          <p className="mt-1 text-[12px] opacity-70">
            {t(
              `Offer of ${f.isoDate(terms.offerDate)}, valid until ${f.isoDate(terms.validUntil)}`,
              `عرض بتاريخ ${f.isoDate(terms.offerDate)}، ساري حتى ${f.isoDate(terms.validUntil)}`,
            )}
          </p>
        </div>
        <div className="flex flex-col sm:items-end">
          <span className="text-[12px] font-medium uppercase tracking-wide opacity-70">
            {t('Approved facility', 'التمويل المعتمد')}
          </span>
          <span className="flex items-baseline gap-1.5">
            <bdi className="text-[30px] font-bold tabular-nums">{f.money(terms.facilityAmount.minorUnits)}</bdi>
            <span className="text-[14px] opacity-80">{f.cur}</span>
          </span>
          {/* For reference only, from the application: the request the committee approved less than. Not part of the letter. */}
          {a.requested.minorUnits === terms.facilityAmount.minorUnits && a.tenorMonths === terms.months ? null : (
            <span className="text-[12px] opacity-70" data-requested-reference>
              {t('Requested', 'المطلوب')} <bdi className="tabular-nums">{f.money(a.requested.minorUnits)}</bdi> {f.cur}{' '}
              · {t(`${f.n(a.tenorMonths)} months`, `${f.n(a.tenorMonths)} شهراً`)}
            </span>
          )}
        </div>
      </section>

      {/* -- KPI tiles --------------------------------------------------------------------------- */}
      <section aria-label={t('Offer terms', 'شروط العرض')} className="grid gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <MetricTile
          label={t('Tenor', 'المدة')}
          value={f.n(terms.months)}
          unit={t('months', 'شهراً')}
          sub={
            terms.graceMonths === 0
              ? t('no grace', 'دون سماح')
              : t(`incl. ${f.n(terms.graceMonths)} months grace`, `تشمل ${f.n(terms.graceMonths)} أشهر سماح`)
          }
        />
        <MetricTile
          label={t('Monthly instalment', 'القسط الشهري')}
          value={<bdi>{f.money(terms.monthlyInstalment.minorUnits)}</bdi>}
          unit={f.cur}
          sub={t(`due on day ${f.n(terms.paymentDay)}`, `يستحق في اليوم ${f.n(terms.paymentDay)}`)}
        />
        <MetricTile
          label={t('Total interest', 'إجمالي الفائدة')}
          value={<bdi>{f.money(terms.totalInterest.minorUnits)}</bdi>}
          unit={f.cur}
        />
        <MetricTile
          label={t('Total repayable', 'إجمالي المبلغ المستحق')}
          value={<bdi>{f.money(terms.totalPayable.minorUnits)}</bdi>}
          unit={f.cur}
        />
        <MetricTile
          label={t('Own contribution', 'المساهمة الذاتية')}
          value={f.digits(formatPercent(BigInt(a.contributionPerTenThousand)))}
          sub={t('of the project cost', 'من تكلفة المشروع')}
        />
      </section>

      {/* -- Rate and APR, as stored on the offer ------------------------------------------------ */}
      <section
        aria-label={t('Rate and APR', 'معدل الفائدة ومعدل النسبة السنوي')}
        data-testid="offer-rate-apr"
        className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-card border border-line bg-surface px-5 py-4 shadow-card"
      >
        <Rate
          rate={rate(terms.rateBp, 'REDUCING', 'ANNUAL')}
          locale={f.arabic ? 'ar-SA' : 'en-SA'}
          label={t('Interest rate (annual, reducing balance)', 'معدل الفائدة (سنوي، على الرصيد المتناقص)')}
        />
        <Rate
          rate={rate(terms.aprBp, 'APR', 'ANNUAL')}
          locale={f.arabic ? 'ar-SA' : 'en-SA'}
          label={t('APR (computed by the platform)', 'معدل النسبة السنوي (تحسبه المنصة)')}
        />
        {/* The rate's source reference is stored with the offer (terms.rateSourceRef) but not shown: in this tenant's catalogue it is a free-text provenance note that names a vendor. */}
        <span className="text-[12px] text-ink-quiet">
          {t(
            'Rate source: the fund’s rate card (ILLUSTRATIVE), recorded with the offer.',
            'مصدر المعدل: جدول أسعار الصندوق (توضيحي)، مسجّل مع العرض.',
          )}
        </span>
        <span className="w-full text-[12px] text-ink-quiet">
          {offer.letter.terms.some((r) => r.code === 'APR')
            ? t(
                'Both are the figures stored with this offer: the rate snapshot taken at quotation and the APR computed from the quoted cash flows. The letter states both.',
                'كلاهما من الأرقام المحفوظة مع هذا العرض: لقطة المعدل عند التسعير ومعدل النسبة السنوي المحسوب من التدفقات النقدية المسعّرة. ويذكرهما الخطاب كليهما.',
              )
            : t(
                'Both are the figures stored with this offer: the rate snapshot taken at quotation and the APR computed from the quoted cash flows. The letter states the same rate; this version of it does not state the APR.',
                'كلاهما من الأرقام المحفوظة مع هذا العرض: لقطة المعدل عند التسعير ومعدل النسبة السنوي المحسوب من التدفقات النقدية المسعّرة. يذكر الخطاب المعدل نفسه، ولا يذكر هذا الإصدار منه معدل النسبة السنوي.',
              )}
        </span>
      </section>

      {/* -- Schedule ------------------------------------------------------------------------------ */}
      <SectionCard
        title={t('Repayment schedule', 'جدول السداد')}
        note={t(
          `${f.n(schedule.rows.length)} instalments, actual/365 from disbursement on ${f.isoDate(terms.disbursementDate)}; first due ${f.isoDate(terms.firstDueDate)}.`,
          `${f.n(schedule.rows.length)} قسطاً، على أساس الأيام الفعلية مقسومةً على ${f.n(365)} من الصرف بتاريخ ${f.isoDate(terms.disbursementDate)}؛ أول قسط ${f.isoDate(terms.firstDueDate)}.`,
        )}
      >
        <div className="relative -mx-5 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="bg-sunken">
                <th scope="col" className={`${TH} ps-5`}>
                  {t('#', 'رقم')}
                </th>
                <th scope="col" className={TH}>
                  {t('Payment date', 'تاريخ السداد')}
                </th>
                <th scope="col" className={`${TH_END} hidden md:table-cell`}>
                  {t('Opening', 'الرصيد الافتتاحي')}
                </th>
                <th scope="col" className={TH_END}>
                  {t('Principal', 'الأصل')}
                </th>
                <th scope="col" className={TH_END}>
                  {t('Interest', 'الفائدة')}
                </th>
                <th scope="col" className={TH_END}>
                  {t('Instalment', 'القسط')}
                </th>
                <th scope="col" className={`${TH_END} hidden pe-5 md:table-cell`}>
                  {t('Closing', 'الرصيد الختامي')}
                </th>
              </tr>
            </thead>
            <tbody>
              {excerpt.head.map((r) => (
                <ScheduleRow key={r.number} row={r} f={f} />
              ))}
              {excerpt.omitted > 0 ? (
                <tr className="border-t border-line bg-sunken/50">
                  <td colSpan={7} className="py-2 ps-5 pe-5 text-center text-[12px] text-ink-quiet">
                    ⋯ {t(`${f.n(excerpt.omitted)} more instalments`, `${f.n(excerpt.omitted)} قسطاً آخر`)} ⋯
                  </td>
                </tr>
              ) : null}
              {excerpt.tail.map((r) => (
                <ScheduleRow key={r.number} row={r} f={f} />
              ))}
              <tr className="border-t-2 border-line-strong font-semibold text-heading">
                <td className="py-3 ps-5 pe-3" colSpan={2}>
                  {t('Totals', 'الإجمالي')}
                </td>
                <td className="hidden py-3 pe-3 md:table-cell" />
                <td className="py-3 pe-3 text-end tabular-nums">
                  <bdi>{f.money(schedule.totalPrincipal.minorUnits)}</bdi>
                </td>
                <td className="py-3 pe-3 text-end tabular-nums">
                  <bdi>{f.money(schedule.totalInterest.minorUnits)}</bdi>
                </td>
                <td className="py-3 pe-3 text-end tabular-nums">
                  <bdi>{f.money(schedule.totalPayable.minorUnits)}</bdi>
                </td>
                <td className="hidden py-3 pe-5 md:table-cell" />
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[12px] text-ink-quiet">
          {t(
            `Amounts in ${f.cur}. The schedule is the core banking system’s, reproduced to the fil.`,
            `المبالغ بال${f.cur}. الجدول مطابق للنظام المصرفي حتى الفلس.`,
          )}
        </p>
      </SectionCard>

      {/* -- Signing and disbursement --------------------------------------------------------------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard
          title={t('Digital signing', 'التوقيع الرقمي')}
          note={
            f.arabic ? (
              <>
                التوقيع عبر الهوية الرقمية (
                <bdi dir="ltr" className="whitespace-nowrap">
                  UAE Pass
                </bdi>
                ) — مرجع تجريبي إلى أن يُتحقق من الربط.
              </>
            ) : (
              'Signed through UAE Pass — a fixture reference until the UAE Pass rail is verified.'
            )
          }
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Notification channels', 'قنوات الإشعار')}>
              {[
                view.contact.emailMasked === undefined ? '' : t('Email', 'البريد الإلكتروني'),
                view.contact.mobileMasked === undefined ? '' : t('SMS', 'رسالة نصية'),
              ]
                .filter((s) => s !== '')
                .join(' + ') || t('None', 'لا يوجد')}
            </Field>
            <Field label={t('Recipient (masked)', 'المستلم (مُقنّع)')}>
              <span className="flex flex-col text-[13px]">
                {view.contact.emailMasked === undefined ? null : <Id>{view.contact.emailMasked}</Id>}
                {view.contact.mobileMasked === undefined ? null : <Id>{view.contact.mobileMasked}</Id>}
              </span>
            </Field>
            <Field label={t('Language', 'اللغة')}>{t('Arabic and English', 'العربية والإنجليزية')}</Field>
            <Field label={t('Letter version', 'إصدار الخطاب')}>
              <span title={offer.letter.version}>
                <Id className="text-[12px]">{`${offer.letter.version.slice(0, 12)}…`}</Id>
              </span>
            </Field>
          </dl>
        </SectionCard>
        <SectionCard
          title={t('Disbursement', 'الصرف')}
          note={t(
            'Partner bank — a fixture reference until the partner-bank rail is verified.',
            'البنك الشريك — مرجع تجريبي إلى أن يُتحقق من الربط.',
          )}
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Paying bank', 'البنك الدافع')}>{t('Partner bank', 'البنك الشريك')}</Field>
            <Field label={t('Disbursement', 'طريقة الصرف')}>{t('Single disbursement', 'دفعة واحدة')}</Field>
            <Field label={t('Amount', 'المبلغ')}>
              <bdi className="tabular-nums">{f.money(terms.facilityAmount.minorUnits)}</bdi>{' '}
              <span className="text-[12px] font-normal text-ink-quiet">{f.cur}</span>
            </Field>
            <Field label={t('Planned date', 'التاريخ المخطط')}>{f.isoDate(terms.disbursementDate)}</Field>
          </dl>
          <p className="mt-4 rounded-tile bg-sunken px-3 py-2.5 text-[12px] text-ink-quiet">
            {f.arabic ? (
              <>
                التسلسل: يوقّع العميل ← يُطلق موظف يحمل صلاحية المالية أمر الدفع — لا المعتمِد ولا الموظف الذي أحال
                الطلب ← يدفع البنك الشريك ← يقيّد نظام القروض التمويل (المرحلة {f.n(8)}).
              </>
            ) : (
              <>
                Flow: the applicant signs → a member of staff holding the finance authority — neither the approver nor
                the submitting officer — releases the payment instruction → the partner bank pays → the loan system
                books the facility (stage 8).
              </>
            )}
          </p>
        </SectionCard>
      </div>

      {/* -- Confirm & send, then signing, disbursement, portfolio ------------------------------------- */}
      <SectionCard
        title={t('Confirm & send', 'التأكيد والإرسال')}
        note={t(
          'Three automated actions, queued on the transactional outbox — a retry cannot send twice.',
          'ثلاثة إجراءات آلية في قائمة الإرسال — لا يُرسل الإجراء مرتين عند إعادة المحاولة.',
        )}
        aside={
          a.offer === undefined ? (
            <Chip tone="warn">{t('Not sent', 'لم يُرسل')}</Chip>
          ) : (
            <Chip tone="good">
              {t(`Sent ${f.epochDate(a.offer.sentAtEpochSeconds)}`, `أُرسل ${f.epochDate(a.offer.sentAtEpochSeconds)}`)}
            </Chip>
          )
        }
      >
        <ol className="grid list-none gap-3 p-0 md:grid-cols-3">
          <ActionItem
            n={f.n(1)}
            title={t('Email', 'البريد الإلكتروني')}
            body={
              view.contact.emailMasked === undefined ? (
                t('No email on record', 'لا يوجد بريد مسجل')
              ) : (
                <>
                  {t('Bilingual offer email to', 'بريد العرض باللغتين إلى')} <Id>{view.contact.emailMasked}</Id>
                </>
              )
            }
          />
          <ActionItem
            n={f.n(2)}
            title={t('SMS', 'رسالة نصية')}
            body={
              view.contact.mobileMasked === undefined ? (
                t('No mobile on record', 'لا يوجد هاتف مسجل')
              ) : (
                <>
                  {t('Arabic and English SMS to', 'رسالة بالعربية والإنجليزية إلى')}{' '}
                  <Id>{view.contact.mobileMasked}</Id>
                </>
              )
            }
          />
          <ActionItem
            n={f.n(3)}
            title={t(LETTER_ACTION.title.en, LETTER_ACTION.title.ar)}
            body={t(LETTER_ACTION.body.en, LETTER_ACTION.body.ar)}
          />
        </ol>

        <details className="mt-4 rounded-tile border border-line px-4 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold text-brand">
            {t('Preview notification', 'معاينة الإشعار')}
          </summary>
          {!notices.ok ? (
            <p className="mt-3 text-[13px] text-blocked">
              {t('The notification cannot be previewed for this contact.', 'تتعذّر معاينة الإشعار لجهة الاتصال هذه.')}
            </p>
          ) : (
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {/* Arabic screens read the Arabic first: the SMS (Arabic line first) leads, then the email with its Arabic summary before the English body. */}
              {f.arabic ? <SmsPreview sms={notices.value.sms} f={f} /> : null}
              {notices.value.email === undefined ? null : <EmailPreview email={notices.value.email} f={f} />}
              {f.arabic ? null : <SmsPreview sms={notices.value.sms} f={f} />}
            </div>
          )}
        </details>

        <details className="mt-3 rounded-tile border border-line px-4 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold text-brand">
            {t('Preview offer letter', 'معاينة خطاب العرض')}
          </summary>
          <LetterPreview letter={offer.letter} />
        </details>

        <div className="mt-5 border-t border-line pt-5">
          <NextStep
            segment={segment}
            view={view}
            letterVersion={a.offer?.letterVersion}
            latestVersion={offer.letter.version}
            staff={staff}
            f={f}
          />
        </div>
      </SectionCard>
    </ApplicationShell>
  );
}

function ScheduleRow({
  row,
  f,
}: {
  readonly row: NonNullable<Awaited<ReturnType<typeof getApplication>>>['offers'][number]['schedule']['rows'][number];
  readonly f: Formatters;
}): ReactElement {
  return (
    <tr className="border-t border-line">
      <td className="py-2.5 ps-5 pe-3 tabular-nums text-ink-quiet">
        {f.n(row.number)}
        {row.grace ? (
          <span className="ms-1.5 rounded-full bg-attention-wash px-1.5 text-[10px] font-semibold text-attention">
            {f.t('grace', 'سماح')}
          </span>
        ) : null}
      </td>
      <td className="whitespace-nowrap py-2.5 pe-3 text-ink">
        <bdi>{f.isoDate(row.dueDate)}</bdi>
      </td>
      <td className="hidden py-2.5 pe-3 text-end tabular-nums text-ink-quiet md:table-cell">
        <bdi>{f.money(row.openingBalance.minorUnits)}</bdi>
      </td>
      <td className="py-2.5 pe-3 text-end tabular-nums text-ink">
        <bdi>{f.money(row.principal.minorUnits)}</bdi>
      </td>
      <td className="py-2.5 pe-3 text-end tabular-nums text-ink">
        <bdi>{f.money(row.interest.minorUnits)}</bdi>
      </td>
      <td className="py-2.5 pe-3 text-end font-semibold tabular-nums text-heading">
        <bdi>{f.money(row.instalment.minorUnits)}</bdi>
      </td>
      <td className="hidden py-2.5 pe-5 text-end tabular-nums text-ink-quiet md:table-cell">
        <bdi>{f.money(row.closingBalance.minorUnits)}</bdi>
      </td>
    </tr>
  );
}

/** The SMS exactly as sent: an Arabic line, then an English line, each in its own direction. */
function SmsPreview({
  sms,
  f,
}: {
  readonly sms: { readonly to: string; readonly body: string } | undefined;
  readonly f: Formatters;
}): ReactElement | null {
  if (sms === undefined) return null;
  return (
    <div className="min-w-0 rounded-tile border border-line" data-preview="sms">
      <p className="border-b border-line bg-sunken px-3 py-2 text-[12px] text-ink-quiet">
        {f.t('SMS to', 'رسالة نصية إلى')} <Id>{sms.to}</Id>
      </p>
      <div className="flex flex-col gap-2 p-3">
        {sms.body.split('\n').map((line, i) => (
          <p
            key={`${String(i)}-${line.slice(0, 8)}`}
            dir={i === 0 ? 'rtl' : 'ltr'}
            lang={i === 0 ? 'ar' : 'en'}
            className="rounded-tile bg-brand-wash px-3 py-2 text-[13px] text-ink"
          >
            <span className="mb-1 block text-[11px] font-semibold text-brand-deep">
              {i === 0 ? 'العربية' : 'English'}
            </span>
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * The email exactly as sent, in two parts: the English body and the Arabic
 * summary the email ends with. An Arabic screen shows the Arabic summary
 * first and says that the sent email carries it after the English.
 */
function EmailPreview({
  email,
  f,
}: {
  readonly email: { readonly to: string; readonly subject: string; readonly body: string };
  readonly f: Formatters;
}): ReactElement {
  const parts = splitOfferEmail(email.body);
  const english = (
    <pre
      key="en"
      lang="en"
      dir="ltr"
      className="whitespace-pre-wrap break-words px-3 py-3 font-[inherit] text-[13px] leading-relaxed text-ink"
    >
      {parts.english}
    </pre>
  );
  const arabic =
    parts.arabic === undefined ? null : (
      <div key="ar" lang="ar" dir="rtl" className="border-line px-3 py-3">
        <p className="mb-1 text-[11px] font-semibold text-brand-deep">الملخص العربي</p>
        <pre className="whitespace-pre-wrap break-words font-[inherit] text-[13px] leading-relaxed text-ink">
          {parts.arabic}
        </pre>
      </div>
    );
  return (
    <div className="min-w-0 rounded-tile border border-line" data-preview="email">
      <p className="border-b border-line bg-sunken px-3 py-2 text-[12px] text-ink-quiet">
        {f.t('Email to', 'بريد إلكتروني إلى')} <Id>{email.to}</Id>
      </p>
      <p className="border-b border-line px-3 py-2 text-[13px] font-semibold text-heading" dir="auto">
        {email.subject}
      </p>
      {f.arabic && arabic !== null ? (
        <>
          {arabic}
          <p className="border-t border-line bg-sunken px-3 py-1.5 text-[11px] text-ink-quiet">
            النص الإنجليزي — يأتي أولاً في البريد المرسل، يليه الملخص العربي أعلاه.
          </p>
          {english}
        </>
      ) : (
        <>
          {english}
          {arabic === null ? null : <div className="border-t border-line">{arabic}</div>}
        </>
      )}
    </div>
  );
}

function ActionItem({
  n,
  title,
  body,
}: {
  readonly n: string;
  readonly title: string;
  readonly body: ReactNode;
}): ReactElement {
  return (
    <li className="flex min-w-0 gap-3 rounded-tile border border-line bg-sunken px-4 py-3">
      <span
        aria-hidden
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-[12px] font-bold text-white"
      >
        {n}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[14px] font-semibold text-heading">{title}</span>
        <span className="break-words text-[12px] text-ink-quiet">{body}</span>
      </span>
    </li>
  );
}

/** The letter as built: English and Arabic side by side, each in its own direction. Gregorian dates (the AE profile's contractual calendar). */
function LetterPreview({ letter }: { readonly letter: OfferLetter }): ReactElement {
  const column = (lang: 'en' | 'ar') => {
    const pick = (b: { readonly en: string; readonly ar: string }) => b[lang];
    return (
      <article
        lang={lang}
        dir={lang === 'ar' ? 'rtl' : 'ltr'}
        className="min-w-0 rounded-tile border border-line bg-surface p-4 text-[13px] leading-relaxed text-ink"
      >
        <h3 className="text-[16px] font-bold text-heading">{pick(letter.title)}</h3>
        <p className="mt-1 text-[12px] text-ink-quiet">
          <Id>{letter.reference}</Id> · {pick(letter.offerDate.gregorian)}
        </p>
        <dl className="mt-3 grid gap-1">
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-quiet">{lang === 'ar' ? 'المُقرض:' : 'Lender:'}</dt>
            <dd className="font-medium">{pick(letter.parties.lender)}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-quiet">{lang === 'ar' ? 'المقترض:' : 'Borrower:'}</dt>
            <dd className="font-medium">{pick(letter.parties.borrower)}</dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-ink-quiet">{lang === 'ar' ? 'المنتج:' : 'Product:'}</dt>
            <dd className="font-medium">{pick(letter.productVariant)}</dd>
          </div>
        </dl>
        <h4 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-quiet">
          {lang === 'ar' ? 'شروط التمويل' : 'Facility terms'}
        </h4>
        <dl className="mt-1 divide-y divide-line">
          {letter.terms.map((r) => (
            <div key={r.code} className="flex flex-wrap justify-between gap-x-3 py-1.5">
              <dt className="text-ink-quiet">{pick(r.label)}</dt>
              <dd className="font-medium">{pick(r.value)}</dd>
            </div>
          ))}
        </dl>
        <h4 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-quiet">
          {lang === 'ar' ? 'ملخص السداد' : 'Repayment'}
        </h4>
        <dl className="mt-1 divide-y divide-line">
          {letter.repayment.map((r) => (
            <div key={r.code} className="flex flex-wrap justify-between gap-x-3 py-1.5">
              <dt className="text-ink-quiet">{pick(r.label)}</dt>
              <dd className="font-medium">{pick(r.value)}</dd>
            </div>
          ))}
        </dl>
        {letter.conditions.length === 0 ? null : (
          <>
            <h4 className="mt-4 text-[12px] font-semibold uppercase tracking-wide text-ink-quiet">
              {lang === 'ar' ? 'الشروط المسبقة' : 'Conditions precedent'}
            </h4>
            <ul className="mt-1 list-disc ps-5">
              {letter.conditions.map((c, i) => (
                <li key={i}>{pick(c)}</li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-4 text-[12px] text-ink-quiet">{pick(letter.validity)}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {letter.signatures.map((s) => (
            <div key={s.party} className="rounded-tile border border-dashed border-line-strong px-3 py-2">
              <p className="text-[12px] font-semibold text-heading">{pick(s.partyName)}</p>
              <p className="text-[11px] text-ink-quiet">{pick(s.role)}</p>
            </div>
          ))}
        </div>
      </article>
    );
  };
  return (
    <div className="mt-3 flex flex-col gap-3">
      {/* The letter is bilingual, so is its version line; the hash is isolated so its hyphens and full stop keep their place in either direction. */}
      <p className="flex flex-wrap items-baseline gap-x-2 text-[12px] text-ink-quiet" data-letter-version>
        <span lang="ar" dir="rtl">
          الإصدار (بصمة <bdi dir="ltr">SHA-256</bdi>)
        </span>
        <span aria-hidden>·</span>
        <span lang="en" dir="ltr">
          Version (SHA-256)
        </span>
        <Id className="break-all text-ink">{letter.version}</Id>
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        {column('en')}
        {column('ar')}
      </div>
    </div>
  );
}

function NextStep({
  segment,
  view,
  letterVersion,
  latestVersion,
  staff,
  f,
}: {
  readonly segment: string;
  readonly view: NonNullable<Awaited<ReturnType<typeof getApplication>>>;
  readonly letterVersion: string | undefined;
  readonly latestVersion: string | undefined;
  readonly staff: StaffPrincipal;
  readonly f: Formatters;
}): ReactElement {
  const { t } = f;
  const a = view.application;
  const ctx = <FormContext segment={segment} applicationId={a.applicationId} screen="offer" />;
  switch (a.status) {
    case 'APPROVED':
      return (
        <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
          <form action={sendOfferAction} className="flex flex-wrap items-center justify-between gap-3">
            {ctx}
            <p className="text-[13px] text-ink-quiet">
              {t('Sent by the officer who is signed in', 'يرسله الموظف الذي سجّل الدخول')} (<Id>{staff.principalId}</Id>
              ).{' '}
              {t(
                'The applicant receives the letter to sign through UAE Pass. The letter goes by reference; the PDF arrives when the document platform is licensed.',
                'يستلم العميل الخطاب للتوقيع عبر الهوية الرقمية. يُرسل الخطاب بمرجعه؛ ويصل ملف PDF عند ترخيص منصة المستندات.',
              )}
            </p>
            <button type="submit" className={BTN_PRIMARY}>
              {t(SEND_LABEL.en, SEND_LABEL.ar)}
            </button>
          </form>
        </Gate>
      );
    case 'OFFER_SENT': {
      // A sent version is sent once; a resend needs a new version. A newer, unsent version is offered for sending here.
      const unsent = latestVersion !== undefined && latestVersion !== letterVersion;
      return (
        <div className="flex flex-col gap-4">
          <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
            <form action={recordSignedAction} className="flex flex-wrap items-center justify-between gap-3">
              {ctx}
              <input type="hidden" name="letterVersion" value={letterVersion ?? ''} />
              <p className="text-[13px] text-ink-quiet">
                {t(
                  'Waiting for the applicant’s signature. This records the UAE Pass signing callback (fixture) on the letter version that was sent — and no other.',
                  'بانتظار توقيع العميل. يسجّل هذا إشعار التوقيع من الهوية الرقمية (تجريبي) على إصدار الخطاب المرسل — ولا غيره.',
                )}
              </p>
              <button type="submit" className={BTN_PRIMARY}>
                {t('Record signature', 'تسجيل التوقيع')}
              </button>
            </form>
          </Gate>
          {unsent ? (
            <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
              <form
                action={sendOfferAction}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4"
                data-send-new-version
              >
                {ctx}
                <p className="text-[13px] text-ink-quiet">
                  {t(
                    'A newer letter version has been generated and not sent. Sending it replaces the sent version as the one to sign.',
                    'أُعدّ إصدار أحدث من الخطاب ولم يُرسل بعد. إرساله يجعله الإصدار المعتمد للتوقيع بدلاً من الإصدار المرسل.',
                  )}
                </p>
                <button type="submit" className={BTN_SECONDARY}>
                  {t('Send the new version', 'إرسال الإصدار الجديد')}
                </button>
              </form>
            </Gate>
          ) : (
            <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
              <form
                action={generateOfferAction}
                className="flex flex-wrap items-end gap-3 border-t border-line pt-4"
                data-generate-new-version
              >
                {ctx}
                <p className="w-full text-[13px] text-ink-quiet">
                  {t(
                    'Sending the same version again sends nothing: to resend the offer, generate a new version, then send it. The letter is re-quoted as of today; a letter identical to the sent one is the same version, so change a date if nothing else has changed.',
                    'إعادة إرسال الإصدار نفسه لا ترسل شيئاً: لإعادة إرسال العرض أعدّ إصداراً جديداً ثم أرسله. يُعاد تسعير الخطاب بتاريخ اليوم؛ والخطاب المطابق للمرسل هو الإصدار نفسه، فغيّر تاريخاً إن لم يتغير شيء آخر.',
                  )}
                </p>
                <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
                  {t('Disbursement date', 'تاريخ الصرف')}
                  <input type="date" name="disbursementDate" className={INPUT} />
                </label>
                <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
                  {t('First due date', 'تاريخ أول قسط')}
                  <input type="date" name="firstDueDate" className={INPUT} />
                </label>
                <button type="submit" className={BTN_SECONDARY}>
                  {t('Generate a new version', 'إعداد إصدار جديد')}
                </button>
              </form>
            </Gate>
          )}
        </div>
      );
    }
    case 'SIGNED':
      return (
        <Gate staff={staff} act="BUSINESS_DISBURSE" arabic={f.arabic} ownWork={a.submittedBy === staff.principalId}>
          <form action={recordDisbursedAction} className="flex flex-wrap items-center justify-between gap-3">
            {ctx}
            <p className="text-[13px] text-ink-quiet" data-releases-disbursement>
              {t(
                `Signed${a.signature === undefined ? '' : ` on ${f.epochDate(a.signature.atEpochSeconds)}`}. A finance user — you are`,
                `وُقّع${a.signature === undefined ? '' : ` بتاريخ ${f.epochDate(a.signature.atEpochSeconds)}`}. يُطلق موظف المالية — وأنت`,
              )}{' '}
              <Id>{staff.principalId}</Id> —{' '}
              {t(
                'releases the payment — not the approver and not the submitting officer; the partner bank’s confirmation is a fixture reference.',
                'الدفعة — لا المعتمِد ولا الموظف الذي أحال الطلب؛ تأكيد البنك الشريك مرجع تجريبي.',
              )}
            </p>
            <button type="submit" className={BTN_PRIMARY}>
              {t('Release disbursement as finance', 'إطلاق الصرف بصفة المالية')}
            </button>
          </form>
        </Gate>
      );
    case 'DISBURSED':
      return (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-ink">
            {t(
              `Disbursed${a.disbursement === undefined ? '' : ` on ${f.epochDate(a.disbursement.atEpochSeconds)}`} — handed to the loan system (stage 8).`,
              `صُرف${a.disbursement === undefined ? '' : ` بتاريخ ${f.epochDate(a.disbursement.atEpochSeconds)}`} — سُلّم إلى نظام القروض (المرحلة ${f.n(8)}).`,
            )}
            {a.disbursement === undefined ? null : (
              <Id className="ms-2 text-[12px] text-ink-quiet">{a.disbursement.paymentRef}</Id>
            )}
          </p>
          {view.portfolio === undefined ? null : (
            <p className="text-[13px] text-ink">
              {view.portfolio.daysPastDue > 0 ? (
                <Chip tone="bad">
                  {t(
                    `Collections · ${f.n(view.portfolio.daysPastDue)} days past due · arrears ${f.money(view.portfolio.arrears.minorUnits)} ${f.cur}`,
                    `التحصيل · متأخر ${f.n(view.portfolio.daysPastDue)} يوماً · متأخرات ${f.money(view.portfolio.arrears.minorUnits)} ${f.cur}`,
                  )}
                </Chip>
              ) : (
                <Chip tone="good">{t('Performing', 'منتظم')}</Chip>
              )}
            </p>
          )}
          <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
            <form action={recordPortfolioStatusAction} className="flex flex-wrap items-end gap-3">
              {ctx}
              <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
                {t('Days past due', 'أيام التأخر')}
                <input
                  name="daysPastDue"
                  required
                  inputMode="numeric"
                  defaultValue={view.portfolio?.daysPastDue ?? 0}
                  className={`${INPUT} w-[120px]`}
                />
              </label>
              <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
                {t(`Arrears (${f.cur})`, `المتأخرات (${f.cur})`)}
                <input name="arrears" inputMode="decimal" placeholder="0.00" className={`${INPUT} w-[160px]`} />
              </label>
              <button type="submit" className={BTN_SECONDARY}>
                {t('Record loan-system status', 'تسجيل حالة نظام القروض')}
              </button>
            </form>
          </Gate>
        </div>
      );
    default:
      return (
        <DisabledAction
          label={t(SEND_LABEL.en, SEND_LABEL.ar)}
          reason={t('Available once the application is approved.', 'متاح بعد اعتماد الطلب.')}
        />
      );
  }
}
