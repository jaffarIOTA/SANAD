/**
 * A sealed token: a small map of strings, encrypted and authenticated
 * (AES-256-GCM) under a key derived by HKDF from a master secret, with an
 * issue time and a fixed expiry inside the seal.
 *
 * Every browser-held session on the platform is one of these. The browser
 * holds an opaque string that reveals nothing and cannot be altered without
 * the seal failing. Lifetime counts from issue, never from the last request.
 *
 * Pure: no cookie, no clock, no environment. Callers supply those.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export type SealedPayload = Readonly<Record<string, string>>;

export interface Sealed<T extends SealedPayload> {
  readonly payload: T;
  readonly issuedAtEpochSeconds: bigint;
  readonly expiresAtEpochSeconds: bigint;
}

export type SealKey = { readonly bytes: Uint8Array; readonly brand: 'SealKey' };

const KEY_BYTES = 32;
const IV_BYTES = 12;
const MIN_MASTER_BYTES = 32;

/** `purpose` separates keys: a consumer session key never opens an admin session, even from one master. */
export function deriveSealKey(masterSecret: Uint8Array, purpose: string): SealKey {
  if (masterSecret.byteLength < MIN_MASTER_BYTES) throw new Error(`seal master secret must be at least ${String(MIN_MASTER_BYTES)} bytes`);
  if (purpose.trim().length === 0) throw new Error('seal purpose is required');
  return { bytes: new Uint8Array(hkdfSync('sha256', masterSecret, new Uint8Array(0), `sanad-seal-${purpose}`, KEY_BYTES)), brand: 'SealKey' };
}

export function ephemeralMasterSecret(): Uint8Array {
  return new Uint8Array(randomBytes(MIN_MASTER_BYTES));
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const unb64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'));

export function seal<T extends SealedPayload>(value: Sealed<T>, key: SealKey, version = 'v1'): string {
  if (value.expiresAtEpochSeconds <= value.issuedAtEpochSeconds) throw new Error('a sealed token expires after it is issued');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  cipher.setAAD(Buffer.from(version, 'utf8'));
  const plain = Buffer.from(JSON.stringify({ p: value.payload, t: value.issuedAtEpochSeconds.toString(), e: value.expiresAtEpochSeconds.toString() }), 'utf8');
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `${version}.${b64u(iv)}.${b64u(body)}.${b64u(cipher.getAuthTag())}`;
}

export type OpenOutcome<T extends SealedPayload> =
  | { readonly kind: 'VALID'; readonly value: Sealed<T> }
  | { readonly kind: 'EXPIRED'; readonly expiredAtEpochSeconds: bigint }
  | { readonly kind: 'INVALID' };

const INVALID = { kind: 'INVALID' } as const;
const isEpoch = (v: unknown): v is string => typeof v === 'string' && /^\d{1,12}$/.test(v);

export function open<T extends SealedPayload>(
  token: string,
  key: SealKey,
  nowEpochSeconds: bigint,
  /** Refuses a token whose lifetime exceeds this, whatever it claims. */
  maxLifetimeSeconds: bigint,
  isPayload: (p: Readonly<Record<string, unknown>>) => p is T,
  version = 'v1',
): OpenOutcome<T> {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== version) return INVALID;
  let plain: Buffer;
  try {
    const iv = unb64u(parts[1] ?? '');
    const tag = unb64u(parts[3] ?? '');
    if (iv.byteLength !== IV_BYTES || tag.byteLength !== 16) return INVALID;
    const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv);
    decipher.setAAD(Buffer.from(version, 'utf8'));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(unb64u(parts[2] ?? '')), decipher.final()]);
  } catch {
    return INVALID;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(plain.toString('utf8')); } catch { return INVALID; }
  if (typeof parsed !== 'object' || parsed === null) return INVALID;
  const o = parsed as Record<string, unknown>;
  const p = o['p'];
  if (typeof p !== 'object' || p === null || Array.isArray(p) || !isEpoch(o['t']) || !isEpoch(o['e'])) return INVALID;
  const payload = p as Readonly<Record<string, unknown>>;
  if (!Object.values(payload).every((v) => typeof v === 'string') || !isPayload(payload)) return INVALID;
  const issuedAt = BigInt(o['t']);
  const expiresAt = BigInt(o['e']);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > maxLifetimeSeconds) return INVALID;
  if (nowEpochSeconds >= expiresAt) return { kind: 'EXPIRED', expiredAtEpochSeconds: expiresAt };
  return { kind: 'VALID', value: { payload, issuedAtEpochSeconds: issuedAt, expiresAtEpochSeconds: expiresAt } };
}
