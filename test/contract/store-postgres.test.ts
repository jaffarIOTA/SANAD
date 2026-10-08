/**
 * The PostgreSQL store against a real database.
 *
 * Runs only when SANAD_TEST_DATABASE_URL points at a database with migration
 * 0006 applied. Without it the suite reports itself skipped rather than
 * green — a store that has never touched a database is not a tested store.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadOriginationPolicy } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { raise, submitForReview, type Principal } from '@sanad/core/origination/request.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { postgresIdempotencyStore } from '../../services/origination/src/idempotency-postgres.ts';
import { postgresRequestRepository } from '../../services/origination/src/repository-postgres.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const TENANT = '11111111-1111-4111-8111-111111111111';
const at = (s: number) =>
  tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });

describe.skipIf(url === undefined)('PostgreSQL store (SANAD_TEST_DATABASE_URL)', () => {
  it('saves, finds by tenant and partner, lists newest first, and hides other partners', async () => {
    const repo = postgresRequestRepository({ connectionString: url });
    const policy = expectOk(loadOriginationPolicy('bank-a'));
    const maker: Principal = { principalId: 'partner-dev-01', tenantId: TENANT };
    const id = await repo.nextRequestId();
    const request = expectOk(
      submitForReview(
        expectOk(
          raise({
            core: {
              requestId: id,
              tenantId: TENANT,
              programmeId: 'prg-0001',
              counterpartyId: 'cp',
              channel: 'PARTNER_API',
              identification: { kind: 'PARTNER_SYSTEM', partnerId: 'partner-dev-01', credentialRef: 'c' },
              tradeReference: {
                type: 'CLEARED_INVOICE',
                invoiceUuid: id,
                invoiceHash: 'h',
                issuerCr: '1010000002',
                recipientCr: '7001000001',
              },
              requestedAmount: money(5_000_000n),
              requestedTenorDays: 60,
              correlationId: 'c',
              raisedAt: at(1_000),
            },
            maker,
            policy,
          }),
        ),
        at(1_100),
      ),
    );
    await repo.save({ requestId: id, tenantId: TENANT, partnerId: 'partner-dev-01', request, sequence: 0 });
    const found = await repo.find(TENANT, 'partner-dev-01', id);
    expect(found?.request).toEqual(request);
    expect(await repo.find(TENANT, 'partner-other', id)).toBeUndefined();
    const page = await repo.list({ tenantId: TENANT, partnerId: 'partner-dev-01', limit: 1 });
    expect(page.items[0]?.requestId).toBe(id);
    // Newest first means numerically: the feed once sorted the sequence as text, so 8 came before 23.
    const feed = await repo.list({ tenantId: TENANT, partnerId: 'partner-dev-01', limit: 100 });
    const sequences = feed.items.map((i) => Number(i.sequence));
    expect(sequences).toEqual([...sequences].sort((a, b) => b - a));
    await repo.close();
  });

  it('orders the feed by the stored sequence, not by its text rendering', () => {
    const source = readFileSync(
      new URL('../../services/origination/src/repository-postgres.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/order by r\.sequence desc/);
    expect(source).not.toMatch(/order by sequence desc/);
  });

  it('reserves a key atomically, replays with the same fingerprint and conflicts on a different one', async () => {
    const store = postgresIdempotencyStore({ connectionString: url });
    const key = crypto.randomUUID();
    const scope = { tenantId: TENANT, partnerId: 'partner-dev-01', key };
    expect((await store.reserve({ ...scope, fingerprint: 'a' })).kind).toBe('FRESH');
    expect((await store.reserve({ ...scope, fingerprint: 'a' })).kind).toBe('IN_FLIGHT');
    await store.complete({ ...scope, response: { status: 201, body: { ok: true, n: 1n } } });
    const replay = await store.reserve({ ...scope, fingerprint: 'a' });
    expect(replay.kind).toBe('REPLAY');
    if (replay.kind === 'REPLAY') expect(replay.response.body).toEqual({ ok: true, n: 1n });
    expect((await store.reserve({ ...scope, fingerprint: 'b' })).kind).toBe('CONFLICT');
    await store.close();
  });
});
