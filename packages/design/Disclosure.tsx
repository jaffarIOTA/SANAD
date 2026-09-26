/**
 * The consumer disclosure (CLAUDE.md §4.2, §9).
 *
 * Renders exactly the fields `disclose()` returned plus the APR the platform
 * computed, in both languages, before acceptance. Nothing here is computed:
 * every figure arrives as an amount or as basis points and is formatted, not
 * derived. The `disclosureVersion` is rendered into the markup so the
 * acceptance event can record which disclosure was shown.
 */

import type { ReactElement } from 'react';

import type { Money as DomainMoney } from '@sanad/core/kernel/money.ts';
import type { Offer } from '@sanad/core/products/offer.ts';

import { type NumeralSystem, defaultNumerals, formatMinorUnits } from './Money.tsx';
import { Rate } from './Rate.tsx';

export interface DisclosureProps {
  readonly offer: Offer;
  readonly locale: 'ar-SA' | 'en-SA';
  readonly numerals?: NumeralSystem;
}

const COPY = {
  'en-SA': { title: 'Before you accept', amount: 'Financing amount', tenor: 'Term', days: 'days', instalments: 'Instalments', each: 'each', cost: 'Total cost of credit', payable: 'Total amount payable', fees: 'Fees', none: 'No fees', apr: 'APR', version: 'Disclosure version' },
  'ar-SA': { title: 'قبل أن تقبل', amount: 'مبلغ التمويل', tenor: 'المدة', days: 'يوماً', instalments: 'الأقساط', each: 'لكل قسط', cost: 'إجمالي تكلفة التمويل', payable: 'إجمالي المبلغ المستحق', fees: 'الرسوم', none: 'لا رسوم', apr: 'معدل النسبة السنوي', version: 'إصدار الإفصاح' },
} as const;

export function Disclosure({ offer, locale, numerals }: DisclosureProps): ReactElement {
  const t = COPY[locale];
  const system = numerals ?? defaultNumerals(locale);
  const d = offer.disclosure;
  const amount = (m: DomainMoney) => (
    <span className="tabular-nums"><bdi>{formatMinorUnits(m, system)}</bdi> <span className="text-sm text-ink-quiet">{m.currency}</span></span>
  );
  const row = (label: string, value: ReactElement | string, key: string, strong = false) => (
    <div key={key} className={`flex items-baseline justify-between gap-4 ${strong ? 'border-t border-line pt-3 mt-1 font-semibold' : ''}`}>
      <span className={strong ? 'text-base text-ink' : 'text-sm text-ink-quiet'}>{label}</span>
      <span className="text-ink">{value}</span>
    </div>
  );
  const count = locale === 'ar-SA' ? String(d.instalmentCount).replace(/\d/g, (x) => '٠١٢٣٤٥٦٧٨٩'[Number(x)] ?? x) : String(d.instalmentCount);
  const tenor = locale === 'ar-SA' ? String(d.tenorDays).replace(/\d/g, (x) => '٠١٢٣٤٥٦٧٨٩'[Number(x)] ?? x) : String(d.tenorDays);

  return (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4" data-disclosure-version={offer.disclosureVersion} data-product={offer.productCode}>
      <h2 className="text-base font-semibold text-ink">{t.title}</h2>
      {row(t.amount, amount(d.financingAmount), 'amount')}
      {row(t.tenor, <bdi>{tenor} {t.days}</bdi>, 'tenor')}
      {row(t.instalments, d.instalmentAmount === undefined ? <bdi>{count}</bdi> : <><bdi>{count}</bdi> × {amount(d.instalmentAmount)} {t.each}</>, 'instalments')}
      {d.lines.map((l) => row(locale === 'ar-SA' ? l.labelAr : l.labelEn, amount(l.amount), `line-${l.code}`))}
      {d.fees.length === 0 ? row(t.fees, t.none, 'fees') : d.fees.map((f) => row(`${t.fees} · ${locale === 'ar-SA' ? f.labelAr : f.labelEn}`, amount(f.amount), `fee-${f.code}`))}
      {row(t.cost, amount(d.totalCostOfCredit), 'cost')}
      {row(t.payable, amount(d.totalPayable), 'payable', true)}
      <div className="flex items-baseline justify-between gap-4 pt-1" data-testid="disclosure-apr">
        <Rate rate={{ bp: offer.apr.bp, basis: 'APR', period: 'ANNUAL' }} locale={locale} {...(numerals === undefined ? {} : { numerals })} label={t.apr} />
        <span className="identifier text-xs text-ink-quiet">{t.version} <bdi>{offer.disclosureVersion.slice(0, 12)}</bdi></span>
      </div>
    </section>
  );
}
