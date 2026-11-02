/**
 * Tuum's lending adapter for a consumer loan, over the demonstration transport:
 * booking a natural person's loan on a thirty-day schedule with its own
 * servicing account, reading the receivables, and posting a repayment.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import type { LoanBookingRequest } from '@sanad/core/ports/loan-booking.ts';

import type { RailEnvelope, RailTransport } from '../../adapters/kernel/http-transport.ts';
import { TuumDemonstrationTransport, demonstrationSession } from '../../adapters/tuum/demonstration.ts';
import { TuumLendingAdapter } from '../../adapters/tuum/lending-adapter.ts';

const SETUP = {
  accountTypeCode: 'CURRENT',
  customerGroupCode: 'P_RESIDENT',
  priceListTypeCode: 'RETAIL_CURR_PRICE_LIST',
  repaymentTransactionTypeCode: 'LOAN_REPAYMENT',
};
const HOSTS = { person: 'https://p.invalid', loan: 'https://l.invalid', account: 'https://a.invalid' };

/** Records what crosses the wire, then answers as the demonstration does. */
class Recording implements RailTransport {
  readonly calls: { operation: string; envelope: RailEnvelope }[] = [];
  readonly inner = new TuumDemonstrationTransport();
  call(operation: string, envelope: RailEnvelope) {
    this.calls.push({ operation, envelope });
    return this.inner.call(operation, envelope);
  }
}

const adapter = (transport: RailTransport, restricted = true) =>
  new TuumLendingAdapter(HOSTS, demonstrationSession, transport, 'DEMO', 'FIXTURE', {
    accountSetup: SETUP,
    restricted: restricted
      ? (ref) =>
          Promise.resolve({ idNumber: `ID-FOR-${ref}`, idTypeCode: 'NID', givenName: 'Given', surname: 'Family' })
      : () => Promise.resolve(undefined),
  });

const request = (key: string, extra: Partial<LoanBookingRequest> = {}): LoanBookingRequest => ({
  tenantId: 'bank-a',
  applicationId: key,
  borrower: { kind: 'PERSON', partyRef: 'shopper-1', restrictedAttributesRef: 'identity:shopper-1' },
  productCode: 'BNPL SAR 4X',
  principal: money(120_000n),
  rateBp: 0n,
  aprBp: 0n,
  numberOfPayments: 4,
  firstPaymentDate: '2026-12-02',
  intervalDays: 30,
  openServicingAccount: true,
  idempotencyKey: `loan:${key}:book`,
  correlationId: key,
  ...extra,
});

/** The same request, debited from the customer's own account instead of a servicing account opened for it. */
const ownAccount = (r: LoanBookingRequest, ownAccountRef: string): LoanBookingRequest => {
  const { openServicingAccount, ...rest } = r;
  void openServicingAccount;
  return { ...rest, ownAccountRef };
};

