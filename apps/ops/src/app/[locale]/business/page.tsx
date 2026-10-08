/**
 * Business applications — the SME direct-lending book at stages 5–9, one row
 * per application with the one action it is waiting for. Filtered by the
 * stage it shows at; closed applications (declined, withdrawn) on their own
 * tab. The tenant is the deployment's active tenant (ADR 0005).
 */

import { notFound } from 'next/navigation';

import { Icon } from '@sanad/design/icons.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import {
  type BusinessApplicationView,
  listApplications,
  productVariants,
  syncBusiness,
} from '../../../server/business.ts';
import { statusChip } from '../../../server/business-dashboard.ts';
import { workbenchJurisdiction } from '../../../server/jurisdiction.ts';
import { developmentAttestation } from '../../../server/store.ts';
import { screenHref } from '../PipelineDashboard.tsx';
import { Chip, type Formatters, Id, TH, TH_END, formatters, stageRange, stageTitle } from './ui.tsx';

type Filter = 'all' | '5' | '6' | '7' | '8' | '9' | 'closed';
const FILTERS: readonly Filter[] = ['all', '5', '6', '7', '8', '9', 'closed'];
const CLOSED = new Set(['DECLINED', 'WITHDRAWN']);

/** What the application is waiting for, as the row's one action. */
function nextAction(v: BusinessApplicationView, f: Formatters): { readonly label: string; readonly primary: boolean } {
  switch (v.application.status) {
    case 'RECEIVED':
    case 'SPREADING':
      return { label: f.t('Verify figures', 'التحقق من الأرقام'), primary: true };
    case 'SUBMITTED':
      return { label: f.t('Run assessment', 'تشغيل التقييم'), primary: true };
    case 'ASSESSED':
      return { label: f.t('Approve', 'اعتماد'), primary: true };
    case 'IN_COMMITTEE':
      return { label: f.t('Decide', 'اتخاذ القرار'), primary: true };
    case 'APPROVED':
      return { label: f.t('Generate offer', 'إعداد العرض'), primary: true };
    case 'OFFER_SENT':
      return { label: f.t('Record signature', 'تسجيل التوقيع'), primary: true };
    case 'SIGNED':
      return { label: f.t('Disburse', 'الصرف'), primary: true };
    default:
      return { label: f.t('Open', 'فتح'), primary: false };
  }
}

