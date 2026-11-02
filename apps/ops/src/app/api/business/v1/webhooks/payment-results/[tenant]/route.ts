/**
 * The partner bank's status report for a released tranche (UAE M5b): settled,
 * rejected or returned, by the instruction's idempotency key.
 *
 * Verified before it is parsed (SR-016): the `Sanad-Signature` HMAC over the
 * raw body, with the tenant's own secret from the vault (capability
 * PAYMENTS_HUB, key `webhook_secret`). The tenant is the one whose secret
 * verified the signature — the path names which secret to try, and a body
 * naming a tenant is never read. The response says nothing about why a
 * delivery was refused beyond its status code, and never echoes the body.
 *
 * Replays: a signature is accepted once per process, and the result itself is
 * idempotent (the same status twice changes nothing), so a replay across
 * replicas records nothing new.
 */
import { isTenantCode } from '@sanad/config/loader.ts';
import { credentialProviderFromEnvironment } from '@sanad/origination/credentials.ts';

import { SIGNATURE_HEADER, verifyWebhook } from '../../../../../../../../../../adapters/kernel/webhook-signature.ts';
import { mutateBusiness, recordPaymentResult } from '../../../../../../../server/business.ts';

const NO_STORE = { 'cache-control': 'no-store' } as const;
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

const STATUSES = new Set(['ACCEPTED', 'SETTLED', 'REJECTED', 'RETURNED']);

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly tenant: string }> },
): Promise<Response> {
  const { tenant } = await context.params;
  if (!isTenantCode(tenant)) return new Response(null, { status: 404, headers: NO_STORE });
  const rawBody = await request.text();
  if (rawBody.length > 16_384) return new Response(null, { status: 413, headers: NO_STORE });
  let secret: Uint8Array;
  try {
    const value = await credentialProviderFromEnvironment().get(
      { tenantId: tenant, provider: 'PAYMENTS_HUB', environment: 'sandbox', keyName: 'webhook_secret' },
      'payment-results-webhook',
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
  const str = (k: string): string | undefined => (typeof body[k] === 'string' ? (body[k] as string) : undefined);
  const applicationId = str('applicationId');
  const idempotencyKey = str('idempotencyKey');
  const status = str('status');
  if (applicationId === undefined || idempotencyKey === undefined || status === undefined || !STATUSES.has(status))
    return new Response(null, { status: 400, headers: NO_STORE });
  const instructionRef = str('instructionRef');
  const reasonCode = str('reasonCode');
  // Recorded and saved as one unit under the tenant's lock, as every workbench change is.
  const r = await mutateBusiness(tenant, () =>
    recordPaymentResult(
    tenant,
    applicationId,
    {
      idempotencyKey,
      status: status as 'ACCEPTED' | 'SETTLED' | 'REJECTED' | 'RETURNED',
      ...(instructionRef === undefined ? {} : { instructionRef }),
      ...(reasonCode === undefined ? {} : { reasonCode }),
      source: 'LIVE',
    },
    'partner-bank',
    ),
  );
  if (!r.ok)
    return new Response(null, {
      status: r.error.reason === 'BUSINESS_APPLICATION_NOT_FOUND' || r.error.reason === 'PAYMENT_NOT_FOUND' ? 404 : 422,
      headers: NO_STORE,
    });
  return new Response(null, { status: 204, headers: NO_STORE });
}
