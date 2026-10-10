/**
 * Rate limits for the partner API (SR-031): per credential and per tenant,
 * counted in a store shared by every replica when one is configured.
 *
 * The defaults suit Phase 1; a tenant's own limits belong in its
 * configuration and replace these when it carries them. The `n+1`th request
 * in a window is refused 429 with Retry-After; a counter store that does not
 * answer admits the request, because a limiter outage must not become an API
 * outage.
 */

import type { RateDecision, RateLimit, RateLimitPort } from '../../../core/ports/rate-limit.ts';
import { redisRestRateLimiter } from '../../../adapters/kernel/redis-rest-rate-limit.ts';

export interface PartnerRateLimits {
  /** One credential. */
  readonly principal: RateLimit;
  /** Every credential of one tenant together. */
  readonly tenant: RateLimit;
}

export const DEFAULT_PARTNER_RATE_LIMITS: PartnerRateLimits = {
  principal: { limit: 120, windowSeconds: 60 },
  tenant: { limit: 600, windowSeconds: 60 },
};

/** This process's counters: fixed windows on the host clock, pruned as they close. */
export function inMemoryRateLimiter(
  nowEpochSeconds: () => bigint = () => BigInt(Math.floor(Date.now() / 1000)),
): RateLimitPort {
  const windows = new Map<string, { readonly endsAt: bigint; count: number }>();
  return {
    take(key, limit) {
      const now = nowEpochSeconds();
      for (const [k, w] of windows) if (w.endsAt <= now) windows.delete(k);
      const window = BigInt(limit.windowSeconds);
      const endsAt = (now / window + 1n) * window;
      const w = windows.get(key) ?? { endsAt, count: 0 };
      w.count += 1;
      windows.set(key, w);
      return Promise.resolve(
        w.count <= limit.limit
          ? { kind: 'ALLOWED', remaining: limit.limit - w.count }
          : { kind: 'LIMITED', retryAfterSeconds: Number(w.endsAt - now) },
      );
    },
  };
}

type Env = Readonly<Record<string, string | undefined>>;

/** The shared counter store when its URL and token are configured; else this process's. */
export function configuredRateLimiter(env: Env = process.env): RateLimitPort {
  const url = env['IOTA_REDIS_URL']?.trim();
  const token = env['IOTA_REDIS_TOKEN']?.trim();
  return url && token ? redisRestRateLimiter({ url, token }) : inMemoryRateLimiter();
}

/**
 * Count a request against the principal and its tenant. Limited by either:
 * the longer wait. Neither key carries anything but the authenticated identity.
 */
export async function admitPartner(
  limiter: RateLimitPort,
  principal: { readonly tenantId: string; readonly partnerId: string },
  limits: PartnerRateLimits = DEFAULT_PARTNER_RATE_LIMITS,
): Promise<RateDecision> {
  const [own, tenant] = await Promise.all([
    limiter.take(`partner:${principal.tenantId}:${principal.partnerId}`, limits.principal),
    limiter.take(`tenant:${principal.tenantId}`, limits.tenant),
  ]);
  const waits = [own, tenant].flatMap((d) => (d.kind === 'LIMITED' ? [d.retryAfterSeconds] : []));
  if (waits.length > 0) return { kind: 'LIMITED', retryAfterSeconds: Math.max(1, ...waits) };
  return own.kind === 'ALLOWED' ? own : { kind: 'UNAVAILABLE' };
}
