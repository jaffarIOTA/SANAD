import { problem } from '@sanad/origination/problem.ts';

import { consumerBaseUrl, correlation, json, merchantOr401, refuse, toWire } from '../../shared.ts';
import { findSession } from '../../../../../../server/checkout-store.ts';
import { syncConsumerStore } from '../../../../../../server/durable.ts';

export async function GET(
  request: Request,
  ctx: { readonly params: Promise<{ readonly sessionId: string }> },
): Promise<Response> {
  const correlationId = correlation(request);
  const merchant = merchantOr401(request, correlationId);
  if (merchant instanceof Response) return merchant;
  const { sessionId } = await ctx.params;
  await syncConsumerStore();
  const session = findSession(sessionId);
  // Another merchant's session is absent, not forbidden.
  if (session === undefined || session.core.merchantId !== merchant.merchantId)
    return refuse(
      problem({
        status: 404,
        title: 'Not found',
        detail: 'No such session.',
        reason: 'SESSION_NOT_FOUND',
        correlationId,
      }),
    );
  return json(200, toWire(session, consumerBaseUrl(request)), correlationId);
}
