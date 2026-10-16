/**
 * The channel's result for an instalment presented for collection (Servicing
 * S2): SADAD's payment notification in Saudi Arabia, the partner bank's
 * collection status in the UAE — paid or returned, by the collection's
 * idempotency key.
 *
 * Verified before it is parsed (SR-016): the `Sanad-Signature` HMAC over the
 * raw body with the tenant's own secret from the vault (BILL_COLLECTION for a
 * Saudi tenant, PAYMENTS_HUB for a UAE one; key `webhook_secret`). The tenant
 * is the one whose secret verified it; a body naming one is never read. A
 * paid result becomes a receipt confirmed by the rail; the same result twice
 * records nothing new.
 */
import { isTenantCode } from '@sanad/config/loader.ts';
import { credentialProviderFromEnvironment } from '@sanad/origination/credentials.ts';

import { SIGNATURE_HEADER, verifyWebhook } from '../../../../../../../../../../adapters/kernel/webhook-signature.ts';
import { mutateBusiness, recordCollectionResult } from '../../../../../../../server/business.ts';
import { tenantJurisdiction } from '../../../../../../../server/intake-rails.ts';

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
      {
        tenantId: tenant,
        provider: tenantJurisdiction(tenant) === 'SA' ? 'BILL_COLLECTION' : 'PAYMENTS_HUB',
        environment: 'sandbox',
        keyName: 'webhook_secret',
      },
      'collection-results-webhook',
    );
    secret = new TextEncoder().encode(value.expose());
  } catch {
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
  const reference = str('reference');
  const receivedOn = str('receivedOn');
  const amount = str('amountMinorUnits');
  if (
    applicationId === undefined ||
    idempotencyKey === undefined ||
    (status !== 'PAID' && status !== 'RETURNED') ||
    reference === undefined ||
    receivedOn === undefined ||
    (amount !== undefined && !/^\d{1,15}$/.test(amount))
  )
    return new Response(null, { status: 400, headers: NO_STORE });
  const r = await mutateBusiness(tenant, () =>
    recordCollectionResult(
      tenant,
      applicationId,
      {
        idempotencyKey,
        status,
        ...(amount === undefined ? {} : { amountMinorUnits: BigInt(amount) }),
        reference,
        receivedOn,
        source: 'LIVE',
      },
      tenantJurisdiction(tenant) === 'SA' ? 'sadad' : 'partner-bank',
    ),
  );
  if (!r.ok)
    return new Response(null, {
      status: r.error.reason === 'BUSINESS_APPLICATION_NOT_FOUND' || r.error.reason === 'COLLECTION_NOT_FOUND' ? 404 : 422,
      headers: NO_STORE,
    });
  return new Response(null, { status: 204, headers: NO_STORE });
}
