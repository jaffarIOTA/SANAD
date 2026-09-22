/**
 * The Money component.
 *
 * It renders a cost, a profit and a total, together, as amounts. It has no prop
 * for a rate and it must not gain one (CLAUDE.md §6, SDD §7.6, SH-15).
 *
 * That is not a presentational rule. Disclosure of the original cost and the
 * markup is a validity condition of the Murabaha — not a consumer-protection
 * courtesy — so this component is where a Shariah requirement is either met or
 * quietly lost. It takes the same three amounts that render into the
 * instrument, from the same source, so the screen and the contract cannot
 * disagree.
 *
 * The prop is `MurabahaPricing` straight from the domain, deliberately: there
 * is no intermediate view model in which a fourth field could appear.
 */

import type { ReactElement } from 'react';

import type { Money as DomainMoney } from '../../../../core/kernel/money.ts';
import type { MurabahaPricing } from '../../../../core/pricing/murabaha.ts';

export type NumeralSystem = 'arabic-indic' | 'latin';

export interface MoneyLabels {
  readonly cost: string;
  readonly profit: string;
  readonly total: string;
}

export interface MoneyProps {
  readonly pricing: MurabahaPricing;
  readonly locale: 'ar-SA' | 'en-SA';
  /** Defaults to Arabic-Indic under Arabic, Latin under English (SDD §7.5). */
  readonly numerals?: NumeralSystem;
  /** Copy comes from the caller so all wording lives in one catalogue. */
  readonly labels: MoneyLabels;
}

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;
/** U+066C, the Arabic thousands separator. */
const ARABIC_GROUP = '٬';

/**
 * Minor units to a display string, without floating point.
 *
 * The integer is split on its last two digits rather than divided, because
 * dividing is how a rounding error enters a number someone is about to be
 * contractually bound by (BE-06).
 */
export function formatMinorUnits(
  amount: DomainMoney,
  numerals: NumeralSystem,
): string {
  const negative = amount.minorUnits < 0n;
  const absolute = negative ? -amount.minorUnits : amount.minorUnits;
  const digits = absolute.toString().padStart(3, '0');

  const major = digits.slice(0, -2);
  const minor = digits.slice(-2);
  const separator = numerals === 'arabic-indic' ? ARABIC_GROUP : ',';
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, separator);

  const rendered = `${negative ? '-' : ''}${grouped}.${minor}`;
  return numerals === 'arabic-indic' ? toArabicIndic(rendered) : rendered;
}

function toArabicIndic(value: string): string {
  return value.replace(/\d/g, (d) => ARABIC_INDIC[Number(d)] ?? d);
}

export function defaultNumerals(locale: MoneyProps['locale']): NumeralSystem {
  return locale === 'ar-SA' ? 'arabic-indic' : 'latin';
}

export function Money({ pricing, locale, numerals, labels }: MoneyProps): ReactElement {
  const system = numerals ?? defaultNumerals(locale);
  const currency = pricing.salePriceAmount.currency;

  const row = (label: string, amount: DomainMoney, isTotal: boolean) => (
    <div
      className={
        isTotal
          ? 'flex items-baseline justify-between border-t border-line pt-3 mt-1'
          : 'flex items-baseline justify-between'
      }
    >
      <span
        className={
          isTotal ? 'text-base font-semibold text-ink' : 'text-sm text-ink-quiet'
        }
      >
        {label}
      </span>
      <span
        className={
          isTotal
            ? 'text-amount font-semibold text-ink tabular-nums'
            : 'text-base text-ink tabular-nums'
        }
        data-testid={isTotal ? 'money-total' : undefined}
      >
        {/* Isolated so neighbouring punctuation and digits do not reorder
            when an Arabic paragraph surrounds a Latin currency code. */}
        <bdi>{formatMinorUnits(amount, system)}</bdi>{' '}
        <span className="text-sm text-ink-quiet">{currency}</span>
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="money">
      {row(labels.cost, pricing.costAmount, false)}
      {row(labels.profit, pricing.profitAmount, false)}
      {row(labels.total, pricing.salePriceAmount, true)}
    </div>
  );
}
