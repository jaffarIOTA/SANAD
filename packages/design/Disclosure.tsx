/**
 * The consumer disclosure (CLAUDE.md §4.2, §9).
 *
 * Renders exactly the fields `disclose()` returned plus the APR the platform
 * computed, in both languages, before acceptance. Nothing here is computed:
 * every figure arrives as an amount or as basis points and is formatted, not
 * derived. The `disclosureVersion` is rendered into the markup so the
 * acceptance event can record which disclosure was shown.
 *
 * Layout: the three figures a customer decides on (instalment, APR, total
 * payable) lead in a tinted summary; every other disclosed figure follows as
 * an itemised list. Each field appears once. Moving a field between the two
 * groups is a layout change; adding or dropping one is a disclosure change.
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
  'en-SA': {
    title: 'Before you accept',
    lede: 'Every figure below is final. Nothing is added later.',
    breakdown: 'Breakdown',
    amount: 'Financing amount',
    tenor: 'Term',
    days: 'days',
    instalments: 'Instalments',
    each: 'each',
    cost: 'Total cost of credit',
    payable: 'Total amount payable',
    fees: 'Fees',
    none: 'No fees',
    apr: 'APR',
    version: 'Disclosure version',
  },
  'ar-SA': {
    title: 'قبل أن تقبل',
    lede: 'كل الأرقام أدناه نهائية. لا يُضاف شيء لاحقاً.',
    breakdown: 'التفاصيل',
    amount: 'مبلغ التمويل',
    tenor: 'المدة',
    days: 'يوماً',
    instalments: 'الأقساط',
    each: 'لكل قسط',
    cost: 'إجمالي تكلفة التمويل',
    payable: 'إجمالي المبلغ المستحق',
    fees: 'الرسوم',
    none: 'لا رسوم',
    apr: 'معدل النسبة السنوي',
    version: 'إصدار الإفصاح',
  },
} as const;

const toArabicIndic = (n: number): string => String(n).replace(/\d/g, (x) => '٠١٢٣٤٥٦٧٨٩'[Number(x)] ?? x);

export function Disclosure({ offer, locale, numerals }: DisclosureProps): ReactElement {
  const t = COPY[locale];
  const system = numerals ?? defaultNumerals(locale);
  const d = offer.disclosure;
  const amount = (m: DomainMoney, large = false) => (
    <span className="whitespace-nowrap tabular-nums">
      <bdi className={large ? 'text-amount font-semibold' : ''}>{formatMinorUnits(m, system)}</bdi>{' '}
      <span className="text-sm font-normal text-ink-quiet">{m.currency}</span>
    </span>
  );
  const row = (label: string, value: ReactElement | string, key: string) => (
    <div key={key} className="flex items-baseline justify-between gap-4 py-3">
      <dt className="text-sm text-ink-quiet">{label}</dt>
      <dd className="text-end text-base text-ink">{value}</dd>
    </div>
  );
  const count = locale === 'ar-SA' ? toArabicIndic(d.countOfInstalments) : String(d.countOfInstalments);
  const tenor = locale === 'ar-SA' ? toArabicIndic(d.tenorDays) : String(d.tenorDays);

  return (
    <section
      className="flex flex-col gap-5 rounded-card border border-line bg-surface p-6"
      data-disclosure-version={offer.disclosureVersion}
      data-product={offer.productCode}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-h3 font-semibold text-heading">{t.title}</h2>
        <p className="text-sm text-ink-quiet">{t.lede}</p>
      </header>

      <dl className="flex flex-col gap-4 rounded-tile bg-brand-wash p-5">
        <div className="flex items-baseline justify-between gap-4">
          {d.instalmentAmount === undefined ? (
            <>
              <dt className="text-sm text-ink-quiet">{t.instalments}</dt>
              <dd className="text-ink">
                <bdi className="text-amount font-semibold">{count}</bdi>
              </dd>
            </>
          ) : (
            <>
              <dt className="text-sm text-ink-quiet">
                {t.instalments} (<bdi>{count}</bdi>)
              </dt>
              <dd className="text-end text-ink">
                {amount(d.instalmentAmount, true)}
                <span className="block text-sm text-ink-quiet">{t.each}</span>
              </dd>
            </>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-4" data-testid="disclosure-apr">
          <dt className="text-sm text-ink-quiet">{t.apr}</dt>
          {/* <Rate> carries its own label; the term beside it already names it, so the inner one is hidden, not repeated. */}
          <dd className="text-ink **:data-[testid=rate-value]:text-amount [&>span>span:first-child]:hidden">
            <Rate
              rate={{ bp: offer.apr.bp, basis: 'APR', period: 'ANNUAL' }}
              locale={locale}
              {...(numerals === undefined ? {} : { numerals })}
              label={t.apr}
            />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-4 border-t border-brand/20 pt-4">
          <dt className="text-base font-semibold text-ink">{t.payable}</dt>
          <dd className="text-ink">{amount(d.totalPayable, true)}</dd>
        </div>
      </dl>

      <div>
        <h3 className="text-sm font-medium text-ink">{t.breakdown}</h3>
        <dl className="mt-1 divide-y divide-line">
          {row(t.amount, amount(d.financingAmount), 'amount')}
          {row(
            t.tenor,
            <bdi>
              {tenor} {t.days}
            </bdi>,
            'tenor',
          )}
          {d.lines.map((l) => row(locale === 'ar-SA' ? l.labelAr : l.labelEn, amount(l.amount), `line-${l.code}`))}
          {d.fees.length === 0
            ? row(t.fees, t.none, 'fees')
            : d.fees.map((f) =>
                row(`${t.fees} · ${locale === 'ar-SA' ? f.labelAr : f.labelEn}`, amount(f.amount), `fee-${f.code}`),
              )}
          {row(t.cost, amount(d.totalCostOfCredit), 'cost')}
        </dl>
      </div>

      <p className="identifier text-xs text-ink-quiet">
        {t.version} <bdi>{offer.disclosureVersion.slice(0, 12)}</bdi>
      </p>
    </section>
  );
}
