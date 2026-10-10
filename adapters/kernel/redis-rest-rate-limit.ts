/**
 * Rate-limit counters in Redis over its REST interface (the Upstash wire
 * format: a pipeline of commands, bearer token), shared by every replica
 * (SR-031).
 *
 * One fixed window per key: INCR, then EXPIRE … NX starts the window on the
 * first request only, and TTL says how long until it ends. The token is sent
 * in a header and never logged; an error answer's body is not read further
 * than its status. Anything but a clean answer is UNAVAILABLE.
 *
 * Residency: keys carry the tenant and the partner credential's id only, no
 * personal datum; production points this at an in-Kingdom store.
 */

import type { RateLimitPort } from '../../core/ports/rate-limit.ts';

export interface RedisRestOptions {
  readonly url: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function redisRestRateLimiter(o: RedisRestOptions): RateLimitPort {
  const doFetch = o.fetchImpl ?? fetch;
  const endpoint = `${o.url.replace(/\/+$/, '')}/pipeline`;
  return {
    async take(key, limit) {
      const k = `sanad:rl:${key}`;
      try {
        const r = await doFetch(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.token}`, 'content-type': 'application/json' },
          body: JSON.stringify([
            ['INCR', k],
            ['EXPIRE', k, String(limit.windowSeconds), 'NX'],
            ['TTL', k],
          ]),
          signal: AbortSignal.timeout(o.timeoutMs ?? 1_000),
        });
        if (!r.ok) return { kind: 'UNAVAILABLE' };
        const answers = (await r.json()) as readonly { readonly result?: unknown }[];
        const count = answers[0]?.result;
        const ttl = answers[2]?.result;
        if (typeof count !== 'number' || typeof ttl !== 'number') return { kind: 'UNAVAILABLE' };
        return count <= limit.limit
          ? { kind: 'ALLOWED', remaining: limit.limit - count }
          : { kind: 'LIMITED', retryAfterSeconds: ttl > 0 ? ttl : limit.windowSeconds };
      } catch {
        return { kind: 'UNAVAILABLE' };
      }
    },
  };
}
