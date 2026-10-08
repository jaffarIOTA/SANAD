/**
 * The SME pipeline dashboard — what the dashboard route shows when the
 * deployment behaves as the UAE (ADR 0005), to the core banking partner's
 * prototype ("Pipeline — Direct Lending") in the workbench's Figma kit.
 *
 *   1. Title; '+ New application' is disabled with its reason (applications
 *      arrive from the upstream customer record at stage 5), and Export.
 *   2. The end-to-end journey: nine stages, their typical duration and the
 *      system that owns each — 1–4 upstream, 5–9 Sanad and the loan system.
 *   3. Four figures computed from the book (server/business-dashboard.ts).
 *   4. A kanban of stages 5–9, a card per open application.
 *   5. Recent activity.
 *
 * Every figure is a count or a sum of recorded amounts; every chip restates
 * what the state machine recorded. Stage targets are ILLUSTRATIVE (the
 * partner's prototype), and say so.
 */

import type { ReactElement } from 'react';

import { Icon } from '@sanad/design/icons.tsx';

import { type BusinessApplicationView, PIPELINE_STAGES, listApplications, productVariants, syncBusiness } from '../../server/business.ts';
import { type DisplayStage, SANAD_STAGES, recentActivity, statusChip, summarisePipeline, turnaroundSeconds, wholeDays } from '../../server/business-dashboard.ts';
import { developmentAttestation } from '../../server/store.ts';
import { workbenchJurisdiction } from '../../server/jurisdiction.ts';
import { Chip, type Formatters, Id, TH, TH_END, formatters, stageTitle } from './business/ui.tsx';

/** Which of an application's screens a card opens. */
export function screenHref(segment: string, v: BusinessApplicationView): string {
  const base = `/${segment}/business/${encodeURIComponent(v.application.applicationId)}`;
  if (v.displayStage === 5) return base;
  if (v.displayStage === 6 && v.application.status !== 'APPROVED') return `${base}/assessment`;
  return `${base}/offer`;
}

