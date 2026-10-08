/**
 * Shared by the checkout route handlers. Kept out of route files because Next
 * treats every export of a route file as an HTTP handler.
 */

import { randomUUID } from 'node:crypto';

import type { CheckoutSession } from '@sanad/core/checkout/session.ts';
import { problem, type Problem } from '@sanad/origination/problem.ts';
import { compileContract, contractPath } from '@sanad/origination/contracts.ts';

import { type MerchantPrincipal, authenticateMerchant } from '@/server/merchants.ts';

export const contract = compileContract(contractPath('checkout.v1.yaml'));

export function json(
  status: number,
  body: unknown,
  correlationId: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      'x-correlation-id': correlationId,
      'cache-control': 'no-store',
      ...extra,
    },
  });
}
export const refuse = (p: Problem): Response => json(p.status, p, p.correlationId);
export function correlation(request: Request): string {
  const supplied = request.headers.get('x-correlation-id');
  return supplied !== null && /^[0-9a-f-]{36}$/i.test(supplied) ? supplied : randomUUID();
}
export function merchantOr401(request: Request, correlationId: string): MerchantPrincipal | Response {
  const principal = authenticateMerchant(request.headers.get('authorization') ?? undefined);
  return (
    principal ??
    refuse(
      problem({
        status: 401,
        title: 'Unauthenticated',
        detail: 'No merchant credential was recognised.',
        reason: 'CREDENTIAL_NOT_RECOGNISED',
        correlationId,
      }),
    )
  );
}

const instant = (epochSeconds: bigint, ref: string) => ({
  instant: new Date(Number(epochSeconds) * 1000).toISOString(),
  attestationRef: ref,
});

/** The session as the contract describes it. Nothing about the shopper's person; the offer's figures stay on the platform. */
export function toWire(
  session: CheckoutSession,
  consumerBaseUrl: string,
  localeSegment = 'ar',
): Record<string, unknown> {
  const c = session.core;
  return {
    sessionId: c.sessionId,
    state: session.state,
    merchantOrderRef: c.merchantOrderRef,
    basket: { minorUnits: c.basket.minorUnits.toString(), currency: c.basket.currency },
    redirectUrl: `${consumerBaseUrl}/${localeSegment}/checkout/${c.sessionId}`,
    createdAt: instant(c.createdAt.epochSeconds, c.createdAt.tokenDigest),
    expiresAt: instant(c.expiresAtEpochSeconds, c.createdAt.tokenDigest),
    ...(session.state === 'ACCEPTED' || session.state === 'BOOKED' ? { acceptanceRef: session.acceptanceRef } : {}),
    ...(session.state === 'BOOKED' ? { transactionId: session.transactionId } : {}),
    ...(session.state === 'REFUSED' ? { refusal: { control: session.control, reason: session.reason } } : {}),
  };
}

export const consumerBaseUrl = (request: Request): string =>
  process.env['CONSUMER_BASE_URL'] ?? new URL(request.url).origin;
