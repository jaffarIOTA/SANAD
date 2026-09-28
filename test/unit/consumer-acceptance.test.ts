/**
 * An acceptance is of the disclosure that was shown, by a verified identity,
 * once, while the offer is live. Each of those four is refused when absent.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { DEV_AFFORDABILITY, maturityDates, quoteFor } from '../../apps/consumer/src/server/engine.ts';
import { accept, acceptanceFor, findOffer, saveOffer } from '../../apps/consumer/src/server/store.ts';

const at = (s: number) => tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const T0 = 1_791_000_000;

describe('the consumer journey engine', () => {
  it('quotes a consumer product through the engine with the platform APR', () => {
    const q = expectOk(quoteFor('tawarruq-personal', 5_000_000n, 12, 'app-1', at(T0)));
    expect(q.offer.apr.computedBy).toBe('core/pricing/apr.ts'); expect(q.offer.disclosure.instalmentCount).toBe(12);
    expect(DEV_AFFORDABILITY.incomeSourceRef).toContain('dev');
  });
  it('refuses a non-consumer product', () => {
    expect(quoteFor('murabaha-scf', 5_000_000n, 3, 'app-1', at(T0)).ok).toBe(false);
  });
  it('fixes both calendars at quotation', () => {
    const d = maturityDates(at(T0), 360);
    expect(d.gregorian).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(d.hijri).toMatch(/^1[45]\d{2}-\d{2}-\d{2}$/);
  });
});

describe('acceptance', () => {
  const seeded = (id: string) => {
    const q = expectOk(quoteFor('tawarruq-personal', 5_000_000n, 12, 'app-1', at(T0)));
    saveOffer({ offerId: id, tenantId: 'bank-a', applicantRef: 'app-1', productCode: 'tawarruq-personal', offer: q.offer, maturityDateGregorian: '2027-09-25', maturityDateHijri: '1449-03-13', expiresAtEpochSeconds: BigInt(T0 + 7 * 86_400) });
    return q.offer;
  };
  it('records the disclosure version shown, bound to the identity assertion, once', () => {
    const offer = seeded('ofr-a');
    const a = expectOk(accept({ offerId: 'ofr-a', identityAssertionId: 'asr-1', localeShown: 'ar-SA', disclosureVersionShown: offer.disclosureVersion, at: at(T0 + 10) }));
    expect(a.disclosureVersion).toBe(offer.disclosureVersion); expect(acceptanceFor('ofr-a')?.identityAssertionId).toBe('asr-1');
    const again = accept({ offerId: 'ofr-a', identityAssertionId: 'asr-1', localeShown: 'ar-SA', disclosureVersionShown: offer.disclosureVersion, at: at(T0 + 20) });
    expect(again.ok).toBe(false); if (!again.ok) expect(again.error.reason).toBe('OFFER_ALREADY_ACCEPTED');
  });
  it('refuses without an identity assertion, after expiry, and when the disclosure shown is not the current one', () => {
    const offer = seeded('ofr-b');
    expect(accept({ offerId: 'ofr-b', identityAssertionId: ' ', localeShown: 'en-SA', disclosureVersionShown: offer.disclosureVersion, at: at(T0 + 1) }).ok).toBe(false);
    const stale = accept({ offerId: 'ofr-b', identityAssertionId: 'asr-2', localeShown: 'en-SA', disclosureVersionShown: 'deadbeef', at: at(T0 + 1) });
    expect(stale.ok).toBe(false); if (!stale.ok) expect(stale.error.reason).toBe('DISCLOSURE_VERSION_MISMATCH');
    const late = accept({ offerId: 'ofr-b', identityAssertionId: 'asr-2', localeShown: 'en-SA', disclosureVersionShown: offer.disclosureVersion, at: at(T0 + 8 * 86_400) });
    expect(late.ok).toBe(false); if (!late.ok) expect(late.error.reason).toBe('OFFER_EXPIRED');
    expect(findOffer('ofr-b')).toBeDefined();
    expect(money(1n).currency).toBe('SAR');
  });
});