export default async function BusinessListPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: segment } = await params;
  const sp = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const j = await workbenchJurisdiction(typeof sp['tenant'] === 'string' ? sp['tenant'] : undefined);
  const f = formatters(locale === 'ar-SA', j.currency);
  const { t } = f;
  if (j.tenant === undefined)
    return (
      <p className="rounded-card border border-line bg-surface p-6 text-ink-quiet">
        {t('No institution is onboarded under this jurisdiction yet.', 'لا توجد مؤسسة مسجلة في هذه الولاية بعد.')}
      </p>
    );

  await syncBusiness(j.tenant);
  const [views, variants] = await Promise.all([listApplications(j.tenant), productVariants(j.tenant)]);
  const now = developmentAttestation().epochSeconds;
  const requested = typeof sp['stage'] === 'string' ? sp['stage'] : 'all';
  const filter: Filter = (FILTERS as readonly string[]).includes(requested) ? (requested as Filter) : 'all';
  const matches = (v: BusinessApplicationView, x: Filter): boolean =>
    x === 'all'
      ? true
      : x === 'closed'
        ? CLOSED.has(v.application.status)
        : !CLOSED.has(v.application.status) && String(v.displayStage) === x;
  const rows = views.filter((v) => matches(v, filter));
  const label = (x: Filter): string =>
    x === 'all'
      ? t('All', 'الكل')
      : x === 'closed'
        ? t('Closed', 'مغلق')
        : `${f.n(Number(x))} · ${stageTitle(Number(x), f)}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-display font-bold tracking-tight text-heading">
            {t('Business applications', 'طلبات المنشآت')}
          </h1>
          <p className="mt-1 text-[14px] text-ink-quiet">
            {t(
              `SME direct lending, stages ${stageRange(5, 9, f)}. Handed over from the upstream customer record. Amounts in ${f.cur}.`,
              `التمويل المباشر للمنشآت، المراحل ${stageRange(5, 9, f)}. مستلمة من سجل العميل في الأنظمة السابقة. المبالغ بال${f.cur}.`,
            )}
          </p>
        </div>
        <a
          href={`/${segment}/business/export`}
          className="press inline-flex h-10 items-center gap-2 rounded-tile border border-line-strong bg-surface px-4 text-[14px] font-semibold text-heading hover:bg-sunken"
        >
          <Icon name="document" size={18} />
          {t('Export', 'تصدير')}
        </a>
      </div>

      <section className="rounded-card border border-line bg-surface shadow-card">
        <nav aria-label={t('Stages', 'المراحل')} className="border-b border-line px-5 pt-4">
          <ul className="-mb-px flex list-none flex-wrap gap-1 p-0">
            {FILTERS.map((x) => {
              const active = x === filter;
              const count = views.filter((v) => matches(v, x)).length;
              return (
                <li key={x}>
                  <a
                    href={`/${segment}/business${x === 'all' ? '' : `?stage=${x}`}`}
                    aria-current={active ? 'page' : undefined}
                    className={`press inline-flex items-center gap-2 border-b-2 px-3 pb-3 text-[14px] font-medium ${active ? 'border-brand text-brand-deep' : 'border-transparent text-ink-quiet hover:text-heading'}`}
                  >
                    {label(x)}
                    <span
                      className={`rounded-full px-2 py-0.5 text-[12px] tabular-nums ${active ? 'bg-brand-wash text-brand-deep' : 'bg-sunken text-ink-quiet'}`}
                    >
                      {f.n(count)}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        {rows.length === 0 ? (
          <p className="px-5 py-14 text-center text-[15px] text-ink-quiet">
            {t('No applications in this view.', 'لا توجد طلبات في هذا العرض.')}
          </p>
        ) : (
          // `relative`: the sr-only header label is absolutely positioned; keep it inside the scroller.
          <div className="relative overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead>
                <tr className="bg-sunken">
                  <th scope="col" className={`${TH} ps-5`}>
                    {t('Applicant', 'مقدم الطلب')}
                  </th>
                  <th scope="col" className={`${TH} hidden md:table-cell`}>
                    {t('Product', 'المنتج')}
                  </th>
                  <th scope="col" className={TH_END}>
                    {t(`Amount (${f.cur})`, `المبلغ (${f.cur})`)}
                  </th>
                  <th scope="col" className={`${TH} hidden lg:table-cell`}>
                    {t('Stage', 'المرحلة')}
                  </th>
                  <th scope="col" className={TH}>
                    {t('Status', 'الحالة')}
                  </th>
                  <th scope="col" className={`${TH} hidden xl:table-cell`}>
                    {t('Received', 'تاريخ الاستلام')}
                  </th>
                  <th scope="col" className={`${TH_END} pe-5`}>
                    <span className="sr-only">{t('Action', 'إجراء')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => {
                  const a = v.application;
                  const chip = statusChip(v, now);
                  const action = nextAction(v, f);
                  const variant = variants.get(a.variantCode);
                  return (
                    <tr key={a.applicationId} className="border-t border-line hover:bg-sunken/60">
                      <td className="py-3 ps-5 pe-3">
                        <span className="flex min-w-0 flex-col">
                          <span className="font-semibold text-heading">
                            {f.arabic
                              ? (a.applicant.businessNameAr ?? a.applicant.businessNameEn)
                              : a.applicant.businessNameEn}
                          </span>
                          <Id className="text-[12px] text-ink-quiet">{a.applicationId}</Id>
                        </span>
                      </td>
                      <td className="hidden py-3 pe-3 text-ink md:table-cell">
                        {variant === undefined ? a.variantCode : t(variant.nameEn, variant.nameAr)}
                      </td>
                      <td className="py-3 pe-3 text-end font-semibold tabular-nums text-heading">
                        <bdi>{f.money(a.requested.minorUnits)}</bdi>
                      </td>
                      <td className="hidden py-3 pe-3 text-ink lg:table-cell">
                        {f.n(v.displayStage)} · {stageTitle(v.displayStage, f)}
                      </td>
                      <td className="py-3 pe-3">
                        <Chip tone={chip.tone}>{f.digits(t(chip.en, chip.ar))}</Chip>
                      </td>
                      <td className="hidden py-3 pe-3 text-ink-quiet xl:table-cell">
                        <bdi>{f.epochDate(a.receivedAtEpochSeconds)}</bdi>
                      </td>
                      <td className="py-3 pe-5 text-end">
                        <a
                          href={screenHref(segment, v)}
                          className={`press inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-tile px-3 text-[13px] font-semibold ${action.primary ? 'bg-brand text-white hover:bg-brand-deep' : 'border border-line text-heading hover:bg-sunken'}`}
                        >
                          {action.label}
                          <Icon name="chevron-end" size={14} />
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
