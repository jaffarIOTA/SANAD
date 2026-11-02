/**
 * Collecting consumer instalments, attempted the wrong way. Each case tries a
 * prohibited outcome and passes only when it fails:
 *
 * - a scheme offered outside its country (SADAD in the UAE, UAEDDS in the
 *   Kingdom);
 * - a profile mapping a channel to a capability its jurisdiction lacks;
 * - a cash collection;
 * - a loan booked at a rate other than the one Sanad sent (0% must stay 0%);
 * - a payment initiation dispatched with no consent;
 * - a bureau report about a BNPL facility that does not state its currency.
 */
import { describe, expect, it } from 'vitest';

import { loadJurisdictionProfile } from '@sanad/config/loader.ts';
import { parseJurisdictionProfile } from '@sanad/core/jurisdiction/profile.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { dispatchOnce, type DispatchPorts } from '@sanad/core/outbox/dispatch.ts';
import { bnpl } from '@sanad/products/bnpl/index.ts';
import { book } from '@sanad/products/bnpl/execution.ts';

import { TuumDemonstrationTransport, demonstrationSession } from '../../adapters/tuum/demonstration.ts';
import { TuumLendingAdapter } from '../../adapters/tuum/lending-adapter.ts';

describe('each country’s collection schemes stay in that country', () => {
  it('the Kingdom carries SADAD bills and no UAE direct debit; the UAE carries UAEDDS direct debit and no SADAD', () => {
    const sa = expectOk(loadJurisdictionProfile('SA'));
    const ae = expectOk(loadJurisdictionProfile('AE'));
    expect(sa.collectionChannels['BILL_PRESENTMENT']).toBe('BILL_COLLECTION');
    expect(sa.collectionChannels['DIRECT_DEBIT']).toBeUndefined();
    expect(ae.collectionChannels['DIRECT_DEBIT']).toBe('PAYMENTS_HUB');
    expect(ae.collectionChannels['BILL_PRESENTMENT']).toBeUndefined();
    // And the rails behind them are each country's own.
    expect(sa.railAdapters['BILL_COLLECTION']).toEqual(['SADAD']);
    expect(ae.railAdapters['BILL_COLLECTION']).toBeUndefined();
    expect(ae.railAdapters['OPEN_BANKING']).toEqual(['OPEN_FINANCE']);
    expect(sa.railAdapters['OPEN_BANKING']).toEqual(['OPEN_BANKING']);
  });

  it('a profile that maps a channel to a capability its jurisdiction does not list is refused', () => {
    const raw = JSON.parse(JSON.stringify(expectOk(loadJurisdictionProfile('AE')))) as Record<string, unknown>;
    raw['collectionChannels'] = { BILL_PRESENTMENT: 'BILL_COLLECTION' };
    const r = parseJurisdictionProfile(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('JURISDICTION_COLLECTION_CHANNELS');
  });

  it('a term sheet asking for cash collection is refused (Art. 22(3))', () => {
    const r = bnpl.validateTerms({
      instalments: 4,
      intervalDays: 30,
      consumerLimitMinorUnits: '500000',
      merchantDiscountPerTenThousand: 400,
      citation: 'SAMA BNPL Rules, Nov 2023, Art. 22(1)',
      collectionMethods: ['CARD', 'CASH'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('TERMS_COLLECTION_NOT_ELECTRONIC');
  });
});

describe('a BNPL loan in the loan system', () => {
  it('is refused when the loan system echoes a rate other than 0%', async () => {
    const a = new TuumLendingAdapter(
      { person: 'https://p.invalid', loan: 'https://l.invalid', account: 'https://a.invalid' },
      demonstrationSession,
      new TuumDemonstrationTransport(),
      'DEMO',
      'FIXTURE',
      {
        accountSetup: {
          accountTypeCode: 'CURRENT',
          customerGroupCode: 'P_RESIDENT',
          priceListTypeCode: 'RETAIL_CURR_PRICE_LIST',
          repaymentTransactionTypeCode: 'LOAN_REPAYMENT',
        },
        restricted: () => Promise.resolve({ idNumber: 'X', idTypeCode: 'NID', givenName: 'G', surname: 'F' }),
      },
    );
    // A product code starting RATE makes the demonstration echo another rate, as a price list would.
    const r = expectOk(
      await a.bookLoan({
        tenantId: 'bank-a',
        applicationId: 'txn_c1',
        borrower: { kind: 'PERSON', partyRef: 'p', restrictedAttributesRef: 'identity:p' },
        productCode: 'RATE-PRICED',
        principal: money(120_000n),
        rateBp: 0n,
        aprBp: 0n,
        numberOfPayments: 4,
        firstPaymentDate: '2026-12-02',
        intervalDays: 30,
        openServicingAccount: true,
        idempotencyKey: 'loan:txn_c1:book',
        correlationId: 'c',
      }),
    );
    expect(r.kind).toBe('REFUSED');
    if (r.kind === 'REFUSED') expect(r.code).toBe('RATE_MISMATCH');
  });
});

describe('dispatching consumer collections', () => {
  const dead = () => Promise.reject(new Error('not this port'));
  const ports = (initiate?: DispatchPorts['paymentInitiation']): DispatchPorts =>
    ({
      payments: { disburse: dead, collect: dead },
      bureau: { report: dead },
      webhooks: { deliver: dead },
      notifications: { send: dead },
      bills: { present: dead, paid: dead },
      ...(initiate === undefined ? {} : { paymentInitiation: initiate }),
    }) as unknown as DispatchPorts;
  const event = (payload: Record<string, string>) => ({
    eventId: 'loan:txn_1:collect:I1',
    tenantId: 'bank-a',
    kind: 'PAYMENT_INITIATE' as const,
    subjectRef: 'txn_1',
    idempotencyKey: 'loan:txn_1:collect:I1',
    payload,
    correlationId: 'c',
  });

  it('a payment initiation without a consent is dead-lettered, never sent', async () => {
    let called = false;
    const r = await dispatchOnce(
      event({ payerRef: 'shopper-1', minorUnits: '30000', currency: 'SAR' }),
      ports({
        initiate: () => {
          called = true;
          return Promise.reject(new Error('must not be called'));
        },
        status: dead,
      } as unknown as DispatchPorts['paymentInitiation']),
      { maxAttempts: 3, backoffSeconds: 60 },
      1,
    );
    expect(r.kind).toBe('DEAD');
    expect(called).toBe(false);
  });

  it('a payment initiation with no payment-initiation port configured is dead-lettered', async () => {
    const r = await dispatchOnce(
      event({ payerRef: 'shopper-1', consentId: 'consent-1', minorUnits: '30000', currency: 'SAR' }),
      ports(),
      { maxAttempts: 3, backoffSeconds: 60 },
      1,
    );
    expect(r).toEqual({ kind: 'DEAD', reason: 'no payment-initiation port is configured' });
  });
});

describe('the bureau is told the facility’s own currency', () => {
  it('a booked BNPL facility’s OPENED report states its currency rather than leaving the dispatcher to assume one', () => {
    const draft = {
      core: {
        transactionId: 'txn_b1',
        tenantId: 'bank-a',
        correlationId: 'c',
        merchantRef: 'mer-1',
        openedAt: { epochSeconds: 1n, authorityId: 'a', tokenDigest: 'd' },
        quote: { basket: money(120_000n), merchantFee: { amount: money(4_800n) } },
      },
    } as unknown as Parameters<typeof book>[0];
    const booked = expectOk(book(draft, { epochSeconds: 2n, authorityId: 'a', tokenDigest: 'd' } as never));
    const report = booked.outbox.events.find((e) => e.kind === 'BUREAU_REPORT');
    expect(report?.payload['currency']).toBe('SAR');
  });
});
