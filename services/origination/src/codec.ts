/**
 * The store codec: an origination request to and from a JSON document.
 *
 * Two things do not survive `JSON.stringify` as they are: `bigint` (every
 * amount and every attested instant) and the brand on `TsaInstant`, which is
 * a symbol key. Amounts are tagged on the way out and restored on the way
 * in; an attested instant is recognised by its three fields and rebuilt
 * through `tsaInstant()` so the brand — and the guarantee it carries — is
 * re-established by the one function allowed to establish it.
 */

import type { OriginationRequest } from '@sanad/core/origination/request.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

const BIGINT_TAG = '$bigint';

export function encodeRequest(request: OriginationRequest): string {
  return JSON.stringify(request, (_key, value: unknown) =>
    typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value,
  );
}

export function decodeRequest(json: string): OriginationRequest {
  return JSON.parse(json, (_key, value: unknown) => revive(value)) as OriginationRequest;
}

function revive(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const tagged = record[BIGINT_TAG];
  if (typeof tagged === 'string' && Object.keys(record).length === 1) return BigInt(tagged);
  if (
    typeof record['epochSeconds'] === 'bigint' &&
    typeof record['tokenDigest'] === 'string' &&
    typeof record['authorityId'] === 'string' &&
    Object.keys(record).length === 3
  ) {
    return tsaInstant({
      verified: true,
      genTimeEpochSeconds: record['epochSeconds'],
      tokenDigest: record['tokenDigest'],
      authorityId: record['authorityId'],
    });
  }
  return value;
}

/** For jsonb columns holding arbitrary responses (idempotency), the same tagging. */
export const encodeJson = (value: unknown): string =>
  JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? { [BIGINT_TAG]: v.toString() } : v));
export const decodeJson = (json: string): unknown => JSON.parse(json, (_k, v: unknown) => revive(v));
