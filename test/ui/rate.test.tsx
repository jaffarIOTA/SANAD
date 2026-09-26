/**
 * `<Rate>` — basis points to a percentage, by digit splitting, never division.
 * And the prop surface: no amount prop, asserted at compile time.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Rate, formatBasisPoints } from '@sanad/design/Rate.tsx';
import { rate } from '@sanad/core/pricing/rate.ts';

describe('formatBasisPoints', () => {
  it.each([[0n, '0.00'], [1n, '0.01'], [99n, '0.99'], [100n, '1.00'], [1_268n, '12.68'], [10_000n, '100.00'], [-25n, '-0.25']])('%s bp → %s', (bp, expected) => {
    expect(formatBasisPoints(bp, 'latin')).toBe(expected);
  });
  it('renders Arabic-Indic numerals under Arabic', () => {
    expect(formatBasisPoints(1_268n, 'arabic-indic')).toBe('١٢.٦٨');
  });
});

describe('<Rate>', () => {
  it('renders the figure with the locale percent sign and carries basis and period as data', () => {
    const en = renderToStaticMarkup(<Rate rate={rate(1_268n, 'APR')} locale="en-SA" label="APR" />);
    expect(en).toContain('12.68%'); expect(en).toContain('data-rate-basis="APR"'); expect(en).toContain('data-rate-period="ANNUAL"');
    const ar = renderToStaticMarkup(<Rate rate={rate(1_268n, 'APR')} locale="ar-SA" label="معدل النسبة السنوي" />);
    expect(ar).toContain('١٢.٦٨٪');
  });
  it('has no amount prop', () => {
    // @ts-expect-error — an amount does not belong on a rate component (CLAUDE.md §9)
    const bad = <Rate rate={rate(1n, 'APR')} locale="en-SA" label="x" amount={1n} />;
    expect(bad).toBeTruthy();
  });
});
