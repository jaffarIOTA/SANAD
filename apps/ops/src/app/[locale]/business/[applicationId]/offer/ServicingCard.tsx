/**
 * Servicing (S1): where a disbursed facility stands against its signed
 * schedule — each instalment paid, part-paid, due or overdue; arrears, days
 * past due and what is still owed — from confirmed receipts only. A manual
 * receipt is recorded by finance and counts once a second person confirms it.
 * The loan system's last reported status is set beside Sanad's; a difference
 * is flagged, never overwritten. The card computes nothing.
 */
import type { ReactElement } from 'react';

import { delinquencyBucket } from '@sanad/core/servicing/instalment-position.ts';

import {
  confirmRepaymentAction,
  presentCollectionsAction,
  recordFixtureCollectionResultAction,
  recordRepaymentAction,
  reportToBureauAction,
} from '../../../../../server/business-actions.ts';
import type { getApplication } from '../../../../../server/business.ts';
import type { StaffPrincipal } from '../../../../../server/staff.ts';
import { Gate } from '../../../Gate.tsx';
import { BTN_SMALL, Chip, Field, FormContext, type Formatters, INPUT, Id, SectionCard, TH, TH_END } from '../../ui.tsx';

type View = NonNullable<Awaited<ReturnType<typeof getApplication>>>;

const STATE: Readonly<
  Record<string, { readonly en: string; readonly ar: string; readonly tone: 'good' | 'warn' | 'bad' | 'neutral' }>
> = {
  PAID: { en: 'Paid', ar: 'مدفوع', tone: 'good' },
  PART_PAID: { en: 'Part paid', ar: 'مدفوع جزئياً', tone: 'warn' },
  DUE: { en: 'Due today', ar: 'مستحق اليوم', tone: 'warn' },
  OVERDUE: { en: 'Overdue', ar: 'متأخر', tone: 'bad' },
  FUTURE: { en: 'Not yet due', ar: 'لم يستحق بعد', tone: 'neutral' },
};

const CHANNEL: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  MANUAL: { en: 'Manual', ar: 'يدوي' },
  SADAD: { en: 'SADAD', ar: 'سداد' },
  PARTNER_BANK: { en: 'Partner bank', ar: 'البنك الشريك' },
  PAYMENTS_HUB: { en: 'Payments hub', ar: 'منصة المدفوعات' },
};

