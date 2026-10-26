/**
 * The Shariah compliance report for the Board (Wasl W6c; BR-F08): a period's
 * transactions, the time goods were held at the institution's risk before
 * each sale, incidents by severity and age, template drift, charity and
 * purification, and the approvals register — for the Board's meeting and its
 * annual Shariah report. Printable as it stands; downloadable as JSON for the
 * institution's own report format. Read-only.
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { TenantCode } from '@sanad/config/loader.ts';
import { INCIDENT_SEVERITIES } from '@sanad/core/shariah/incidents.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_INPUT } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { civilDateOf } from '@sanad/origination/civil-date.ts';
import { hostClockInstant } from '@sanad/origination/host-clock.ts';
import { boardReport } from '@sanad/origination/wasl/audit.ts';

import { permits, refusalWording } from '../../../../server/authority.ts';
import { pageStaff } from '../../../../server/session.ts';
import { STATE_LABEL } from '../../transactions/states.ts';
import { SEVERITY, type Words } from '../words.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const STANDING: Readonly<Record<string, Words>> = {
  IN_FORCE: { en: 'In force', ar: 'ساري' },
  NOT_YET_EFFECTIVE: { en: 'Not yet effective', ar: 'لم يسرِ بعد' },
  LAPSED: { en: 'Lapsed', ar: 'منقضٍ' },
  SUSPENDED: { en: 'Suspended', ar: 'موقوف' },
  WITHDRAWN: { en: 'Withdrawn', ar: 'مسحوب' },
};

export default async function BoardReportPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly from?: string; readonly to?: string }>;
}): Promise<ReactElement> {
  const { locale: segment } = await params;
  const q = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const w = (words: Words): string => (arabic ? words.ar : words.en);
  const staff = await pageStaff(segment);
  if (staff.tenantId === undefined) notFound();
  const tenant = staff.tenantId as TenantCode;
  const allowed = permits(staff, 'SHARIAH_AUDIT_READ');
  if (!allowed.allowed) return <p className="text-[14px] text-ink-quiet">{refusalWording(allowed.needs, arabic)}</p>;

  const today = civilDateOf(tenant, hostClockInstant());
  const to = q.to !== undefined && DATE.test(q.to) ? q.to : today;
  const from = q.from !== undefined && DATE.test(q.from) ? q.from : `${to.slice(0, 4)}-01-01`;
  const r = await boardReport(tenant, from, to);
  const numerals = defaultNumerals(locale);
  const amount = (minorUnits: bigint) => (
    <bdi className="tabular-nums">
      {formatMinorUnits({ minorUnits, currency: r.charity.currency as 'SAR' }, numerals)} {r.charity.currency}
    </bdi>
  );
  const hours = (s: bigint | undefined) =>
    s === undefined
      ? '—'
      : t(
          `${String(s / 3600n)} h ${String((s % 3600n) / 60n)} min`,
          `${String(s / 3600n)} س ${String((s % 3600n) / 60n)} د`,
        );
  const tile = (label: string, value: ReactElement | string, tone?: 'blocked' | 'positive') => (
    <div className="rounded-card border border-line bg-surface px-4 py-3 shadow-card">
      <div className="text-[12px] text-ink-quiet">{label}</div>
      <div
        className={`mt-1 text-[18px] font-semibold ${tone === 'blocked' ? 'text-blocked' : tone === 'positive' ? 'text-positive' : 'text-heading'}`}
      >
        {value}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6" data-board-report>
      <div>
        <h1 className="text-display font-bold tracking-tight text-heading">
          {t('Shariah compliance report for the Board', 'تقرير الالتزام الشرعي للهيئة')}
        </h1>
        <p className="mt-1 text-[14px] text-ink-quiet">
          <bdi className="identifier">{r.from}</bdi> → <bdi className="identifier">{r.to}</bdi>
        </p>
      </div>

      <form className="flex flex-wrap items-end gap-3 print:hidden" data-report-period>
        <label className="grid gap-1 text-[13px]">
          {t('From', 'من')}
          <input type="date" name="from" defaultValue={from} className={FIELD_INPUT} dir="ltr" />
        </label>
        <label className="grid gap-1 text-[13px]">
          {t('To', 'إلى')}
          <input type="date" name="to" defaultValue={to} className={FIELD_INPUT} dir="ltr" />
        </label>
        <button type="submit" className={BUTTON_PRIMARY}>
          {t('Show the period', 'عرض الفترة')}
        </button>
        <a
          href={`/${segment}/shariah/report/export?from=${from}&to=${to}`}
          className={BUTTON_SECONDARY}
          download
          data-report-export
        >
          {t('Download (JSON)', 'تنزيل (JSON)')}
        </a>
      </form>

      <section className="grid gap-3 sm:grid-cols-4" data-report-transactions>
        {tile(t('Transactions opened', 'المعاملات المفتوحة'), String(r.transactions.opened))}
        {tile(t('Sales executed', 'البيوع المنفّذة'), String(r.transactions.executed))}
        {tile(t('Sales offered', 'عروض البيع'), String(r.riskPeriod.salesOffered))}
        {tile(
          t('Sold before the risk period ran', 'بيعت قبل انقضاء مدة الضمان'),
          String(r.riskPeriod.heldBelowRequired),
          r.riskPeriod.heldBelowRequired === 0 ? 'positive' : 'blocked',
        )}
      </section>

      <section
        className="rounded-card border border-line bg-surface px-5 py-4 text-[13px] shadow-card"
        data-report-risk
      >
        <h2 className="mb-2 text-[15px] font-semibold text-heading">
          {t(
            'Time the goods were held at the institution’s risk before the sale',
            'مدة بقاء البضاعة في ضمان المؤسسة قبل البيع',
          )}
        </h2>
        <p>
          {t('Shortest', 'الأقصر')} {hours(r.riskPeriod.shortestHeldSeconds)} · {t('median', 'الوسيط')}{' '}
          {hours(r.riskPeriod.medianHeldSeconds)}
        </p>
        <p className="mt-2 text-ink-quiet">
          {t('Every transaction in the book, by where it stands:', 'كل معاملات المحفظة حسب وضعها:')}{' '}
          {Object.entries(r.transactions.byState)
            .map(([s, n]) => `${w(STATE_LABEL[s] ?? { en: s, ar: s })} ${String(n)}`)
            .join(' · ')}
        </p>
      </section>

      <section
        className="overflow-x-auto rounded-card border border-line bg-surface px-5 py-4 text-[13px] shadow-card"
        data-report-incidents
      >
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Shariah incidents', 'المخالفات الشرعية')}</h2>
        <table className="w-full">
          <thead>
            <tr className="text-ink-quiet">
              <th className="py-1 text-start font-normal">{t('Severity', 'الخطورة')}</th>
              <th className="py-1 text-end font-normal">{t('Raised in the period', 'المُثارة في الفترة')}</th>
              <th className="py-1 text-end font-normal">{t('Open at its end', 'المفتوحة في نهايتها')}</th>
            </tr>
          </thead>
          <tbody>
            {[...INCIDENT_SEVERITIES].reverse().map((s) => (
              <tr key={s} className="border-t border-line">
                <td className="py-1">{w(SEVERITY[s])}</td>
                <td className="py-1 text-end">{String(r.incidents.raised[s])}</td>
                <td
                  className={`py-1 text-end ${s === 'MATERIAL' && r.incidents.openAtEnd[s] > 0 ? 'text-blocked font-semibold' : ''}`}
                >
                  {String(r.incidents.openAtEnd[s])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2">
          {t('Closed in the period', 'المغلقة في الفترة')} {String(r.incidents.closed)} ·{' '}
          {t('template drift found', 'انحراف نماذج مكتشف')} {String(r.incidents.templateDriftRaised)}
        </p>
        <p className="text-ink-quiet">
          {t('Open by age:', 'المفتوحة حسب العمر:')} {t('up to 7 days', 'حتى ٧ أيام')}{' '}
          {String(r.incidents.openByAge.upTo7)} · {t('8–30 days', '٨–٣٠ يوماً')}{' '}
          {String(r.incidents.openByAge.from8To30)} · {t('over 30 days', 'أكثر من ٣٠ يوماً')}{' '}
          {String(r.incidents.openByAge.over30)}
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-4" data-report-charity>
        {tile(t('Late amounts collected', 'مبالغ التأخير المحصّلة'), amount(r.charity.lateAmountsCollectedMinor))}
        {tile(t('Income purified', 'الدخل المطهَّر'), amount(r.charity.purifiedRaisedMinor))}
        {tile(t('Given to charity', 'المصروف للجهات الخيرية'), amount(r.charity.disbursedMinor))}
        {tile(t('Held for charity at the end', 'المحتجز للتبرع في النهاية'), amount(r.charity.heldAtEndMinor))}
      </section>

      <section
        className="overflow-x-auto rounded-card border border-line bg-surface px-5 py-4 text-[13px] shadow-card"
        data-report-approvals
      >
        <h2 className="mb-2 text-[15px] font-semibold text-heading">
          {t('The approvals register at the period’s end', 'سجل الاعتمادات في نهاية الفترة')}
        </h2>
        {r.approvals.length === 0 ? (
          <p className="text-ink-quiet">{t('No approval was recorded.', 'لم يُقيَّد أي اعتماد.')}</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="text-ink-quiet">
                <th className="py-1 text-start font-normal">{t('Reference', 'المرجع')}</th>
                <th className="py-1 text-start font-normal">{t('Products', 'المنتجات')}</th>
                <th className="py-1 text-start font-normal">{t('Standing', 'الحالة')}</th>
                <th className="py-1 text-start font-normal">{t('Review or expiry', 'المراجعة أو الانتهاء')}</th>
                <th className="py-1 text-end font-normal">{t('Changes in the period', 'التغييرات في الفترة')}</th>
              </tr>
            </thead>
            <tbody>
              {r.approvals.map((a) => (
                <tr key={a.approvalRef} className="border-t border-line">
                  <td className="identifier py-1">{a.approvalRef}</td>
                  <td className="py-1">{a.productCodes.join(', ')}</td>
                  <td className={`py-1 ${a.standingAtEnd === 'IN_FORCE' ? 'text-positive' : 'text-blocked'}`}>
                    {w(STANDING[a.standingAtEnd] ?? { en: a.standingAtEnd, ar: a.standingAtEnd })}
                  </td>
                  <td className="identifier py-1">{a.reviewOrExpiry ?? '—'}</td>
                  <td className="py-1 text-end">{String(a.changesInPeriod)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
