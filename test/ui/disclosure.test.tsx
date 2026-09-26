/**
 * The disclosure screen renders exactly what `disclose()` returned plus the
 * platform's APR — in both languages, with the disclosure version in the markup.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Disclosure } from '@sanad/design/Disclosure.tsx';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { buildOffer } from '@sanad/core/products/offer.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { murabahaScf } from '@sanad/products/murabaha-scf/index.ts';

const at = tsaInstant({ verified: true, genTimeEpochSeconds: 1_790_000_000n, tokenDigest: 't', authorityId: 'test' });
const terms = expectOk(murabahaScf.validateTerms({ instalments: { count: 3 }, structureCode: 'MURABAHA', maxTenorDays: 180 }));
const quote = expectOk(murabahaScf.quote(terms, {
  tenantId: 'bank-a', programmeId: 'prg-0001', counterpartyId: 'cp', requestedAmount: money(18_500_000n), requestedTenorDays: 90, asOf: at,
  tradeReference: { type: 'CLEARED_INVOICE', invoiceUuid: 'u', invoiceHash: 'h', issuerCr: '1010000002', recipientCr: '7001000001' },
  pricing: { profitAmount: money(462_500n) },
}));
const offer = expectOk(buildOffer(murabahaScf, quote, at));

describe('<Disclosure>', () => {
  it('renders every disclosed figure, the APR and the disclosure version, in English', () => {
    const html = renderToStaticMarkup(<Disclosure offer={offer} locale="en-SA" />);
    for (const s of ['185,000.00', '4,625.00', '189,625.00', 'Cost of goods', 'Profit', 'Sale price', 'Total amount payable', 'APR', '90 days', '3']) expect(html).toContain(s);
    expect(html).toContain(`data-disclosure-version="${offer.disclosureVersion}"`);
  });
  it('renders the same figures in Arabic with Arabic-Indic numerals', () => {
    const html = renderToStaticMarkup(<Disclosure offer={offer} locale="ar-SA" />);
    for (const s of ['١٨٥٬٠٠٠.٠٠', 'تكلفة البضاعة', 'الربح', 'ثمن البيع', 'معدل النسبة السنوي', '٪']) expect(html).toContain(s);
  });
  it('shows the APR the platform computed, not one the product supplied', () => {
    expect(offer.apr.computedBy).toBe('core/pricing/apr.ts');
    const html = renderToStaticMarkup(<Disclosure offer={offer} locale="en-SA" />);
    expect(html).toContain('data-testid="disclosure-apr"');
  });
});
