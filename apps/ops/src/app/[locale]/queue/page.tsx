/**
 * The review queue, to the Figma Transactions frame (applied 2026-09-28):
 * two summary cards and a small bar chart across the top, a tab strip of
 * views, the queue as a white table with pill actions, and pagination.
 *
 * What is unchanged from the previous queue, because it is the point of the
 * screen: oldest first so nothing starves; SLA breach shown in words; a
 * checker's own work shown but not actionable (the domain refuses it too);
 * no bulk approve. What is new is only how it looks.
 */

import { notFound } from 'next/navigation';

import { WeekBars } from '@sanad/design/charts.tsx';
import { Icon } from '@sanad/design/icons.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { Card, PILL_OUTLINE, Pagination, Status, Tabs } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { isExpired, slaStatus } from '@sanad/core/origination/policy.ts';

import { canReview, pageStaff } from '../../../server/session.ts';
import { Gate, authorityRefusal } from '../Gate.tsx';
import { expireOverdueAction } from '../../../server/actions.ts';
import { listRequests, originationPolicy, type RequestRow } from '../../../server/store.ts';

type View = 'review' | 'servicing' | 'maker' | 'information' | 'failures' | 'breached' | 'decided';
const VIEWS: readonly View[] = ['review', 'servicing', 'maker', 'information', 'failures', 'breached', 'decided'];
const WAITING: readonly RequestRow['state'][] = [
  'AWAITING_SERVICING_RESPONSE',
  'AWAITING_REVIEW',
  'RETURNED_TO_MAKER',
  'PENDING_INFORMATION',
  'SERVICING_UNAVAILABLE',
];
const VIEW_STATES: Readonly<Record<View, readonly RequestRow['state'][]>> = {
  review: ['AWAITING_REVIEW'],
  servicing: ['AWAITING_SERVICING_RESPONSE'],
  maker: ['RETURNED_TO_MAKER', 'KEYING'],
  information: ['PENDING_INFORMATION'],
  failures: ['SERVICING_UNAVAILABLE'],
  breached: WAITING,
  decided: ['APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'],
};
const VIEW_LABEL: Readonly<Record<View, { en: string; ar: string }>> = {
  review: { en: 'Needs your decision', ar: 'بانتظار قرارك' },
  servicing: { en: 'With the servicing platform', ar: 'لدى نظام الخدمة' },
  maker: { en: 'With the maker', ar: 'لدى المُدخِل' },
  information: { en: 'Awaiting information', ar: 'بانتظار معلومات' },
  failures: { en: 'Integration failures', ar: 'أعطال التكامل' },
  breached: { en: 'Past SLA', ar: 'تجاوزت المهلة' },
  decided: { en: 'Decided', ar: 'تم البت فيها' },
};
const VIEW_EMPTY: Readonly<Record<View, { en: string; ar: string }>> = {
  review: { en: 'Nothing is waiting on you.', ar: 'لا يوجد ما ينتظر قرارك.' },
  servicing: { en: 'Nothing is with the servicing platform.', ar: 'لا يوجد لدى نظام الخدمة شيء.' },
  maker: { en: 'Nothing has been returned.', ar: 'لم يُعَد أي طلب.' },
  information: { en: 'Nothing is waiting on outside information.', ar: 'لا يوجد طلب بانتظار معلومات خارجية.' },
  failures: { en: 'The servicing platform is reachable for everything.', ar: 'نظام الخدمة متاح لكل الطلبات.' },
  breached: { en: 'Nothing is past its SLA.', ar: 'لا يوجد طلب تجاوز مهلته.' },
  decided: { en: 'Nothing has been decided yet.', ar: 'لم يتم البت في أي طلب بعد.' },
};
const PAGE_SIZE = 8;
const WEEK_EN = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const WEEK_AR = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];

const isView = (value: string | undefined): value is View =>
  value !== undefined && (VIEWS as readonly string[]).includes(value);
