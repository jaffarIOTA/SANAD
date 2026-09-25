/**
 * Shared by the partner API route handlers.
 *
 * Kept out of `route.ts` on purpose: Next treats every export of a route file
 * as an HTTP handler and refuses the build if one is not, so helpers cannot
 * live beside the handlers that use them.
 */

import { randomUUID } from 'node:crypto';

import { authenticate, developmentRegistry, type PartnerPrincipal } from '@sanad/origination/principal.ts';
import { problem, type Problem } from '@sanad/origination/problem.ts';

export function json(status: number, body: unknown, correlationId: string, extra: Record<string, string> = {}): Response {
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

/** The authenticated partner, or the 401 to send instead. */
export function principalOr401(request: Request, correlationId: string): PartnerPrincipal | Response {
  const auth = authenticate(request.headers.get('authorization') ?? undefined, developmentRegistry(process.env));
  if (auth.ok) return auth.principal;
  return refuse(
    problem({
      status: 401,
      title: 'Unauthenticated',
      detail: auth.reason === 'CREDENTIAL_MISSING' ? 'No credential was presented.' : 'The credential was not recognised.',
      reason: auth.reason,
      correlationId,
    }),
  );
}
