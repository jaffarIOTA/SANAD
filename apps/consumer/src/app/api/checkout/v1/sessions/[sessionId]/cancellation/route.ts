import { cancel } from '@sanad/core/checkout/session.ts';
import { problem } from '@sanad/origination/problem.ts';

import { consumerBaseUrl, correlation, json, merchantOr401, refuse, toWire } from '../../../shared.ts';
import { findSession, saveSession } from '@/server/checkout-store.ts';
import { developmentAttestation } from '@/server/store.ts';

export async function PUT(request: Request, ctx: { readonly params: Promise<{ readonly sessionId: string }> }): Promise<Response> {
  const correlationId = correlation(request);
  const merchant = merchantOr401(request, correlationId);
  if (merchant instanceof Response) return merchant;
  const { sessionId } = await ctx.params;
  const session = findSession(sessionId);
  if (session === undefined || session.core.merchantId !== merchant.merchantId) return refuse(problem({ status: 404, title: 'Not found', detail: 'No such session.', reason: 'SESSION_NOT_FOUND', correlationId }));
  if (session.state === 'CANCELLED') return json(200, toWire(session, consumerBaseUrl(request)), correlationId);
  if (session.state !== 'CREATED' && session.state !== 'IDENTIFIED' && session.state !== 'OFFERED') {
    return refuse(problem({ status: 422, kind: 'control-rejection', title: 'Refused', detail: 'The shopper has accepted; the session can no longer be cancelled from the shop.', reason: 'SESSION_PAST_ACCEPTANCE', control: 'OP-DETERMINACY', correlationId, context: { state: session.state } }));
  }
  const cancelled = cancel(session, developmentAttestation());
  saveSession(cancelled);
  return json(200, toWire(cancelled, consumerBaseUrl(request)), correlationId);
}
