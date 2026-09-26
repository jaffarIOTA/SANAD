/**
 * `<Money>`, the component a Shariah requirement passes through.
 *
 * Two things are being protected.
 *
 * **The arithmetic.** Minor units are split on their last two digits, never
 * divided, because dividing is how a rounding error enters a number someone is
 * about to be contractually bound by (BE-06). The tests below include amounts
 * that a float would get wrong, so the assertion is not decorative.
 *
 * **The prop surface.** There is no rate prop and there must never be one
 * (§6, SH-15). That is asserted at compile time with `@ts-expect-error`: the
 * annotation fails the build if the error it expects does not occur, so adding
 * a rate prop to `MoneyProps` breaks `npm run typecheck` rather than silently
 * making this test meaningless.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Money, defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { money } from '@sanad/core/kernel/money.ts';
import type { MurabahaPricing } from '@sanad/products/murabaha-scf/pricing/murabaha.ts';

const LABELS_EN = { cost: 'Cost', profit: 'Profit', total: 'Total' } as const;
const LABELS_AR = { cost: 'التكلفة', profit: 'الربح', total: 'الإجمالي' } as const;

const pricing = (cost: bigint, profit: bigint): MurabahaPricing => ({
  costAmount: money(cost),
  profitAmount: money(profit),
  salePriceAmount: money(cost + profit),
});

describe('formatMinorUnits — no floating point', () => {
  it.each([
    [0n, '0.00'],
    [1n, '0.01'],
    [99n, '0.99'],
    [100n, '1.00'],
    [123_456n, '1,234.56'],
    [100_000_000n, '1,000,000.00'],
  ])('renders %s minor units as %s', (minorUnits, expected) => {
    expect(formatMinorUnits(money(minorUnits), 'latin')).toBe(expected);
  });

  it('is exact at magnitudes a double cannot represent', () => {
    // 2^53 + 1 minor units. `Number` cannot hold this; `bigint` can, and the
    // formatter never converts.
    const beyondDouble = 9_007_199_254_740_993n;
    expect(formatMinorUnits(money(beyondDouble), 'latin')).toBe('90,071,992,547,409.93');
  });

  it('renders Arabic-Indic digits with the Arabic thousands separator', () => {
    expect(formatMinorUnits(money(123_456n), 'arabic-indic')).toBe('١٬٢٣٤٫٥٦'.replace('٫', '.'));
  });

  it('chooses numerals from the locale', () => {
    expect(defaultNumerals('ar-SA')).toBe('arabic-indic');
    expect(defaultNumerals('en-SA')).toBe('latin');
  });
});

describe('<Money> discloses cost, profit and total together (SH-15)', () => {
  it('renders all three amounts in English', () => {
    const html = renderToStaticMarkup(
      <Money pricing={pricing(100_000n, 2_500n)} locale="en-SA" labels={LABELS_EN} />,
    );
    expect(html).toContain('1,000.00');
    expect(html).toContain('25.00');
    expect(html).toContain('1,025.00');
    expect(html).toContain('Cost');
    expect(html).toContain('Profit');
    expect(html).toContain('Total');
  });

  it('renders all three amounts in Arabic', () => {
    const html = renderToStaticMarkup(
      <Money pricing={pricing(100_000n, 2_500n)} locale="ar-SA" labels={LABELS_AR} />,
    );
    expect(html).toContain('التكلفة');
    expect(html).toContain('الربح');
    // Arabic-Indic, not Latin digits.
    expect(html).toMatch(/[٠-٩]/);
    expect(html).not.toContain('1,025.00');
  });

  it('isolates each amount so Arabic text cannot reorder it', () => {
    const html = renderToStaticMarkup(
      <Money pricing={pricing(100_000n, 2_500n)} locale="ar-SA" labels={LABELS_AR} />,
    );
    // Three amounts, three <bdi> elements. Without them a Latin currency code
    // beside an Arabic paragraph reorders on screen.
    expect(html.match(/<bdi>/g)).toHaveLength(3);
  });

  it('shows the total as the sum it is, never as a separate figure', () => {
    const html = renderToStaticMarkup(
      <Money pricing={pricing(4_999_999n, 1n)} locale="en-SA" labels={LABELS_EN} />,
    );
    expect(html).toContain('49,999.99');
    expect(html).toContain('0.01');
    expect(html).toContain('50,000.00');
  });

  it('names an explicit currency beside every amount', () => {
    const html = renderToStaticMarkup(
      <Money pricing={pricing(100_000n, 2_500n)} locale="en-SA" labels={LABELS_EN} />,
    );
    expect(html.match(/SAR/g)).toHaveLength(3);
  });
});

describe('SH-01 — a rate is not expressible', () => {
  /**
   * A compile-time assertion, not a runtime one.
   *
   * `@ts-expect-error` is an error itself when the line below it compiles
   * cleanly. So if someone adds `profitRate` to `MoneyProps`, this stops
   * failing to compile, which makes the annotation unused, which fails
   * `npm run typecheck`. The guard survives the thing it guards against.
   */
  it('rejects a rate prop at compile time', () => {
    const element = (
      <Money
        pricing={pricing(100_000n, 2_500n)}
        locale="en-SA"
        labels={LABELS_EN}
        // @ts-expect-error — MoneyProps has no rate prop and must never gain one (§6, SH-15).
        profitRate={0.025}
      />
    );
    // It still renders; the point is that it did not typecheck.
    expect(renderToStaticMarkup(element)).toContain('1,025.00');
  });

  it('renders no percent sign and no proportion anywhere', () => {
    for (const locale of ['ar-SA', 'en-SA'] as const) {
      const html = renderToStaticMarkup(
        <Money
          pricing={pricing(100_000n, 2_500n)}
          locale={locale}
          labels={locale === 'ar-SA' ? LABELS_AR : LABELS_EN}
        />,
      );
      expect(html).not.toContain('%');
      expect(html).not.toMatch(/\bp\.?a\.?\b/i);
    }
  });
});
