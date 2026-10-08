/**
 * Merchant onboarding, checkout sessions and partner settlement reconciliation.
 */
import { describe, expect, it } from 'vitest';

import { accept, book, cancel, create, expire, identify, offer, refuse } from '@sanad/core/checkout/session.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { beginOnboarding, canTransact, close, reinstate, suspend, verify } from '@sanad/core/merchants/merchant.ts';
import { emptyOutbox, eventsOfKind } from '@sanad/core/outbox/outbox.ts';
import { reconcile } from '@sanad/core/reconciliation/settlement.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

const at = (s: number) =>
  tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const T0 = 1_791_000_000;
const core = {
  merchantId: 'mer-1',
  tenantId: 'bank-a',
  commercialRegistration: '4030000004',
  legalNameAr: 'متجر',
  legalNameEn: 'Store',
  categoryCode: 'RETAIL',
  settlementAccountRef: 'hub-ref-1',
  onboardedBy: 'stf-maker-01',
  correlationId: 'c',
};
const clear = {
  agreementRef: 'AGR-2026-0001',
  registryLookupRef: 'w-1',
  registryStatus: 'ACTIVE' as const,
  screeningResultRef: 's-1',
  screeningOutcome: 'CLEAR' as const,
  activityPermitted: true,
  verifiedBy: 'ops',
  verifiedAt: at(T0),
};

describe('merchant onboarding', () => {
  it('becomes active only on registry, screening and activity evidence', () => {
    const pending = expectOk(beginOnboarding(core, at(T0)));
    expect(verify(pending, { ...clear, screeningOutcome: 'REFER' }).ok).toBe(false);
    expect(verify(pending, { ...clear, registryStatus: 'SUSPENDED' }).ok).toBe(false);
    expect(verify(pending, { ...clear, activityPermitted: false }).ok).toBe(false);
    expect(verify(pending, { ...clear, registryLookupRef: '' }).ok).toBe(false);
    const active = expectOk(verify(pending, clear));
    expect(canTransact(active)).toBe(true);
    const suspended = expectOk(suspend(active, 'ops', 'chargebacks', at(T0 + 1)));
    expect(canTransact(suspended)).toBe(false);
    expect(canTransact(reinstate(suspended, at(T0 + 2)))).toBe(true);
    expect(expectOk(close(active, 'ops', 'merchant request', at(T0 + 3))).status).toBe('CLOSED');
  });
  it('a store transacts only under an executed contract (SAMA BNPL Rules Art. 27), verified by someone other than whoever onboarded it', () => {
    const pending = expectOk(beginOnboarding(core, at(T0)));
    const noContract = verify(pending, { ...clear, agreementRef: ' ' });
    expect(noContract.ok).toBe(false);
    if (!noContract.ok) {
      expect(noContract.error.reason).toBe('MERCHANT_AGREEMENT_REQUIRED');
      expect(String(noContract.error.context?.['citation'])).toContain('Art. 27');
    }
    const self = verify(pending, { ...clear, verifiedBy: 'stf-maker-01' });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error.reason).toBe('FOUR_EYES_SELF_VERIFICATION');
    expect(beginOnboarding({ ...core, onboardedBy: '' }, at(T0)).ok).toBe(false);
  });
  it('refuses an account by value and a malformed registration', () => {
    expect(beginOnboarding({ ...core, settlementAccountRef: 'SA0380000000608010167519' }, at(T0)).ok).toBe(false);
    expect(beginOnboarding({ ...core, commercialRegistration: '12' }, at(T0)).ok).toBe(false);
  });
});

