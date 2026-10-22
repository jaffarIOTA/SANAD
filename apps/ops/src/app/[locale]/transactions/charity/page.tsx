/**
 * The charity ledger (Wasl W4b-2): every late amount raised to the
 * segregated charity liability, across the institution's Wasl transactions —
 * what is held, what has been given and to whom. Read-only: each entry is
 * raised by a collection and disbursed from its own transaction's page, by
 * two people. Never the institution's income (SH-13).
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { TenantCode } from '@sanad/config/loader.ts';
import { resolveBoard } from '@sanad/origination/wasl/configuration.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { listTransactions } from '@sanad/origination/wasl/book.ts';
import { charityHoldings } from '@sanad/origination/wasl/late-amounts.ts';

import { pageStaff } from '../../../../server/session.ts';

export default async function CharityLedgerPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactElement> {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const numerals = defaultNumerals(locale);
  const staff = await pageStaff(segment);
  if (staff.tenantId === undefined) notFound();
  const tenant = staff.tenantId as TenantCode;
  const board = (await resolveBoard(tenant)).value;
  const ruling = board.ok ? board.value.lateAmounts : undefined;
  let holdings: ReturnType<typeof charityHoldings> = [];
  try {
    holdings = charityHoldings(await listTransactions(tenant));
  } catch {
    // An institution with no Wasl programme holds nothing for charity.
    holdings = [];
  }
  const sum = (xs: typeof holdings) => xs.reduce((s, h) => s + h.late.amount.minorUnits, 0n);
  const currency = holdings[0]?.late.amount.currency ?? 'SAR';
  const held = holdings.filter((h) => h.late.status !== 'DISBURSED');
  const given = holdings.filter((h) => h.late.status === 'DISBURSED');
  const amount = (minorUnits: bigint) => (
    <bdi className="tabular-nums">
      {formatMinorUnits({ minorUnits, currency }, numerals)} {currency}
    </bdi>
  );
  const recipientName = (id: string) => {
    const r = ruling?.approvedRecipients.find((x) => x.recipientId === id);
    return r === undefined ? id : t(r.nameEn, r.nameAr);
  };

  return (
    <div className="flex flex-col gap-6" data-charity-ledger>
      <div>
        <a href={`/${segment}/transactions`} className="text-[13px] text-brand hover:underline">
          {t('Transactions', 'المعاملات')}
        </a>
        <h1 className="mt-1 text-display font-bold tracking-tight text-heading">
          {t('Charity ledger', 'سجل التبرعات')}
        </h1>
        <p className="mt-1 max-w-3xl text-[14px] text-ink-quiet">
          {t(
            'Late amounts collected from distributors, held in the segregated charity liability until a second person approves their payment to a board-approved recipient. None of it is the institution’s income, and none of it reduces or adds to a sale price.',
            'مبالغ التأخير المحصّلة من الموزعين، محتجزة في التزام التبرع المستقل حتى يعتمد شخص ثانٍ صرفها لجهة اعتمدتها الهيئة. لا شيء منها دخل للمؤسسة، ولا يُنقص ثمن بيع أو يزيده.',
          )}
        </p>
      </div>

      <section className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-charity-held>
          <div className="text-[13px] text-ink-quiet">{t('Held for charity', 'محتجز للتبرع')}</div>
          <div className="mt-1 text-[20px] font-semibold text-heading">{amount(sum(held))}</div>
          <div className="text-[12px] text-ink-quiet">
            {t(`${String(held.length)} entries`, `${String(held.length)} قيود`)}
          </div>
        </div>
        <div className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-charity-given>
          <div className="text-[13px] text-ink-quiet">{t('Given to charity', 'صُرف للجهات الخيرية')}</div>
          <div className="mt-1 text-[20px] font-semibold text-heading">{amount(sum(given))}</div>
          <div className="text-[12px] text-ink-quiet">
            {t(`${String(given.length)} entries`, `${String(given.length)} قيود`)}
          </div>
        </div>
      </section>

      <section className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
        {holdings.length === 0 ? (
          <p className="px-5 py-6 text-[14px] text-ink-quiet">
            {ruling === undefined
              ? t(
                  'The board has ruled no late amounts for this institution.',
                  'لم تقرّ الهيئة الشرعية مبالغ تأخير لهذه المؤسسة.',
                )
              : t('Nothing has been raised to charity yet.', 'لم يُقيّد شيء للتبرع بعد.')}
          </p>
        ) : (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-ink-quiet">
                <th className="px-4 py-2 text-start font-normal">{t('Transaction', 'المعاملة')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Instalment', 'القسط')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Collected', 'حُصّل')}</th>
                <th className="px-4 py-2 text-end font-normal">{t('Amount', 'المبلغ')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Basis', 'الأساس')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Recipient', 'المستفيد')}</th>
              </tr>
            </thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={`${h.transactionRef}-${String(h.late.sequenceNumber)}`} className="border-t border-line">
                  <td className="px-4 py-2">
                    <a
                      href={`/${segment}/transactions/${h.transactionRef}`}
                      className="identifier text-brand hover:underline"
                    >
                      {h.transactionRef}
                    </a>
                  </td>
                  <td className="px-4 py-2">{String(h.late.sequenceNumber)}</td>
                  <td className="px-4 py-2">
                    <bdi dir="ltr" className="identifier">
                      {h.late.charity?.collectedOn}
                    </bdi>
                  </td>
                  <td className="px-4 py-2 text-end font-medium text-heading">{amount(h.late.amount.minorUnits)}</td>
                  <td className="px-4 py-2 identifier text-ink-quiet">{h.late.computationBasisKey}</td>
                  <td className="px-4 py-2">
                    {h.late.status === 'DISBURSED' && h.late.disbursement !== undefined
                      ? recipientName(h.late.disbursement.recipientId)
                      : h.late.status === 'DISBURSEMENT_PROPOSED'
                        ? t('Proposed, awaiting approval', 'مقترح، بانتظار الاعتماد')
                        : t('Held', 'محتجز')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
