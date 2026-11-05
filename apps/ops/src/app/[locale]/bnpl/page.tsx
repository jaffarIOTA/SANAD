/**
 * BNPL loans: each purchase booked as a loan in the institution's loan system
 * and serviced there.
 *
 * Laid out as a list beside a detail panel (the pattern of Airwallex's and
 * Midday's transaction screens, chosen 2026-11-04): the list on the
 * reading-start side with filter chips, a progress bar per loan and its
 * stage; the chosen loan on the reading-end side, its amount first, the one
 * action it needs next, where it is in its life, its instalments as cards and
 * what has happened to it.
 *
 * The loan system holds the schedule; this screen shows its position for the
 * chosen date, never a schedule of Sanad's own. Sanad's part is what only it
 * knows: the channel the shopper chose to pay through, the collections it
 * queued and their results, the repayments it posted into the loan, and what
 * it reported. A loan system or rail answering from the demonstration
 * transport is labelled Fixture wherever it appears.
 */
import { notFound } from 'next/navigation';
import type { ReactElement, ReactNode } from 'react';

import { loadTenantJurisdiction } from '@sanad/config/loader.ts';
import type { CollectionChannel } from '@sanad/core/jurisdiction/profile.ts';
import type { InstalmentStanding } from '@sanad/core/ports/loan-servicing.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { Icon } from '@sanad/design/icons.tsx';
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Card,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  Status,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { civilDateOf } from '@sanad/origination/civil-date.ts';
import { type StoredLoanEvent, dueDatesOf } from '@sanad/origination/consumer-loans.ts';

import { bookConsumerLoanAction, serviceConsumerLoanAction } from '../../../server/consumer-loan-actions.ts';
import { consumerLoanPositionFor, consumerLoans, consumerLoansAvailable } from '../../../server/consumer-loans.ts';
import { pageStaff } from '../../../server/session.ts';
import { Gate, authorityRefusal } from '../Gate.tsx';
import {
  LOAN_FILTERS,
  type LoanFilter,
  type LoanStage,
  isLoanFilter,
  matchesFilter,
  standingOf,
} from './loan-standing.ts';

type Bilingual = { readonly en: string; readonly ar: string };

/** Each country's own scheme names; a channel its jurisdiction does not carry is never shown for it. */
const CHANNEL: Readonly<Record<'SA' | 'AE', Partial<Record<CollectionChannel, Bilingual>>>> = {
  SA: {
    BILL_PRESENTMENT: { en: 'SADAD bill', ar: 'فاتورة سداد' },
    CARD: { en: 'Card through the payments hub', ar: 'البطاقة عبر مركز المدفوعات' },
    PAYMENT_INITIATION: { en: 'Open Banking payment initiation', ar: 'بدء الدفع عبر المصرفية المفتوحة' },
    OWN_ACCOUNT: { en: 'Own account, debited by the loan system', ar: 'حساب العميل لدينا، يخصمه نظام القروض' },
  },
  AE: {
    DIRECT_DEBIT: { en: 'Direct debit (UAEDDS) via the partner bank', ar: 'الخصم المباشر عبر البنك الشريك' },
    CARD: { en: 'Card through the partner bank', ar: 'البطاقة عبر البنك الشريك' },
    PAYMENT_INITIATION: { en: 'Open Finance payment initiation', ar: 'بدء الدفع عبر التمويل المفتوح' },
    OWN_ACCOUNT: { en: 'Own account, debited by the loan system', ar: 'حساب العميل لدينا، يخصمه نظام القروض' },
  },
};

const STANDING: Readonly<
  Record<InstalmentStanding, { readonly tone: 'available' | 'progress' | 'settled' | 'blocked' } & Bilingual>
> = {
  NOT_DUE: { tone: 'progress', en: 'Upcoming', ar: 'قادم' },
  DUE: { tone: 'available', en: 'Due', ar: 'مستحق' },
  PAID: { tone: 'settled', en: 'Paid', ar: 'مدفوع' },
  OVERDUE: { tone: 'blocked', en: 'Overdue', ar: 'متأخر' },
};

const STAGE: Readonly<
  Record<LoanStage, { readonly tone: 'available' | 'progress' | 'settled' | 'blocked' } & Bilingual>
