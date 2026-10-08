/**
 * The short-lived token the viewer presents to Document Engine.
 *
 * The browser never holds the engine's API token (verification item V-07). It
 * holds this instead: a JWT the server signs with the `jwt_private_key`
 * credential, naming one document, the permissions the viewer may exercise on
 * it, and an expiry a few minutes out. The engine verifies it against the
 * public key in its own configuration.
 *
 * Pure: the key, the clock and the document are inputs.
 */

import { createSign } from 'node:crypto';

export type ViewerPermission = 'read-document' | 'write' | 'download' | 'cover-image';

export interface ViewerTokenClaims {
  readonly documentId: string;
  readonly permissions: readonly ViewerPermission[];
  /** A layer isolates one user's annotations from another's; the applicant reference serves. */
  readonly layer?: string;
  readonly nowEpochSeconds: bigint;
  readonly ttlSeconds?: bigint;
}

export const VIEWER_TOKEN_MAX_TTL_SECONDS = 900n;

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export function issueViewerToken(claims: ViewerTokenClaims, privateKeyPem: string): string {
  const ttl = claims.ttlSeconds ?? 300n;
  if (ttl <= 0n || ttl > VIEWER_TOKEN_MAX_TTL_SECONDS) throw new RangeError('viewer token ttl out of range');
  if (claims.documentId.trim().length === 0) throw new RangeError('viewer token names one document');
  if (claims.permissions.length === 0) throw new RangeError('viewer token carries at least one permission');
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64u(
    JSON.stringify({
      document_id: claims.documentId,
      permissions: [...claims.permissions],
      ...(claims.layer === undefined ? {} : { layer: claims.layer }),
      iat: Number(claims.nowEpochSeconds),
      exp: Number(claims.nowEpochSeconds + ttl),
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64u(signer.sign(privateKeyPem))}`;
}
