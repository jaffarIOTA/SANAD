/**
 * The origination dashboard, to the Figma design (BankDash kit "Main
 * Dashboard", applied 2026-09-26): product cards and recent requests; weekly
 * activity and the share by channel; quick actions and the pipeline history;
 * then the working table the operators live in.
 *
 * Every figure is a real count or sum from the store. The design's widgets
 * are kept as drawn and bound to what this platform actually has: cards are
 * products, "transactions" are requests, activity is requests raised and
 * decided, the pie is the share by channel, the history is pipeline value by
 * month. Nothing is fabricated to fill a slot — an empty chart says so.
 *
 * Two things deliberately differ from the kit: there is no rate anywhere
 * (SH-01 for the Murabaha product; every other product discloses through
 * the platform's offer, not a dashboard), and the compliance indicators
 * stay, because SDD §4.10 asks for them and a lending kit does not.
 */

import { notFound } from 'next/navigation';

import { type TenantCode, loadProductCatalogue } from '@sanad/config/loader.ts';
import { AreaTrend, Indicator, SharePie, WeekBars } from '@sanad/design/charts.tsx';
import { Icon } from '@sanad/design/icons.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { Card, Status } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { channelCards } from '../../server/origination.ts';
import { listRequests, type RequestRow } from '../../server/store.ts';

const TENANT: TenantCode = 'bank-a';
const DAY = 86_400;
const WEEK_EN = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const WEEK_AR = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];
const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const DECIDED = new Set(['APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED']);

/** Calendar facts of an attested instant. Reading a stored value, never the clock. */
const dayOf = (epoch: bigint) => new Date(Number(epoch) * 1000);

