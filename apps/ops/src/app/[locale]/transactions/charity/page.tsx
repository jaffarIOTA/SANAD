/**
 * The charity ledger (Wasl W4b-2, W6b-2): every late amount and every share
 * of purified income raised to the segregated charity liability, across the
 * institution's Wasl transactions —
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
import { type PurifiedShare, purificationsOf } from '@sanad/origination/wasl/purification.ts';

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
  // Purified income (W6b-2): each share raised to the same segregated liability, as its instalment was collected.
  const purificationRuling = board.ok ? board.value.purification : undefined;
  let purified: { key: string; transactionRef: string; incidentRef: string; share: PurifiedShare }[] = [];
  try {
    purified = (await purificationsOf(tenant)).flatMap((h) =>
      h.purification.shares
        .filter((s) => s.raised !== undefined)
        .map((share) => ({
          key: share.raised?.sourceRef ?? '',
          transactionRef: h.transactionRef,
          incidentRef: h.purification.incidentRef,
          share,
        })),
    );
  } catch {
    purified = [];
  }
  const purifiedHeld = purified.filter((x) => x.share.disbursed === undefined);
  const purifiedGiven = purified.filter((x) => x.share.disbursed !== undefined);
  const sum = (xs: typeof holdings) => xs.reduce((s, h) => s + h.late.amount.minorUnits, 0n);
  const purifiedSum = (xs: typeof purified) => xs.reduce((s, x) => s + x.share.amount.minorUnits, 0n);
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
          <div className="mt-1 text-[20px] font-semibold text-heading">
            {amount(sum(held) + purifiedSum(purifiedHeld))}
          </div>
          <div className="text-[12px] text-ink-quiet">
            {t(
              `${String(held.length + purifiedHeld.length)} entries`,
              `${String(held.length + purifiedHeld.length)} قيود`,
            )}
          </div>
        </div>
        <div className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-charity-given>
          <div className="text-[13px] text-ink-quiet">{t('Given to charity', 'صُرف للجهات الخيرية')}</div>
          <div className="mt-1 text-[20px] font-semibold text-heading">
            {amount(sum(given) + purifiedSum(purifiedGiven))}
          </div>
          <div className="text-[12px] text-ink-quiet">
            {t(
              `${String(given.length + purifiedGiven.length)} entries`,
              `${String(given.length + purifiedGiven.length)} قيود`,
            )}
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

      <section className="overflow-x-auto rounded-card border border-line bg-surface shadow-card" data-purified-income>
        <h2 className="px-4 pt-4 text-[15px] font-semibold text-heading">{t('Purified income', 'الدخل المطهَّر')}</h2>
        <p className="px-4 text-[13px] text-ink-quiet">
          {t(
            `Income from defective transactions, raised as it was collected (W6b-2): ${String(purifiedHeld.length)} held, ${String(purifiedGiven.length)} given. Worked from each incident, under Shariah governance → Incidents.`,
            `دخل المعاملات المعيبة، مقيّد عند تحصيله: ${String(purifiedHeld.length)} محتجز، و${String(purifiedGiven.length)} مصروف. يُعالج من كل مخالفة في الحوكمة الشرعية ← المخالفات.`,
          )}
        </p>
        {purified.length === 0 ? (
          <p className="px-4 py-4 text-[14px] text-ink-quiet">{t('Nothing purified yet.', 'لم يُطهَّر شيء بعد.')}</p>
        ) : (
          <table className="mt-2 w-full text-[13px]">
            <thead>
              <tr className="text-ink-quiet">
                <th className="px-4 py-2 text-start font-normal">{t('Transaction', 'المعاملة')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Incident', 'المخالفة')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Instalment', 'القسط')}</th>
                <th className="px-4 py-2 text-end font-normal">{t('Amount', 'المبلغ')}</th>
                <th className="px-4 py-2 text-start font-normal">{t('Recipient', 'المستفيد')}</th>
              </tr>
            </thead>
            <tbody>
              {purified.map((x) => (
                <tr key={x.key} className="border-t border-line">
                  <td className="px-4 py-2">
                    <a
                      href={`/${segment}/transactions/${x.transactionRef}`}
                      className="identifier text-brand hover:underline"
                    >
                      {x.transactionRef}
                    </a>
                  </td>
                  <td className="px-4 py-2 identifier">{x.incidentRef}</td>
                  <td className="px-4 py-2">{String(x.share.sequenceNumber)}</td>
                  <td className="px-4 py-2 text-end font-medium text-heading">{amount(x.share.amount.minorUnits)}</td>
                  <td className="px-4 py-2">
                    {x.share.disbursed === undefined
                      ? t('Held', 'محتجز')
                      : (purificationRuling?.approvedRecipients.find(
                          (r) => r.recipientId === x.share.disbursed?.recipientId,
                        )?.[arabic ? 'nameAr' : 'nameEn'] ?? x.share.disbursed.recipientId)}
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
