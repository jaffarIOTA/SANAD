/**
 * Wasl W1 — an approved request opens its Murabaha transaction, in DRAFT, and
 * nothing else. Each case attempts something opening must refuse and passes
 * only when it is refused: opening from a request that is not approved, from
 * another institution's request, twice for one request, on goods the board
 * excludes, or on goods that cannot be screened at all. The figures are the
 * product module's — cost from the invoice, a profit amount, the sale price
 * their sum — and the gates all lie ahead.
 *
 * The book is the workbench's in-memory development book (bank-a).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  listTransactions,
  openTransactionForRequest,
  resetTransactions,
  transactionForRequest,
} from '../../apps/ops/src/server/murabaha-transactions.ts';
import { approveRequest, listRequests } from '../../apps/ops/src/server/store.ts';
import { resetShariahApprovals } from '../../services/origination/src/shariah/approvals.ts';
import { recordTestApprovals } from '../support/shariah-approvals.ts';

// The development book's req_00002 finances invoice …0002, and req_00004 invoice …0004.
const EXCLUDED = '3cf5d9a2-0000-4000-8000-000000000002';
const UNSCREENABLE = '3cf5d9a2-0000-4000-8000-000000000004';
vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    // One invoice re-declared as spirits (HS 2208), which the board's register excludes; one whose lines are unknown.
    invoiceGoodsLines: (uuid: string) =>
      uuid === EXCLUDED
        ? [{ lineNo: 1, goodsClassificationCode: '2208' }]
        : uuid === UNSCREENABLE
          ? undefined
          : actual.invoiceGoodsLines(uuid),
  };
});

const SENIOR = { principalId: 'stf-senior-01', tenantId: 'bank-a' };
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'opened' : r.error?.reason);

beforeEach(async () => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  resetTransactions();
  resetShariahApprovals();
  await recordTestApprovals();
});

const awaiting = (counterparty: string) => {
  const r = listRequests().find((x) => x.state === 'AWAITING_REVIEW' && x.counterpartyId.startsWith(counterparty));
  if (r === undefined) throw new Error(`no request awaiting review for ${counterparty}`);
  return r;
};

describe('opening a Murabaha transaction', () => {
  it('an approved request opens one transaction in DRAFT, with the module’s figures and every gate ahead', async () => {
    const r = awaiting('Rawabi');
    expect(reason(await openTransactionForRequest('bank-a', r.requestId, 'stf-senior-01'))).toBe(
      'REQUEST_NOT_APPROVED',
    );
    expectOk(approveRequest(r.requestId, SENIOR));
    const opened = expectOk(await openTransactionForRequest('bank-a', r.requestId, 'stf-senior-01'));
    expect(opened.transaction.state).toBe('DRAFT');
    expect(opened.transactionRef).toMatch(/^WT-\d{6}$/);
    const p = opened.transaction.core.pricing;
    expect(p.costAmount.minorUnits).toBe(r.amountMinorUnits);
    expect(p.profitAmount.minorUnits).toBeGreaterThan(0n);
    expect(p.salePriceAmount.minorUnits).toBe(p.costAmount.minorUnits + p.profitAmount.minorUnits);
    expect(opened.transaction.core.maturityDateHijri).toMatch(/^14\d{2}-\d{2}-\d{2}$/);
    expect(opened.transaction.core.riskPeriodRequiredSeconds).toBeGreaterThanOrEqual(3600);
    expect(opened.gates.gates.map((g) => g.status)).toEqual(['NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED']);
    expect(opened.events).toEqual([
      expect.objectContaining({ eventType: 'TRANSACTION_OPENED', toState: 'DRAFT', actor: 'stf-senior-01' }),
    ]);
    // A profit amount, never a rate: nothing on the transaction names one (M-1).
    expect(
      JSON.stringify(opened.transaction.core, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toMatch(/rate|apr|bp"/i);
  });

  it('opening twice for one request returns the transaction already open', async () => {
    const r = awaiting('Al-Ufuq');
    expectOk(approveRequest(r.requestId, SENIOR));
    const first = expectOk(await openTransactionForRequest('bank-a', r.requestId, 'stf-senior-01'));
    const second = expectOk(await openTransactionForRequest('bank-a', r.requestId, 'stf-checker-01'));
    expect(second.transactionRef).toBe(first.transactionRef);
    expect((await listTransactions('bank-a')).filter((v) => v.requestRef === r.requestId)).toHaveLength(1);
  });

  it('another institution’s request opens nothing', async () => {
    const r = listRequests().find((x) => x.state === 'APPROVED');
    if (r === undefined) throw new Error('no approved request');
    expect(reason(await openTransactionForRequest('fintech-b', r.requestId, 'stf-fb-officer-01'))).toBe(
      'REQUEST_NOT_APPROVED',
    );
    expect(await listTransactions('fintech-b')).toEqual([]);
  });

  it('goods the board’s register excludes open nothing', async () => {
    // req_00002 finances invoice …0002, re-declared above as spirits (HS 2208).
    expectOk(approveRequest('req_00002', SENIOR));
    const refused = await openTransactionForRequest('bank-a', 'req_00002', 'stf-senior-01');
    expect(refused.ok ? '' : `${refused.error.control} ${refused.error.reason}`).toMatch(/^SH-11 /);
    expect(await transactionForRequest('bank-a', 'req_00002')).toBeUndefined();
  });

  it('goods that cannot be screened open nothing', async () => {
    // req_00004 finances invoice …0004, whose lines are unknown; approved against the servicing decline, in writing.
    expectOk(
      approveRequest('req_00004', SENIOR, 'Credit judgement: the exposure is within the institution’s own appetite'),
    );
    expect(reason(await openTransactionForRequest('bank-a', 'req_00004', 'stf-senior-01'))).toBe('GOODS_LINES_UNKNOWN');
    expect(await transactionForRequest('bank-a', 'req_00004')).toBeUndefined();
  });
});