export async function PipelineDashboard({ segment, arabic }: { readonly segment: string; readonly arabic: boolean }): Promise<ReactElement> {
  const j = await workbenchJurisdiction();
  const f = formatters(arabic, j.currency);
  const { t } = f;
  if (j.tenant === undefined) {
    return <p className="rounded-card border border-line bg-surface p-6 text-ink-quiet">{t('No institution is onboarded under this jurisdiction yet.', 'لا توجد مؤسسة مسجلة في هذه الولاية بعد.')}</p>;
  }
  await syncBusiness(j.tenant);
  const [views, variants] = await Promise.all([listApplications(j.tenant), productVariants(j.tenant)]);
  const now = developmentAttestation().epochSeconds;
  const summary = summarisePipeline(views, now);
  const variantName = (code: string): string => { const v = variants.get(code); return v === undefined ? code : t(v.nameEn, v.nameAr); };
  const businessName = (v: BusinessApplicationView): string => (arabic ? v.application.applicant.businessNameAr ?? v.application.applicant.businessNameEn : v.application.applicant.businessNameEn);
  const average = summary.averageTurnaroundTenthsOfDay;
  const averageText = average === undefined ? '—' : f.digits(`${(average / 10n).toString()}.${(average % 10n).toString()}`);
  const onTarget = average !== undefined && average <= BigInt(summary.targetDays) * 10n;

  return (
    <div className="flex flex-col gap-6">
      {/* -- 1. Title and actions --------------------------------------------------------- */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display font-bold tracking-tight text-heading">{t('Pipeline — Direct Lending', 'مسار الطلبات — التمويل المباشر')}</h1>
          <p className="mt-1 text-[14px] text-ink-quiet">
            {t(`${f.n(summary.activeCount)} applications in origination, ${f.n(summary.portfolioCount)} in the portfolio. Amounts in ${f.cur}.`, `${f.n(summary.activeCount)} طلب قيد الإنشاء و${f.n(summary.portfolioCount)} في المحفظة. المبالغ بال${f.cur}.`)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <a href={`/${segment}/business/export`} className="press inline-flex h-10 items-center gap-2 rounded-tile border border-line-strong bg-surface px-4 text-[14px] font-semibold text-heading hover:bg-sunken">
              <Icon name="document" size={18} />{t('Export', 'تصدير')}
            </a>
            <button type="button" disabled aria-describedby="new-application-why" className="inline-flex h-10 cursor-not-allowed items-center gap-2 rounded-tile bg-sunken px-4 text-[14px] font-semibold text-ink-faint">
              + {t('New application', 'طلب جديد')}
            </button>
          </div>
          <p id="new-application-why" className="max-w-[44ch] text-end text-[12px] text-ink-quiet">{t('Applications arrive from the upstream customer record at stage 5; they are not keyed here.', f.digits('تصل الطلبات من سجل العميل في الأنظمة السابقة عند المرحلة 5؛ لا تُدخل هنا.'))}</p>
        </div>
      </div>

      {/* -- 2. The end-to-end journey ---------------------------------------------------------- */}
      <section aria-labelledby="journey-title" className="rounded-card border border-line bg-surface p-5 shadow-card">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="journey-title" className="text-[15px] font-semibold text-heading">{t('End-to-end journey', 'رحلة الطلب من البداية إلى النهاية')}</h2>
          <p className="text-[12px] text-ink-quiet">{t(`Target end-to-end turnaround ${f.n(summary.targetDays)} days · stage targets ILLUSTRATIVE (partner prototype)`, `المدة المستهدفة الإجمالية ${f.n(summary.targetDays)} يوماً · مدد المراحل توضيحية (نموذج الشريك)`)}</p>
        </div>
        <div className="mb-2 hidden gap-2 xl:grid xl:grid-cols-9">
          <p className="col-span-4 rounded-tile bg-sunken px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-quiet">{t('Upstream — government portal & core banking customer record', 'خارج سند — البوابة الحكومية وسجل العميل في النظام المصرفي')}</p>
          <p className="col-span-5 rounded-tile bg-brand-wash px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-deep">{t('Sanad & the loan system', 'سند ونظام إدارة القروض')}</p>
        </div>
        <ol className="grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3 xl:grid-cols-9">
          {PIPELINE_STAGES.map((s) => {
            const upstream = s.owner === 'UPSTREAM';
            const here = upstream ? undefined : summary.byStage[s.stage as DisplayStage].length;
            return (
              <li key={s.stage} className={`flex min-w-0 flex-col gap-1 overflow-hidden rounded-tile border px-2.5 py-2.5 ${upstream ? 'border-dashed border-line-strong bg-sunken' : 'border-line bg-surface'}`}>
                <span className="flex items-center justify-between gap-2">
                  <span className={`inline-flex size-6 items-center justify-center rounded-full text-[11px] font-bold ${upstream ? 'bg-surface text-ink-quiet' : 'bg-brand text-white'}`}>{f.n(s.stage)}</span>
                  {here === undefined ? <span className="text-[11px] text-ink-quiet">{t('Upstream', 'خارج سند')}</span> : <span className="text-[11px] font-semibold text-brand-deep">{t(`${f.n(here)} here`, `${f.n(here)} هنا`)}</span>}
                </span>
                <span className={`hyphens-auto text-[12px] font-semibold leading-snug wrap-anywhere ${upstream ? 'text-ink-quiet' : 'text-heading'}`}>{t(s.titleEn, s.titleAr)}</span>
                <span className="text-[12px] text-ink-quiet">{f.digits(t(s.targetEn, s.targetAr))}</span>
                <span className="text-[11px] text-ink-faint">{upstream ? (s.stage === 4 ? t('Gov. portal · customer record', 'البوابة الحكومية · سجل العميل') : t('Gov. portal', 'البوابة الحكومية')) : s.stage >= 8 ? t('Loan system', 'نظام القروض') : t('Sanad', 'سند')}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {/* -- 3. Four figures ---------------------------------------------------------------------- */}
      <section aria-label={t('Key figures', 'أرقام رئيسية')} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Figure label={t('Active applications', 'طلبات نشطة')} value={f.n(summary.activeCount)} sub={t(`stages 5–7 · ${f.n(summary.portfolioCount)} in portfolio`, f.digits(`المراحل 5–7 · ${f.n(summary.portfolioCount)} في المحفظة`))} tone="quiet" icon="queue" f={f} />
        <Figure label={t('Pending assessment', 'بانتظار التقييم')} value={f.n(summary.pendingAssessmentCount)}
          sub={summary.nearSlaCount > 0 ? t(`${f.n(summary.nearSlaCount)} near or past the 5-day target`, f.digits(`${f.n(summary.nearSlaCount)} قارب أو تجاوز مدة 5 أيام`)) : t('all within the 5-day target', f.digits('كلها ضمن مدة 5 أيام'))} tone={summary.breachedCount > 0 ? 'bad' : summary.nearSlaCount > 0 ? 'warn' : 'quiet'} icon="clock" f={f} />
        <Figure label={t('Approved this month', 'معتمد هذا الشهر')} value={f.n(summary.approvedThisMonthCount)}
          sub={<bdi>{t(`${f.money(summary.disbursedThisMonthMinorUnits)} ${f.cur} disbursed (${f.n(summary.disbursedThisMonthCount)})`, `صُرف ${f.money(summary.disbursedThisMonthMinorUnits)} ${f.cur} (${f.n(summary.disbursedThisMonthCount)})`)}</bdi>} tone="good" icon="check-circle" f={f} />
        <Figure label={t('Average turnaround', 'متوسط مدة الإنجاز')} value={averageText} unit={t('days', 'يوم')}
          sub={average === undefined ? t(`nothing disbursed yet · target ${f.n(summary.targetDays)} days`, `لا صرف بعد · المستهدف ${f.n(summary.targetDays)} يوماً`) : t(`vs ${f.n(summary.targetDays)}-day target · ${f.n(summary.completedCount)} disbursed, from hand-over`, `مقابل ${f.n(summary.targetDays)} يوماً · ${f.n(summary.completedCount)} مصروف، من التسليم`)}
          tone={average === undefined ? 'quiet' : onTarget ? 'good' : 'bad'} icon="gauge" f={f} />
      </section>

      {/* -- 4. Kanban of stages 5–9 ------------------------------------------------------------------ */}
      <section aria-labelledby="board-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="board-title" className="text-[17px] font-semibold text-heading">{t('Applications by stage', 'الطلبات حسب المرحلة')}</h2>
          <a href={`/${segment}/business`} className="text-[13px] font-medium text-brand hover:underline">{t('All applications', 'كل الطلبات')}</a>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {SANAD_STAGES.map((stage) => {
            const meta = PIPELINE_STAGES.find((s) => s.stage === stage);
            const cards = summary.byStage[stage];
            return (
              <div key={stage} className="flex min-w-0 flex-col gap-2 rounded-card border border-line bg-sunken p-3">
                <div className="flex items-start justify-between gap-2 px-1">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[13px] font-semibold text-heading">{f.n(stage)} · {stageTitle(stage, f)}</span>
                    <span className="text-[11px] text-ink-quiet">{meta === undefined ? '' : f.digits(t(meta.targetEn, meta.targetAr))}</span>
                  </span>
                  <span className="rounded-full bg-surface px-2 py-0.5 text-[12px] font-semibold tabular-nums text-ink-quiet">{f.n(cards.length)}</span>
                </div>
                {cards.length === 0 ? <p className="px-1 py-4 text-center text-[12px] text-ink-faint">{t('Nothing at this stage', 'لا شيء في هذه المرحلة')}</p> : cards.map((v) => <KanbanCard key={v.application.applicationId} v={v} href={screenHref(segment, v)} name={businessName(v)} variant={variantName(v.application.variantCode)} now={now} f={f} />)}
              </div>
            );
          })}
        </div>
      </section>

      {/* -- 5. Recent activity ------------------------------------------------------------------------- */}
      <section aria-labelledby="activity-title" className="rounded-card border border-line bg-surface shadow-card">
        <div className="flex items-baseline justify-between gap-2 border-b border-line px-5 py-4">
          <h2 id="activity-title" className="text-[15px] font-semibold text-heading">{t('Recent activity', 'آخر النشاطات')}</h2>
          <span className="text-[12px] text-ink-quiet">{t('Turnaround measured from hand-over at stage 5', f.digits('تُحسب المدة من التسليم في المرحلة 5'))}</span>
        </div>
        {/* `relative`: the screen-reader label in the last header cell is absolutely positioned; without a positioned ancestor it widens the page on a phone. */}
        <div className="relative overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="bg-sunken">
                <th scope="col" className={`${TH} ps-5`}>{t('Applicant', 'مقدم الطلب')}</th>
                <th scope="col" className={`${TH} hidden md:table-cell`}>{t('Product', 'المنتج')}</th>
                <th scope="col" className={TH_END}>{t(`Amount (${f.cur})`, `المبلغ (${f.cur})`)}</th>
                <th scope="col" className={`${TH} hidden lg:table-cell`}>{t('Stage', 'المرحلة')}</th>
                <th scope="col" className={TH}>{t('Status', 'الحالة')}</th>
                <th scope="col" className={`${TH_END} hidden sm:table-cell`}>{t('Turnaround (days)', 'المدة (أيام)')}</th>
                <th scope="col" className={`${TH_END} pe-5`}><span className="sr-only">{t('Action', 'إجراء')}</span></th>
              </tr>
            </thead>
            <tbody>
              {recentActivity(views).map((v) => {
                const chip = statusChip(v, now);
                return (
                  <tr key={v.application.applicationId} className="border-t border-line hover:bg-sunken/60">
                    <td className="py-3 ps-5 pe-3">
                      <span className="flex min-w-0 flex-col">
                        <span className="font-semibold text-heading">{businessName(v)}</span>
                        <Id className="text-[12px] text-ink-quiet">{v.application.applicationId}</Id>
                      </span>
                    </td>
                    <td className="hidden py-3 pe-3 text-ink md:table-cell">{variantName(v.application.variantCode)}</td>
                    <td className="py-3 pe-3 text-end font-semibold tabular-nums text-heading"><bdi>{f.money(v.application.requested.minorUnits)}</bdi></td>
                    <td className="hidden py-3 pe-3 text-ink lg:table-cell">{f.n(v.displayStage)} · {stageTitle(v.displayStage, f)}</td>
                    <td className="py-3 pe-3"><Chip tone={chip.tone}>{f.digits(t(chip.en, chip.ar))}</Chip></td>
                    <td className="hidden py-3 pe-3 text-end tabular-nums text-ink sm:table-cell">{f.n(wholeDays(turnaroundSeconds(v, now)))}</td>
                    <td className="py-3 pe-5 text-end">
                      <a href={screenHref(segment, v)} className="press inline-flex h-8 items-center gap-1 rounded-tile border border-line px-3 text-[13px] font-semibold text-heading hover:bg-sunken">{t('Open', 'فتح')}<Icon name="chevron-end" size={14} /></a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Figure({ label, value, unit, sub, tone, icon, f }: { readonly label: string; readonly value: string; readonly unit?: string; readonly sub: ReactElement | string; readonly tone: 'quiet' | 'good' | 'bad' | 'warn'; readonly icon: 'queue' | 'clock' | 'check-circle' | 'gauge'; readonly f: Formatters }): ReactElement {
  const toneClass = tone === 'bad' ? 'text-blocked font-medium' : tone === 'warn' ? 'text-attention font-medium' : tone === 'good' ? 'text-positive' : 'text-ink-quiet';
  return (
    <div className="flex min-w-0 items-start justify-between gap-3 rounded-card border border-line bg-surface px-5 py-4 shadow-card" lang={f.arabic ? 'ar' : 'en'}>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[12px] font-medium uppercase tracking-wide text-ink-quiet">{label}</span>
        <span className="mt-2 flex flex-wrap items-baseline gap-x-1.5">
          <span className="whitespace-nowrap text-[24px] font-bold leading-8 tabular-nums text-heading">{value}</span>
          {unit === undefined ? null : <span className="text-[13px] text-ink-quiet">{unit}</span>}
        </span>
        <span className={`mt-1.5 text-[12px] ${toneClass}`}>{sub}</span>
      </span>
      <Icon name={icon} size={22} className="mt-6 shrink-0 text-ink-quiet" />
    </div>
  );
}

function KanbanCard({ v, href, name, variant, now, f }: { readonly v: BusinessApplicationView; readonly href: string; readonly name: string; readonly variant: string; readonly now: bigint; readonly f: Formatters }): ReactElement {
  const chip = statusChip(v, now);
  return (
    <a href={href} className="card-lift press flex min-w-0 flex-col gap-2 rounded-tile border border-line bg-surface p-3 shadow-card hover:border-brand/40">
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-[13px] font-semibold text-heading" title={name}>{name}</span>
        <Id className="shrink-0 text-[11px] text-ink-quiet">{v.application.applicationId.slice(-4)}</Id>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-1">
        <bdi className="text-[15px] font-bold tabular-nums text-heading">{f.money(v.application.requested.minorUnits)}</bdi>
        <span className="text-[11px] text-ink-quiet">{f.cur}</span>
      </span>
      <span className="truncate text-[12px] text-ink-quiet">{variant}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Chip tone={chip.tone}>{f.digits(f.t(chip.en, chip.ar))}</Chip>
      </span>
    </a>
  );
}
