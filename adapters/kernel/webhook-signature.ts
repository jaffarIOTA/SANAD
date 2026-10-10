/**
 * Signed webhooks, both ways (SR-016): the `Sanad-Signature` the platform puts
 * on what it delivers, and the check any inbound callback passes before its
 * body is parsed.
 *
 *   Sanad-Signature: t=<epoch seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *
 * The timestamp is inside the MAC, so it cannot be moved; a signature outside
 * the tolerance window is refused, and one inside it is accepted once
 * (`replay`), so a captured delivery cannot be played again. Several `v1`
 * values may be present while a secret rotates; one matching is enough.
 *
 * Pure: the secret, the clock reading and the replay store are passed in. The
 * refusal names a reason only, never the body, the signature or the secret.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'Sanad-Signature';
/** How far a signature's timestamp may be from the receiver's clock, either way. */
export const SIGNATURE_TOLERANCE_SECONDS = 300n;
const MIN_SECRET_BYTES = 32;

const mac = (secret: Uint8Array, timestamp: bigint, rawBody: string): Buffer =>
  createHmac('sha256', secret).update(`${timestamp.toString()}.`, 'utf8').update(rawBody, 'utf8').digest();

/** The header value for a body about to be sent. */
export function signWebhook(secret: Uint8Array, rawBody: string, timestampEpochSeconds: bigint): string {
  if (secret.byteLength < MIN_SECRET_BYTES)
    throw new Error(`a webhook signing secret is at least ${String(MIN_SECRET_BYTES)} bytes`);
  return `t=${timestampEpochSeconds.toString()},v1=${mac(secret, timestampEpochSeconds, rawBody).toString('hex')}`;
}

export type WebhookRefusal =
  'SIGNATURE_MISSING' | 'SIGNATURE_MALFORMED' | 'SIGNATURE_INVALID' | 'TIMESTAMP_OUTSIDE_TOLERANCE' | 'REPLAYED';

/** Accepts a signature once within its window: true the first time, false ever after. */
export interface SignatureReplayGuard {
  firstUse(signature: string, expiresAtEpochSeconds: bigint): Promise<boolean>;
}

export interface InboundWebhook {
  readonly header: string | null | undefined;
  /** The body exactly as received, before any parsing. */
  readonly rawBody: string;
  /** The current secret, and the previous one while it rotates. */
  readonly secrets: readonly Uint8Array[];
  readonly nowEpochSeconds: bigint;
  readonly replay: SignatureReplayGuard;
}

/** Verify before parsing. On `ok`, and only then, the caller may parse `rawBody`. */
export async function verifyWebhook(
  i: InboundWebhook,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: WebhookRefusal }> {
  const no = (reason: WebhookRefusal) => ({ ok: false as const, reason });
  if (i.header === null || i.header === undefined || i.header.length === 0) return no('SIGNATURE_MISSING');
  if (i.header.length > 512) return no('SIGNATURE_MALFORMED');
  let timestamp: bigint | undefined;
  const presented: Buffer[] = [];
  for (const part of i.header.split(',')) {
    const [k, v] = part.trim().split('=', 2);
    if (k === 't' && v !== undefined && /^\d{1,12}$/.test(v) && timestamp === undefined) timestamp = BigInt(v);
    else if (k === 'v1' && v !== undefined && /^[0-9a-f]{64}$/.test(v)) presented.push(Buffer.from(v, 'hex'));
    else return no('SIGNATURE_MALFORMED');
  }
  if (timestamp === undefined || presented.length === 0) return no('SIGNATURE_MALFORMED');
  const matches = i.secrets.some((secret) => {
    const expected = mac(secret, timestamp, i.rawBody);
    return presented.some((p) => timingSafeEqual(p, expected));
  });
  if (!matches) return no('SIGNATURE_INVALID');
  const skew = i.nowEpochSeconds - timestamp;
  if (skew > SIGNATURE_TOLERANCE_SECONDS || -skew > SIGNATURE_TOLERANCE_SECONDS)
    return no('TIMESTAMP_OUTSIDE_TOLERANCE');
  if (!(await i.replay.firstUse(i.header, timestamp + SIGNATURE_TOLERANCE_SECONDS))) return no('REPLAYED');
  return { ok: true };
}
