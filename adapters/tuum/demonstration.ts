/**
 * Tuum's person, lending and account calls answered without a network, for the
 * synthetic demonstration (UAE M6): labelled Fixture wherever its answers are
 * shown, used only where a synthetic demonstration is permitted.
 *
 * Deterministic: the same idempotency key always answers the same person and
 * contract, as the platform's own idempotency would. A loan type code
 * starting `REFUSE` answers a 200 carrying errors; `RATE` echoes a different
 * interest rate — so the screens can show both refusals.
 */
import { createHash } from 'node:crypto';

import type { RailEnvelope, RailTransport } from '../kernel/http-transport.ts';
import type { TuumSession } from './authentication.ts';

const short = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);

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
      return Promise.resolve({
        errors: null,
        data: {
          headerId: `ID-DEMO-C-${key}`,
          contractNumber: `DEMO-${String((Number.parseInt(key, 16) % 9_000_000) + 1_000_000)}`,
          loanTypeCode: code,
          ...(code.startsWith('RATE') ? { interestRate: 99 } : {}),
        },
      });
    }
    // Account-shaped booking of an executed Murabaha (ADR 0007; core-banking-adapter.ts): the party, its
    // collection account, and the receivable posted at the fixed total. Never the lending module.
    if (operation === 'person.resolveOrCreate') {
      const cr = typeof body['registrationNumber'] === 'string' ? body['registrationNumber'] : id;
      return Promise.resolve({ personId: `ID-DEMO-P-${short(cr)}` });
    }
    if (operation === 'account.findByPurpose' || operation === 'account.create') {
      const person = /\/persons\/([^/]+)\/accounts/.exec(envelope.url)?.[1] ?? '';
      return Promise.resolve({
        data: [{ accountId: `ACC-DEMO-${short(person)}` }],
        accountId: `ACC-DEMO-${short(person)}`,
      });
    }
    if (operation === 'account.postTransaction') {
      const reference = typeof body['externalReference'] === 'string' ? body['externalReference'] : '';
      return Promise.resolve({ transactionId: `TRX-DEMO-${short(`${id}|${reference}`)}` });
    }
    return Promise.reject(new Error(`no demonstration answer for ${operation}`));
  }
}

/** The demonstration needs no login. */
export const demonstrationSession: TuumSession = {
  authHeaders: () => Promise.resolve({ ok: true, value: { 'x-auth-token': 'demonstration', 'x-tenant-code': 'DEMO' } }),
  invalidate: () => undefined,
} as TuumSession;