export default async function DashboardPage({ params, searchParams }: { readonly params: Promise<{ readonly locale: string }>; readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { locale: segment } = await params;
  const { q } = await searchParams;
  const term = (Array.isArray(q) ? q[0] : q)?.trim() ?? '';
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const numerals = defaultNumerals(locale);
  const sar = (minorUnits: bigint) => formatMinorUnits({ minorUnits, currency: 'SAR' }, numerals);

  const [channels] = await Promise.all([channelCards()]);
  const all = listRequests();
  const catalogue = loadProductCatalogue(TENANT);

  // The header search narrows the table only. Everything else counts the whole
  // book — a filtered figure presented as a total is how an operator reports
  // the wrong number.
  const needle = term.toLowerCase();
  const queue = needle === '' ? all : all.filter((r) => [r.requestId, r.counterpartyId, r.invoiceNumber].some((f) => f.toLowerCase().includes(needle)));

  const count = (...states: string[]) => all.filter((r) => states.includes(r.state)).length;
  const awaitingReview = count('AWAITING_REVIEW');
  const pipeline = all.filter((r) => r.state !== 'REJECTED' && r.state !== 'WITHDRAWN').reduce((s, r) => s + r.amountMinorUnits, 0n);
  const approvedValue = all.filter((r) => r.state === 'APPROVED').reduce((s, r) => s + r.amountMinorUnits, 0n);

  // -- Weekly activity: the seven days up to the latest request on the book ----
  const latest = all.reduce((m, r) => (r.raisedAtEpochSeconds > m ? r.raisedAtEpochSeconds : m), 0n);
  const weekStart = latest - BigInt(6 * DAY);
  const week = WEEK_EN.map((_, i) => ({ first: 0, second: 0, index: i }));
  const weekIndex = (epoch: bigint) => (dayOf(epoch).getUTCDay() + 1) % 7; // Sat = 0
  for (const r of all) {
    if (r.raisedAtEpochSeconds >= weekStart) { const w = week[weekIndex(r.raisedAtEpochSeconds)]; if (w !== undefined) w.first += 1; }
    if (DECIDED.has(r.state) && r.raisedAtEpochSeconds >= weekStart) { const w = week[weekIndex(r.raisedAtEpochSeconds)]; if (w !== undefined) w.second += 1; }
  }
  const bars = week.map((w) => ({ label: (arabic ? WEEK_AR : WEEK_EN)[w.index] ?? '', first: w.first, second: w.second }));

  // -- Share by channel ------------------------------------------------------
  const slices = channels.map((c) => ({ label: arabic ? c.titleAr : c.titleEn, value: all.filter((r) => r.channel === c.channel).length }));

  // -- Pipeline history: value raised per month, the seven months to the latest --
  const months: { readonly label: string; readonly value: number }[] = [];
  if (latest > 0n) {
    const end = dayOf(latest);
    for (let back = 6; back >= 0; back -= 1) {
      const y = end.getUTCFullYear(); const m = end.getUTCMonth() - back;
      const d = new Date(Date.UTC(y, m, 1));
      const sum = all.filter((r) => { const rd = dayOf(r.raisedAtEpochSeconds); return rd.getUTCFullYear() === d.getUTCFullYear() && rd.getUTCMonth() === d.getUTCMonth() && r.state !== 'REJECTED' && r.state !== 'WITHDRAWN'; })
        .reduce((s, r) => s + r.amountMinorUnits, 0n);
      months.push({ label: (arabic ? MONTH_AR : MONTH_EN)[d.getUTCMonth()] ?? '', value: Number(sum / 100_000n) }); // thousands of SAR
    }
  }

  // -- Recent requests -----------------------------------------------------------
  const recent = [...all].sort((a, b) => (a.raisedAtEpochSeconds < b.raisedAtEpochSeconds ? 1 : -1)).slice(0, 3);
  const disc: Record<RequestRow['channel'], { readonly bg: string; readonly icon: 'key-in' | 'plug' | 'store' | 'people' | 'building' }> = {
    MAKER_CHECKER: { bg: 'bg-disc-yellow text-attention', icon: 'key-in' },
    PARTNER_API: { bg: 'bg-disc-blue text-brand', icon: 'plug' },
    EMBEDDED_AGGREGATOR: { bg: 'bg-disc-teal text-positive', icon: 'store' },
    COUNTERPARTY_SELF: { bg: 'bg-disc-blue text-brand', icon: 'people' },
    AGENT_ASSISTED: { bg: 'bg-disc-yellow text-attention', icon: 'building' },
  };
  const dateOf = (epoch: bigint) => { const d = dayOf(epoch); return `${String(d.getUTCDate())} ${(arabic ? MONTH_AR : MONTH_EN)[d.getUTCMonth()] ?? ''} ${String(d.getUTCFullYear())}`; };

  const sectionTitle = (en: string, ar: string) => <h2 className="mb-5 text-h2 font-semibold text-heading">{t(en, ar)}</h2>;
  const products = catalogue.ok ? catalogue.value.entries.filter((e) => e.enabled).slice(0, 2) : [];

  return (
    <div className="flex flex-col gap-8">
      {/* -- Row 1: products and recent requests --------------------------------- */}
      <section className="grid gap-8 xl:grid-cols-[minmax(0,730fr)_minmax(0,350fr)]">
        <div className="min-w-0">
          <div className="mb-5 flex items-baseline justify-between">
            <h2 className="text-h2 font-semibold text-heading">{t('Products', 'المنتجات')}</h2>
            <a href={`/${segment}/products`} className="text-[17px] font-semibold text-heading hover:text-brand">{t('See All', 'عرض الكل')}</a>
          </div>
          <div className="grid gap-[30px] md:grid-cols-2">
            {products.map((entry, i) => {
              const dark = i === 0;
              const openCount = all.filter((r) => r.state !== 'REJECTED' && r.state !== 'WITHDRAWN').length;
              return (
                <a key={entry.productCode} href={`/${segment}/products`} className={`card-lift press relative flex h-[235px] flex-col justify-between overflow-hidden rounded-card ${dark ? 'bg-[linear-gradient(107deg,#4c49ed_0%,#0a06f4_100%)] text-white' : 'border border-line-strong bg-surface text-heading'}`}>
                  <div className="flex items-start justify-between px-[26px] pt-6">
                    <div>
                      <p className={`text-xs ${dark ? 'text-white/70' : 'text-ink-quiet'}`}>{t('Pipeline value', 'قيمة قيد المعالجة')}</p>
                      <p className="mt-1 text-[20px] font-semibold tabular-nums"><bdi>{sar(i === 0 ? pipeline : approvedValue)}</bdi> <span className="text-xs font-normal">SAR</span></p>
                    </div>
                    <span aria-hidden className={`inline-flex size-[35px] items-center justify-center rounded-[6px] ${dark ? 'bg-white/20' : 'bg-brand-wash text-brand'}`}><Icon name="store" size={18} /></span>
                  </div>
                  <div className="grid grid-cols-2 gap-4 px-[26px]">
                    <div className="min-w-0"><p className={`text-xs ${dark ? 'text-white/70' : 'text-ink-quiet'}`}>{t('PRODUCT', 'المنتج')}</p><p className="mt-0.5 truncate text-[15px] font-semibold">{arabic ? entry.nameAr : entry.nameEn}</p></div>
                    <div className="min-w-0"><p className={`text-xs ${dark ? 'text-white/70' : 'text-ink-quiet'}`}>{t('BOARD RULING', 'قرار الهيئة')}</p><p className="mt-0.5 truncate text-[15px] font-semibold"><span className="identifier">{entry.boardRulingRef ?? '—'}</span></p></div>
                  </div>
                  <div className={`flex h-[70px] items-center justify-between px-[26px] ${dark ? 'bg-[linear-gradient(180deg,rgba(255,255,255,0.15)_0%,rgba(255,255,255,0)_100%)]' : 'border-t border-line-strong'}`}>
                    <span className="identifier text-[22px] font-semibold">{entry.productCode}</span>
                    <span className={`text-xs ${dark ? 'text-white/80' : 'text-ink-quiet'}`}>{i === 0 ? `${String(openCount)} ${t('open', 'مفتوح')}` : `${String(count('APPROVED'))} ${t('approved', 'معتمد')}`}</span>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
        <div className="min-w-0">
          {sectionTitle('Recent requests', 'أحدث الطلبات')}
          <Card>
            {recent.length === 0 ? <p className="text-sm text-ink-quiet">{t('No requests yet.', 'لا توجد طلبات بعد.')}</p> : (
              <ul className="flex list-none flex-col gap-[10px] p-0">
                {recent.map((r) => (
                  <li key={r.requestId}>
                    <a href={`/${segment}/requests/${r.requestId}`} className="press flex items-center gap-4 rounded-tile py-1 hover:bg-sunken">
                      <span aria-hidden className={`inline-flex size-[55px] shrink-0 items-center justify-center rounded-full ${disc[r.channel].bg}`}><Icon name={disc[r.channel].icon} size={24} /></span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[16px] font-medium text-ink">{r.counterpartyId}</span>
                        <span className="text-[15px] text-ink-quiet"><bdi>{dateOf(r.raisedAtEpochSeconds)}</bdi></span>
                      </span>
                      <span className={`text-[16px] font-medium tabular-nums ${r.state === 'REJECTED' ? 'text-blocked' : r.state === 'APPROVED' ? 'text-positive' : 'text-ink'}`}><bdi>{sar(r.amountMinorUnits)}</bdi></span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </section>

      {/* -- Row 2: weekly activity and share by channel ----------------------------- */}
      <section className="grid gap-8 xl:grid-cols-[minmax(0,730fr)_minmax(0,350fr)]">
        <div className="min-w-0">
          {sectionTitle('Weekly activity', 'النشاط الأسبوعي')}
          <Card><WeekBars title={t('Requests raised and decided, last seven days', 'الطلبات المرفوعة والمقرَّرة خلال سبعة أيام')} series={[t('Raised', 'مرفوعة'), t('Decided', 'مقرَّرة')]} bars={bars} emptyLabel={t('No activity in the last seven days.', 'لا نشاط خلال الأيام السبعة الأخيرة.')} /></Card>
        </div>
        <div className="min-w-0">
          {sectionTitle('Requests by channel', 'الطلبات حسب القناة')}
          <Card><SharePie title={t('Share of requests by channel', 'حصة الطلبات حسب القناة')} slices={slices} otherLabel={t('Other', 'أخرى')} emptyLabel={t('No requests yet.', 'لا توجد طلبات بعد.')} /></Card>
        </div>
      </section>

      {/* -- Row 3: quick actions and pipeline history -------------------------------- */}
      <section className="grid gap-8 xl:grid-cols-[minmax(0,445fr)_minmax(0,635fr)]">
        <div className="min-w-0">
          {sectionTitle('Quick actions', 'إجراءات سريعة')}
          <Card>
            <ul className="flex list-none justify-between gap-2 p-0">
              {[
                { href: '/originate', icon: 'key-in' as const, en: 'Key a request', ar: 'إدخال طلب', sub: awaitingReview > 0 ? `${String(awaitingReview)} ${t('to review', 'للمراجعة')}` : t('maker', 'مُدخِل') },
                { href: '/queue', icon: 'queue' as const, en: 'Review queue', ar: 'قائمة المراجعة', sub: t('checker', 'مُراجِع') },
                { href: '/products', icon: 'store' as const, en: 'Products', ar: 'المنتجات', sub: t('catalogue', 'الكتالوج') },
              ].map((a) => (
                <li key={a.href} className="flex-1">
                  <a href={`/${segment}${a.href}`} className="press group flex flex-col items-center gap-3 text-center">
                    <span className="inline-flex size-[70px] items-center justify-center rounded-full bg-brand-wash text-brand transition-colors group-hover:bg-brand group-hover:text-white"><Icon name={a.icon} size={28} /></span>
                    <span className="text-[16px] font-medium text-ink">{t(a.en, a.ar)}</span>
                    <span className="-mt-2 text-[15px] text-ink-quiet">{a.sub}</span>
                  </a>
                </li>
              ))}
            </ul>
            <form action={`/${segment}`} method="get" className="mt-7 flex items-center gap-4">
              <label htmlFor="find" className="shrink-0 text-[16px] text-ink-quiet">{t('Find a request', 'ابحث عن طلب')}</label>
              <div className="flex h-[50px] flex-1 items-center rounded-pill bg-field ps-6 pe-1">
                <input id="find" name="q" defaultValue={term} placeholder="req_00001" className="identifier w-full min-w-0 bg-transparent text-[16px] text-ink outline-none placeholder:text-ink-quiet" />
                <button type="submit" className="press inline-flex h-[42px] items-center gap-2 rounded-pill bg-brand px-6 text-[16px] font-medium text-white hover:bg-brand-deep">{t('Open', 'فتح')} <Icon name="send" size={18} /></button>
              </div>
            </form>
          </Card>
        </div>
        <div className="min-w-0">
          {sectionTitle('Pipeline history', 'تاريخ قيمة المعالجة')}
          <Card><AreaTrend title={t('Value raised per month, thousands of SAR', 'القيمة المرفوعة شهرياً بآلاف الريالات')} points={months} unit={t('k SAR', 'ألف ريال')} emptyLabel={t('No history yet.', 'لا يوجد تاريخ بعد.')} /></Card>
        </div>
      </section>

      {/* -- The working table --------------------------------------------------------- */}
      <section>
        <div className="mb-5 flex items-baseline justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="text-h2 font-semibold text-heading">{t('Requests', 'الطلبات')}</h2>
            <a href={`/${segment}/queue`} className="text-sm text-brand hover:underline">{t('Open the review queue', 'فتح قائمة المراجعة')}</a>
          </div>
          {term === '' ? <span className="text-sm text-ink-quiet tabular-nums">{queue.length} {t('total', 'إجمالاً')}</span> : (
            <span className="flex items-center gap-2 text-sm text-ink-quiet"><span className="tabular-nums">{queue.length} {t('of', 'من')} {all.length}</span><span className="rounded-full bg-sunken px-2 py-0.5 text-xs"><bdi>{term}</bdi></span><a href={`/${segment}`} className="text-brand hover:underline">{t('clear', 'إلغاء التصفية')}</a></span>
          )}
        </div>
        <Card>
          {queue.length === 0 ? <p className="text-sm text-ink-quiet">{term === '' ? t('No requests yet.', 'لا توجد طلبات بعد.') : t('No request matches that search.', 'لا يطابق البحث أي طلب.')}</p> : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[15px]">
                <thead>
                  <tr className="border-b border-line text-start text-[13px] text-ink-quiet">
                    <th className="py-3 pe-3 text-start font-medium">{t('Request', 'الطلب')}</th>
                    <th className="py-3 pe-3 text-start font-medium">{t('Counterparty', 'العميل')}</th>
                    <th className="py-3 pe-3 text-start font-medium">{t('Invoice', 'الفاتورة')}</th>
                    <th className="py-3 pe-3 text-end font-medium">{t('Amount', 'المبلغ')}</th>
                    <th className="py-3 pe-3 text-start font-medium">{t('Channel', 'القناة')}</th>
                    <th className="py-3 pe-3 text-start font-medium">{t('Status', 'الحالة')}</th>
                    <th className="py-3 text-end font-medium">{t('Action', 'إجراء')}</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.map((item) => (
                    <tr key={item.requestId} className={`border-b border-line last:border-b-0 ${item.state === 'AWAITING_REVIEW' ? 'bg-brand-wash/40' : ''}`}>
                      <td className="py-3 pe-3"><span className="identifier text-ink-quiet">{item.requestId}</span></td>
                      <td className="py-3 pe-3 font-medium text-ink">{item.counterpartyId}</td>
                      <td className="py-3 pe-3"><span className="identifier text-ink-quiet">{item.invoiceNumber}</span></td>
                      <td className="py-3 pe-3 text-end tabular-nums"><bdi>{sar(item.amountMinorUnits)}</bdi></td>
                      <td className="py-3 pe-3 text-ink-quiet">{item.channel.replaceAll('_', ' ').toLowerCase()}</td>
                      <td className="py-3 pe-3"><Status tone={item.state === 'APPROVED' ? 'settled' : item.state === 'REJECTED' ? 'blocked' : 'progress'} label={item.state.replaceAll('_', ' ').toLowerCase()} /></td>
                      <td className="py-3 text-end"><a href={`/${segment}/requests/${item.requestId}`} className="press inline-flex h-[35px] items-center rounded-pill border border-brand px-5 text-[15px] font-medium text-brand hover:bg-brand hover:text-white">{t('Open', 'فتح')}</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-4 text-xs text-ink-quiet">{t('There is no rate column. The Murabaha equivalent is the profit amount, shown with the offer when a request is opened.', 'لا يوجد عمود لنسبة العائد. البديل في المرابحة هو مبلغ الربح، ويظهر مع العرض عند فتح الطلب.')}</p>
        </Card>
      </section>

      {/* -- Compliance indicators (SDD §4.10) ----------------------------------------- */}
      <section>
        {sectionTitle('Compliance indicators', 'مؤشرات الالتزام الشرعي')}
        <Card>
          <p className="text-xs text-ink-quiet">{t('These populate once transactions execute. Zero here is a real zero, not a placeholder.', 'تُملأ هذه المؤشرات بعد تنفيذ أول معاملة. الصفر هنا صفر حقيقي.')}</p>
          <ul className="mt-2 grid list-none gap-x-8 p-0 md:grid-cols-2">
            <Indicator label={t('Gate blocks', 'بوابات مُنعت')} note="SH-05 · SH-06" value="0" tone="neutral" />
            <Indicator label={t('Evidence completeness', 'اكتمال الأدلة')} note="SDD §4.10" value="—" tone="neutral" />
            <Indicator label={t('Open Shariah incidents', 'مخالفات شرعية مفتوحة')} note="BR-F04" value="0" tone="good" />
            <Indicator label={t('Template drift detections', 'انحراف القوالب')} note="BR-F07" value="0" tone="good" />
            <Indicator label={t('Charity liability balance', 'رصيد حساب الخير')} note="SH-13" value="0.00" tone="neutral" />
            <Indicator label={t('Questions with the Board', 'أسئلة معلّقة لدى الهيئة')} note="OI-22 · OI-23 · OI-24" value="3" tone="warning" />
          </ul>
        </Card>
      </section>
    </div>
  );
}
