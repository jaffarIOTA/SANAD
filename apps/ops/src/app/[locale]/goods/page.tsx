/**
 * Goods register (Wasl W5b), as the workbench reads it: the goods the Shariah
 * board excludes from financing, by HS heading, in force now — an invoice
 * line on it refuses the trade when the transaction opens (SH-11) — and the
 * headings the institution has actually financed, from its transactions'
 * invoices. Read-only: the register is the board's ruling, recorded in
 * Admin → Goods register by one administrator and approved by another.
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { TenantCode } from '@sanad/config/loader.ts';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { type TransactionRecord, hydrate } from '@sanad/origination/wasl/book.ts';
import { resolveBoard } from '@sanad/origination/wasl/configuration.ts';

import { invoiceGoodsLines } from '../../../server/invoices.ts';
import { pageStaff } from '../../../server/session.ts';

export default async function GoodsRegisterPage({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}): Promise<ReactElement> {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const staff = await pageStaff(segment);
  if (staff.tenantId === undefined) notFound();
  const tenant = staff.tenantId as TenantCode;
  const board = await resolveBoard(tenant);
  // An institution with no Wasl programme has financed nothing.
  const records: readonly TransactionRecord[] = await hydrate(tenant).then(
    (b) => [...b.records.values()],
    () => [],
  );
  // Each heading financed, and by how many transactions: from the invoice lines screened when each opened.
  const financed = new Map<string, Set<string>>();
  for (const r of records) {
    const lines = invoiceGoodsLines(r.transaction.core.tradeReference.invoiceUuid ?? '') ?? [];
    for (const l of lines) {
      const set = financed.get(l.goodsClassificationCode) ?? new Set<string>();
      set.add(r.transactionRef);
      financed.set(l.goodsClassificationCode, set);
    }
  }

  return (
    <div className="flex flex-col gap-6" data-goods>
      <div>
        <h1 className="text-display font-bold tracking-tight text-heading">{t('Goods register', 'سجل البضائع')}</h1>
        <p className="mt-1 max-w-3xl text-[14px] text-ink-quiet">
          {t(
            'The goods the Shariah board excludes from financing. An invoice line on the register refuses the trade when its transaction opens. The register is the board’s ruling, recorded in Admin → Goods register by one administrator and approved by another.',
            'البضائع التي تستبعدها الهيئة الشرعية من التمويل. يُرفض أي سطر فاتورة مدرج في السجل عند فتح معاملته. السجل قرار الهيئة، يسجّله مسؤول في الإدارة ← سجل البضائع ويعتمده آخر.',
          )}
        </p>
        <p className="mt-1 text-[12px] text-ink-quiet">
          {board.source === 'REVISION'
            ? `${t('Approved revision', 'مراجعة معتمدة')}: ${board.revisionSummary ?? ''}`
            : t('From the checked-in board positions', 'من مواقف الهيئة المضمّنة')}
        </p>
      </div>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-goods-excluded>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">
          {t('Excluded by the board', 'مستبعدة بقرار الهيئة')}
        </h2>
        {board.value.ok ? (
          <ul className="divide-y divide-line text-[13px]">
            {board.value.value.excludedGoods.map((g) => (
              <li key={g.code} className="flex flex-wrap gap-x-4 py-2">
                <bdi dir="ltr" className="identifier w-16 text-heading">
                  {g.code}
                </bdi>
                <span>{g.description}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-blocked">
            {t('The board’s positions do not load.', 'لا يمكن تحميل مواقف الهيئة.')}
          </p>
        )}
      </section>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-goods-financed>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Financed', 'المموّلة')}</h2>
        {financed.size === 0 ? (
          <p className="text-[13px] text-ink-quiet">{t('Nothing financed yet.', 'لم يُموّل شيء بعد.')}</p>
        ) : (
          <ul className="divide-y divide-line text-[13px]">
            {[...financed.entries()]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([code, refs]) => (
                <li key={code} className="flex flex-wrap gap-x-4 py-2">
                  <bdi dir="ltr" className="identifier w-16 text-heading">
                    {code}
                  </bdi>
                  <span className="text-ink-quiet">
                    {t(`${String(refs.size)} transactions`, `${String(refs.size)} معاملات`)}
                  </span>
                </li>
              ))}
          </ul>
        )}
        <p className="mt-2 text-[12px] text-ink-quiet">
          {t(
            'From the invoice lines each transaction was screened on when it opened. A heading added to the register later refuses new trades; it does not reopen these.',
            'من أسطر الفواتير التي فُحصت عليها كل معاملة عند فتحها. البند المضاف لاحقاً إلى السجل يرفض الصفقات الجديدة ولا يعيد فتح هذه.',
          )}
        </p>
      </section>
    </div>
  );
}