const waitingSince = (row: RequestRow): bigint => row.submittedAtEpochSeconds ?? row.raisedAtEpochSeconds;
function age(sinceEpochSeconds: bigint, nowEpochSeconds: bigint, locale: string): string {
  const seconds = Number(nowEpochSeconds - sinceEpochSeconds);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (seconds < 60) return format.format(-Math.max(seconds, 1), 'second');
  if (seconds < 3_600) return format.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return format.format(-Math.floor(seconds / 3_600), 'hour');
  return format.format(-Math.floor(seconds / 86_400), 'day');
}

export default async function QueuePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: segment } = await params;
  const query = await searchParams;
  const one = (k: string) => {
    const v = query[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const view: View = isView(one('show')) ? (one('show') as View) : 'review';
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const text = (pair: { en: string; ar: string }): string => (arabic ? pair.ar : pair.en);
  const numerals = defaultNumerals(locale);
  const sar = (minorUnits: bigint): string => formatMinorUnits({ minorUnits, currency: 'SAR' }, numerals);

  // Read once, so every row on the page is aged against the same instant.
  const nowEpochSeconds = BigInt(Math.floor(Date.now() / 1000));
  // Only the signed-in person's own institution's requests (SEC-TM08).
  const staff = await pageStaff(segment);
  const all = listRequests().filter((r) => r.tenantId === staff.tenantId);
  const policy = originationPolicy();
  const breached = (r: RequestRow): boolean =>
    slaStatus(policy, r.state, waitingSince(r), nowEpochSeconds) === 'BREACHED';
  const overdue = (r: RequestRow): boolean => isExpired(policy, r.state, waitingSince(r), nowEpochSeconds);
  const inView = (v: View, r: RequestRow): boolean =>
    VIEW_STATES[v].includes(r.state) && (v !== 'breached' || breached(r));
  const counts = Object.fromEntries(VIEWS.map((v) => [v, all.filter((r) => inView(v, r)).length])) as Record<
    View,
    number
  >;
  const expirable = all.filter((r) => WAITING.includes(r.state) && overdue(r)).length;
  const justExpired = Number.parseInt(one('expired') ?? '0', 10) || 0;

  const rows = all
    .filter((r) => inView(view, r))
    .sort((a, b) => {
      const direction = view === 'decided' ? -1 : 1;
      const byTime = Number(waitingSince(a) - waitingSince(b));
      return byTime !== 0 ? direction * byTime : direction * a.requestId.localeCompare(b.requestId);
    });
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(one('page') ?? '1', 10) || 1));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  // Four eyes is evaluated against who is actually signed in (`staff`, above).
  const refusal = authorityRefusal(one('reason'), one('needs'), arabic);
  const blockedCount = all.filter(
    (r) => r.state === 'AWAITING_REVIEW' && !canReview(staff, r.makerPrincipalId).allowed,
  ).length;

  // The summary cards: what needs you, and what is past its SLA — the oldest of each.
  const needsYou = all.filter((r) => inView('review', r)).sort((a, b) => Number(waitingSince(a) - waitingSince(b)));
  const oldest = needsYou[0];
  const pastSla = all.filter((r) => inView('breached', r));
  const oldestBreached = pastSla.sort((a, b) => Number(waitingSince(a) - waitingSince(b)))[0];

  // Decided per weekday, last seven days to the latest request on the book.
  const latest = all.reduce((m, r) => (r.raisedAtEpochSeconds > m ? r.raisedAtEpochSeconds : m), 0n);
  const weekStart = latest - BigInt(6 * 86_400);
  const weekIndex = (epoch: bigint) => (new Date(Number(epoch) * 1000).getUTCDay() + 1) % 7;
  const bars = WEEK_EN.map((_, i) => ({ label: (arabic ? WEEK_AR : WEEK_EN)[i] ?? '', first: 0, second: 0 }));
  for (const r of all) {
    if (r.raisedAtEpochSeconds < weekStart) continue;
    const b = bars[weekIndex(r.raisedAtEpochSeconds)];
    if (b === undefined) continue;
    if (r.state === 'APPROVED') b.first += 1;
    if (r.state === 'REJECTED' || r.state === 'WITHDRAWN' || r.state === 'EXPIRED') b.second += 1;
  }

  const hrefFor = (p: number) => `/${segment}/queue?show=${view}&page=${String(p)}`;

  return (
    <div className="flex flex-col gap-8">
      {refusal === undefined ? null : (
        <p
          role="alert"
          className="rounded-card border border-blocked/30 bg-blocked-wash px-4 py-3 text-[14px] text-blocked"
        >
          {refusal}
        </p>
      )}
      {/* -- Summary: two cards and the week ------------------------------------ */}
      <section className="grid gap-[30px] lg:grid-cols-2 2xl:grid-cols-3">
        <div className="card-lift flex h-[225px] flex-col justify-between overflow-hidden rounded-card bg-[linear-gradient(107deg,#4c49ed_0%,#0a06f4_100%)] text-white">
          <div className="flex items-start justify-between px-[26px] pt-6">
            <div>
              <p className="text-xs text-white/70">{t('Needs your decision', 'بانتظار قرارك')}</p>
              <p className="mt-1 text-[28px] font-semibold tabular-nums leading-none">{counts.review}</p>
            </div>
            <span aria-hidden className="inline-flex size-[35px] items-center justify-center rounded-[6px] bg-white/20">
              <Icon name="queue" size={18} />
            </span>
          </div>
          <div className="px-[26px] text-xs text-white/70">
            {oldest !== undefined ? (
              <>
                {t('Oldest waiting ', 'الأقدم ينتظر ')}
                <bdi>{age(waitingSince(oldest), nowEpochSeconds, locale)}</bdi> ·{' '}
                <span className="identifier text-white">{oldest.requestId}</span>
              </>
            ) : (
              t('Nothing is waiting on you.', 'لا يوجد ما ينتظر قرارك.')
            )}
          </div>
          <div className="flex min-h-[70px] flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-[linear-gradient(180deg,rgba(255,255,255,0.15)_0%,rgba(255,255,255,0)_100%)] px-[26px] py-3">
            <span className="whitespace-nowrap text-[15px] font-semibold">
              {t('Four eyes', 'أربع أعين')} · <span className="identifier">{staff.principalId}</span>
            </span>
            {blockedCount > 0 ? (
              <span className="text-xs text-white/80">
                {blockedCount} {t('your own work', 'من إدخالك')}
              </span>
            ) : null}
          </div>
        </div>
        <div className="card-lift flex h-[225px] flex-col justify-between overflow-hidden rounded-card border border-line-strong bg-surface">
          <div className="flex items-start justify-between px-[26px] pt-6">
            <div>
              <p className="text-xs text-ink-quiet">{t('Past SLA', 'تجاوزت المهلة')}</p>
              <p
                className={`mt-1 text-[28px] font-semibold tabular-nums leading-none ${pastSla.length > 0 ? 'text-blocked' : 'text-heading'}`}
              >
                {pastSla.length}
              </p>
            </div>
            <span
              aria-hidden
              className="inline-flex size-[35px] items-center justify-center rounded-[6px] bg-blocked-wash text-blocked"
            >
              <Icon name="clock" size={18} />
            </span>
          </div>
          <div className="px-[26px] text-xs text-ink-quiet">
            {oldestBreached !== undefined ? (
              <>
                {t('Longest breach ', 'أطول تجاوز ')}
                <bdi>{age(waitingSince(oldestBreached), nowEpochSeconds, locale)}</bdi> ·{' '}
                <span className="identifier text-ink">{oldestBreached.requestId}</span>
              </>
            ) : (
              t('Every request is inside its SLA.', 'كل الطلبات ضمن مهلتها.')
            )}
          </div>
          <div className="flex min-h-[70px] flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line-strong px-[26px] py-3">
            <span className="text-[15px] font-semibold text-heading">
              {expirable} {t('expirable', 'قابلة للانتهاء')}
            </span>
            <Gate staff={staff} act="REVIEW" arabic={arabic}>
              <form action={expireOverdueAction}>
                <input type="hidden" name="locale" value={segment} />
                <button type="submit" disabled={expirable === 0} className={`${PILL_OUTLINE} disabled:opacity-40`}>
                  {t('Expire overdue', 'إنهاء المتأخر')}
                </button>
              </form>
            </Gate>
          </div>
        </div>
        <Card className="lg:col-span-2 2xl:col-span-1">
          <WeekBars
            title={t('Decided this week', 'قرارات هذا الأسبوع')}
            series={[t('Approved', 'معتمد'), t('Declined', 'مرفوض')]}
            bars={bars}
            emptyLabel={t('No decisions in the last seven days.', 'لا قرارات خلال الأيام السبعة الأخيرة.')}
          />
        </Card>
      </section>

      {justExpired > 0 ? (
        <p className="rounded-tile bg-brand-wash px-4 py-3 text-sm text-brand-deep">
          {justExpired} {t('request(s) expired against the tenant policy.', 'طلب(ات) انتهت وفق سياسة المؤسسة.')}
        </p>
      ) : null}

      {/* -- Views -------------------------------------------------------------- */}
      <div>
        <h2 className="mb-4 text-h2 font-semibold text-heading">{t('Review queue', 'قائمة المراجعة')}</h2>
        <Tabs
          ariaLabel={t('Queue views', 'عروض القائمة')}
          current={view}
          items={VIEWS.map((v) => ({
            id: v,
            label: text(VIEW_LABEL[v]),
            href: `/${segment}/queue?show=${v}`,
            count: counts[v],
          }))}
        />
      </div>

      {/* -- The queue ---------------------------------------------------------- */}
      <Card>
        {pageRows.length === 0 ? (
          <p className="text-[15px] text-ink-quiet">{text(VIEW_EMPTY[view])}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[16px]">
              <caption className="sr-only">
                {text(VIEW_LABEL[view])} — {rows.length}
              </caption>
              <thead>
                <tr className="border-b border-line text-[16px] text-ink-quiet">
                  <th scope="col" className="py-3 pe-3 text-start font-normal">
                    {t('Waiting', 'منذ')}
                  </th>
                  <th scope="col" className="py-3 pe-3 text-start font-normal">
                    {t('Counterparty', 'العميل')}
                  </th>
                  <th scope="col" className="hidden py-3 pe-3 text-start font-normal 2xl:table-cell">
                    {t('Invoice', 'الفاتورة')}
                  </th>
                  <th scope="col" className="py-3 pe-3 text-end font-normal">
                    {t('Amount', 'المبلغ')}
                  </th>
                  <th scope="col" className="hidden py-3 pe-3 text-start font-normal xl:table-cell">
                    {t('Channel', 'القناة')}
                  </th>
                  <th scope="col" className="py-3 pe-3 text-start font-normal">
                    {t('Servicing', 'نظام الخدمة')}
                  </th>
                  <th scope="col" className="py-3 text-end font-normal">
                    {t('Action', 'إجراء')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const review = canReview(staff, row.makerPrincipalId);
                  const ownWork = view === 'review' && !review.allowed;
                  const declined = row.servicing?.decision === 'DECLINED';
                  return (
                    <tr key={row.requestId} className="border-b border-line last:border-b-0">
                      <td className="py-4 pe-3 text-ink-quiet">
                        <span className="flex flex-col gap-1">
                          <span className="whitespace-nowrap">
                            <bdi>{age(waitingSince(row), nowEpochSeconds, locale)}</bdi>
                          </span>
                          {breached(row) ? <Status tone="blocked" label={t('past SLA', 'تجاوز المهلة')} /> : null}
                        </span>
                      </td>
                      <td className="py-4 pe-3">
                        <span className="flex items-center gap-3">
                          <span
                            aria-hidden
                            className={`inline-flex size-[30px] shrink-0 items-center justify-center rounded-full border ${row.state === 'APPROVED' ? 'border-positive text-positive' : row.state === 'REJECTED' ? 'border-blocked text-blocked' : 'border-line-strong text-ink-quiet'}`}
                          >
                            <Icon name={row.state === 'APPROVED' ? 'check-circle' : 'document'} size={14} />
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="font-medium leading-snug text-ink">{row.counterpartyId}</span>
                            <span className="identifier text-xs text-ink-quiet">{row.requestId}</span>
                          </span>
                        </span>
                      </td>
                      <td className="hidden whitespace-nowrap py-4 pe-3 2xl:table-cell">
                        <span className="identifier text-ink-quiet">{row.invoiceNumber}</span>
                      </td>
                      <td className="whitespace-nowrap py-4 pe-3 text-end tabular-nums">
                        <bdi
                          className={
                            row.state === 'REJECTED'
                              ? 'text-blocked'
                              : row.state === 'APPROVED'
                                ? 'text-positive'
                                : 'text-ink'
                          }
                        >
                          {sar(row.amountMinorUnits)}
                        </bdi>
                        <span className="ms-1 text-xs text-ink-quiet">SAR</span>
                      </td>
                      <td className="hidden whitespace-nowrap py-4 pe-3 text-ink-quiet xl:table-cell">
                        {row.channel.replaceAll('_', ' ').toLowerCase()}
                      </td>
                      <td className="py-4 pe-3">
                        {row.servicing === undefined ? (
                          <span className="text-ink-quiet">
                            {row.state === 'AWAITING_SERVICING_RESPONSE' ? t('awaiting', 'بانتظار الرد') : '—'}
                          </span>
                        ) : (
                          <span className="flex flex-col gap-1">
                            <Status
                              tone={
                                row.servicing.decision === 'APPROVED'
                                  ? 'settled'
                                  : row.servicing.decision === 'DECLINED'
                                    ? 'blocked'
                                    : 'progress'
                              }
                              label={row.servicing.decision.toLowerCase()}
                            />
                            {declined ? (
                              <span className="max-w-[11rem] text-xs leading-snug text-attention">
                                {t('approval needs a written justification', 'الاعتماد يتطلب تسبيباً مكتوباً')}
                              </span>
                            ) : null}
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-4 text-end">
                        {ownWork ? (
                          // Shown, not hidden, and not actionable. The domain refuses this transition too.
                          <span
                            className="inline-flex flex-col items-end text-xs text-ink-quiet"
                            title={t('The principal who raised a request cannot approve it', 'المُدخِل لا يعتمد عمله')}
                          >
                            <span className="font-medium text-attention">{t('your own work', 'من إدخالك')}</span>
                            <span>{t('needs another reviewer', 'يلزم مراجع آخر')}</span>
                          </span>
                        ) : (
                          <a href={`/${segment}/requests/${row.requestId}`} className={PILL_OUTLINE}>
                            {view === 'review' ? t('Review', 'مراجعة') : t('Open', 'فتح')}
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-4 border-t border-line pt-3 text-xs text-ink-quiet">
          {t(
            'There is no bulk approve. Reviewing means looking at the trade, and a checkbox column is a way of not looking at it.',
            'لا يوجد اعتماد جماعي. المراجعة تعني النظر في الصفقة، وخانة الاختيار وسيلة لعدم النظر فيها.',
          )}
        </p>
      </Card>
      <Pagination
        page={page}
        pages={pages}
        hrefFor={hrefFor}
        labels={{ previous: t('Previous', 'السابق'), next: t('Next', 'التالي') }}
      />
    </div>
  );
}