> = {
  NOT_BOOKED: { tone: 'progress', en: 'Not booked', ar: 'لم يُسجَّل' },
  AWAITING_ACTIVATION: { tone: 'available', en: 'Awaiting activation', ar: 'بانتظار التفعيل' },
  ACTIVE: { tone: 'available', en: 'Active', ar: 'نشط' },
  OVERDUE: { tone: 'blocked', en: 'Overdue', ar: 'متأخر' },
  PAID_IN_FULL: { tone: 'settled', en: 'Paid in full', ar: 'مسدد بالكامل' },
};

const FILTER_LABEL: Readonly<Record<LoanFilter, Bilingual>> = {
  ALL: { en: 'All', ar: 'الكل' },
  NOT_BOOKED: { en: 'Not booked', ar: 'لم تُسجَّل' },
  ACTIVE: { en: 'Active', ar: 'نشطة' },
  OVERDUE: { en: 'Overdue', ar: 'متأخرة' },
  PAID_IN_FULL: { en: 'Paid in full', ar: 'مسددة' },
};

const EVENT: Readonly<Record<StoredLoanEvent['kind'], Bilingual>> = {
  BOOKED_IN_LOAN_SYSTEM: { en: 'Booked in the loan system', ar: 'سُجّل في نظام القروض' },
  COLLECTION_QUEUED: { en: 'Collection queued', ar: 'أُدرج التحصيل' },
  COLLECTION_SETTLED: { en: 'Collection settled', ar: 'سُوّي التحصيل' },
  COLLECTION_RETURNED: { en: 'Collection returned', ar: 'أُعيد التحصيل' },
  REPAYMENT_POSTED: { en: 'Repayment posted into the loan', ar: 'قُيّد السداد على القرض' },
  INSTALMENT_OVERDUE: { en: 'Overdue: bureau told, customer reminded', ar: 'متأخر: أُبلغ المكتب ونُبّه العميل' },
  LOAN_CLOSED: { en: 'Paid in full: bureau told', ar: 'سُدّد بالكامل: أُبلغ المكتب' },
};

/** The mark beside each activity entry: what kind of thing happened, never only by colour. */
const EVENT_TONE: Readonly<Record<StoredLoanEvent['kind'], string>> = {
  BOOKED_IN_LOAN_SYSTEM: 'bg-brand',
  COLLECTION_QUEUED: 'bg-line-strong',
  COLLECTION_SETTLED: 'bg-positive-mark',
  COLLECTION_RETURNED: 'bg-attention-mark',
  REPAYMENT_POSTED: 'bg-positive-mark',
  INSTALMENT_OVERDUE: 'bg-blocked-mark',
  LOAN_CLOSED: 'bg-positive-mark',
};

function FixtureBadge({ arabic }: { readonly arabic: boolean }) {
  return (
    <span
      className="inline-flex items-center rounded-pill border border-attention/40 bg-attention-wash px-2 py-0.5 text-[11px] font-semibold text-attention"
      title={
        arabic
          ? 'أجابت عنه بيئة العرض التجريبي لا الخدمة الفعلية'
          : 'Answered by the demonstration transport, not the live service'
      }
    >
      {arabic ? 'تجريبي' : 'Fixture'}
    </span>
  );
}

/** A reference, a date or a figure inside running text: isolated so the bidi algorithm cannot reorder it. */
function Ltr({ children, className = '' }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <bdi dir="ltr" className={className}>
      {children}
    </bdi>
  );
}

/** How far apart the instalments are, as the plan was disclosed. */
function cadenceLabel(
  loan: { readonly intervalDays?: number; readonly intervalMonths?: number },
  t: (en: string, ar: string) => string,
): string {
  if (loan.intervalMonths === undefined) return `${String(loan.intervalDays)} ${t('days', 'يوماً')}`;
  if (loan.intervalMonths === 1) return t('monthly', 'شهرياً');
  return `${String(loan.intervalMonths)} ${t('months', 'أشهر')}`;
}

