/**
 * Adding a product to a tenant's catalogue from the Admin screen. Each case
 * attempts something the rules forbid and passes only when it is refused.
 */
import { describe, expect, it } from 'vitest';

import { loadProductCatalogue } from '@sanad/config/loader.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';

import { catalogueWithAddition, productsNotInCatalogue } from '../../apps/admin/src/server/products.ts';

const template = expectOk(loadProductCatalogue('bank-a'));
const without = (...codes: string[]) => ({ ...template, entries: template.entries.filter((e) => !codes.includes(e.productCode)) });

describe('adding a shipped product to the catalogue', () => {
  it('offers exactly the shipped modules the catalogue in force lacks', () => {
    expect(productsNotInCatalogue(without('sme-term-conventional', 'sme-term-islamic'), template).map((e) => e.productCode)).toEqual(['sme-term-conventional', 'sme-term-islamic']);
    expect(productsNotInCatalogue(template, template)).toEqual([]);
  });

  it('adds the checked-in term sheet as it is, and the result parses as production parses it', () => {
    const added = expectOk(catalogueWithAddition(without('sme-term-conventional'), template, 'sme-term-conventional'));
    expect(added.parsed.entries.map((e) => e.productCode)).toContain('sme-term-conventional');
  });

  it('an Islamic product arrives disabled, because its board ruling is not yet recorded', () => {
    const added = expectOk(catalogueWithAddition(without('sme-term-islamic'), template, 'sme-term-islamic'));
    expect(added.parsed.entries.find((e) => e.productCode === 'sme-term-islamic')?.enabled).toBe(false);
  });

  it('refuses a product already in the catalogue, and one with no term sheet for this tenant', () => {
    const twice = catalogueWithAddition(template, template, 'bnpl');
    expect(twice.ok).toBe(false); if (!twice.ok) expect(twice.error.reason).toBe('PRODUCT_ALREADY_IN_CATALOGUE');
    const none = catalogueWithAddition(without('bnpl'), without('bnpl'), 'bnpl');
    expect(none.ok).toBe(false); if (!none.ok) expect(none.error.reason).toBe('PRODUCT_HAS_NO_TEMPLATE');
  });
});
