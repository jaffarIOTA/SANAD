/**
 * The Tuum lending adapter (UAE M6): a loan contract on Sanad's terms, for a
 * rate-priced product. The amounts and rate reach the wire as exact decimal
 * tokens made from integers; Sanad's rate is sent and never taken; Tuum's
 * vocabulary stops at the adapter.
 */
import { describe, expect, it } from 'vitest';

import { money } from '../../core/kernel/money.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { type RailEnvelope, type RailTransport, TransportError } from '../../adapters/kernel/http-transport.ts';
import type { TuumSession } from '../../adapters/tuum/authentication.ts';
import { TuumLendingAdapter } from '../../adapters/tuum/lending-adapter.ts';

interface Seen {
  readonly operation: string;
  readonly url: string;
  readonly wire: string;
  readonly requestId: string;
}

const session = (invalidated: string[] = []): TuumSession => ({
  authHeaders: () => Promise.resolve({ ok: true, value: { 'x-auth-token': 't', 'x-tenant-code': 'FUND' } }),
  invalidate: () => {
    invalidated.push('yes');
  },
});

const transport = (answer: (operation: string) => unknown, seen: Seen[] = []): RailTransport => ({
  call(operation: string, envelope: RailEnvelope) {
    seen.push({
      operation,
      url: envelope.url,
      wire: JSON.stringify(envelope.body),
      requestId: envelope.headers['x-request-id'] ?? '',
    });
    const a = answer(operation);
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a as Record<string, unknown>);
  },
});

const ok200 = (contract: Record<string, unknown> = {}) => (operation: string) =>
  operation === 'person.create'
    ? { errors: null, data: { personId: 'ID-P-1' } }
    : { errors: null, data: { headerId: 'ID-C-1', contractNumber: '2026001', ...contract } };

const request = {
  tenantId: 'sme-fund-ae',
  applicationId: 'FR-00009001',
  borrower: { legalNameEn: 'Example Trading LLC', registrationRef: 'licence-1' },
  productCode: 'SME FINANCE AED',
  principal: money(200_000_000n, 'AED'),
  rateBp: 150n,
  aprBp: 162n,
  numberOfPayments: 60,
  firstPaymentDate: '2029-09-10',
  paymentDay: 10,
  idempotencyKey: 'business:FR-00009001:book',
  correlationId: 'c',
};
const adapter = (t: RailTransport, s: TuumSession = session()) =>
  new TuumLendingAdapter({ person: 'https://person.example', loan: 'https://lending.example' }, s, t, 'FUND', 'LIVE');

describe('booking a loan contract', () => {
  it('creates the legal person, then the contract on Sanad’s terms, and returns the contract number as the loan account', async () => {
    const seen: Seen[] = [];
    const r = expectOk(await adapter(transport(ok200(), seen)).bookLoan(request));
    expect(r).toEqual({ kind: 'ANSWERED', value: { loanAccountNumber: '2026001', contractRef: 'ID-C-1', customerRef: 'ID-P-1' } });
    expect(seen.map((s) => [s.operation, s.url, s.requestId])).toEqual([
      ['person.create', 'https://person.example/api/v2/persons', 'business:FR-00009001:book:person'],
      ['loan.contract.create', 'https://lending.example/api/v1/persons/ID-P-1/contracts', 'business:FR-00009001:book:contract'],
    ]);
    // Exact decimal tokens on the wire, made from integers: 2,000,000.00 AED at 1.50%, APR 1.62%.
    expect(seen[1]?.wire).toContain('"contractMoney":{"amount":2000000.00,"currencyCode":"AED"}');
    expect(seen[1]?.wire).toContain('"interestRate":1.50');
    expect(seen[1]?.wire).toContain('"apr":1.62');
    expect(seen[1]?.wire).toContain('"tenantCode":"FUND"');
    expect(seen[1]?.wire).toContain('"loanTypeCode":"SME FINANCE AED"');
    expect(seen[0]?.wire).toContain('"personTypeCode":"L"');
  });

  it('refuses a contract that echoes a different rate; accepts the same rate however it is written', async () => {
    const differ = expectOk(await adapter(transport(ok200({ interestRate: 2.5 }))).bookLoan(request));
    expect(differ).toEqual({ kind: 'REFUSED', code: 'RATE_MISMATCH', referenceId: 'ID-C-1' });
    expect(expectOk(await adapter(transport(ok200({ interestRate: 1.5 }))).bookLoan(request)).kind).toBe('ANSWERED');
    expect(expectOk(await adapter(transport(ok200({ interestRate: '1.50' }))).bookLoan(request)).kind).toBe('ANSWERED');
  });

  it('a 200 carrying errors is a refusal; a transport failure is unavailable, and a 401 discards the token', async () => {
    const refused = expectOk(
      await adapter(transport((op) => (op === 'person.create' ? { errors: null, data: { personId: 'P' } } : { errors: [{ code: 'err.loanTypeNotFound' }] }))).bookLoan(
        request,
      ),
    );
    expect(refused).toEqual({ kind: 'REFUSED', code: 'err.loanTypeNotFound' });
    const invalidated: string[] = [];
    const down = expectOk(await adapter(transport(() => new TransportError('person.create', 401, 'no')), session(invalidated)).bookLoan(request));
    expect(down).toEqual({ kind: 'UNAVAILABLE', reason: 'HTTP_401' });
    expect(invalidated).toEqual(['yes']);
  });

  it('refuses incomplete terms without a call', async () => {
    const seen: Seen[] = [];
    const r = await adapter(transport(ok200(), seen)).bookLoan({ ...request, numberOfPayments: 0 });
    expect(r.ok ? 'called' : r.error.reason).toBe('LOAN_BOOKING_INVALID');
    expect(seen).toHaveLength(0);
  });
});
