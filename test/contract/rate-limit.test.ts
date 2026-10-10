/**
 * SR-031: the partner API limits each credential, and each tenant as a whole.
 * Against the service itself: the n+1th request in a window answers 429 with
 * Retry-After and a bilingual problem; another credential of another tenant
 * is unaffected; a credential sharing the tenant meets the tenant's limit.
 * And the shared counter store over its REST interface, with a stand-in.
 */
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redisRestRateLimiter } from '../../adapters/kernel/redis-rest-rate-limit.ts';
import { createHealthService } from '../../services/origination/src/health.ts';
import { inMemoryIdempotencyStore } from '../../services/origination/src/idempotency.ts';
import type { CredentialRegistry, PartnerPrincipal } from '../../services/origination/src/principal.ts';
import { inMemoryRateLimiter } from '../../services/origination/src/rate-limit.ts';
import { inMemoryRequestRepository } from '../../services/origination/src/repository.ts';
import { BASE_PATH, createService, developmentTimestamps } from '../../services/origination/src/server.ts';

const sha = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');
const principal = (partnerId: string, tenantId: string): PartnerPrincipal => ({
  partnerId,
  tenantId,
  channel: 'PARTNER_API',
  scopes: ['origination:read'],
  credentialRef: `cred-${partnerId}`,
});
const TOKENS = {
  'tok-a1': principal('partner-a1', 'bank-a'),
  'tok-a2': principal('partner-a2', 'bank-a'),
  'tok-b1': principal('partner-b1', 'fintech-b'),
} as const;
const registry: CredentialRegistry = {
  findByTokenDigest: (digest) => Object.entries(TOKENS).find(([t]) => sha(t) === digest)?.[1],
};

let server: Server;
let origin: string;
let now = 1_800_000_010n;

beforeAll(async () => {
  server = createService({
    repository: inMemoryRequestRepository(),
    idempotency: inMemoryIdempotencyStore(),
    credentials: registry,
    timestamps: developmentTimestamps(),
    health: createHealthService({ checks: [] }),
    rateLimiter: inMemoryRateLimiter(() => now),
    rateLimits: { principal: { limit: 3, windowSeconds: 60 }, tenant: { limit: 5, windowSeconds: 60 } },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${BASE_PATH}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

const list = (token: keyof typeof TOKENS) =>
  fetch(`${origin}/requests`, { headers: { authorization: `Bearer ${token}` } });

describe('partner API rate limits (SR-031)', () => {
  it('answers the n+1th request of a credential 429 with Retry-After, in both languages', async () => {
    for (let i = 0; i < 3; i++) expect((await list('tok-a1')).status).not.toBe(429);
    const limited = await list('tok-a1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('50');
    const body = (await limited.json()) as { reason: string; detailAr: string; context: { retryAfterSeconds: number } };
    expect(body.reason).toBe('RATE_LIMITED');
    expect(body.detailAr.length).toBeGreaterThan(0);
    expect(body.context.retryAfterSeconds).toBe(50);
  });

  it('leaves another tenant’s credential alone, and holds the tenant to its own limit', async () => {
    expect((await list('tok-b1')).status).not.toBe(429);
    // bank-a has used 4 of its 5 (3 admitted and one refused, which still counted).
    expect((await list('tok-a2')).status).not.toBe(429);
    expect((await list('tok-a2')).status).toBe(429);
  });

  it('admits again once the window has passed', async () => {
    now += 60n;
    expect((await list('tok-a1')).status).not.toBe(429);
  });
});

describe('the shared counter store over REST (SR-031)', () => {
  const stand = (answer: () => Promise<Response>) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const limiter = redisRestRateLimiter({
      url: 'https://counters.example/',
      token: 'test-only-token',
      fetchImpl: (url, init) => {
        seen.push({ url: String(url), init: init ?? {} });
        return answer();
      },
    });
    return { limiter, seen };
  };
  const reply = (count: number, ttl: number) =>
    Promise.resolve(Response.json([{ result: count }, { result: 1 }, { result: ttl }]));

  it('counts in one pipeline, starts the window on the first request only, and reads the wait from TTL', async () => {
    const { limiter, seen } = stand(() => reply(4, 17));
    expect(await limiter.take('partner:bank-a:p1', { limit: 3, windowSeconds: 60 })).toEqual({
      kind: 'LIMITED',
      retryAfterSeconds: 17,
    });
    expect(seen[0]?.url).toBe('https://counters.example/pipeline');
    expect(JSON.parse(String(seen[0]?.init.body))).toEqual([
      ['INCR', 'sanad:rl:partner:bank-a:p1'],
      ['EXPIRE', 'sanad:rl:partner:bank-a:p1', '60', 'NX'],
      ['TTL', 'sanad:rl:partner:bank-a:p1'],
    ]);
    expect((seen[0]?.init.headers as Record<string, string>)['authorization']).toBe('Bearer test-only-token');
    expect(await stand(() => reply(2, 40)).limiter.take('k', { limit: 3, windowSeconds: 60 })).toEqual({
      kind: 'ALLOWED',
      remaining: 1,
    });
  });

  it('a store that errs or does not answer is UNAVAILABLE, never a refusal', async () => {
    const limit = { limit: 1, windowSeconds: 60 };
    expect(await stand(() => Promise.resolve(new Response('no', { status: 401 }))).limiter.take('k', limit)).toEqual({
      kind: 'UNAVAILABLE',
    });
    expect(await stand(() => Promise.reject(new Error('down'))).limiter.take('k', limit)).toEqual({
      kind: 'UNAVAILABLE',
    });
  });
});
