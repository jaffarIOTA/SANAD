/**
 * Reconciliation with SADAD (Wasl W4b): the latest reading of SADAD's
 * paid-bills file — what it applied, what was already recorded, what belongs
 * to other products — and every bill it could not match, for operations to
 * resolve. The daily cycle reads it first each morning; finance can read it
 * now. Nothing here edits a receipt: an exception is resolved at its source.
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { TenantCode } from '@sanad/config/loader.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { BUTTON_PRIMARY } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import {
  RECONCILIATION_WINDOW_DAYS,
  type ReconciliationException,
  lastReconciliation,
} from '@sanad/origination/wasl/reconciliation.ts';

import { reconcileAction } from '../../../../server/transaction-actions.ts';
import { pageStaff } from '../../../../server/session.ts';
import { Gate } from '../../Gate.tsx';
import { PendingButton } from '../../business/PendingButton.tsx';
import { NOTICE, REFUSAL } from '../states.ts';

const EXCEPTION_WORDS: Readonly<Record<ReconciliationException['code'], readonly [string, string]>> = {
  TRANSACTION_NOT_FOUND: ['No such Wasl transaction', 'لا توجد معاملة وصل بهذا المرجع'],
  NOT_PRESENTED: ['No open bill for this instalment', 'لا توجد فاتورة مفتوحة لهذا القسط'],
  AMOUNT_DIFFERS: ['Paid amount differs from the bill', 'المبلغ المدفوع يختلف عن الفاتورة'],
  RECEIPT_REFUSED: ['The obligation refused the receipt', 'رفض الالتزام المبلغ المحصّل'],
};

export default async function ReconciliationPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly notice?: string; readonly reason?: string }>;
}): Promise<ReactElement> {
  const { locale: segment } = await params;
  const { notice, reason } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const numerals = defaultNumerals(locale);
  const staff = await pageStaff(segment);
  const report = staff.tenantId === undefined ? undefined : lastReconciliation(staff.tenantId as TenantCode);
  const said = notice === undefined ? undefined : NOTICE[notice];
  const refused = reason === undefined ? undefined : (REFUSAL[reason] ?? { en: reason, ar: reason });
  const when = (s: bigint) =>
    new Intl.DateTimeFormat(arabic ? 'ar-SA-u-ca-gregory' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Riyadh',
    }).format(new Date(Number(s) * 1000));

  return (
    <div className="flex flex-col gap-6" data-reconciliation>
      <div>
        <a href={`/${segment}/transactions`} className="text-[13px] text-brand hover:underline">
          {t('Transactions', 'المعاملات')}
        </a>
        <h1 className="mt-1 text-display font-bold tracking-tight text-heading">
          {t('Reconciliation with SADAD', 'المطابقة مع سداد')}
        </h1>
        <p className="mt-1 max-w-3xl text-[14px] text-ink-quiet">
          {t(
            `SADAD’s paid-bills file, read over the last ${String(RECONCILIATION_WINDOW_DAYS)} days and matched to the instalments presented. A receipt is recorded once, whether the webhook or the file brings it first. Anything that does not match exactly is listed here and never applied by guesswork.`,
            `ملف الفواتير المدفوعة من سداد، يُقرأ عن آخر ${new Intl.NumberFormat('ar-SA').format(RECONCILIATION_WINDOW_DAYS)} يومًا ويُطابق مع الأقساط المعروضة. يُسجّل المبلغ مرة واحدة سواء وصل أولًا عبر الإشعار أو عبر الملف. وما لا يتطابق تمامًا يُدرج هنا ولا يُطبّق بالتخمين.`,
          )}
        </p>
      </div>

      {said === undefined ? null : (
        <p className="rounded-card border border-positive/30 bg-positive-wash px-4 py-3 text-[14px] text-positive">
          {t(said.en, said.ar)}
        </p>
      )}
      {refused === undefined ? null : (
        <p className="rounded-card border border-blocked/30 bg-blocked-wash px-4 py-3 text-[14px] text-blocked">
          {t(refused.en, refused.ar)}
        </p>
      )}

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[14px] text-ink">
            {report === undefined
              ? t('Not read yet in this session.', 'لم يُقرأ بعد في هذه الجلسة.')
              : t(`Last read ${when(report.atEpochSeconds)}`, `آخر قراءة ${when(report.atEpochSeconds)}`)}
            {report?.source === 'FIXTURE' ? (
              <span className="ms-2 rounded-pill border border-attention/40 bg-attention-wash px-2 py-0.5 text-[11px] font-semibold text-attention">
                {t('Fixture', 'تجريبي')}
              </span>
            ) : null}
          </div>
          <Gate staff={staff} act="TRADE_SETTLEMENT" arabic={arabic}>
            <form action={reconcileAction}>
              <input type="hidden" name="locale" value={segment} />
              <PendingButton className={BUTTON_PRIMARY}>
                {t('Read SADAD’s paid-bills file now', 'قراءة ملف الفواتير المدفوعة الآن')}
              </PendingButton>
            </form>
          </Gate>
        </div>

        {report === undefined ? null : (
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5" data-reconciliation-counts>
            {(
              [
                ['Paid bills in the file', 'الفواتير المدفوعة في الملف', report.paidBills],
                ['Applied now', 'طُبّق الآن', report.applied.length],
                ['Already recorded', 'مسجّلة مسبقًا', report.alreadyRecorded],
                ['Other products', 'منتجات أخرى', report.otherBills],
                ['Exceptions', 'استثناءات', report.exceptions.length],
              ] as const
            ).map(([en, ar, n]) => (
              <div key={en} className="rounded-tile border border-line px-3 py-2">
                <dt className="text-[12px] text-ink-quiet">{t(en, ar)}</dt>
                <dd
                  className={`text-[20px] font-semibold tabular-nums ${en === 'Exceptions' && n > 0 ? 'text-attention' : 'text-heading'}`}
                >
                  {new Intl.NumberFormat(arabic ? 'ar-SA' : 'en-GB').format(n)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {report === undefined || report.applied.length === 0 ? null : (
        <section
          className="rounded-card border border-line bg-surface px-5 py-4 shadow-card"
          data-reconciliation-applied
        >
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Applied now', 'طُبّق الآن')}</h2>
          <ul className="divide-y divide-line text-[13px]">
            {report.applied.map((a) => (
              <li key={a.billNumber} className="flex flex-wrap items-center gap-3 py-2">
                <a
                  href={`/${segment}/transactions/${a.transactionRef}`}
                  className="identifier text-brand hover:underline"
                >
                  {a.transactionRef}
                </a>
                <bdi dir="ltr" className="identifier text-ink-quiet">
                  {a.billNumber}
                </bdi>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report === undefined || report.exceptions.length === 0 ? null : (
        <section
          className="overflow-x-auto rounded-card border border-attention/40 bg-surface px-5 py-4 shadow-card"
          data-reconciliation-exceptions
        >
          <h2 className="mb-1 text-[15px] font-semibold text-heading">
            {t('Exceptions for operations', 'استثناءات للعمليات')}
          </h2>
          <p className="mb-3 text-[12px] text-ink-quiet">
            {t(
              'Paid at SADAD but not applied. Resolve each with SADAD or on the transaction; the next reading applies it once it matches.',
              'مدفوعة لدى سداد ولم تُطبّق. عالج كلًا منها مع سداد أو على المعاملة، وتُطبّق القراءة التالية ما يتطابق.',
            )}
          </p>
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="text-start text-ink-quiet">
                <th className="py-1 text-start font-normal">{t('SADAD bill', 'فاتورة سداد')}</th>
                <th className="py-1 text-start font-normal">{t('Settlement', 'التسوية')}</th>
                <th className="py-1 text-start font-normal">{t('Transaction', 'المعاملة')}</th>
                <th className="py-1 text-start font-normal">{t('Why', 'السبب')}</th>
              </tr>
            </thead>
            <tbody>
              {report.exceptions.map((x) => {
                const w = EXCEPTION_WORDS[x.code];
                return (
                  <tr key={`${x.billRef}|${x.settlementRef}`} className="border-t border-line" data-exception={x.code}>
                    <td className="py-1.5">
                      <bdi dir="ltr" className="identifier">
                        {x.billRef}
                      </bdi>
                    </td>
                    <td className="py-1.5">
                      <bdi dir="ltr" className="identifier text-ink-quiet">
                        {x.settlementRef}
                      </bdi>
                    </td>
                    <td className="py-1.5">
                      {x.transactionRef === undefined ? (
                        '—'
                      ) : (
                        <a
                          href={`/${segment}/transactions/${x.transactionRef}`}
                          className="identifier text-brand hover:underline"
                        >
                          {x.transactionRef}
                        </a>
                      )}
                    </td>
                    <td className="py-1.5 text-heading">
                      {t(w[0], w[1])}
                      {x.presented !== undefined && x.paid !== undefined
                        ? ` · ${t('billed', 'الفاتورة')} ${formatMinorUnits(x.presented, numerals)} · ${t('paid', 'المدفوع')} ${formatMinorUnits(x.paid, numerals)}`
                        : ''}
                      {x.reason === undefined ? '' : ` (${x.reason})`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
