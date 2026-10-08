/**
 * The origination dashboard, to the Figma "Loan management web application"
 * kit (Loan Officer VD → Dashboard, applied 2026-10-08), with the triage
 * pattern of an approvals inbox: the work that needs a person comes first.
 *
 *   1. Title and the one primary action (key a request).
 *   2. Five figures across, each a real count or sum from the book: awaiting
 *      review (with breaches of the tenant's own targets), open pipeline,
 *      approved, closed without approval, waiting on someone outside.
 *   3. The requests table with view tabs — Needs attention first — search,
 *      stage pills and the time each request has been waiting against its
 *      target. Paginated.
 *   4. Underneath: where the book sits in the pipeline, the rails as
 *      configured, and the compliance indicators (SDD §4.10).
 *
 * Nothing on this page is computed in the page beyond arranging it: the
 * figures come from `server/dashboard.ts`, the targets from the tenant's
 * origination policy in force, the rails from its approved configuration.
 * There is no rate anywhere (SH-01 for the Murabaha product), and nothing is
 * invented to fill a slot — an empty list says so.
 *
 * When the deployment behaves as the UAE (ADR 0005) this route shows the SME
 * pipeline dashboard instead (PipelineDashboard.tsx); the Saudi request book
 * below is unchanged.
 */

import { notFound } from 'next/navigation';
import type { ReactElement, ReactNode } from 'react';

import { CAPABILITY_LABELS } from '@sanad/adapters/catalogue.ts';
import type { TenantCode } from '@sanad/config/loader.ts';
import { Indicator } from '@sanad/design/charts.tsx';
import { Icon, type IconName } from '@sanad/design/icons.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { resolveOriginationPolicy } from '@sanad/origination/origination-policy.ts';
import { resolveRailsConfiguration } from '@sanad/origination/rails.ts';

import { type AttentionItem, railStatuses, summarise } from '../../server/dashboard.ts';
import { workbenchJurisdiction } from '../../server/jurisdiction.ts';
import { pageStaff } from '../../server/session.ts';
import { developmentAttestation, listRequests, type RequestRow } from '../../server/store.ts';
import { PipelineDashboard } from './PipelineDashboard.tsx';

const TENANT: TenantCode = 'bank-a';
const PAGE_SIZE = 8;

type View = 'attention' | 'review' | 'outside' | 'approved' | 'closed' | 'all';
const VIEWS: readonly View[] = ['attention', 'review', 'outside', 'approved', 'closed', 'all'];
const IN_VIEW: Readonly<Record<Exclude<View, 'attention' | 'all'>, ReadonlySet<string>>> = {
  review: new Set(['KEYING', 'AWAITING_SERVICING_RESPONSE', 'AWAITING_REVIEW', 'RETURNED_TO_MAKER']),
  outside: new Set(['PENDING_INFORMATION', 'SERVICING_UNAVAILABLE']),
  approved: new Set(['APPROVED']),
  closed: new Set(['REJECTED', 'WITHDRAWN', 'EXPIRED']),
};

/** The kit's stage pills: a soft container with darker text. Every pill carries a label, never colour alone. */
const STAGE: Readonly<Record<RequestRow['state'], { readonly en: string; readonly ar: string; readonly cls: string }>> =
  {
    KEYING: { en: 'Keying', ar: 'قيد الإدخال', cls: 'bg-sunken text-ink-quiet' },
    AWAITING_SERVICING_RESPONSE: { en: 'Checking', ar: 'قيد التحقق', cls: 'bg-brand-wash text-brand-deep' },
    AWAITING_REVIEW: { en: 'Awaiting review', ar: 'بانتظار المراجعة', cls: 'bg-brand-wash text-brand-deep' },
    RETURNED_TO_MAKER: { en: 'Returned', ar: 'مُعاد للمُدخِل', cls: 'bg-attention-wash text-attention' },
    PENDING_INFORMATION: {
      en: 'Waiting on information',
      ar: 'بانتظار معلومات',
      cls: 'bg-attention-wash text-attention',
    },
    SERVICING_UNAVAILABLE: { en: 'Service unavailable', ar: 'الخدمة غير متاحة', cls: 'bg-blocked-wash text-blocked' },
    APPROVED: { en: 'Approved', ar: 'معتمد', cls: 'bg-positive-wash text-positive' },
    REJECTED: { en: 'Rejected', ar: 'مرفوض', cls: 'bg-blocked-wash text-blocked' },
    WITHDRAWN: { en: 'Withdrawn', ar: 'مسحوب', cls: 'bg-sunken text-ink-quiet' },
    EXPIRED: { en: 'Expired', ar: 'منتهي', cls: 'bg-sunken text-ink-quiet' },
  };

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const initials = (id: string): string =>
  id
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 2)
    .toUpperCase() || '··';