export function ServicingCard({
  segment,
  view,
  staff,
  f,
  fixtureResults,
}: {
  readonly segment: string;
  readonly view: View;
  readonly staff: StaffPrincipal;
  readonly f: Formatters;
  /** On the synthetic site, where no channel is connected, finance may record a collection result marked Fixture. */
  readonly fixtureResults: boolean;
}): ReactElement | null {
  const s = view.servicing;
  if (s === undefined) return null;
  const { t } = f;
  const p = s.position;
  const amount = (minor: bigint) => (
    <>
      <bdi className="tabular-nums">{f.money(minor)}</bdi>{' '}
      <span className="text-[12px] font-normal text-ink-quiet">{f.cur}</span>
    </>
  );
  const bucket = delinquencyBucket(p.daysPastDue);
  const ctx = <FormContext segment={segment} applicationId={view.application.applicationId} screen="offer" />;
  return (
    <SectionCard
      id="servicing"
      title={t('Servicing', 'خدمة التمويل')}
      note={t(
        'Against the signed schedule, from confirmed receipts, as of today. Oldest instalment first; within an instalment, the charge before principal.',
        'مقابل الجدول الموقّع، من المبالغ المؤكدة، حتى اليوم. يُسدَّد الأقدم أولاً، وفي كل قسط العائد قبل الأصل.',
      )}
      aside={
        <Chip tone={p.daysPastDue > 0 ? 'bad' : 'good'}>
          {p.daysPastDue > 0
            ? t(`${f.n(p.daysPastDue)} days past due (${bucket})`, `متأخر ${f.n(p.daysPastDue)} يوماً (${bucket})`)
            : t('Current', 'منتظم')}
        </Chip>
      }
    >
      <dl className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-servicing-position>
        <Field label={t('Arrears', 'المتأخرات')}>{amount(p.arrears.minorUnits)}</Field>
        <Field label={t('Paid to date', 'المدفوع حتى الآن')}>{amount(p.totalPaid.minorUnits)}</Field>
        <Field label={t('Principal outstanding', 'الأصل القائم')}>{amount(p.outstandingPrincipal.minorUnits)}</Field>
        <Field label={t('Next instalment', 'القسط التالي')}>
          {p.nextDue === undefined ? (
            t('Repaid in full', 'مسدّد بالكامل')
          ) : (
            <span>
              {f.isoDate(p.nextDue.dueDate)} · {amount(p.nextDue.outstanding.minorUnits)}
            </span>
          )}
        </Field>
      </dl>

      {s.reconciliation === undefined ? null : (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-[13px]" data-servicing-reconciliation>
          <Chip tone={s.reconciliation.matches ? 'good' : 'bad'}>
            {s.reconciliation.matches
              ? t('Agrees with the loan system', 'يتطابق مع نظام القروض')
              : t('Differs from the loan system', 'يختلف عن نظام القروض')}
          </Chip>
          <span className="text-ink-quiet">
            {t(
              `Loan system: ${f.n(s.reconciliation.loanSystemDaysPastDue)} days past due; Sanad: ${f.n(s.reconciliation.sanadDaysPastDue)}.`,
              `نظام القروض: ${f.n(s.reconciliation.loanSystemDaysPastDue)} يوماً؛ سند: ${f.n(s.reconciliation.sanadDaysPastDue)}.`,
            )}
          </span>
        </p>
      )}

      <div className="mb-5 max-h-[360px] overflow-auto rounded-tile border border-line">
        <table className="w-full min-w-[560px] border-collapse text-[13px]" data-servicing-instalments>
          <thead>
            <tr>
              <th className={TH}>#</th>
              <th className={TH}>{t('Due', 'الاستحقاق')}</th>
              <th className={TH_END}>{t('Instalment', 'القسط')}</th>
              <th className={TH_END}>{t('Paid', 'المدفوع')}</th>
              <th className={TH_END}>{t('Status', 'الحالة')}</th>
            </tr>
          </thead>
          <tbody>
            {p.instalments.map((i) => {
              const st = STATE[i.state] ?? { en: i.state, ar: i.state, tone: 'neutral' as const };
              return (
                <tr key={i.number} className="border-t border-line">
                  <td className="py-1.5 pe-3 ps-3 tabular-nums">{f.n(i.number)}</td>
                  <td className="py-1.5 pe-3">{f.isoDate(i.dueDate)}</td>
                  <td className="py-1.5 pe-3 text-end">{amount(i.amount.minorUnits)}</td>
                  <td className="py-1.5 pe-3 text-end">{amount(i.paid.minorUnits)}</td>
                  <td className="py-1.5 pe-3 text-end">
                    <Chip tone={st.tone}>{t(st.en, st.ar)}</Chip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet">{t('Collections', 'التحصيل')}</h3>
      {s.collections.length === 0 ? (
        <p className="mb-3 text-[13px] text-ink-quiet">{t('Nothing presented yet.', 'لم يُقدَّم شيء بعد.')}</p>
      ) : (
        <ul className="mb-3 flex list-none flex-col divide-y divide-line rounded-tile border border-line p-0" data-servicing-collections>
          {s.collections.map((c) => (
            <li key={c.idempotencyKey} className="flex flex-wrap items-center gap-3 px-4 py-2 text-[13px]">
              <span className="tabular-nums">
                {t('Instalment', 'القسط')} {f.n(c.instalmentNumber)}
              </span>
              <span>{f.isoDate(c.dueDate)}</span>
              <span className="font-medium text-heading">{amount(c.amount.minorUnits)}</span>
              <span className="text-ink-quiet">{t(CHANNEL[c.channel]?.en ?? c.channel, CHANNEL[c.channel]?.ar ?? c.channel)}</span>
              <Chip tone={c.result === 'PAID' ? 'good' : c.result === 'RETURNED' ? 'bad' : 'warn'}>
                {c.result === 'PAID' ? t('Paid', 'مدفوع') : c.result === 'RETURNED' ? t('Returned', 'مرتجع') : t('Awaiting the channel', 'بانتظار القناة')}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      <Gate staff={staff} act="BUSINESS_DISBURSE" arabic={f.arabic}>
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <form action={presentCollectionsAction}>
            {ctx}
            <button type="submit" className={BTN_SMALL}>
              {t('Present due instalments for collection', 'تقديم الأقساط المستحقة للتحصيل')}
            </button>
          </form>
          <form action={reportToBureauAction}>
            {ctx}
            <button type="submit" className={BTN_SMALL}>
              {t('Report this month to the bureau', 'إبلاغ المكتب الائتماني بحالة هذا الشهر')}
            </button>
          </form>
          {fixtureResults && s.collections.some((c) => c.result === undefined)
            ? (['PAID', 'RETURNED'] as const).map((st) => (
                <form key={st} action={recordFixtureCollectionResultAction}>
                  {ctx}
                  <input type="hidden" name="status" value={st} />
                  <button type="submit" className={BTN_SMALL} data-fixture-collection>
                    {st === 'PAID' ? t('Fixture: paid', 'تجريبي: مدفوع') : t('Fixture: returned', 'تجريبي: مرتجع')}
                  </button>
                </form>
              ))
            : null}
        </div>
      </Gate>

      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet">
        {t('Receipts', 'المبالغ المستلمة')}
      </h3>
      {s.repayments.length === 0 ? (
        <p className="mb-4 text-[13px] text-ink-quiet">{t('None yet.', 'لا يوجد بعد.')}</p>
      ) : (
        <ul
          className="mb-4 flex list-none flex-col divide-y divide-line rounded-tile border border-line p-0"
          data-servicing-receipts
        >
          {s.repayments.map((rp) => (
            <li key={rp.repaymentId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
              <Id>{rp.repaymentId}</Id>
              <span>{f.isoDate(rp.receivedOn)}</span>
              <span className="font-medium text-heading">{amount(rp.amount.minorUnits)}</span>
              <span className="text-ink-quiet">
                {t(CHANNEL[rp.channel]?.en ?? rp.channel, CHANNEL[rp.channel]?.ar ?? rp.channel)}
              </span>
              <Id className="text-[11px] text-ink-quiet">{rp.reference}</Id>
              {rp.confirmedBy !== undefined ? (
                <Chip tone="good">{t('Counted', 'محتسب')}</Chip>
              ) : (
                <Gate
                  staff={staff}
                  act="BUSINESS_VERIFY"
                  arabic={f.arabic}
                  ownWork={rp.recordedBy === staff.principalId}
                >
                  <form action={confirmRepaymentAction}>
                    {ctx}
                    <input type="hidden" name="repaymentId" value={rp.repaymentId} />
                    <button type="submit" className={BTN_SMALL}>
                      {t('Confirm against the statement', 'تأكيد مقابل الكشف')}
                    </button>
                  </form>
                </Gate>
              )}
            </li>
          ))}
        </ul>
      )}
      <Gate staff={staff} act="BUSINESS_DISBURSE" arabic={f.arabic}>
        <details className="rounded-tile border border-line p-4" data-record-repayment>
          <summary className="cursor-pointer select-none text-[14px] font-semibold text-heading">
            {t('Record a receipt seen on the bank statement', 'تسجيل مبلغ ظاهر في كشف البنك')}
          </summary>
          <form action={recordRepaymentAction} className="mt-3 grid gap-3 sm:grid-cols-3">
            {ctx}
            <label className="grid gap-1 text-[13px]">
              {t(`Amount (${f.cur})`, `المبلغ (${f.cur})`)}
              <input name="amount" required inputMode="decimal" dir="ltr" className={INPUT} />
            </label>
            <label className="grid gap-1 text-[13px]">
              {t('Value date', 'تاريخ القيمة')}
              <input name="receivedOn" type="date" required dir="ltr" className={INPUT} />
            </label>
            <label className="grid gap-1 text-[13px]">
              {t('Bank reference', 'مرجع البنك')}
              <input name="reference" required dir="ltr" className={INPUT} />
            </label>
            <button type="submit" className={`${BTN_SMALL} sm:col-span-3 sm:justify-self-start`}>
              {t('Record receipt', 'تسجيل المبلغ')}
            </button>
          </form>
        </details>
      </Gate>
    </SectionCard>
  );
}
