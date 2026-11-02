/**
 * Tuum's person, lending and account calls answered without a network, for the
 * synthetic demonstration (UAE M6; BNPL booking and servicing): labelled
 * Fixture wherever its answers are shown, used only where a synthetic
 * demonstration is permitted.
 *
 * Deterministic: the same idempotency key always answers the same person,
 * account, contract and posting, as the platform's own idempotency would. A
 * loan type code starting `REFUSE` answers a 200 carrying errors; `RATE`
 * echoes a different interest rate — so the screens can show both refusals.
 *
 * Servicing keeps a small loan book in this process's memory: each contract's
 * terms and the repayments posted to its servicing account. Receivables are
 * derived from them for the date asked, the way the loan system would show
 * them: equal instalments with the rounding remainder on the last, paid in
 * order, overdue the day after the due date. A contract booked with automatic
 * repayment from the customer's own account is debited on each due date, unless
 * the account reference says `insufficient`. The book does not survive a
 * restart of the process; the demonstration rebuilds from an empty database.
 */
import { createHash } from 'node:crypto';

import type { RailEnvelope, RailTransport } from '../kernel/http-transport.ts';
import type { TuumSession } from './authentication.ts';

const short = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);

interface FixtureContract {
  readonly principalMinor: bigint;
  readonly currency: string;
  readonly payments: number;
  readonly firstPaymentDate: string;
  readonly intervalDays?: number;
  readonly paymentDay?: number;
  readonly servicingAccountId?: string;
  readonly automaticRepayment: boolean;
}
interface FixtureBook {
  readonly contracts: Map<string, FixtureContract>;
  /** Posted repayments per servicing account, by the posting's request id (idempotent). */
  readonly postings: Map<string, Map<string, bigint>>;
}
const KEY = Symbol.for('sanad.tuum.demonstration.book');
const book = ((globalThis as unknown as Record<symbol, FixtureBook | undefined>)[KEY] ??= {
  contracts: new Map(),
  postings: new Map(),
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * A decimal token or number → minor units by its text. The adapter's exact decimal tokens
 * (JSON.rawJSON) reach this in-process transport unserialised, so their text is read from `rawJSON`.
 */
const minorOf = (v: unknown): bigint => {
  const text = isRecord(v) && typeof v['rawJSON'] === 'string' ? v['rawJSON'] : typeof v === 'object' ? '' : String(v);
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  return m === null ? 0n : BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
};
const decimal = (minor: bigint): string => `${(minor / 100n).toString()}.${(minor % 100n).toString().padStart(2, '0')}`;
const dayOf = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
const isoOf = (day: number): string => new Date(day * 86_400_000).toISOString().slice(0, 10);

function dueDates(c: FixtureContract): string[] {
  const first = dayOf(c.firstPaymentDate);
  if (c.intervalDays !== undefined)
    return Array.from({ length: c.payments }, (_, i) => isoOf(first + i * (c.intervalDays ?? 0)));
  const [y, m] = c.firstPaymentDate.split('-').map(Number);
  return Array.from({ length: c.payments }, (_, i) => {
    const month = (m ?? 1) - 1 + i;
    const d = new Date(Date.UTC((y ?? 2000) + Math.floor(month / 12), month % 12, c.paymentDay ?? 1));
    return d.toISOString().slice(0, 10);
  });
}

function receivables(c: FixtureContract, asOf: string): Record<string, unknown>[] {
  const n = BigInt(c.payments);
  const base = c.principalMinor / n;
  const dates = dueDates(c);
  const amounts = dates.map((_, i) => (i === c.payments - 1 ? c.principalMinor - base * (n - 1n) : base));
  const today = dayOf(asOf);
  // What the account received: postings, and, for automatic repayment, the instalments due by today.
  let received = [...(book.postings.get(c.servicingAccountId ?? '')?.values() ?? [])].reduce((s, a) => s + a, 0n);
  if (c.automaticRepayment && !(c.servicingAccountId ?? '').includes('insufficient'))
    received += amounts.filter((_, i) => dayOf(dates[i] ?? '') <= today).reduce((s, a) => s + a, 0n);
  return dates.map((due, i) => {
    const amount = amounts[i] ?? 0n;
    const paid = received >= amount ? amount : received > 0n ? received : 0n;
    received -= paid;
    const late = today - dayOf(due);
    const status = paid === amount ? 'PAID' : late > 0 ? 'OVERDUE' : late === 0 ? 'DUE' : 'NOT_DUE';
    return {
      sequenceNumber: i + 1,
      dueDate: due,
      amount: decimal(amount),
      paidAmount: decimal(paid),
      statusCode: status,
      daysPastDue: status === 'OVERDUE' ? late : 0,
    };
  });
}

export class TuumDemonstrationTransport implements RailTransport {
  call(operation: string, envelope: RailEnvelope): Promise<Readonly<Record<string, unknown>>> {
    const id = envelope.headers['x-request-id'] ?? '';
    const body = envelope.body ?? {};
    if (operation === 'person.create')
      return Promise.resolve({ errors: null, data: { personId: `ID-DEMO-P-${short(id.replace(/:person$/, ''))}` } });
    if (operation === 'loan.contract.create') {
      const code = typeof body['loanTypeCode'] === 'string' ? body['loanTypeCode'] : '';
      if (code.startsWith('REFUSE')) return Promise.resolve({ errors: [{ code: 'err.loanTypeNotFound' }], data: null });
      const key = short(id.replace(/:contract$/, ''));
      const headerId = `ID-DEMO-C-${key}`;
      const money = isRecord(body['contractMoney']) ? body['contractMoney'] : {};
      const frequency = isRecord(body['paymentFrequency']) ? body['paymentFrequency'] : undefined;
      book.contracts.set(headerId, {
        principalMinor: minorOf(money['amount']),
        currency: typeof money['currencyCode'] === 'string' ? money['currencyCode'] : 'SAR',
        payments: typeof body['numberOfPayments'] === 'number' ? body['numberOfPayments'] : 1,
        firstPaymentDate: typeof body['firstPaymentDate'] === 'string' ? body['firstPaymentDate'] : '2026-01-01',
        ...(frequency !== undefined && typeof frequency['value'] === 'number'
          ? { intervalDays: frequency['value'] }
          : {}),
        ...(typeof body['paymentDay'] === 'number' ? { paymentDay: body['paymentDay'] } : {}),
        ...(typeof body['servicingAccountId'] === 'string' ? { servicingAccountId: body['servicingAccountId'] } : {}),
        automaticRepayment: body['automaticRepayment'] === true,
      });
      return Promise.resolve({
        errors: null,
        data: {
          headerId,
          contractNumber: `DEMO-${String((Number.parseInt(key, 16) % 9_000_000) + 1_000_000)}`,
          loanTypeCode: code,
          ...(code.startsWith('RATE') ? { interestRate: 99 } : {}),
        },
      });
    }
    if (operation === 'loan.receivables.list') {
      const headerId = decodeURIComponent(/\/contracts\/([^/?]+)\/receivables/.exec(envelope.url)?.[1] ?? '');
      const asOf = /[?&]asOf=(\d{4}-\d{2}-\d{2})/.exec(envelope.url)?.[1] ?? new Date().toISOString().slice(0, 10);
      const c = book.contracts.get(headerId);
      if (c === undefined) return Promise.resolve({ errors: [{ code: 'err.contractNotFound' }], data: null });
      return Promise.resolve({ errors: null, data: { currencyCode: c.currency, receivables: receivables(c, asOf) } });
    }
    // Account-shaped booking of an executed Murabaha (ADR 0007; core-banking-adapter.ts): the party, its
    // collection account, and the receivable posted at the fixed total. Never the lending module.
    if (operation === 'person.resolveOrCreate') {
      const cr = typeof body['registrationNumber'] === 'string' ? body['registrationNumber'] : id;
      return Promise.resolve({ personId: `ID-DEMO-P-${short(cr)}` });
    }
    if (operation === 'account.findByPurpose' || operation === 'account.create') {
      // A consumer loan's own servicing account, one per booking; otherwise the party's account.
      const accountId = id.endsWith(':account')
        ? `ACC-DEMO-${short(id)}`
        : `ACC-DEMO-${short(/\/persons\/([^/]+)\/accounts/.exec(envelope.url)?.[1] ?? '')}`;
      return Promise.resolve({ errors: null, data: [{ accountId }], accountId });
    }
    if (operation === 'account.postTransaction') {
      const reference = typeof body['externalReference'] === 'string' ? body['externalReference'] : '';
      const account = decodeURIComponent(/\/accounts\/([^/]+)\/transactions/.exec(envelope.url)?.[1] ?? '');
      const money = isRecord(body['money']) ? body['money'] : undefined;
      if (money !== undefined) {
        const postings = book.postings.get(account) ?? new Map<string, bigint>();
        postings.set(id, minorOf(money['amount']));
        book.postings.set(account, postings);
      }
      return Promise.resolve({ errors: null, transactionId: `TRX-DEMO-${short(`${id}|${reference}`)}` });
    }
    return Promise.reject(new Error(`no demonstration answer for ${operation}`));
  }
}

/** The demonstration needs no login. */
export const demonstrationSession: TuumSession = {
  authHeaders: () => Promise.resolve({ ok: true, value: { 'x-auth-token': 'demonstration', 'x-tenant-code': 'DEMO' } }),
  invalidate: () => undefined,
} as TuumSession;
