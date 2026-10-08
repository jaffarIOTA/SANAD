/**
 * #5 The hand-over route releases its Idempotency-Key when the hand-over or
 * its write throws, so the caller can retry the request it never received an
 * answer to — as services/origination/src/server.ts does. Without the release
 * the retry would be refused as IDEMPOTENCY_KEY_IN_FLIGHT for as long as the
 * reservation lives.
 *
 * #3 It releases the key, too, when the write is refused without anything
 * being written — STALE_APPLICATION (409) or PERSISTENCE_FAILED (503) — and
 * does not store that answer: before the fix the 409 was stored against the
 * key, so the upstream system's retry with the same key replayed the
 * conflict forever.
 *
 * The service is the real one, with `handOver` made to throw once, or the
 * save (`mutateBusiness`) made to answer a settle failure once.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

const failures = vi.hoisted(() => ({ handOver: 0, settle: [] as string[] }));

vi.mock('../../apps/ops/src/server/business.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../apps/ops/src/server/business.ts')>();
  return {
    ...real,
    handOver: (...args: Parameters<typeof real.handOver>) => {
      if (failures.handOver > 0) {
        failures.handOver -= 1;
        return Promise.reject(new Error('simulated: the service threw'));
      }
      return real.handOver(...args);
    },
    mutateBusiness: (...args: Parameters<typeof real.mutateBusiness>) => {
      const reason = failures.settle.shift();
      if (reason === 'THROW') return Promise.reject(new Error('simulated: the database write failed'));
      // A settle failure: the save wrote nothing and says so.
      if (reason !== undefined)
        return Promise.resolve({
          ok: false,
          error: { control: 'OP-DETERMINACY', reason, detail: 'simulated: nothing was written' },
        });
      return real.mutateBusiness(...args);
    },
  };
});

const DATABASE = process.env['SANAD_DATABASE_URL'] ?? process.env['SANAD_TEST_DATABASE_URL'];
const TOKEN = 'test-token-upstream-record-idempotency';

describe.skipIf(DATABASE !== undefined)(
  'the hand-over route releases the Idempotency-Key when nothing was written',
  () => {
    let POST: (r: Request) => Promise<Response>;

    beforeAll(async () => {
      process.env['UPSTREAM_RECORD_DEV_TOKEN'] = TOKEN;
      process.env['SANAD_JURISDICTION'] = 'AE';
      const business = await import('../../apps/ops/src/server/business.ts');
      business.resetBusinessStore({ seed: false });
      ({ POST } = await import('../../apps/ops/src/app/api/origination/v1/business-applications/route.ts'));
    });

    const body = (n: string) =>
      JSON.stringify({
        applicationId: `FR-0000${n}`,
        upstreamRef: `upstream-release-${n}`,
        applicant: {
          businessNameEn: 'Release Test Trading LLC',
          registrationRef: `TL-REL-${n}`,
          sector: 'TRADING',
          yearsInOperation: 4,
          owners: [{ displayName: 'Release Owner Example', ref: `owner-rel-${n}` }],
          upstreamVerificationRefs: ['uaepass:assert-rel'],
        },
        productCode: 'sme-term-conventional',
        variantCode: 'SMALL_LOAN',
        purpose: 'INVENTORY',
        requestedMinorUnits: '25000000',
        tenorMonths: 24,
      });
    const post = (payload: string, key: string) =>
      POST(
        new Request('http://ops.test/api/origination/v1/business-applications', {
          method: 'POST',
          body: payload,
          headers: { authorization: `Bearer ${TOKEN}`, 'idempotency-key': key, 'content-type': 'application/json' },
        }),
      );

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
      failures.settle = ['THROW'];
      await expect(post(body('7202'), key)).rejects.toThrow(/write failed/);
      const retry = await post(body('7202'), key);
      expect(retry.status).toBe(201);
      expect(((await retry.json()) as { applicationId: string }).applicationId).toBe('FR-00007202');
    });

    it('#3 a STALE_APPLICATION answer is a 409 that is not stored: the retry with the same key is processed afresh', async () => {
      const key = crypto.randomUUID();
      failures.settle = ['STALE_APPLICATION'];
      const stale = await post(body('7203'), key);
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { reason: string }).reason).toBe('STALE_APPLICATION');
      const retry = await post(body('7203'), key);
      expect(retry.headers.get('idempotent-replay')).toBeNull();
      expect(retry.status).toBe(201);
    });

    it('#2 a PERSISTENCE_FAILED answer is a 503 with Retry-After, not stored either', async () => {
      const key = crypto.randomUUID();
      failures.settle = ['PERSISTENCE_FAILED'];
      const failed = await post(body('7204'), key);
      expect(failed.status).toBe(503);
      expect(failed.headers.get('retry-after')).toBe('1');
      expect(((await failed.json()) as { reason: string }).reason).toBe('PERSISTENCE_FAILED');
      const retry = await post(body('7204'), key);
      expect(retry.headers.get('idempotent-replay')).toBeNull();
      expect(retry.status).toBe(201);
    });

    it('a domain refusal (422) is still stored and replayed: only a write that did not happen is released', async () => {
      const key = crypto.randomUUID();
      const refused = JSON.stringify({ ...(JSON.parse(body('7205')) as object), purpose: 'NOT_A_PURPOSE' });
      const first = await post(refused, key);
      expect(first.status).toBe(422);
      const again = await post(refused, key);
      expect(again.status).toBe(422);
      expect(again.headers.get('idempotent-replay')).toBe('true');
    });
  },
);
