/**
 * Murabaha transactions (Wasl) — one row per transaction an approved request
 * opened, with where it stands in the sequence. The signed-in person's own
 * institution only.
 */
import { notFound } from 'next/navigation';

import type { TenantCode } from '@sanad/config/loader.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { listTransactions } from '../../../server/murabaha-transactions.ts';
import { pageStaff } from '../../../server/session.ts';
import { STATE_LABEL } from './states.ts';

export default async function TransactionsPage({ params }: { readonly params: Promise<{ readonly locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const numerals = defaultNumerals(locale);
  const staff = await pageStaff(segment);
  const rows = staff.tenantId === undefined ? [] : await listTransactions(staff.tenantId as TenantCode);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-display font-bold tracking-tight text-heading">{t('Transactions', 'المعاملات')}</h1>
        <p className="mt-1 text-[14px] text-ink-quiet">
          {t(
            'Murabaha transactions opened by approved requests. Each moves through the wa’d, the purchase and the three gates before a sale can be offered; nobody can skip a gate.',
            'معاملات المرابحة التي فتحتها طلبات معتمدة. تمر كل معاملة بالوعد والشراء والبوابات الثلاث قبل أن يُعرض البيع، ولا يمكن لأحد تجاوز بوابة.',
          )}
        </p>
        <a
          href={`/${segment}/transactions/reconciliation`}
          className="mt-2 inline-block text-[13px] font-semibold text-brand hover:underline"
        >
          {t('Reconciliation with SADAD', 'المطابقة مع سداد')}
        </a>
        <a
          href={`/${segment}/transactions/charity`}
          className="ms-4 mt-2 inline-block text-[13px] font-semibold text-brand hover:underline"
        >
          {t('Charity ledger', 'سجل التبرعات')}
        </a>
      </div>
      <section className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
        {rows.length === 0 ? (
          <p className="px-5 py-6 text-[14px] text-ink-quiet" data-transactions-empty>
            {t(
              'No transaction is open yet. Approving a request in the review queue opens one.',
              'لا توجد معاملة مفتوحة بعد. اعتماد طلب في قائمة المراجعة يفتح معاملة.',
            )}
          </p>
        ) : (
          <table className="w-full min-w-[760px] text-[14px]">
            <thead>
              <tr className="border-b border-line text-start text-[12px] text-ink-quiet">
                <th className="px-5 py-3 text-start font-medium">{t('Transaction', 'المعاملة')}</th>
                <th className="px-3 py-3 text-start font-medium">{t('Distributor', 'الموزّع')}</th>
                <th className="px-3 py-3 text-end font-medium">{t('Cost', 'التكلفة')}</th>
                <th className="px-3 py-3 text-end font-medium">{t('Profit', 'الربح')}</th>
                <th className="px-3 py-3 text-end font-medium">{t('Sale price', 'ثمن البيع')}</th>
                <th className="px-5 py-3 text-start font-medium">{t('State', 'الحالة')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((v) => {
                const p = v.transaction.core.pricing;
                const label = STATE_LABEL[v.transaction.state];
                return (
                  <tr key={v.transactionRef} data-transaction-row>
                    <td className="px-5 py-3">
                      <a
                        href={`/${segment}/transactions/${v.transactionRef}`}
                        className="identifier font-semibold text-brand hover:underline"
                      >
                        {v.transactionRef}
                      </a>
                      <span className="identifier block text-[11px] text-ink-quiet">{v.requestRef}</span>
                    </td>
                    <td className="px-3 py-3 text-heading">{v.transaction.core.counterpartyId}</td>
                    <td className="px-3 py-3 text-end tabular-nums">{formatMinorUnits(p.costAmount, numerals)}</td>
                    <td className="px-3 py-3 text-end tabular-nums">{formatMinorUnits(p.profitAmount, numerals)}</td>
                    <td className="px-3 py-3 text-end font-semibold tabular-nums">
                      {formatMinorUnits(p.salePriceAmount, numerals)}
                    </td>
                    <td className="px-5 py-3">
                      <span className="rounded-full border border-line-strong px-2 py-0.5 text-[12px] text-heading">
                        {label === undefined ? v.transaction.state : t(label.en, label.ar)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
