/**
 * BNPL loans: each purchase booked as a loan in the institution's loan system
 * and serviced there.
 *
 * The loan system holds the schedule; this screen shows its position for the
 * chosen date, never a schedule of Sanad's own. Sanad's part is what only it
 * knows: the channel the shopper chose to pay through, the collections it
 * queued and their results, the repayments it posted into the loan, and what
 * it reported. A loan system or rail answering from the demonstration
 * transport is labelled Fixture wherever it appears.
 */
import { notFound } from 'next/navigation';

import { loadTenantJurisdiction } from '@sanad/config/loader.ts';
import type { CollectionChannel } from '@sanad/core/jurisdiction/profile.ts';
import type { InstalmentStanding } from '@sanad/core/ports/loan-servicing.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Card,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  Status,
  Tile,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { civilDateOf } from '@sanad/origination/civil-date.ts';
import { type StoredLoanEvent, dueDatesOf } from '@sanad/origination/consumer-loans.ts';

import { bookConsumerLoanAction, serviceConsumerLoanAction } from '../../../server/consumer-loan-actions.ts';
import { consumerLoanPositionFor, consumerLoans, consumerLoansAvailable } from '../../../server/consumer-loans.ts';
import { pageStaff } from '../../../server/session.ts';
import { Gate, authorityRefusal } from '../Gate.tsx';

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
  NOT_DUE: { tone: 'available', en: 'not due', ar: 'غير مستحق' },
  DUE: { tone: 'progress', en: 'due', ar: 'مستحق' },
  PAID: { tone: 'settled', en: 'paid', ar: 'مدفوع' },
  OVERDUE: { tone: 'blocked', en: 'overdue', ar: 'متأخر' },
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
  const numerals = defaultNumerals(locale);
  const profile = loadTenantJurisdiction(staff.tenantId);
  const code = profile.ok ? profile.value.code : 'SA';
  const available = consumerLoansAvailable();
  const loans = await consumerLoans(staff.tenantId);
  const selected = loans.find((l) => l.loan.loanRef === q['loan']) ?? loans[0];
  const today = civilDateOf(staff.tenantId, { epochSeconds: BigInt(Math.floor(Date.now() / 1000)) });
  const asOf = q['asOf'] !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(q['asOf']) ? q['asOf'] : today;
  const booking = selected?.events.find((e) => e.kind === 'BOOKED_IN_LOAN_SYSTEM');
  const position =
    selected !== undefined && booking !== undefined
      ? await consumerLoanPositionFor(staff.tenantId, selected.loan.loanRef, asOf)
      : undefined;
  const channelLabel = (c: CollectionChannel): string => {
    const l = CHANNEL[code][c];
    return l === undefined ? c : arabic ? l.ar : l.en;
  };
  const sum = (s: string | undefined): number => (s === undefined ? 0 : Number.parseInt(s, 10) || 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-h2 font-semibold text-heading">{t('BNPL loans', 'قروض اشترِ الآن وادفع لاحقاً')}</h2>
        <p className="mt-1 text-[15px] text-ink-quiet">
          {t(
            'Each purchase is booked as a loan in the institution’s loan system, which holds its schedule. SANAD collects each instalment through the channel the shopper chose, posts it into the loan, and reports what is overdue.',
            'تُسجَّل كل عملية شراء قرضاً في نظام القروض لدى المؤسسة، وهو الذي يحفظ جدولها. يحصّل «سند» كل قسط عبر القناة التي اختارها المتسوّق، ويقيّده على القرض، ويُبلغ عن المتأخر.',
          )}
        </p>
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
        <>
          <section className="grid gap-[30px] sm:grid-cols-2 2xl:grid-cols-4">
            <Tile icon="document" disc="blue" label={t('Loans', 'القروض')} value={loans.length} />
            <Tile
              icon="shield-check"
              disc="teal"
              label={t('Booked in the loan system', 'مسجّلة في نظام القروض')}
              value={loans.filter((l) => l.events.some((e) => e.kind === 'BOOKED_IN_LOAN_SYSTEM')).length}
            />
            <Tile
              icon="document"
              disc="pink"
              label={t('With an overdue instalment', 'بقسط متأخر')}
              value={
                loans.filter(
                  (l) =>
                    l.events.some((e) => e.kind === 'INSTALMENT_OVERDUE') &&
                    !l.events.some((e) => e.kind === 'LOAN_CLOSED'),
                ).length
              }
            />
            <Tile
              icon="store"
              disc="yellow"
              label={t('Paid in full', 'مسددة بالكامل')}
              value={loans.filter((l) => l.events.some((e) => e.kind === 'LOAN_CLOSED')).length}
            />
          </section>

          <Card>
            <table className="w-full text-start text-[14px]">
              <thead className="text-ink-quiet">
                <tr>
                  <th className="py-2 text-start font-medium">{t('Loan', 'القرض')}</th>
                  <th className="py-2 text-start font-medium">{t('Purchase', 'المشتريات')}</th>
                  <th className="py-2 text-start font-medium">{t('Paid through', 'قناة السداد')}</th>
                  <th className="py-2 text-start font-medium">{t('Loan system', 'نظام القروض')}</th>
                </tr>
              </thead>
              <tbody>
                {loans.map((l) => {
                  const b = l.events.find((e) => e.kind === 'BOOKED_IN_LOAN_SYSTEM');
                  const active = l.loan.loanRef === selected?.loan.loanRef;
                  return (
                    <tr key={l.loan.loanRef} className={`border-t border-line ${active ? 'bg-brand-wash' : ''}`}>
                      <td className="py-2">
                        <a
                          className="font-semibold text-brand"
                          href={`/${segment}/bnpl?loan=${l.loan.loanRef}&asOf=${asOf}`}
                        >
                          {l.loan.loanRef}
                        </a>
                      </td>
                      <td className="py-2">
                        {formatMinorUnits(
                          { minorUnits: l.loan.principalMinorUnits, currency: l.loan.currency },
                          numerals,
                        )}{' '}
                        {l.loan.currency} · {String(l.loan.numberOfInstalments)} × {cadenceLabel(l.loan, t)}
                      </td>
                      <td className="py-2">{channelLabel(l.loan.collectionChannel)}</td>
                      <td className="py-2">
                        {b === undefined ? (
                          <span className="text-ink-quiet">{t('not booked yet', 'لم يُسجَّل بعد')}</span>
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            {b.detail['loanAccountNumber']}
                            {b.detail['source'] === 'FIXTURE' ? <FixtureBadge arabic={arabic} /> : null}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {selected === undefined ? null : (
            <Card>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <h3 className="text-[18px] font-semibold text-heading">
                    {t('Loan', 'القرض')} {selected.loan.loanRef}
                  </h3>
                  <p className="mt-1 text-[14px] text-ink-quiet">
                    {formatMinorUnits(
                      { minorUnits: selected.loan.principalMinorUnits, currency: selected.loan.currency },
                      numerals,
                    )}{' '}
                    {selected.loan.currency} · {t('first instalment due', 'أول قسط في')} {selected.loan.firstDueDate} ·{' '}
                    {channelLabel(selected.loan.collectionChannel)} ({selected.loan.collectionMandateRef})
                  </p>
                </div>
                {booking === undefined ? (
                  <Gate staff={staff} act="CONSUMER_LOAN_SERVICE" arabic={arabic}>
                    <form action={bookConsumerLoanAction}>
                      <input type="hidden" name="locale" value={segment} />
                      <input type="hidden" name="loanRef" value={selected.loan.loanRef} />
                      <button type="submit" className={BUTTON_PRIMARY}>
                        {t('Book in the loan system', 'سجّل في نظام القروض')}
                      </button>
                    </form>
                  </Gate>
                ) : (
                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[14px]">
                    <dt className="text-ink-quiet">{t('Loan account', 'حساب القرض')}</dt>
                    <dd className="inline-flex items-center gap-2">
                      {booking.detail['loanAccountNumber']}
                      {booking.detail['source'] === 'FIXTURE' ? <FixtureBadge arabic={arabic} /> : null}
                    </dd>
                    <dt className="text-ink-quiet">{t('Product in the loan system', 'المنتج في نظام القروض')}</dt>
                    <dd>{booking.detail['loanTypeCode']}</dd>
                    <dt className="text-ink-quiet">{t('Servicing account', 'حساب الخدمة')}</dt>
                    <dd>{booking.detail['servicingAccountRef']}</dd>
                    {booking.detail['loanState'] === 'AWAITING_ACTIVATION' ? (
                      <>
                        <dt className="text-ink-quiet">{t('State in the loan system', 'الحالة في نظام القروض')}</dt>
                        <dd>
                          {t(
                            'Awaiting activation: the loan system’s own review and disbursement steps are still to run',
                            'بانتظار التفعيل: لم تكتمل بعد خطوات المراجعة والصرف في نظام القروض',
                          )}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                )}
              </div>

              <form action={serviceConsumerLoanAction} className="mt-6 flex flex-wrap items-end gap-4">
                <input type="hidden" name="locale" value={segment} />
                <input type="hidden" name="loanRef" value={selected.loan.loanRef} />
                <label className="flex flex-col gap-1">
                  <span className={FIELD_LABEL}>{t('Service as at', 'الخدمة بتاريخ')}</span>
                  <input type="date" name="asOf" defaultValue={asOf} className={FIELD_INPUT} />
                </label>
                <label className="flex items-center gap-2 text-[14px] text-ink">
                  <input
                    type="checkbox"
                    name="simulateRailResults"
                    value="yes"
                    defaultChecked
                    className="size-5 accent-brand"
                  />
                  {t('Rails answer at once (Fixture)', 'تجيب القنوات فوراً (تجريبي)')}
                </label>
                <button type="submit" className={BUTTON_SECONDARY}>
                  {t('Run servicing for this date', 'شغّل الخدمة لهذا التاريخ')}
                </button>
                <span className="flex gap-2 text-[13px] text-ink-quiet">
                  {dueDatesOf(selected.loan).map((date) => (
                    <a
                      key={date}
                      className="text-brand"
                      href={`/${segment}/bnpl?loan=${selected.loan.loanRef}&asOf=${date}`}
                    >
                      {date}
                    </a>
                  ))}
                </span>
              </form>

              {position === undefined ? null : !position.ok ? (
                <div className="mt-6">
                  <ControlRejection
                    control={position.error.control}
                    explanation={position.error.detail}
                    controlLabel={t('Control', 'الضابط')}
                  />
                </div>
              ) : (
                <div className="mt-6">
                  <h4 className="flex items-center gap-2 text-[15px] font-semibold text-heading">
                    {t('Instalments in the loan system, as at', 'الأقساط في نظام القروض بتاريخ')} {asOf}
                    {position.value.source === 'FIXTURE' ? <FixtureBadge arabic={arabic} /> : null}
                  </h4>
                  <table className="mt-3 w-full text-start text-[14px]">
                    <thead className="text-ink-quiet">
                      <tr>
                        <th className="py-2 text-start font-medium">#</th>
                        <th className="py-2 text-start font-medium">{t('Due', 'الاستحقاق')}</th>
                        <th className="py-2 text-start font-medium">{t('Instalment', 'القسط')}</th>
                        <th className="py-2 text-start font-medium">{t('Paid', 'المدفوع')}</th>
                        <th className="py-2 text-start font-medium">{t('Outstanding', 'المتبقي')}</th>
                        <th className="py-2 text-start font-medium">{t('Standing', 'الحالة')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {position.value.position.instalments.map((i) => (
                        <tr key={i.number} className="border-t border-line">
                          <td className="py-2">{i.number}</td>
                          <td className="py-2">{i.dueDate}</td>
                          <td className="py-2">{formatMinorUnits(i.amount, numerals)}</td>
                          <td className="py-2">{formatMinorUnits(i.paid, numerals)}</td>
                          <td className="py-2">{formatMinorUnits(i.outstanding, numerals)}</td>
                          <td className="py-2">
                            <Status
                              tone={STANDING[i.standing].tone}
                              label={`${arabic ? STANDING[i.standing].ar : STANDING[i.standing].en}${i.daysPastDue > 0 ? ` · ${String(i.daysPastDue)} ${t('days', 'يوماً')}` : ''}`}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="mt-6">
                <h4 className="text-[15px] font-semibold text-heading">{t('What happened', 'ما حدث')}</h4>
                {selected.events.length === 0 ? (
                  <p className="mt-2 text-[14px] text-ink-quiet">{t('Nothing yet.', 'لا شيء بعد.')}</p>
                ) : (
                  <ol className="mt-2 flex flex-col gap-1 text-[14px]">
                    {selected.events.map((e) => (
                      <li key={e.sequence} className="flex flex-wrap gap-x-3 border-t border-line py-1.5">
                        <span className="font-medium text-ink">{arabic ? EVENT[e.kind].ar : EVENT[e.kind].en}</span>
                        {e.scheduleNumber === undefined ? null : (
                          <span className="text-ink-quiet">
                            {t('instalment', 'القسط')} {e.scheduleNumber}
                          </span>
                        )}
                        {e.detail['minorUnits'] !== undefined && e.detail['currency'] !== undefined ? (
                          <span className="text-ink-quiet">
                            {formatMinorUnits(
                              { minorUnits: BigInt(e.detail['minorUnits']), currency: e.detail['currency'] as 'SAR' },
                              numerals,
                            )}{' '}
                            {e.detail['currency']}
                          </span>
                        ) : null}
                        {e.detail['eventKind'] !== undefined ? (
                          <span className="text-ink-quiet">{e.detail['eventKind']}</span>
                        ) : null}
                        {e.detail['transactionRef'] !== undefined ? (
                          <span className="text-ink-quiet">{e.detail['transactionRef']}</span>
                        ) : null}
                        {e.detail['reason'] !== undefined ? (
                          <span className="text-attention">{e.detail['reason']}</span>
                        ) : null}
                        {e.detail['source'] === 'FIXTURE' ? <FixtureBadge arabic={arabic} /> : null}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
