/**
 * What the Wasl webhooks share (W4a): a delivery is verified before it is
 * parsed (SR-016) — the `Sanad-Signature` HMAC over the raw body, with the
 * tenant's own secret from the vault (the payments hub's for payment results,
 * SADAD's for collection results, key `webhook_secret`). The tenant is the one
 * whose secret verified the signature: the path names which secret to try, a
 * body naming a tenant is never read. A refusal says nothing beyond its status
 * code and never echoes the body.
 *
 * Replays: a signature is accepted once per process, and every result is
 * idempotent besides (the same result twice records nothing), so a replay
 * across replicas changes nothing either.
 */
import { type TenantCode, isTenantCode } from '@sanad/config/loader.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import { credentialProviderFromEnvironment } from '@sanad/origination/credentials.ts';

import { SIGNATURE_HEADER, verifyWebhook } from '../../../../adapters/kernel/webhook-signature.ts';

export const NO_STORE = { 'cache-control': 'no-store' } as const;

const seen = new Map<string, bigint>();
const replay = {
  firstUse(signature: string, expiresAtEpochSeconds: bigint): Promise<boolean> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    if (seen.has(signature)) return Promise.resolve(false);
    seen.set(signature, expiresAtEpochSeconds);
    return Promise.resolve(true);
  },
};

/** The verified body of a delivery, as string fields; or the response refusing it. */
export async function verifiedDelivery(
  request: Request,
  tenantSegment: string,
  provider: 'PAYMENTS_HUB' | 'BILL_COLLECTION',
): Promise<{ readonly tenant: TenantCode; readonly field: (k: string) => string | undefined } | Response> {
  if (!isTenantCode(tenantSegment)) return new Response(null, { status: 404, headers: NO_STORE });
  const rawBody = await request.text();
  if (rawBody.length > 16_384) return new Response(null, { status: 413, headers: NO_STORE });
  let secret: Uint8Array;
  try {
    const value = await credentialProviderFromEnvironment().get(
      { tenantId: tenantSegment, provider, environment: 'sandbox', keyName: 'webhook_secret' },
      'wasl-results-webhook',
    );
    secret = new TextEncoder().encode(value.expose());
  } catch {
    // No secret configured for this tenant: nothing can be verified, so nothing is accepted.
    return new Response(null, { status: 401, headers: NO_STORE });
  }
  const verified = await verifyWebhook({
    header: request.headers.get(SIGNATURE_HEADER),
    rawBody,
    secrets: [secret],
    nowEpochSeconds: BigInt(Math.floor(Date.now() / 1000)),
    replay,
  });
  if (!verified.ok) return new Response(null, { status: 401, headers: NO_STORE });
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 400, headers: NO_STORE });
  }
  return { tenant: tenantSegment, field: (k) => (typeof body[k] === 'string' ? (body[k] as string) : undefined) };
}

/** A recorded result answers 204; the same result again is delivered, not an error; an unknown subject 404s. */
export function answer(r: Result<unknown>): Response {
  if (r.ok || r.error.reason === 'RESULT_ALREADY_RECORDED')
    return new Response(null, { status: 204, headers: NO_STORE });
  const missing = ['TRANSACTION_NOT_FOUND', 'PAYMENT_NOT_FOUND', 'COLLECTION_NOT_FOUND'].includes(r.error.reason);
  // The core banking platform did not take the charity posting (W4b-2): nothing was recorded; deliver it again.
  const unavailable = ['CORE_BANKING_UNAVAILABLE', 'CORE_BANKING_CALL_FAILED', 'SERVICING_UNAVAILABLE'].includes(
    r.error.reason,
  );
  let status = 422;
  if (missing) status = 404;
  else if (unavailable) status = 503;
  return new Response(null, { status, headers: NO_STORE });
}

export const isTransactionRef = (v: string | undefined): v is string => v !== undefined && /^WT-\d{6,10}$/.test(v);