describe('Tuum lending adapter: a consumer loan', () => {
  it('books a natural person on a thirty-day schedule with its own servicing account, at the rate Sanad sent', async () => {
    const t = new Recording();
    const booked = expectOk(await adapter(t).bookLoan(request('txn_a1')));
    expect(booked.kind).toBe('ANSWERED');
    if (booked.kind !== 'ANSWERED') return;
    expect(booked.value.servicingAccountRef).toMatch(/^ACC-DEMO-/);
    expect(t.calls.map((c) => c.operation)).toEqual(['person.create', 'account.create', 'loan.contract.create']);
    const person = t.calls[0]?.envelope.body ?? {};
    expect(person['personTypeCode']).toBe('P');
    const contract = t.calls[2]?.envelope.body ?? {};
    expect(contract['paymentFrequency']).toEqual({ value: 30, unitCode: 'DAY' });
    expect(contract['paymentDay']).toBeUndefined();
    expect(contract['servicingAccountId']).toBe(booked.value.servicingAccountRef);
    expect(JSON.stringify(contract['interestRate'])).toBe('0.00');
  });

  it('refuses as unavailable, never guesses, when the borrower’s identity does not resolve', async () => {
    const t = new Recording();
    const r = expectOk(await adapter(t, false).bookLoan(request('txn_a2')));
    expect(r).toEqual({ kind: 'UNAVAILABLE', reason: 'RESTRICTED_ATTRIBUTES_UNAVAILABLE' });
    expect(t.calls).toEqual([]);
  });

  it('reads the receivables, and a posted repayment pays the first instalment', async () => {
    const a = adapter(new TuumDemonstrationTransport());
    const b = expectOk(await a.bookLoan(request('txn_a3')));
    if (b.kind !== 'ANSWERED') throw new Error('not booked');
    const read = async (asOf: string) => {
      const p = expectOk(
        await a.position({ tenantId: 'bank-a', contractRef: b.value.contractRef, asOf, correlationId: 'c' }),
      );
      if (p.kind !== 'ANSWERED') throw new Error('no position');
      return p.value;
    };
    const before = await read('2026-12-02');
    expect(before.instalments.map((i) => [i.dueDate, i.standing])).toEqual([
      ['2026-12-02', 'DUE'],
      ['2027-01-01', 'NOT_DUE'],
      ['2027-01-31', 'NOT_DUE'],
      ['2027-03-02', 'NOT_DUE'],
    ]);
    expect(before.instalments.every((i) => i.amount.minorUnits === 30_000n)).toBe(true);
    const posted = expectOk(
      await a.postRepayment({
        tenantId: 'bank-a',
        contractRef: b.value.contractRef,
        servicingAccountRef: b.value.servicingAccountRef ?? '',
        amount: money(30_000n),
        settlementRef: 'SET-1',
        valueDate: '2026-12-02',
        idempotencyKey: 'loan:txn_a3:collect:I1:post',
        correlationId: 'c',
      }),
    );
    expect(posted.kind).toBe('ANSWERED');
    const after = await read('2026-12-05');
    expect(after.instalments[0]?.standing).toBe('PAID');
    expect(after.instalments[1]?.standing).toBe('NOT_DUE');
    expect(after.outstanding.minorUnits).toBe(90_000n);
  });

  it('a second posting under the same key is the same posting', async () => {
    const a = adapter(new TuumDemonstrationTransport());
    const b = expectOk(await a.bookLoan(request('txn_a4')));
    if (b.kind !== 'ANSWERED') throw new Error('not booked');
    const post = () =>
      a.postRepayment({
        tenantId: 'bank-a',
        contractRef: b.value.contractRef,
        servicingAccountRef: b.value.servicingAccountRef ?? '',
        amount: money(30_000n),
        settlementRef: 'SET-1',
        valueDate: '2026-12-02',
        idempotencyKey: 'loan:txn_a4:collect:I1:post',
        correlationId: 'c',
      });
    await post();
    await post();
    const p = expectOk(
      await a.position({
        tenantId: 'bank-a',
        contractRef: b.value.contractRef,
        asOf: '2027-01-01',
        correlationId: 'c',
      }),
    );
    if (p.kind !== 'ANSWERED') throw new Error('no position');
    expect(p.value.outstanding.minorUnits).toBe(90_000n);
  });

  it('on the customer’s own account the loan system debits each due instalment itself', async () => {
    const a = adapter(new TuumDemonstrationTransport());
    const b = expectOk(await a.bookLoan(ownAccount(request('txn_a5'), 'own-acct-shopper-1')));
    if (b.kind !== 'ANSWERED') throw new Error('not booked');
    expect(b.value.servicingAccountRef).toBe('own-acct-shopper-1');
    const p = expectOk(
      await a.position({
        tenantId: 'bank-a',
        contractRef: b.value.contractRef,
        asOf: '2027-01-01',
        correlationId: 'c',
      }),
    );
    if (p.kind !== 'ANSWERED') throw new Error('no position');
    expect(p.value.instalments.map((i) => i.standing)).toEqual(['PAID', 'PAID', 'NOT_DUE', 'NOT_DUE']);
  });

  it('a position whose figures do not parse is unavailable, never guessed', async () => {
    const broken: RailTransport = {
      call: () =>
        Promise.resolve({
          errors: null,
          data: { currencyCode: 'SAR', receivables: [{ sequenceNumber: 1, amount: 'n/a' }] },
        }),
    };
    const r = expectOk(
      await adapter(broken).position({ tenantId: 'bank-a', contractRef: 'C', asOf: '2026-12-02', correlationId: 'c' }),
    );
    expect(r).toEqual({ kind: 'UNAVAILABLE', reason: 'MALFORMED_POSITION' });
  });
});
