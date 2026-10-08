/**
 * The workbench's request book on PostgreSQL: what is saved is what is
 * loaded, including bigint amounts and attested instants; a later save of the
 * same request replaces it rather than duplicating it; display labels ride
 * beside the request and never inside it. Runs only when
 * SANAD_TEST_DATABASE_URL points at a database with migrations 0006 and 0010.
 */
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { loadOriginationPolicy } from '@sanad/config/loader.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { raise, submitForReview, type Keying } from '@sanad/core/origination/request.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

import { loadRequests, persistenceUrl, saveRequests } from '../../apps/ops/src/server/persistence.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const at = (s: number) =>
  tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const T0 = 1_791_500_000;
const RUN = String(Date.now());

function keying(requestId: string): Keying {
  return expectOk(
    raise({
      core: {
        requestId,
        tenantId: 'fintech-b',
        programmeId: 'prg-0001',
        counterpartyId: 'Example Industrial Supplies Co.',
        channel: 'MAKER_CHECKER',
        tradeReference: {
          type: 'CLEARED_INVOICE',
          invoiceUuid: `00000000-0000-4000-8000-${RUN.slice(-12).padStart(12, '0')}`,
          invoiceHash: 'h',
          issuerCr: '1010000002',
          recipientCr: '7001000001',
        },
        requestedAmount: money(12_345_678n),
        requestedTenorDays: 90,
        raisedAt: at(T0),
        identification: { kind: 'STAFF_PRINCIPAL', principalId: 'stf-maker-01' },
        correlationId: `cor-${RUN}`,
      },
      maker: { principalId: 'stf-maker-01', tenantId: 'fintech-b' },
      policy: expectOk(loadOriginationPolicy('fintech-b')),
    }),
  );
}

describe('the workbench only persists against an explicitly configured database', () => {
  it('ignores the test database fallback and an empty value', () => {
    expect(persistenceUrl({ SANAD_TEST_DATABASE_URL: 'postgresql://x' })).toBeUndefined();
    expect(persistenceUrl({ SANAD_DATABASE_URL: '  ' })).toBeUndefined();
    expect(persistenceUrl({ SANAD_DATABASE_URL: ' postgresql://y ' })).toBe('postgresql://y');
  });
});

describe.skipIf(url === undefined)('the request book on PostgreSQL (SANAD_TEST_DATABASE_URL)', () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const requestId = `req_contract_${RUN}`;
  afterAll(async () => {
    await pool.query('delete from core.origination_request where request_id = $1', [requestId]);
    await pool.end();
  });

  it('loads back exactly what was saved, bigints and attested instants intact, with the display label beside it', async () => {
    const request = keying(requestId);
    await saveRequests(pool, 'fintech-b', [{ requestId, request, invoiceNumber: 'INV-CONTRACT-1' }]);
    const found = (await loadRequests(pool, 'fintech-b')).find((r) => r.requestId === requestId);
    expect(found?.request).toEqual(request);
    expect(found?.request.core.requestedAmount.minorUnits).toBe(12_345_678n);
    expect(found?.invoiceNumber).toBe('INV-CONTRACT-1');
    const raw = await pool.query<{ request: Record<string, unknown>; display: Record<string, unknown> }>(
      'select request, display from core.origination_request where request_id = $1',
      [requestId],
    );
    expect(raw.rows[0]?.request['invoiceNumber']).toBeUndefined();
    expect(raw.rows[0]?.display['invoiceNumber']).toBe('INV-CONTRACT-1');
  });

  it('a later save of the same request replaces it: one row, the new state', async () => {
    const submitted = expectOk(submitForReview(keying(requestId), at(T0 + 60)));
    await saveRequests(pool, 'fintech-b', [{ requestId, request: submitted, invoiceNumber: 'INV-CONTRACT-1' }]);
    const rows = await pool.query<{ state: string }>(
      'select state from core.origination_request where request_id = $1',
      [requestId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.state).toBe(submitted.state);
    const found = (await loadRequests(pool, 'fintech-b')).find((r) => r.requestId === requestId);
    expect(found?.request.state).toBe(submitted.state);
  });

  it('a book belongs to its tenant: another tenant does not see the row', async () => {
    expect((await loadRequests(pool, 'bank-a')).some((r) => r.requestId === requestId)).toBe(false);
  });
});