export default async function DashboardPage({
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
  const arabic = locale === 'ar-SA';
  // A UAE deployment originates SME direct lending, not the Saudi request book (ADR 0005).
  if ((await workbenchJurisdiction()).code === 'AE') return <PipelineDashboard segment={segment} arabic={arabic} />;
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const numerals = defaultNumerals(locale);
  const sar = (minorUnits: bigint) => formatMinorUnits({ minorUnits, currency: 'SAR' }, numerals);
  const n = (count: number) => new Intl.NumberFormat(arabic ? 'ar-SA' : 'en-SA').format(count);

  const observed = developmentAttestation().epochSeconds;
  const [policyResolved, railsResolved] = await Promise.all([
    resolveOriginationPolicy(TENANT, observed),
    resolveRailsConfiguration(TENANT, observed),
  ]);
  const policy = policyResolved.policy.ok ? policyResolved.policy.value : undefined;
  const rails = railsResolved.rails.ok ? railStatuses(railsResolved.rails.value.rails) : [];

  // Only the signed-in person's own institution's requests (SEC-TM08).
  const staff = await pageStaff(segment);
  const all = listRequests().filter((r) => r.tenantId === staff.tenantId);
  const summary = summarise(all, policy, observed);
  const attentionIds = new Map(summary.attention.map((a) => [a.requestId, a] as const));

  // -- The table: view, search, page ------------------------------------------------
  const term = first(sp['q'])?.trim() ?? '';
  const requestedView = first(sp['view']);
  const view: View = VIEWS.includes(requestedView as View)
    ? (requestedView as View)
    : summary.attention.length > 0
      ? 'attention'
      : 'all';
  const needle = term.toLowerCase();
  const inView = (r: RequestRow): boolean =>
    view === 'all' ? true : view === 'attention' ? attentionIds.has(r.requestId) : IN_VIEW[view].has(r.state);
  const viewCount = (v: View): number =>
    v === 'all'
      ? all.length
      : v === 'attention'
        ? summary.attention.length
        : all.filter((r) => IN_VIEW[v].has(r.state)).length;
  const ordered =
    view === 'attention'
      ? summary.attention
          .map((a) => all.find((r) => r.requestId === a.requestId))
          .filter((r): r is RequestRow => r !== undefined)
      : [...all].sort((a, b) => (a.raisedAtEpochSeconds < b.raisedAtEpochSeconds ? 1 : -1));
  const rows = ordered
    .filter(inView)
    .filter(
      (r) =>
        needle === '' || [r.requestId, r.counterpartyId, r.invoiceNumber].some((f) => f.toLowerCase().includes(needle)),
    );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(first(sp['p']) ?? '1', 10) || 1));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const href = (patch: Readonly<Record<string, string | undefined>>): string => {
    const q = new URLSearchParams();
    const merged = { view, q: term === '' ? undefined : term, p: undefined, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v !== undefined && v !== '') q.set(k, v);
    const s = q.toString();
    return `/${segment}${s === '' ? '' : `?${s}`}#requests`;
  };

  const age = (seconds: bigint): string => {
    const minutes = Number(seconds / 60n);
    if (minutes < 60) return t(`${n(minutes)} min`, `${n(minutes)} دقيقة`);
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return t(`${n(hours)} h`, `${n(hours)} ساعة`);
    return t(`${n(Math.floor(hours / 24))} d`, `${n(Math.floor(hours / 24))} يوم`);
  };
  const dateOf = (epoch: bigint): string =>
    new Intl.DateTimeFormat(arabic ? 'ar-SA-u-ca-gregory' : 'en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Asia/Riyadh',
    }).format(new Date(Number(epoch) * 1000));

  const breached = summary.countsByKind.SLA_BREACHED;
  const awaiting = all.filter((r) => r.state === 'AWAITING_REVIEW').length;
  const outsideStage = summary.funnel.find((f) => f.stage === 'WAITING_OUTSIDE');
  const approvedStage = summary.funnel.find((f) => f.stage === 'APPROVED');
  const closedStage = summary.funnel.find((f) => f.stage === 'CLOSED_WITHOUT_APPROVAL');
  const openCount =
    (summary.funnel.find((f) => f.stage === 'IN_PROGRESS')?.requestCount ?? 0) + (outsideStage?.requestCount ?? 0);

  const VIEW_LABEL: Readonly<Record<View, string>> = {
    attention: t('Needs attention', 'يحتاج إجراء'),
    review: t('In progress', 'قيد المعالجة'),
    outside: t('Waiting outside', 'بانتظار جهة خارجية'),
    approved: t('Approved', 'معتمد'),
    closed: t('Closed', 'مغلق'),
    all: t('All', 'الكل'),
  };

  return (
    <div className="flex flex-col gap-6">
      {/* -- 1. Title and the primary action ------------------------------------------------ */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-display font-bold tracking-tight text-heading">{t('Dashboard', 'لوحة المتابعة')}</h1>
          <p className="mt-1 text-[14px] text-ink-quiet">
            {breached > 0
              ? t(
                  `${n(breached)} request${breached === 1 ? ' is' : 's are'} past the bank’s time target.`,
                  `${n(breached)} من الطلبات تجاوز المدة المستهدفة للبنك.`,
                )
              : summary.attention.length > 0
                ? t(
                    `${n(summary.attention.length)} need${summary.attention.length === 1 ? 's' : ''} a person; none is past its target.`,
                    `${n(summary.attention.length)} يحتاج إجراء؛ لا شيء تجاوز المدة المستهدفة.`,
                  )
                : t('Nothing is waiting on anyone.', 'لا شيء بانتظار أحد.')}
          </p>
        </div>
        <a
          href={`/${segment}/originate`}
          className="press inline-flex h-10 items-center gap-2 rounded-tile bg-brand px-4 text-[14px] font-semibold text-white hover:bg-brand-deep"
        >
          <Icon name="key-in" size={18} />
          {t('Key a request', 'إدخال طلب')}
        </a>
      </div>

      {/* -- 2. Five figures ------------------------------------------------------------------- */}
      <section aria-label={t('Key figures', 'أرقام رئيسية')} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric
          icon="queue"
          label={t('Awaiting review', 'بانتظار المراجعة')}
          value={n(awaiting)}
          sub={
            breached > 0
              ? t(`${n(breached)} past target`, `${n(breached)} تجاوز المدة`)
              : t('all within target', 'كلها ضمن المدة')
          }
          subTone={breached > 0 ? 'bad' : 'quiet'}
          href={href({ view: 'attention' })}
        />
        <Metric
          icon="banknote"
          label={t('Open pipeline', 'قيد المعالجة')}
          value={<bdi>{sar(summary.openValueMinorUnits)}</bdi>}
          unit={t('SAR', 'ريال')}
          sub={t(`${n(openCount)} requests open`, `${n(openCount)} طلب مفتوح`)}
          subTone="quiet"
          href={href({ view: 'review' })}
        />
        <Metric
          icon="check-circle"
          label={t('Approved', 'معتمد')}
          value={n(approvedStage?.requestCount ?? 0)}
          unit={t('requests', 'طلب')}
          sub={
            <bdi>
              {sar(approvedStage?.valueMinorUnits ?? 0n)} {t('SAR', 'ريال')}
            </bdi>
          }
          subTone="good"
          href={href({ view: 'approved' })}
        />
        <Metric
          icon="document"
          label={t('Closed', 'مغلق')}
          value={n(closedStage?.requestCount ?? 0)}
          unit={t('requests', 'طلب')}
          sub={t('rejected, withdrawn or expired', 'مرفوض أو مسحوب أو منتهٍ')}
          subTone="quiet"
          href={href({ view: 'closed' })}
        />
        <Metric
          icon="clock"
          label={t('Waiting outside', 'بانتظار جهة خارجية')}
          value={n(outsideStage?.requestCount ?? 0)}
          sub={
            summary.countsByKind.SERVICING_UNAVAILABLE > 0
              ? t(
                  `${n(summary.countsByKind.SERVICING_UNAVAILABLE)} on a service that is down`,
                  `${n(summary.countsByKind.SERVICING_UNAVAILABLE)} بسبب خدمة متوقفة`,
                )
              : t('no service is down', 'لا خدمة متوقفة')
          }
          subTone={summary.countsByKind.SERVICING_UNAVAILABLE > 0 ? 'bad' : 'quiet'}
          href={href({ view: 'outside' })}
        />
      </section>

      {/* -- 3. The requests table -------------------------------------------------------------- */}
      <section id="requests" className="rounded-card border border-line bg-surface shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 pt-4">
          <nav aria-label={t('Views', 'طرق العرض')} className="-mb-px flex flex-wrap gap-1">
            {VIEWS.map((v) => {
              const active = v === view;
              const count = viewCount(v);
              return (
                <a
                  key={v}
                  href={href({ view: v })}
                  aria-current={active ? 'page' : undefined}
                  className={`press inline-flex items-center gap-2 border-b-2 px-3 pb-3 text-[14px] font-medium ${active ? 'border-brand text-brand-deep' : 'border-transparent text-ink-quiet hover:text-heading'}`}
                >
                  {VIEW_LABEL[v]}
                  <span
                    className={`rounded-full px-2 py-0.5 text-[12px] tabular-nums ${active ? 'bg-brand-wash text-brand-deep' : v === 'attention' && count > 0 ? 'bg-blocked-wash text-blocked' : 'bg-sunken text-ink-quiet'}`}
                  >
                    {n(count)}
                  </span>
                </a>
              );
            })}
          </nav>
          <form action={`/${segment}`} method="get" className="mb-3 w-full sm:w-[320px]">
            <input type="hidden" name="view" value={view} />
            <label className="flex h-9 items-center gap-2 rounded-tile border border-line bg-sunken ps-3 pe-2 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20">
              <Icon name="search" size={16} className="shrink-0 text-ink-quiet" />
              <span className="sr-only">{t('Search this view', 'ابحث في هذا العرض')}</span>
              <input
                name="q"
                defaultValue={term}
                placeholder={t('Request, counterparty or invoice', 'الطلب أو العميل أو الفاتورة')}
                className="w-full min-w-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-quiet"
              />
            </label>
          </form>
        </div>

        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-14 text-center">
            <span
              aria-hidden
              className="inline-flex size-11 items-center justify-center rounded-full bg-positive-wash text-positive"
            >
              <Icon name="check-circle" size={22} />
            </span>
            <p className="text-[15px] font-medium text-heading">
              {term !== ''
                ? t('No request matches that search.', 'لا يطابق البحث أي طلب.')
                : view === 'attention'
                  ? t('Nothing needs attention.', 'لا شيء يحتاج إجراء.')
                  : t('No requests in this view.', 'لا توجد طلبات في هذا العرض.')}
            </p>
            {term !== '' ? (
              <a href={href({ q: undefined })} className="text-[13px] text-brand hover:underline">
                {t('Clear the search', 'إلغاء البحث')}
              </a>
            ) : null}
          </div>
        ) : (
          // `relative`: the screen-reader label in the last header cell is absolutely positioned; without a
          // positioned ancestor here it escapes the scroller and widens the whole page on a phone.
          <div className="relative overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead>
                <tr className="bg-sunken text-[13px] text-ink-quiet">
                  <th scope="col" className="py-3 ps-5 pe-3 text-start font-medium">
                    {t('Counterparty', 'العميل')}
                  </th>
                  <th scope="col" className="py-3 pe-3 text-start font-medium">
                    {t('Submitted on', 'تاريخ التقديم')}
                  </th>
                  <th scope="col" className="hidden py-3 pe-3 text-start font-medium md:table-cell">
                    {t('Invoice', 'الفاتورة')}
                  </th>
                  <th scope="col" className="py-3 pe-3 text-end font-medium">
                    {t('Amount (SAR)', 'المبلغ (ريال)')}
                  </th>
                  <th scope="col" className="py-3 pe-3 text-start font-medium">
                    {t('Stage', 'المرحلة')}
                  </th>
                  <th scope="col" className="hidden py-3 pe-3 text-start font-medium lg:table-cell">
                    {t('Waiting', 'مدة الانتظار')}
                  </th>
                  <th scope="col" className="py-3 pe-5 text-end font-medium">
                    <span className="sr-only">{t('Action', 'إجراء')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const stage = STAGE[r.state];
                  const a: AttentionItem | undefined = attentionIds.get(r.requestId);
                  const late = a?.kind === 'SLA_BREACHED';
                  return (
                    <tr key={r.requestId} className="border-t border-line hover:bg-sunken/60">
                      <td className="py-3 ps-5 pe-3">
                        <span className="flex items-center gap-3">
                          <span
                            aria-hidden
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-wash text-[11px] font-bold text-brand-deep"
                          >
                            <span className="identifier">{initials(r.counterpartyId)}</span>
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate font-semibold text-heading">{r.counterpartyId}</span>
                            <span className="identifier text-[12px] text-ink-quiet">{r.requestId}</span>
                          </span>
                        </span>
                      </td>
                      <td className="py-3 pe-3 font-medium text-ink">
                        <bdi>{dateOf(r.submittedAtEpochSeconds ?? r.raisedAtEpochSeconds)}</bdi>
                      </td>
                      <td className="hidden py-3 pe-3 md:table-cell">
                        <span className="identifier text-ink-quiet">{r.invoiceNumber}</span>
                      </td>
                      <td className="py-3 pe-3 text-end font-semibold tabular-nums text-heading">
                        <bdi>{sar(r.amountMinorUnits)}</bdi>
                      </td>
                      <td className="py-3 pe-3">
                        <span
                          className={`inline-flex whitespace-nowrap rounded-[6px] px-2.5 py-1 text-[12px] font-medium ${stage.cls}`}
                        >
                          {arabic ? stage.ar : stage.en}
                        </span>
                      </td>
                      <td className="hidden py-3 pe-3 lg:table-cell">
                        {a === undefined ? (
                          <span className="text-ink-faint">—</span>
                        ) : (
                          <span className={`flex flex-col leading-tight ${late ? 'text-blocked' : 'text-ink'}`}>
                            <span className="font-medium">
                              {age(a.ageSeconds)}
                              {late ? (
                                <span className="ms-1.5 text-[12px] font-semibold">{t('late', 'متأخر')}</span>
                              ) : null}
                            </span>
                            {a.slaSeconds !== undefined ? (
                              <span className="text-[12px] text-ink-quiet">
                                {t('target', 'المستهدف')} {age(BigInt(a.slaSeconds))}
                              </span>
                            ) : null}
                          </span>
                        )}
                      </td>
                      <td className="py-3 pe-5 text-end">
                        <a
                          href={`/${segment}/requests/${r.requestId}`}
                          className={`press inline-flex h-8 items-center gap-1 rounded-tile px-3 text-[13px] font-semibold ${r.state === 'AWAITING_REVIEW' ? 'bg-brand text-white hover:bg-brand-deep' : 'border border-line text-heading hover:bg-sunken'}`}
                        >
                          {r.state === 'AWAITING_REVIEW' ? t('Review', 'مراجعة') : t('Open', 'فتح')}
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

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-[13px] text-ink-quiet">
          <span className="tabular-nums">
            {rows.length === 0
              ? t('0 requests', '٠ طلب')
              : t(
                  `${n((page - 1) * PAGE_SIZE + 1)}–${n(Math.min(page * PAGE_SIZE, rows.length))} of ${n(rows.length)}`,
                  `${n((page - 1) * PAGE_SIZE + 1)}–${n(Math.min(page * PAGE_SIZE, rows.length))} من ${n(rows.length)}`,
                )}
          </span>
          <span className="flex items-center gap-1">
            {page > 1 ? (
              <a
                href={href({ p: String(page - 1) })}
                aria-label={t('Previous page', 'الصفحة السابقة')}
                className="press inline-flex size-8 items-center justify-center rounded-tile hover:bg-sunken"
              >
                <Icon name="chevron-start" size={16} />
              </a>
            ) : (
              <span aria-hidden className="inline-flex size-8 items-center justify-center text-ink-faint">
                <Icon name="chevron-start" size={16} />
              </span>
            )}
            <span className="px-1 tabular-nums">
              {n(page)} / {n(pages)}
            </span>
            {page < pages ? (
              <a
                href={href({ p: String(page + 1) })}
                aria-label={t('Next page', 'الصفحة التالية')}
                className="press inline-flex size-8 items-center justify-center rounded-tile hover:bg-sunken"
              >
                <Icon name="chevron-end" size={16} />
              </a>
            ) : (
              <span aria-hidden className="inline-flex size-8 items-center justify-center text-ink-faint">
                <Icon name="chevron-end" size={16} />
              </span>
            )}
          </span>
        </div>
      </section>

      {/* -- 4. Pipeline, rails, compliance ------------------------------------------------------ */}
      <section className="grid gap-3 xl:grid-cols-3">
        <Panel
          title={t('Where the book sits', 'توزيع الطلبات')}
          note={t(`${n(summary.requestsOnBook)} requests on the book`, `${n(summary.requestsOnBook)} طلب في السجل`)}
        >
          {summary.requestsOnBook === 0 ? (
            <p className="text-[13px] text-ink-quiet">{t('No requests yet.', 'لا توجد طلبات بعد.')}</p>
          ) : (
            <>
              <div
                className="flex h-2.5 overflow-hidden rounded-full bg-sunken"
                role="img"
                aria-label={t('Requests by pipeline stage', 'الطلبات حسب المرحلة')}
              >
                {summary.funnel.map((f, i) =>
                  f.requestCount === 0 ? null : (
                    <span
                      key={f.stage}
                      className={['bg-brand', 'bg-attention-mark', 'bg-positive-mark', 'bg-ink-faint'][i]}
                      style={{ width: `${(f.requestCount / summary.requestsOnBook) * 100}%` }}
                    />
                  ),
                )}
              </div>
              <ul className="mt-4 flex list-none flex-col gap-2.5 p-0">
                {summary.funnel.map((f, i) => (
                  <li key={f.stage} className="flex items-center gap-2.5 text-[13px]">
                    <span
                      aria-hidden
                      className={`size-2.5 shrink-0 rounded-[3px] ${['bg-brand', 'bg-attention-mark', 'bg-positive-mark', 'bg-ink-faint'][i] ?? ''}`}
                    />
                    <span className="text-ink">
                      {
                        [
                          t('In progress', 'قيد المعالجة'),
                          t('Waiting outside the bank', 'بانتظار جهة خارجية'),
                          t('Approved', 'معتمد'),
                          t('Closed without approval', 'مغلق دون اعتماد'),
                        ][i]
                      }
                    </span>
                    <span className="ms-auto tabular-nums font-semibold text-heading">{n(f.requestCount)}</span>
                    <span className="w-[120px] text-end tabular-nums text-ink-quiet">
                      <bdi>{sar(f.valueMinorUnits)}</bdi>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>

        <Panel
          title={t('Connected services', 'الخدمات المتصلة')}
          note={t('As configured for this bank; not a live health check.', 'حسب إعداد البنك؛ ليس فحصاً حياً.')}
        >
          {rails.length === 0 ? (
            <p className="text-[13px] text-ink-quiet">{t('No rails configured.', 'لا توجد قنوات مهيأة.')}</p>
          ) : (
            <ul className="flex list-none flex-col gap-2 p-0">
              {rails.map((r) => (
                <li key={r.capability} className="flex items-center gap-2.5 text-[13px]">
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${r.enabled ? 'bg-positive-mark' : 'bg-ink-faint'}`}
                  />
                  <span className="identifier font-semibold text-heading">{r.adapter}</span>
                  <span
                    className="min-w-0 truncate text-ink-quiet"
                    title={arabic ? CAPABILITY_LABELS[r.capability]?.ar : CAPABILITY_LABELS[r.capability]?.en}
                  >
                    {(arabic ? CAPABILITY_LABELS[r.capability]?.ar : CAPABILITY_LABELS[r.capability]?.en) ??
                      r.capability}
                  </span>
                  <span
                    className={`ms-auto shrink-0 rounded-[6px] px-2 py-0.5 text-[11px] font-medium ${r.enabled ? 'bg-positive-wash text-positive' : 'bg-sunken text-ink-quiet'}`}
                  >
                    {r.enabled ? t('on', 'مفعّل') : t('off', 'معطّل')} · {r.environment}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title={t('Compliance indicators', 'مؤشرات الالتزام الشرعي')}
          note={t(
            'Populate once transactions execute. Zero is a real zero.',
            'تُملأ بعد تنفيذ المعاملات. الصفر هنا صفر حقيقي.',
          )}
        >
          <ul className="flex list-none flex-col gap-1.5 p-0">
            <Indicator label={t('Gate blocks', 'بوابات مُنعت')} note="SH-05 · SH-06" value="0" tone="neutral" />
            <Indicator label={t('Evidence completeness', 'اكتمال الأدلة')} note="SDD §4.10" value="—" tone="neutral" />
            <Indicator
              label={t('Open Shariah incidents', 'مخالفات شرعية مفتوحة')}
              note="BR-F04"
              value="0"
              tone="good"
            />
            <Indicator label={t('Template drift detections', 'انحراف القوالب')} note="BR-F07" value="0" tone="good" />
            <Indicator
              label={t('Charity liability balance', 'رصيد حساب الخير')}
              note="SH-13"
              value="0.00"
              tone="neutral"
            />
            <Indicator
              label={t('Questions with the Board', 'أسئلة معلّقة لدى الهيئة')}
              note="OI-22 · OI-23 · OI-24"
              value="3"
              tone="warning"
            />
          </ul>
        </Panel>
      </section>
    </div>
  );
}

/** One figure, as the kit draws it: label, the value large, one line of context, an icon at the end. The whole card opens its view. */
function Metric({
  icon,
  label,
  value,
  unit,
  sub,
  subTone,
  href,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly value: ReactElement | string;
  readonly unit?: string;
  readonly sub: ReactElement | string;
  readonly subTone: 'good' | 'bad' | 'quiet';
  readonly href: string;
}): ReactElement {
  const tone = subTone === 'bad' ? 'text-blocked font-medium' : subTone === 'good' ? 'text-positive' : 'text-ink-quiet';
  return (
    <a
      href={href}
      className="card-lift press flex min-w-0 items-start justify-between gap-3 rounded-card border border-line bg-surface px-5 py-4 shadow-card"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[12px] font-medium uppercase tracking-wide text-ink-quiet">{label}</span>
        <span className="mt-2 flex flex-wrap items-baseline gap-x-1.5">
          <span className="whitespace-nowrap text-[24px] font-bold leading-8 tabular-nums text-heading">{value}</span>
          {unit !== undefined ? <span className="text-[13px] text-ink-quiet">{unit}</span> : null}
        </span>
        <span className={`mt-1.5 truncate text-[12px] ${tone}`}>{sub}</span>
      </span>
      <Icon name={icon} size={22} className="mt-6 shrink-0 text-ink-quiet" />
    </a>
  );
}

function Panel({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="min-w-0 rounded-card border border-line bg-surface p-5 shadow-card">
      <h2 className="text-[15px] font-semibold text-heading">{title}</h2>
      <p className="mb-4 mt-0.5 text-[12px] text-ink-quiet">{note}</p>
      {children}
    </div>
  );
}
