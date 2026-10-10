/**
 * Shared by the partner API route handlers.
 *
 * Kept out of `route.ts` on purpose: Next treats every export of a route file
 * as an HTTP handler and refuses the build if one is not, so helpers cannot
 * live beside the handlers that use them.
 */

import { randomUUID } from 'node:crypto';

import {
  NO_CREDENTIALS_REGISTERED,
  authenticate,
  developmentRegistry,
  type PartnerPrincipal,
} from '@sanad/origination/principal.ts';
import { problem, rateLimitedProblem, type Problem } from '@sanad/origination/problem.ts';
import { deploymentProfile } from '@sanad/origination/profile.ts';
import { admitPartner, configuredRateLimiter } from '@sanad/origination/rate-limit.ts';
import type { RateLimitPort } from '@sanad/core/ports/rate-limit.ts';

/** Development tokens in development; deployed, nothing is recognised until the vault-backed registry exists (SR-004). */
const registry = () =>
  deploymentProfile() === 'DEVELOPMENT' ? developmentRegistry(process.env) : NO_CREDENTIALS_REGISTERED;

export function json(
  status: number,
  body: unknown,
  correlationId: string,
  extra: Record<string, string> = {},
): Response {
  const isProblem = status >= 400;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': isProblem ? 'application/problem+json' : 'application/json',
      'x-correlation-id': correlationId,
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

export function refuse(p: Problem): Response {
  return json(p.status, p, p.correlationId);
}

export function correlation(request: Request): string {
  const supplied = request.headers.get('x-correlation-id');
  return supplied !== null && /^[0-9a-f-]{36}$/i.test(supplied) ? supplied : randomUUID();
}

const limiter: { port?: RateLimitPort } = ((
  globalThis as { __sanadOpsRateLimiter?: { port?: RateLimitPort } }
).__sanadOpsRateLimiter ??= {});

/** Replace the counters (tests). */
export function setRateLimiter(port: RateLimitPort): void {
  limiter.port = port;
}

/**
 * The authenticated partner, or the response to send instead: 401 without a
 * recognised credential, 429 with Retry-After past its rate limits (SR-031).
 */
export async function principalOr401(request: Request, correlationId: string): Promise<PartnerPrincipal | Response> {
  const auth = authenticate(request.headers.get('authorization') ?? undefined, registry());
  if (auth.ok) {
    limiter.port ??= configuredRateLimiter();
    const admitted = await admitPartner(limiter.port, auth.principal);
    if (admitted.kind !== 'LIMITED') return auth.principal;
    const p = rateLimitedProblem(correlationId, admitted.retryAfterSeconds);
    return json(p.status, p, correlationId, { 'retry-after': String(admitted.retryAfterSeconds) });
  }
  return refuse(
    problem({
      status: 401,
      title: 'Unauthenticated',
      detail:
        auth.reason === 'CREDENTIAL_MISSING' ? 'No credential was presented.' : 'The credential was not recognised.',
      reason: auth.reason,
      correlationId,
    }),
  );
}
