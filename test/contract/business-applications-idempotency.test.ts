/**
 * #5 The hand-over route releases its Idempotency-Key when the hand-over or
 * its write throws, so the caller can retry the request it never received an
 * answer to — as services/origination/src/server.ts does. Without the release
 * the retry would be refused as IDEMPOTENCY_KEY_IN_FLIGHT for as long as the
 * reservation lives.
 *
 * The service is the real one, with `handOver` made to throw once.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const failures = vi.hoisted(() => ({ handOver: 0, flush: 0 }));

vi.mock('../../apps/ops/src/server/business.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../apps/ops/src/server/business.ts')>();
  return {
    ...real,
    handOver: (...args: Parameters<typeof real.handOver>) => {
      if (failures.handOver > 0) { failures.handOver -= 1; return Promise.reject(new Error('simulated: the service threw')); }
      return real.handOver(...args);
    },
    flushBusiness: () => {
      if (failures.flush > 0) { failures.flush -= 1; return Promise.reject(new Error('simulated: the database write failed')); }
      return real.flushBusiness();
    },
  };
});

const DATABASE = process.env['SANAD_DATABASE_URL'] ?? process.env['SANAD_TEST_DATABASE_URL'];
const TOKEN = 'test-token-upstream-record-idempotency';

describe.skipIf(DATABASE !== undefined)('the hand-over route releases the Idempotency-Key on a throw', () => {
  let POST: (r: Request) => Promise<Response>;

  beforeAll(async () => {
    process.env['UPSTREAM_RECORD_DEV_TOKEN'] = TOKEN;
    process.env['SANAD_JURISDICTION'] = 'AE';
    const business = await import('../../apps/ops/src/server/business.ts');
    business.resetBusinessStore({ seed: false });
    ({ POST } = await import('../../apps/ops/src/app/api/origination/v1/business-applications/route.ts'));
  });

  const body = (n: string) => JSON.stringify({
    applicationId: `FR-0000${n}`, upstreamRef: `upstream-release-${n}`,
    applicant: { businessNameEn: 'Release Test Trading LLC', registrationRef: `TL-REL-${n}`, sector: 'TRADING', yearsInOperation: 4, owners: [{ displayName: 'Release Owner Example', ref: `owner-rel-${n}` }], upstreamVerificationRefs: ['uaepass:assert-rel'] },
    productCode: 'sme-term-conventional', variantCode: 'SMALL_LOAN', purpose: 'INVENTORY', requestedMinorUnits: '25000000', tenorMonths: 24,
  });
  const post = (payload: string, key: string) => POST(new Request('http://ops.test/api/origination/v1/business-applications', {
    method: 'POST', body: payload, headers: { authorization: `Bearer ${TOKEN}`, 'idempotency-key': key, 'content-type': 'application/json' },
  }));

  it('after the service throws, the same key and body succeed on retry', async () => {
    const key = crypto.randomUUID();
    failures.handOver = 1;
    await expect(post(body('7201'), key)).rejects.toThrow(/service threw/);
    const retry = await post(body('7201'), key);
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replay')).toBeNull();
  });

  it('after the write throws, the same key and body succeed on retry', async () => {
    const key = crypto.randomUUID();
    failures.flush = 1;
    await expect(post(body('7202'), key)).rejects.toThrow(/write failed/);
    const retry = await post(body('7202'), key);
    // The application was created in memory before the write failed; the retry is the idempotent repeat.
    expect([200, 201]).toContain(retry.status);
    expect(((await retry.json()) as { applicationId: string }).applicationId).toBe('FR-00007202');
  });
});