export default async function BnplLoansPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<Readonly<Record<string, string | undefined>>>;
}) {
  const { locale: segment } = await params;
  const q = await searchParams;
  const staff = await pageStaff(segment);
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const b = (l: Bilingual): string => (arabic ? l.ar : l.en);
  const numerals = defaultNumerals(locale);
  // Gregorian in both languages: an Arabic Saudi locale would otherwise default to the Umm al-Qura calendar.
  const dateFormat = new Intl.DateTimeFormat(arabic ? 'ar-SA-u-ca-gregory' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const dateTimeFormat = new Intl.DateTimeFormat(arabic ? 'ar-SA-u-ca-gregory' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const count = new Intl.NumberFormat(arabic ? 'ar-SA' : 'en-GB');
  const day = (iso: string): string => dateFormat.format(new Date(`${iso}T00:00:00Z`));
  const gregorian = arabic ? 'ar-SA-u-ca-gregory' : 'en-GB';
  const tileDay = (iso: string): string =>
    new Intl.DateTimeFormat(gregorian, { day: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const tileMonth = (iso: string): string =>
    new Intl.DateTimeFormat(gregorian, { month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  const moment = (iso: string | undefined): string | undefined =>
    iso === undefined || Number.isNaN(Date.parse(iso)) ? undefined : dateTimeFormat.format(new Date(iso));

  const profile = loadTenantJurisdiction(staff.tenantId);
  const code = profile.ok ? profile.value.code : 'SA';
  const available = consumerLoansAvailable();
  const loans = (await consumerLoans(staff.tenantId)).map((view) => ({ ...view, standing: standingOf(view) }));
  const filter: LoanFilter = isLoanFilter(q['view']) ? q['view'] : 'ALL';
  const listed = loans.filter((l) => matchesFilter(l.standing.stage, filter));
  const selected = listed.find((l) => l.loan.loanRef === q['loan']) ?? listed[0];
  const today = civilDateOf(staff.tenantId, { epochSeconds: BigInt(Math.floor(Date.now() / 1000)) });
  const asOf = q['asOf'] !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(q['asOf']) ? q['asOf'] : today;
  const booking = selected?.events.find((e) => e.kind === 'BOOKED_IN_LOAN_SYSTEM');
  const position =
    selected !== undefined && booking !== undefined
      ? await consumerLoanPositionFor(staff.tenantId, selected.loan.loanRef, asOf)
      : undefined;
  const channelLabel = (c: CollectionChannel): string => {
    const l = CHANNEL[code][c];
    return l === undefined ? c : b(l);
  };
  const sum = (s: string | undefined): number => (s === undefined ? 0 : Number.parseInt(s, 10) || 0);
  const money = (minorUnits: bigint, currency: string): string =>
    `${formatMinorUnits({ minorUnits, currency: currency as 'SAR' }, numerals)} ${currency}`;
  const hrefFor = (over: { readonly loan?: string; readonly view?: LoanFilter; readonly asOf?: string }): string => {
    const p = new URLSearchParams();
    const v = over.view ?? filter;
    if (v !== 'ALL') p.set('view', v);
    const l = over.loan ?? selected?.loan.loanRef;
    if (l !== undefined && over.view === undefined) p.set('loan', l);
    p.set('asOf', over.asOf ?? asOf);
    return `/${segment}/bnpl?${p.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-h2 font-semibold text-heading">{t('BNPL loans', 'قروض اشترِ الآن وادفع لاحقاً')}</h2>
          <p className="mt-1 max-w-[70ch] text-[15px] text-ink-quiet">
            {t(
              'Each purchase is booked as a loan in the institution’s loan system, which holds its schedule. SANAD collects each instalment through the channel the shopper chose, posts it into the loan, and reports what is overdue.',
              'تُسجَّل كل عملية شراء قرضاً في نظام القروض لدى المؤسسة، وهو الذي يحفظ جدولها. يحصّل «سند» كل قسط عبر القناة التي اختارها المتسوّق، ويقيّده على القرض، ويُبلغ عن المتأخر.',
            )}
          </p>
        </div>
      </div>

      {q['control'] !== undefined ? (
        <ControlRejection
          control={q['control']}
          explanation={authorityRefusal(q['reason'], q['needs'], arabic) ?? q['message'] ?? q['reason'] ?? ''}
          controlLabel={t('Control', 'الضابط')}
        />
      ) : null}
      {q['done'] === 'SERVICED' ? (
        <p role="status" className="rounded-tile bg-disc-teal px-5 py-4 text-[15px] text-positive">
          {t(
            `Serviced for ${asOf}: ${String(sum(q['posted']))} repayment(s) posted into the loan, ${String(sum(q['queued']))} collection(s) queued, ${String(sum(q['settled']))} settled and ${String(sum(q['returned']))} returned by the rails, ${String(sum(q['overdue']))} instalment(s) reported overdue${q['closed'] === 'yes' ? '; the loan is paid in full' : ''}.`,
            `خُدم القرض بتاريخ ${asOf}: قُيّد ${String(sum(q['posted']))} سداد، وأُدرج ${String(sum(q['queued']))} تحصيل، سُوّي منها ${String(sum(q['settled']))} وأُعيد ${String(sum(q['returned']))}، وأُبلغ عن ${String(sum(q['overdue']))} قسط متأخر${q['closed'] === 'yes' ? '؛ وسُدّد القرض بالكامل' : ''}.`,
          )}
        </p>
      ) : q['done'] === 'BOOKED' ? (
        <p role="status" className="rounded-tile bg-disc-teal px-5 py-4 text-[15px] text-positive">
          {t('Booked in the loan system.', 'سُجّل في نظام القروض.')}
        </p>
      ) : null}

      {!available ? (
        <Card>
          <p className="text-[15px] text-ink">
            {t(
              'Consumer loans are kept in the database, and none is configured.',
              'تُحفظ القروض الاستهلاكية في قاعدة البيانات، ولا توجد قاعدة مهيأة.',
            )}
          </p>
        </Card>
      ) : loans.length === 0 ? (
        <Card>
          <p className="text-[15px] text-ink">
            {t('No BNPL purchase has been booked yet.', 'لم تُسجَّل أي عملية شراء بعد.')}
          </p>
        </Card>
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(400px,460px)]">
          {/* The list. */}
          <section
            aria-label={t('Loans', 'القروض')}
            className="card-lift min-w-0 overflow-hidden rounded-card bg-surface"
          >
            <nav
              aria-label={t('Filter loans', 'تصفية القروض')}
              className="flex flex-wrap gap-2 border-b border-line p-4"
            >
              {LOAN_FILTERS.map((f) => {
                const n = loans.filter((l) => matchesFilter(l.standing.stage, f)).length;
                const on = f === filter;
                return (
                  <a
                    key={f}
                    href={hrefFor({ view: f })}
                    aria-current={on ? 'true' : undefined}
                    className={`press inline-flex items-center gap-2 rounded-pill border px-3.5 py-1.5 text-[13px] font-medium ${
                      on
                        ? 'border-brand-deep bg-brand-deep text-on-brand'
                        : 'border-line-strong text-ink hover:bg-sunken'
                    }`}
                  >
                    {b(FILTER_LABEL[f])}
                    <span
                      className={`rounded-pill px-1.5 text-[11px] tabular-nums ${on ? 'bg-white/20' : 'bg-sunken text-ink-quiet'}`}
                    >
                      {count.format(n)}
                    </span>
                  </a>
                );
              })}
            </nav>
            {listed.length === 0 ? (
              <p className="p-6 text-[14px] text-ink-quiet">
                {t('No loan in this view.', 'لا توجد قروض في هذا العرض.')}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-start text-[14px]">
                  <thead className="bg-sunken/60 text-[12px] uppercase tracking-wide text-ink-quiet">
                    <tr>
                      <th className="px-4 py-2.5 text-start font-medium">{t('Loan', 'القرض')}</th>
                      <th className="px-4 py-2.5 text-end font-medium">{t('Amount', 'المبلغ')}</th>
                      <th className="px-4 py-2.5 text-start font-medium">{t('Repaid', 'المسدد')}</th>
                      <th className="px-4 py-2.5 text-start font-medium">{t('Next due', 'القسط التالي')}</th>
                      <th className="px-4 py-2.5 text-start font-medium">{t('Status', 'الحالة')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listed.map((l) => {
                      const s = l.standing;
                      const active = l.loan.loanRef === selected?.loan.loanRef;
                      const href = hrefFor({ loan: l.loan.loanRef });
                      const percent = s.planLength === 0 ? 0 : Math.round((s.paidCount * 100) / s.planLength);
                      // Every cell is a link to the same panel, so the whole row is the target without a script.
                      const cell = (children: ReactNode, className = '') => (
                        <td className="p-0">
                          <a href={href} tabIndex={-1} className={`block px-4 py-3 ${className}`}>
                            {children}
                          </a>
                        </td>
                      );
                      return (
                        <tr
                          key={l.loan.loanRef}
                          aria-selected={active}
                          className={`border-t border-line ${active ? 'bg-brand-wash shadow-[inset_3px_0_0_var(--color-brand)] rtl:shadow-[inset_-3px_0_0_var(--color-brand)]' : 'hover:bg-sunken/70'}`}
                        >
                          <td className="p-0">
                            <a href={href} aria-current={active ? 'true' : undefined} className="block px-4 py-3">
                              <span className="identifier block font-semibold text-heading">{l.loan.loanRef}</span>
                              <span className="block text-[12px] text-ink-quiet">
                                {channelLabel(l.loan.collectionChannel)}
                              </span>
                            </a>
                          </td>
                          {cell(
                            <>
                              <span className="block font-semibold tabular-nums text-heading">
                                <Ltr>{money(l.loan.principalMinorUnits, l.loan.currency)}</Ltr>
                              </span>
                              <span className="block text-[12px] text-ink-quiet">
                                {count.format(l.loan.numberOfInstalments)} × {cadenceLabel(l.loan, t)}
                              </span>
                            </>,
                            'text-end',
                          )}
                          {cell(
                            <span className="flex min-w-[110px] flex-col gap-1.5">
                              <span
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={s.planLength}
                                aria-valuenow={s.paidCount}
                                aria-label={t('Instalments repaid', 'الأقساط المسددة')}
                                className="h-1.5 overflow-hidden rounded-pill bg-sunken"
                              >
                                <span
                                  className={`block h-full rounded-pill ${s.stage === 'PAID_IN_FULL' ? 'bg-positive-mark' : s.stage === 'OVERDUE' ? 'bg-blocked-mark' : 'bg-brand'}`}
                                  style={{ inlineSize: `${String(percent)}%` }}
                                />
                              </span>
                              <span className="text-[12px] text-ink-quiet">
                                {arabic
                                  ? `${count.format(s.paidCount)} من ${count.format(s.planLength)} مسددة`
                                  : `${String(s.paidCount)} of ${String(s.planLength)} paid`}
                              </span>
                            </span>,
                          )}
                          {cell(
                            s.nextDue === undefined ? (
                              <span className="text-ink-faint">—</span>
                            ) : (
                              <span className="whitespace-nowrap text-ink">{day(s.nextDue)}</span>
                            ),
                          )}
                          {cell(<Status tone={STAGE[s.stage].tone} label={b(STAGE[s.stage])} />)}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* The chosen loan. */}
          {selected === undefined ? null : (
            <aside
              aria-label={`${t('Loan', 'القرض')} ${selected.loan.loanRef}`}
              className="card-lift min-w-0 overflow-hidden rounded-card bg-surface xl:sticky xl:top-[88px]"
            >
              <header className="border-b border-line p-6">
                <div className="flex items-center justify-between gap-3">
                  <span className="identifier text-[13px] font-medium text-ink-quiet">{selected.loan.loanRef}</span>
                  <Status tone={STAGE[selected.standing.stage].tone} label={b(STAGE[selected.standing.stage])} />
                </div>
                <p className="mt-3 text-[32px] font-semibold leading-tight tabular-nums text-heading">
                  <Ltr>{money(selected.loan.principalMinorUnits, selected.loan.currency)}</Ltr>
                </p>
                <p className="mt-1 text-[14px] text-ink-quiet">
                  {count.format(selected.loan.numberOfInstalments)} {t('instalments', 'أقساط')} ·{' '}
                  {cadenceLabel(selected.loan, t)} · {channelLabel(selected.loan.collectionChannel)}
                </p>
              </header>

              {booking === undefined ? (
                <div className="m-6 mb-0 flex flex-col gap-3 rounded-tile border border-attention/40 bg-attention-wash p-4">
                  <p className="flex items-start gap-2.5 text-[14px] text-ink">
                    <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-attention" />
                    <span>
                      <span className="block font-semibold text-heading">
                        {t('Not yet in the loan system', 'لم يُسجَّل بعد في نظام القروض')}
                      </span>
                      {t(
                        'The shopper accepted the plan. Book it so the loan system holds the schedule and collection can start.',
                        'قبِل المتسوّق الخطة. سجّلها ليحفظ نظام القروض الجدول ويبدأ التحصيل.',
                      )}
                    </span>
                  </p>
                  <Gate staff={staff} act="CONSUMER_LOAN_SERVICE" arabic={arabic}>
                    <form action={bookConsumerLoanAction}>
                      <input type="hidden" name="locale" value={segment} />
                      <input type="hidden" name="loanRef" value={selected.loan.loanRef} />
                      <button type="submit" className={BUTTON_PRIMARY}>
                        {t('Book in the loan system', 'سجّل في نظام القروض')}
                      </button>
                    </form>
                  </Gate>
                </div>
              ) : booking.detail['loanState'] === 'AWAITING_ACTIVATION' ? (
                <p className="m-6 mb-0 flex items-start gap-2.5 rounded-tile border border-line bg-sunken p-4 text-[14px] text-ink">
                  <Icon name="clock" size={18} className="mt-0.5 shrink-0 text-ink-quiet" />
                  {t(
                    'Awaiting activation: the loan system’s own review and disbursement steps are still to run.',
                    'بانتظار التفعيل: لم تكتمل بعد خطوات المراجعة والصرف في نظام القروض.',
                  )}
                </p>
              ) : null}

              <div className="flex flex-col gap-7 p-6">
                {/* Where it is in its life. */}
                <Stepper
                  steps={[
                    { label: t('Accepted', 'قُبل'), at: moment(selected.loan.createdAt), done: true },
                    {
                      label: t('Booked', 'سُجّل'),
                      at: moment(selected.standing.bookedAt),
                      done: booking !== undefined,
                    },
                    {
                      label: t('Active', 'نشط'),
                      done: ['ACTIVE', 'OVERDUE', 'PAID_IN_FULL'].includes(selected.standing.stage),
                    },
                    {
                      label: t('Paid in full', 'مسدد بالكامل'),
                      at: moment(selected.events.find((e) => e.kind === 'LOAN_CLOSED')?.createdAt),
                      done: selected.standing.stage === 'PAID_IN_FULL',
                    },
                  ]}
                />

                {/* The instalments: the loan system's position once booked; the disclosed dates before. */}
                <section>
                  <h3 className="flex items-center gap-2 text-[15px] font-semibold text-heading">
                    {position?.ok === true
                      ? t('Instalments in the loan system', 'الأقساط في نظام القروض')
                      : t('Instalment dates, as disclosed', 'مواعيد الأقساط كما أُفصح عنها')}
                    {position?.ok === true && position.value.source === 'FIXTURE' ? (
                      <FixtureBadge arabic={arabic} />
                    ) : null}
                  </h3>
                  {position?.ok === true ? (
                    <p className="mt-0.5 text-[12px] text-ink-quiet">
                      {t('As at', 'بتاريخ')} {day(asOf)}
                    </p>
                  ) : null}
                  {position !== undefined && !position.ok ? (
                    <div className="mt-3">
                      <ControlRejection
                        control={position.error.control}
                        explanation={position.error.detail}
                        controlLabel={t('Control', 'الضابط')}
                      />
                    </div>
                  ) : null}
                  <ol className="mt-3 flex list-none flex-col gap-2 p-0">
                    {position?.ok === true
                      ? (() => {
                          const next = position.value.position.instalments.find((i) => i.standing !== 'PAID')?.number;
                          return position.value.position.instalments.map((i) => (
                            <InstalmentCard
                              key={i.number}
                              date={i.dueDate}
                              day={day}
                              tileDay={tileDay}
                              tileMonth={tileMonth}
                              href={hrefFor({ asOf: i.dueDate })}
                              title={`${t('Instalment', 'القسط')} ${count.format(i.number)}`}
                              amount={<Ltr>{`${formatMinorUnits(i.amount, numerals)} ${i.amount.currency}`}</Ltr>}
                              sub={
                                i.paid.minorUnits > 0n && i.standing !== 'PAID' ? (
                                  <>
                                    {t('Outstanding', 'المتبقي')} <Ltr>{formatMinorUnits(i.outstanding, numerals)}</Ltr>
                                  </>
                                ) : undefined
                              }
                              badge={
                                <Status
                                  tone={
                                    i.number === next && i.standing === 'NOT_DUE'
                                      ? 'available'
                                      : STANDING[i.standing].tone
                                  }
                                  label={`${i.number === next && i.standing === 'NOT_DUE' ? t('Next', 'التالي') : b(STANDING[i.standing])}${i.daysPastDue > 0 ? ` · ${count.format(i.daysPastDue)} ${t('days', 'يوماً')}` : ''}`}
                                />
                              }
                              current={i.dueDate === asOf}
                            />
                          ));
                        })()
                      : dueDatesOf(selected.loan).map((date, n) => (
                          <InstalmentCard
                            key={date}
                            date={date}
                            day={day}
                            tileDay={tileDay}
                            tileMonth={tileMonth}
                            title={`${t('Instalment', 'القسط')} ${count.format(n + 1)}`}
                            sub={t('Amount set by the loan system once booked', 'يحدد نظام القروض المبلغ عند التسجيل')}
                          />
                        ))}
                  </ol>
                </section>

                {/* Servicing for a date. */}
                {booking === undefined ? null : (
                  <form
                    action={serviceConsumerLoanAction}
                    className="flex flex-col gap-3 rounded-tile border border-line bg-sunken/60 p-4"
                  >
                    <input type="hidden" name="locale" value={segment} />
                    <input type="hidden" name="loanRef" value={selected.loan.loanRef} />
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1">
                        <span className={FIELD_LABEL}>{t('Service as at', 'الخدمة بتاريخ')}</span>
                        <input type="date" name="asOf" defaultValue={asOf} className={FIELD_INPUT} />
                      </label>
                      <button type="submit" className={BUTTON_SECONDARY}>
                        {t('Run servicing', 'شغّل الخدمة')}
                      </button>
                    </div>
                    <label className="flex items-center gap-2 text-[13px] text-ink">
                      <input
                        type="checkbox"
                        name="simulateRailResults"
                        value="yes"
                        defaultChecked
                        className="size-4 accent-brand"
                      />
                      {t('Rails answer at once (Fixture)', 'تجيب القنوات فوراً (تجريبي)')}
                    </label>
                  </form>
                )}

                {/* Details. */}
                <section>
                  <h3 className="text-[15px] font-semibold text-heading">{t('Details', 'التفاصيل')}</h3>
                  <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-[14px]">
                    <Detail label={t('First instalment due', 'أول قسط في')}>{day(selected.loan.firstDueDate)}</Detail>
                    <Detail label={t('Paid through', 'قناة السداد')}>
                      {channelLabel(selected.loan.collectionChannel)}
                    </Detail>
                    <Detail label={t('Mandate', 'التفويض')}>
                      <Ltr className="identifier">{selected.loan.collectionMandateRef}</Ltr>
                    </Detail>
                    {booking === undefined ? null : (
                      <>
                        <Detail label={t('Loan account', 'حساب القرض')}>
                          <span className="inline-flex items-center gap-2">
                            <Ltr className="identifier">{booking.detail['loanAccountNumber']}</Ltr>
                            {booking.detail['source'] === 'FIXTURE' ? <FixtureBadge arabic={arabic} /> : null}
                          </span>
                        </Detail>
                        <Detail label={t('Product in the loan system', 'المنتج في نظام القروض')}>
                          <Ltr className="identifier">{booking.detail['loanTypeCode']}</Ltr>
                        </Detail>
                        <Detail label={t('Servicing account', 'حساب الخدمة')}>
                          <Ltr className="identifier">{booking.detail['servicingAccountRef']}</Ltr>
                        </Detail>
                      </>
                    )}
                  </dl>
                </section>

                {/* What happened, newest first. */}
                <section>
                  <h3 className="text-[15px] font-semibold text-heading">{t('Activity', 'السجل')}</h3>
                  <ol className="mt-3 flex list-none flex-col p-0">
                    {[...selected.events].reverse().map((e) => (
                      <ActivityItem
                        key={e.sequence}
                        mark={EVENT_TONE[e.kind]}
                        title={b(EVENT[e.kind])}
                        at={moment(e.createdAt)}
                      >
                        {e.scheduleNumber === undefined ? null : (
                          <span>
                            {t('instalment', 'القسط')} {count.format(e.scheduleNumber)}
                          </span>
                        )}
                        {e.detail['minorUnits'] !== undefined && e.detail['currency'] !== undefined ? (
                          <Ltr>{money(BigInt(e.detail['minorUnits']), e.detail['currency'])}</Ltr>
                        ) : null}
                        {e.detail['eventKind'] !== undefined ? <span>{e.detail['eventKind']}</span> : null}
                        {e.detail['transactionRef'] !== undefined ? (
                          <Ltr className="identifier">{e.detail['transactionRef']}</Ltr>
                        ) : null}
                        {e.detail['reason'] !== undefined ? (
                          <span className="text-attention">{e.detail['reason']}</span>
                        ) : null}
                        {e.detail['source'] === 'FIXTURE' ? <FixtureBadge arabic={arabic} /> : null}
                      </ActivityItem>
                    ))}
                    <ActivityItem
                      mark="bg-line-strong"
                      title={t('Plan accepted by the shopper', 'قبِل المتسوّق الخطة')}
                      at={moment(selected.loan.createdAt)}
                      last
                    />
                  </ol>
                </section>
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}

function Stepper({
  steps,
}: {
  readonly steps: readonly { readonly label: string; readonly at?: string | undefined; readonly done: boolean }[];
}): ReactElement {
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol
      className="grid list-none p-0"
      style={{ gridTemplateColumns: `repeat(${String(steps.length)}, minmax(0, 1fr))` }}
    >
      {steps.map((s, i) => (
        <li key={s.label} className="relative flex flex-col items-center gap-1.5 text-center">
          {i > 0 ? (
            <span
              aria-hidden
              // From the previous step's centre to this one's: half a column back from this centre, logical so it mirrors.
              className={`absolute end-1/2 top-[11px] h-0.5 w-full ${s.done ? 'bg-brand' : 'bg-line'}`}
            />
          ) : null}
          <span
            className={`relative z-[1] flex size-6 items-center justify-center rounded-full text-[11px] font-semibold ${
              s.done
                ? 'bg-brand text-on-brand'
                : i === current
                  ? 'border-2 border-brand bg-surface text-brand'
                  : 'border-2 border-line bg-surface text-ink-faint'
            }`}
          >
            {s.done ? <Icon name="check-circle" size={14} /> : null}
          </span>
          <span className={`text-[12px] font-medium ${s.done || i === current ? 'text-heading' : 'text-ink-faint'}`}>
            {s.label}
          </span>
          {s.at === undefined ? null : <span className="text-[11px] text-ink-quiet">{s.at}</span>}
        </li>
      ))}
    </ol>
  );
}

function InstalmentCard({
  date,
  day,
  tileDay,
  tileMonth,
  title,
  amount,
  sub,
  badge,
  href,
  current = false,
}: {
  readonly date: string;
  readonly day: (iso: string) => string;
  readonly tileDay: (iso: string) => string;
  readonly tileMonth: (iso: string) => string;
  readonly title: string;
  readonly amount?: ReactNode;
  readonly sub?: ReactNode;
  readonly badge?: ReactNode;
  readonly href?: string;
  readonly current?: boolean;
}): ReactElement {
  const tile = (
    <span className="flex size-12 shrink-0 flex-col items-center justify-center rounded-tile bg-brand-wash text-brand-deep">
      <span className="text-[17px] font-semibold leading-none tabular-nums">{tileDay(date)}</span>
      <span className="mt-0.5 text-[10px] uppercase">{tileMonth(date)}</span>
    </span>
  );
  const body = (
    <>
      {tile}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[14px] font-medium text-heading">{title}</span>
        <span className="text-[12px] text-ink-quiet">{day(date)}</span>
        {sub === undefined ? null : <span className="text-[12px] text-ink-quiet">{sub}</span>}
      </span>
      <span className="flex flex-col items-end gap-1">
        {amount === undefined ? null : (
          <span className="text-[14px] font-semibold tabular-nums text-heading">{amount}</span>
        )}
        {badge}
      </span>
    </>
  );
  const frame = `flex items-center gap-3 rounded-tile border p-3 ${current ? 'border-brand bg-brand-wash/40' : 'border-line'}`;
  return (
    <li>
      {href === undefined ? (
        <div className={frame}>{body}</div>
      ) : (
        <a href={href} className={`press ${frame} hover:border-line-strong`} title={day(date)}>
          {body}
        </a>
      )}
    </li>
  );
}

function Detail({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <>
      <dt className="text-ink-quiet">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </>
  );
}

function ActivityItem({
  mark,
  title,
  at,
  children,
  last = false,
}: {
  readonly mark: string;
  readonly title: string;
  readonly at?: string | undefined;
  readonly children?: ReactNode;
  readonly last?: boolean;
}): ReactElement {
  return (
    <li className="relative flex gap-3 pb-4">
      {last ? null : <span aria-hidden className="absolute start-[5px] top-4 h-full w-px bg-line" />}
      <span aria-hidden className={`relative mt-1.5 size-[11px] shrink-0 rounded-full ring-4 ring-surface ${mark}`} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-[14px] font-medium text-ink">{title}</span>
          {at === undefined ? null : <span className="text-[12px] text-ink-quiet">{at}</span>}
        </div>
        {children === undefined ? null : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-quiet">{children}</div>
        )}
      </div>
    </li>
  );
}
