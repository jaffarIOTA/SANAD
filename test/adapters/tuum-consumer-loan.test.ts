/**
 * Tuum's lending adapter for a consumer loan, over the demonstration transport:
 * booking a natural person's loan through the offer workflow (the path the
 * sandbox books, README "Sandbox run — KBNPL, 2026-11-03") on a thirty-day or a
 * monthly plan with its own servicing account, the offer's schedule checked
 * against the plan disclosed, reading the receivables, and posting a repayment.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import type { LoanBookingRequest } from '@sanad/core/ports/loan-booking.ts';

import { type RailEnvelope, type RailTransport, TransportError } from '../../adapters/kernel/http-transport.ts';
import { TuumDemonstrationTransport, demonstrationSession } from '../../adapters/tuum/demonstration.ts';
import { TuumLendingAdapter, type TuumOfferPacing } from '../../adapters/tuum/lending-adapter.ts';

const SETUP = {
  accountTypeCode: 'CURRENCY',
  customerGroupCode: 'P_RESIDENT',
  priceListTypeCode: 'RETAIL_CURR_PRICE_LIST',
  repaymentTransactionTypeCode: 'LOAN_REPAYMENT',
};
const HOSTS = { person: 'https://p.invalid', loan: 'https://l.invalid', account: 'https://a.invalid' };
/** No real waiting in a test; a handful of reads before a step is reported unavailable. */
const PACING: TuumOfferPacing = { pause: () => Promise.resolve(), intervalMs: 0, attempts: 5 };

/** Records what crosses the wire, then answers as the demonstration does, or as `override` says. */
class Recording implements RailTransport {
  readonly calls: { operation: string; envelope: RailEnvelope }[] = [];
  readonly inner = new TuumDemonstrationTransport();
  constructor(
    private readonly override?: (
      operation: string,
      envelope: RailEnvelope,
    ) => Readonly<Record<string, unknown>> | undefined,
  ) {}
  call(operation: string, envelope: RailEnvelope) {
    this.calls.push({ operation, envelope });
    const answered = this.override?.(operation, envelope);
    return answered === undefined ? this.inner.call(operation, envelope) : Promise.resolve(answered);
  }
  operations() {
    return this.calls.map((c) => c.operation);
  }
  body(operation: string) {
    return this.calls.find((c) => c.operation === operation)?.envelope.body ?? {};
  }
}

const adapter = (transport: RailTransport, restricted = true) =>
  new TuumLendingAdapter(
    HOSTS,
    demonstrationSession,
    transport,
    'DEMO',
    'FIXTURE',
    {
      accountSetup: SETUP,
      restricted: restricted
        ? (ref) =>
            Promise.resolve({ idNumber: `ID-FOR-${ref}`, idTypeCode: 'NID', givenName: 'Given', surname: 'Family' })
        : () => Promise.resolve(undefined),
    },
    PACING,
  );

const plan = (dates: readonly string[], each: bigint) => dates.map((dueDate) => ({ dueDate, amount: money(each) }));

const request = (key: string, extra: Partial<LoanBookingRequest> = {}): LoanBookingRequest => ({
  tenantId: 'bank-a',
  applicationId: key,
  borrower: { kind: 'PERSON', partyRef: 'shopper-1', restrictedAttributesRef: 'identity:shopper-1' },
  productCode: 'KBNPL',
  principal: money(120_000n),
  rateBp: 0n,
  aprBp: 0n,
  numberOfPayments: 4,
  firstPaymentDate: '2026-12-02',
  intervalDays: 30,
  countryCode: 'SA',
  expectedInstalments: plan(['2026-12-02', '2027-01-01', '2027-01-31', '2027-03-02'], 30_000n),
  openServicingAccount: true,
  idempotencyKey: `loan:${key}:book`,
  correlationId: key,
  ...extra,
});

/** The same request on a monthly plan: the third of each month from December. */
const monthly = (key: string): LoanBookingRequest => {
  const { intervalDays, ...rest } = request(key);
  void intervalDays;
  return {
    ...rest,
    principal: money(400_000n),
    firstPaymentDate: '2026-12-03',
    paymentDay: 3,
    intervalMonths: 1,
    expectedInstalments: plan(['2026-12-03', '2027-01-03', '2027-02-03', '2027-03-03'], 100_000n),
  };
};

/** The same request, debited from the customer's own account instead of a servicing account opened for it. */
const ownAccount = (r: LoanBookingRequest, ownAccountRef: string): LoanBookingRequest => {
  const { openServicingAccount, ...rest } = r;
  void openServicingAccount;
  return { ...rest, ownAccountRef };
};

