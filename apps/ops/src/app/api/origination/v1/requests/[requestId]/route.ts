import { toWire } from '@sanad/origination/representation.ts';
import { problem } from '@sanad/origination/problem.ts';

import { findPartnerRequest } from '../../../../../../server/store.ts';
import { correlation, principalOr401 } from '../route.ts';

export async function GET(request: Request, context: { params: Promise<{ requestId: string }> }): Promise<Response> {
  const correlationId = correlation(request);
  const principal = principalOr401(request, correlationId);
  if (principal instanceof Response) return principal;

  const { requestId } = await context.params;
  const stored = findPartnerRequest(requestId, principal.partnerId);
  const headers = { 'x-correlation-id': correlationId, 'cache-control': 'no-store' };
  if (stored === undefined) {
    // Absent, not forbidden: the API does not confirm other partners' business.
    const p = problem({ status: 404, title: 'Not found', detail: 'No such resource within this credential’s scope.', reason: 'REQUEST_NOT_FOUND', correlationId });
    return new Response(JSON.stringify(p), { status: 404, headers: { ...headers, 'content-type': 'application/problem+json' } });
  }
  return new Response(JSON.stringify(toWire(stored.request, stored.partnerReference)), { status: 200, headers: { ...headers, 'content-type': 'application/json' } });
}
