/**
 * `<Rate>` renders a rate or an APR. Basis points in, a percentage on screen.
 *
 * Separate from `<Money>` on purpose (CLAUDE.md §9): the one renders amounts
 * and cannot gain a rate prop; this one renders rates and cannot gain an
 * amount prop. The conversion here is for display only — two integer digits
 * split off the basis points, never a division — and no arithmetic on the
 * rendered value is possible because it is a string.
 */

import type { ReactElement } from 'react';

import type { Rate as DomainRate } from '@sanad/core/pricing/rate.ts';

import { type NumeralSystem, defaultNumerals } from './Money.tsx';

export interface RateProps {
  readonly rate: DomainRate;
  readonly locale: 'ar-SA' | 'en-SA';
  readonly numerals?: NumeralSystem;
  /** Shown beside the figure: "APR", "معدل النسبة السنوي". Copy comes from the caller. */
  readonly label: string;
}

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;

/** 1 268 bp → "12.68". Negative rates keep their sign. */
export function formatBasisPoints(bp: bigint, numerals: NumeralSystem): string {
  const negative = bp < 0n;
  const digits = (negative ? -bp : bp).toString().padStart(3, '0');
  const rendered = `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return numerals === 'arabic-indic' ? rendered.replace(/\d/g, (d) => ARABIC_INDIC[Number(d)] ?? d) : rendered;
}

export function Rate({ rate, locale, numerals, label }: RateProps): ReactElement {
  const system = numerals ?? defaultNumerals(locale);
  const percent = locale === 'ar-SA' ? '٪' : '%';
  return (
    <span className="inline-flex items-baseline gap-1" data-rate-basis={rate.basis} data-rate-period={rate.period}>
      <span className="text-sm text-ink-quiet">{label}</span>
      <span className="font-semibold text-ink tabular-nums" data-testid="rate-value">
        <bdi>{formatBasisPoints(rate.bp, system)}{percent}</bdi>
      </span>
    </span>
  );
}