describe('Tuum lending adapter: a consumer loan, through the offer workflow', () => {
  it('books a natural person on a thirty-day plan: offer, schedule checked, instruction, review, approval, acceptance, contract confirmed', async () => {
    const t = new Recording();
    const booked = expectOk(await adapter(t).bookLoan(request('txn_a1')));
    expect(booked.kind).toBe('ANSWERED');
    if (booked.kind !== 'ANSWERED') return;
    expect(booked.value.servicingAccountRef).toMatch(/^ACC-DEMO-/);
    expect(booked.value.loanAccountNumber).toMatch(/^DEMO-/);
    expect(booked.value.awaitingActivation).toBe(false);
    const steps = t.operations().filter((o) => o !== 'loan.offer.read' && o !== 'loan.version.read');
    expect(steps).toEqual([
      'person.create',
      'account.create',
      'loan.offer.create',
      'loan.offer.schedule',
      'loan.offer.paymentInstruction',
      'loan.offer.review',
      'loan.offer.approve',
      'loan.offer.accept',
      'loan.offer.contracts',
      'loan.version.confirm',
    ]);
    expect(t.body('person.create')['personTypeCode']).toBe('P');
    // The account API refuses a blank personName (sandbox 2026-11-03): the party's name, resolved in the adapter.
    expect(t.body('account.create')['personName']).toBe('Given Family');
    const offer = t.body('loan.offer.create');
    expect(offer['loanTypeCode']).toBe('KBNPL');
    expect(offer['countryCode']).toBe('SA');
    expect(offer['paymentFrequency']).toBe(30);
    expect(offer['paymentFrequencyUnit']).toBe('DAY');
    expect(offer['paymentDay']).toBeUndefined();
    expect(offer['numberOfPayments']).toBe(4);
    expect(offer['loanPeriod']).toBeUndefined();
    // One interval before the first payment: the day the shopper drew the financing.
    expect(offer['limitUsageDate']).toBe('2026-11-02');
    expect(offer['servicingAccountId']).toBe(booked.value.servicingAccountRef);
    // A plan with no charge for credit sends no rate for the price list to apply.
    expect(offer['interestRate']).toBeUndefined();
  });

  it('books a monthly plan on the payment day, and the loan system’s instalments fall on those dates', async () => {
    const t = new Recording();
    const a = adapter(t);
    const booked = expectOk(await a.bookLoan(monthly('txn_m1')));
    if (booked.kind !== 'ANSWERED') throw new Error('not booked');
    const offer = t.body('loan.offer.create');
    expect(offer['paymentDay']).toBe(3);
    expect(offer['paymentFrequency']).toBe(1);
    expect(offer['paymentFrequencyUnit']).toBe('MONTH');
    expect(offer['loanPeriod']).toBe(4);
    // Never both (err.loanPeriodAndNumberOfPaymentsNotAllowedTogether, sandbox 2026-11-03).
    expect(offer['numberOfPayments']).toBeUndefined();
    expect(offer['limitUsageDate']).toBe('2026-11-03');
    const p = expectOk(
      await a.position({
        tenantId: 'bank-a',
        contractRef: booked.value.contractRef,
        asOf: '2026-12-01',
        correlationId: 'c',
      }),
    );
    if (p.kind !== 'ANSWERED') throw new Error('no position');
    expect(p.value.instalments.map((i) => [i.dueDate, i.amount.minorUnits])).toEqual([
      ['2026-12-03', 100_000n],
      ['2027-01-03', 100_000n],
      ['2027-02-03', 100_000n],
      ['2027-03-03', 100_000n],
    ]);
  });

  it('refuses before anything is accepted when the loan system’s schedule is not the plan disclosed', async () => {
    const t = new Recording();
    // The shopper was shown the 2nd of each month; the loan system would book every thirty days.
    const r = expectOk(
      await adapter(t).bookLoan(
        request('txn_a6', {
          expectedInstalments: plan(['2026-12-02', '2027-01-02', '2027-02-02', '2027-03-02'], 30_000n),
        }),
      ),
    );
    expect(r).toMatchObject({ kind: 'REFUSED', code: 'SCHEDULE_MISMATCH' });
    expect(t.operations()).not.toContain('loan.offer.paymentInstruction');
    expect(t.operations()).not.toContain('loan.offer.accept');
  });

  it('refuses the instalment amounts too, not only the dates', async () => {
    const r = expectOk(
      await adapter(new Recording()).bookLoan(
        request('txn_a7', {
          expectedInstalments: plan(['2026-12-02', '2027-01-01', '2027-01-31', '2027-03-02'], 30_001n),
        }),
      ),
    );
    expect(r).toMatchObject({ kind: 'REFUSED', code: 'SCHEDULE_MISMATCH' });
  });

  it('takes each step only once the workflow has reached the state that permits it', async () => {
    let reads = 0;
    // The workflow is still validating the offer for the first two reads after the instruction.
    const t = new Recording((operation) => {
      if (operation !== 'loan.offer.read') return undefined;
      reads += 1;
      return reads <= 2 ? { errors: null, data: { offerId: 'x', statusCode: 'VALIDATING' } } : undefined;
    });
    const booked = expectOk(await adapter(t).bookLoan(request('txn_a8')));
    expect(booked.kind).toBe('ANSWERED');
    const ops = t.operations();
    // Two reads still validating, then the one that finds it waiting for review: only then the review.
    expect(ops.slice(ops.indexOf('loan.offer.paymentInstruction') + 1, ops.indexOf('loan.offer.review'))).toEqual([
      'loan.offer.read',
      'loan.offer.read',
      'loan.offer.read',
    ]);
  });

  it('is unavailable, and accepts nothing, when the workflow does not move on', async () => {
    const t = new Recording((operation) =>
      operation === 'loan.offer.read' ? { errors: null, data: { offerId: 'x', statusCode: 'VALIDATING' } } : undefined,
    );
    const r = expectOk(await adapter(t).bookLoan(request('txn_a9')));
    expect(r).toEqual({ kind: 'UNAVAILABLE', reason: 'LOAN_SYSTEM_WORKFLOW_PENDING' });
    expect(t.operations()).not.toContain('loan.offer.accept');
  });

  it('gives the payment instruction again, under the same request id, while the new offer is still being prepared', async () => {
    let refused = 0;
    const t = new Recording((operation) => {
      if (operation !== 'loan.offer.paymentInstruction' || refused >= 2) return undefined;
      refused += 1;
      // As the sandbox answered on 2026-11-03: HTTP 400, err.offerNotSuitableForValidation.
      throw new TransportError(operation, 400, `${operation}: HTTP 400`);
    });
    const booked = expectOk(await adapter(t).bookLoan(request('txn_a13')));
    expect(booked.kind).toBe('ANSWERED');
    const given = t.calls.filter((c) => c.operation === 'loan.offer.paymentInstruction');
    expect(given).toHaveLength(3);
    expect(new Set(given.map((c) => c.envelope.headers['x-request-id'])).size).toBe(1);
  });

  it('stops after a bounded number of refused instructions, and nothing is booked', async () => {
    const t = new Recording((operation) => {
      if (operation === 'loan.offer.paymentInstruction') throw new TransportError(operation, 400, 'HTTP 400');
      return undefined;
    });
    const r = expectOk(await adapter(t).bookLoan(request('txn_a14')));
    expect(r).toEqual({ kind: 'UNAVAILABLE', reason: 'HTTP_400' });
    expect(t.operations().filter((o) => o === 'loan.offer.paymentInstruction')).toHaveLength(11);
    expect(t.operations()).not.toContain('loan.offer.review');
  });

  it('is refused when the loan system ends the offer', async () => {
    const t = new Recording((operation) =>
      operation === 'loan.offer.read' ? { errors: null, data: { offerId: 'x', statusCode: 'REJECTED' } } : undefined,
    );
    const r = expectOk(await adapter(t).bookLoan(request('txn_a10')));
    expect(r).toMatchObject({ kind: 'REFUSED', code: 'OFFER_REJECTED' });
  });

  it('reports a contract the loan system has not yet activated as awaiting activation', async () => {
    // After confirmation the loan system's own steps (review, files, asset transaction) are still to run.
    let confirmed = false;
    const t = new Recording((operation, envelope): Readonly<Record<string, unknown>> | undefined => {
      if (operation === 'loan.version.confirm') confirmed = true;
      return operation === 'loan.version.read' && confirmed
        ? { errors: null, data: { versionId: envelope.url, statusCode: 'DRAFT_CONFIRMED' } }
        : undefined;
    });
    const booked = expectOk(await adapter(t).bookLoan(request('txn_a11')));
    if (booked.kind !== 'ANSWERED') throw new Error('not booked');
    expect(booked.value.awaitingActivation).toBe(true);
  });

  it('refuses as unavailable, never guesses, when the borrower’s identity does not resolve', async () => {
    const t = new Recording();
    const r = expectOk(await adapter(t, false).bookLoan(request('txn_a2')));
    expect(r).toEqual({ kind: 'UNAVAILABLE', reason: 'RESTRICTED_ATTRIBUTES_UNAVAILABLE' });
    expect(t.calls).toEqual([]);
  });

  it('refuses a consumer booking that does not carry the institution’s country', async () => {
    const { countryCode, ...rest } = request('txn_a12');
    void countryCode;
    const r = await adapter(new Recording()).bookLoan(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('LOAN_BOOKING_INVALID');
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