describe('checkout sessions', () => {
  const session = () =>
    expectOk(
      create({
        sessionId: 's-1',
        tenantId: 'bank-a',
        merchantId: 'mer-1',
        merchantOrderRef: 'ORD-9',
        basket: money(120_000n),
        productCode: 'bnpl',
        returnUrl: 'https://shop.example/return',
        cancelUrl: 'https://shop.example/cancel',
        createdAt: at(T0),
        expiresAtEpochSeconds: BigInt(T0 + 1800),
        correlationId: 'c',
      }),
    );
  it('walks created → identified → offered → accepted → booked, and the merchant can only cancel before acceptance', () => {
    const s0 = session();
    const s1 = expectOk(identify(s0, 'app-1', 'asr-1', at(T0 + 1)));
    const s2 = expectOk(offer(s1, 'ofr-1', 'v1', at(T0 + 2)));
    expect(accept(s2, 'acc-1', 'v0', at(T0 + 3)).ok).toBe(false);
    const s3 = expectOk(accept(s2, 'acc-1', 'v1', at(T0 + 3)));
    const s4 = book(s3, 'txn-1', at(T0 + 4));
    expect(s4.state).toBe('BOOKED');
    expect(cancel(s2, at(T0 + 3)).state).toBe('CANCELLED');
    // @ts-expect-error — an accepted session is not cancellable from the shop
    expect(() => cancel(s3, at(T0 + 5))).toBeDefined();
  });
  it('refuses http return URLs, a non-positive basket, identity without an assertion, and acts after expiry', () => {
    expect(create({ ...session().core, returnUrl: 'http://shop.example/return' }).ok).toBe(false);
    expect(create({ ...session().core, basket: money(0n) }).ok).toBe(false);
    expect(identify(session(), 'app-1', '', at(T0 + 1)).ok).toBe(false);
    expect(identify(session(), 'app-1', 'asr', at(T0 + 5000)).ok).toBe(false);
    expect(expire(session(), at(T0 + 1)).ok).toBe(false);
    expect(expectOk(expire(session(), at(T0 + 5000))).state).toBe('EXPIRED');
    expect(
      refuse(expectOk(identify(session(), 'app-1', 'asr', at(T0 + 1))), 'OP-LIMIT', 'BNPL_CONSUMER_LIMIT_EXCEEDED')
        .state,
    ).toBe('REFUSED');
  });
});

describe('partner settlement reconciliation (revenue-linked collection)', () => {
  const position = {
    transactionId: 'txn-e',
    tenantId: 'fintech-b',
    merchantRef: 'mer-1',
    partnerRef: 'agg-1',
    holdbackPerTenThousand: 1200,
    totalPayable: money(10_690_411n),
    collectedToDate: money(0n),
    correlationId: 'c',
  };
  const line = (ref: string, revenue: bigint, swept: bigint) => ({
    settlementRef: ref,
    partnerRef: 'agg-1',
    merchantRef: 'mer-1',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-07',
    grossRevenue: money(revenue),
    swept: money(swept),
  });
  it('applies a correct sweep, flags a short one, ignores a duplicate and a foreign line', () => {
    const r = expectOk(
      reconcile(
        position,
        [
          line('s1', 50_000_000n, 6_000_000n),
          line('s2', 50_000_000n, 5_000_000n),
          line('s1', 50_000_000n, 6_000_000n),
          { ...line('s3', 1n, 1n), partnerRef: 'other' },
        ],
        emptyOutbox(),
        new Set(),
      ),
    );
    expect(r.outcomes.map((o) => o.outcome.kind)).toEqual(['APPLIED', 'SHORT', 'DUPLICATE', 'FOREIGN']);
    // 6 000 000 + 5 000 000 exceeds the fixed total by 309 589: the total holds, the excess is refunded.
    expect(r.position.collectedToDate.minorUnits).toBe(10_690_411n);
    expect(r.settled).toBe(true);
    expect(eventsOfKind(r.outbox, 'PAYMENT_DISBURSE')[0]?.payload['minorUnits']).toBe('309589');
  });
  it('never collects past the fixed total: the excess is refunded through the outbox, and the total is untouched', () => {
    const nearlyDone = { ...position, collectedToDate: money(10_000_000n) };
    const r = expectOk(reconcile(nearlyDone, [line('s9', 100_000_000n, 12_000_000n)], emptyOutbox(), new Set()));
    expect(r.position.collectedToDate.minorUnits).toBe(10_690_411n);
    expect(r.position.totalPayable.minorUnits).toBe(10_690_411n);
    expect(r.settled).toBe(true);
    const refunds = eventsOfKind(r.outbox, 'PAYMENT_DISBURSE');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.payload['minorUnits']).toBe(String(12_000_000n - 690_411n));
    expect(refunds[0]?.payload['reason']).toBe('OVER_COLLECTION');
  });
  it('refuses to touch a position that already shows over-collection', () => {
    expect(reconcile({ ...position, collectedToDate: money(20_000_000n) }, [], emptyOutbox(), new Set()).ok).toBe(
      false,
    );
  });
});
