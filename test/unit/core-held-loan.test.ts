/**
 * Servicing a loan the loan system holds (core/servicing/core-held-loan.ts):
 * what to collect, post, report and close on a day, given the loan system's
 * position and what has happened to the loan.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import type { InstalmentPosition, InstalmentStanding, LoanPosition } from '@sanad/core/ports/loan-servicing.ts';
import {
  type CoreHeldLoan,
  type CoreHeldLoanEvent,
  collectionEventKind,
  collectionKey,
  planServicing,
} from '@sanad/core/servicing/core-held-loan.ts';

const LOAN: CoreHeldLoan = {
  loanRef: 'txn_1',
  productCode: 'bnpl',
  applicantRef: 'shopper-1',
  collectionChannel: 'BILL_PRESENTMENT',
  collectionMandateRef: 'bill-acct-1',
};

const row = (n: number, standing: InstalmentStanding, paid = 0n, dpd = 0): InstalmentPosition => ({
  number: n,
  dueDate: `2026-12-0${String(n)}`,
  amount: money(30_000n),
  paid: money(paid),
  outstanding: money(30_000n - paid),
  standing,
  daysPastDue: dpd,
});
const position = (...instalments: InstalmentPosition[]): LoanPosition => ({
  contractRef: 'C-1',
  asOf: '2026-12-02',
  instalments,
  outstanding: money(instalments.reduce((s, i) => s + i.outstanding.minorUnits, 0n)),
  closed: instalments.every((i) => i.outstanding.minorUnits === 0n),
});
const queued = (n: number, attempt: number): CoreHeldLoanEvent => ({
  kind: 'COLLECTION_QUEUED',
  scheduleNumber: n,
  idempotencyKey: collectionKey('txn_1', n, attempt),
  detail: { minorUnits: '30000', currency: 'SAR' },
});
const result = (kind: 'COLLECTION_SETTLED' | 'COLLECTION_RETURNED', n: number, attempt: number): CoreHeldLoanEvent => ({
  kind,
  scheduleNumber: n,
  idempotencyKey: `${collectionKey('txn_1', n, attempt)}:result`,
  detail: {
    collectionKey: collectionKey('txn_1', n, attempt),
    minorUnits: '30000',
    currency: 'SAR',
    settlementRef: 'SET-1',
    valueDate: '2026-12-02',
  },
});

describe('servicing a loan the loan system holds', () => {
  it('collects a due instalment once, through the loan’s channel, keyed by loan, instalment and attempt', () => {
    const plan = planServicing(LOAN, [], position(row(1, 'DUE'), row(2, 'NOT_DUE')), 3);
    expect(plan.collections).toEqual([
      {
        scheduleNumber: 1,
        due: money(30_000n),
        dueDate: '2026-12-01',
        attemptNumber: 0,
        idempotencyKey: 'loan:txn_1:collect:I1',
      },
    ]);
    expect(collectionEventKind('BILL_PRESENTMENT')).toBe('BILL_PRESENT');
  });

  it('never queues a second collection while one is in flight', () => {
    const plan = planServicing(LOAN, [queued(1, 0)], position(row(1, 'OVERDUE', 0n, 2)), 3);
    expect(plan.collections).toEqual([]);
  });

  it('retries a returned collection under a new key, until the tenant’s attempts are used', () => {
    const second = planServicing(
      LOAN,
      [queued(1, 0), result('COLLECTION_RETURNED', 1, 0)],
      position(row(1, 'OVERDUE', 0n, 3)),
      3,
    );
    expect(second.collections.map((c) => c.idempotencyKey)).toEqual(['loan:txn_1:collect:I1:R1']);
    const spent = planServicing(
      LOAN,
      [queued(1, 0), result('COLLECTION_RETURNED', 1, 0), queued(1, 1), result('COLLECTION_RETURNED', 1, 1)],
      position(row(1, 'OVERDUE', 0n, 9)),
      2,
    );
    expect(spent.collections).toEqual([]);
    expect(spent.exhausted).toEqual([1]);
  });

  it('posts a settled collection into the loan system once, keyed from the collection', () => {
    const events = [queued(1, 0), result('COLLECTION_SETTLED', 1, 0)];
    const plan = planServicing(LOAN, events, position(row(1, 'DUE')), 3);
    expect(plan.postings).toHaveLength(1);
    expect(plan.postings[0]?.idempotencyKey).toBe('loan:txn_1:collect:I1:post');
    // Settled but not yet reflected in the position: no second collection.
    expect(plan.collections).toEqual([]);
    const posted: CoreHeldLoanEvent = {
      kind: 'REPAYMENT_POSTED',
      scheduleNumber: 1,
      idempotencyKey: 'loan:txn_1:collect:I1:post',
      detail: {},
    };
    expect(planServicing(LOAN, [...events, posted], position(row(1, 'PAID', 30_000n)), 3).postings).toEqual([]);
  });

  it('collects nothing on the customer’s own account: the loan system debits it', () => {
    const own = { ...LOAN, collectionChannel: 'OWN_ACCOUNT' as const };
    const plan = planServicing(own, [], position(row(1, 'DUE'), row(2, 'OVERDUE', 0n, 4)), 3);
    expect(plan.collections).toEqual([]);
    expect(collectionEventKind('OWN_ACCOUNT')).toBeUndefined();
    // An overdue instalment is still reported, whoever collects it.
    expect(plan.overdue.map((o) => o.scheduleNumber)).toEqual([2]);
  });

  it('reports an overdue instalment once', () => {
    const first = planServicing(LOAN, [], position(row(1, 'OVERDUE', 0n, 3)), 3);
    expect(first.overdue).toEqual([{ scheduleNumber: 1, outstanding: money(30_000n), daysPastDue: 3 }]);
    const reported: CoreHeldLoanEvent = {
      kind: 'INSTALMENT_OVERDUE',
      scheduleNumber: 1,
      idempotencyKey: 'loan:txn_1:overdue:I1',
      detail: {},
    };
    expect(planServicing(LOAN, [reported], position(row(1, 'OVERDUE', 0n, 4)), 3).overdue).toEqual([]);
  });

  it('closes a loan paid in full, once', () => {
    const paid = position(row(1, 'PAID', 30_000n), row(2, 'PAID', 30_000n));
    expect(planServicing(LOAN, [], paid, 3).close).toBe(true);
    const closed: CoreHeldLoanEvent = { kind: 'LOAN_CLOSED', idempotencyKey: 'loan:txn_1:closed', detail: {} };
    expect(planServicing(LOAN, [closed], paid, 3).close).toBe(false);
  });

  it('carries each channel on its own outbox event', () => {
    expect(collectionEventKind('DIRECT_DEBIT')).toBe('PAYMENT_COLLECT');
    expect(collectionEventKind('CARD')).toBe('PAYMENT_COLLECT');
    expect(collectionEventKind('PAYMENT_INITIATION')).toBe('PAYMENT_INITIATE');
  });
});
