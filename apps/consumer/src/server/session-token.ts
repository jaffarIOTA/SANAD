/**
 * The applicant's session token (R-23).
 *
 * A session is issued once, by the identity step, from the rail's assertion.
 * It is sealed with authenticated encryption (AES-256-GCM): the browser holds
 * an opaque string that reveals nothing and that cannot be altered without the
 * seal failing. It expires at a fixed offset from the moment the rail
 * authenticated the applicant — not from the last request — so a session is
 * never extended past the assertion it was born from.
 *
 * Pure: no cookie, no clock, no environment. `session.ts` supplies those.
 * Nothing personal is inside: an applicant reference, the assertion reference
 * and the identity-provider reference. Not a name, not an identifier.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export interface ConsumerSession {
  readonly applicantRef: string;
  readonly identityAssertionId: string;
  readonly identityRef: string;
  /** When the rail authenticated the applicant. The session's lifetime counts from here. */
  readonly authenticatedAtEpochSeconds: bigint;
  /** Fixed at issue. Never slid forward. */
  readonly expiresAtEpochSeconds: bigint;
}

/**
 * How long an authenticated applicant may act before the rail must see them
 * again. An institution may shorten it; it is not extended per request.
 */
export const SESSION_LIFETIME_SECONDS = 1_800n;

const VERSION = 'v1';
const KEY_INFO = 'sanad-consumer-session-v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const MIN_MASTER_BYTES = 32;

/** A 256-bit session key, derived from the master secret; the master is never used directly. */
export type SessionKey = { readonly bytes: Uint8Array; readonly brand: 'SessionKey' };

export function deriveSessionKey(masterSecret: Uint8Array): SessionKey {
  if (masterSecret.byteLength < MIN_MASTER_BYTES) throw new Error(`session master secret must be at least ${String(MIN_MASTER_BYTES)} bytes`);
  return { bytes: new Uint8Array(hkdfSync('sha256', masterSecret, new Uint8Array(0), KEY_INFO, KEY_BYTES)), brand: 'SessionKey' };
}

export function ephemeralMasterSecret(): Uint8Array {
  return new Uint8Array(randomBytes(MIN_MASTER_BYTES));
}

export interface IssueParams {
  readonly applicantRef: string;
  readonly identityAssertionId: string;
  readonly identityRef: string;
  readonly authenticatedAtEpochSeconds: bigint;
  readonly lifetimeSeconds?: bigint;
}

export function issueSession(p: IssueParams): ConsumerSession {
  const lifetime = p.lifetimeSeconds ?? SESSION_LIFETIME_SECONDS;
  if (lifetime <= 0n || lifetime > SESSION_LIFETIME_SECONDS) throw new Error('session lifetime out of range');
  return {
    applicantRef: p.applicantRef,
    identityAssertionId: p.identityAssertionId,
    identityRef: p.identityRef,
    authenticatedAtEpochSeconds: p.authenticatedAtEpochSeconds,
    expiresAtEpochSeconds: p.authenticatedAtEpochSeconds + lifetime,
  };
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString('base64url');
const unb64u = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'));

export function sealSession(session: ConsumerSession, key: SessionKey): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key.bytes, iv);
  cipher.setAAD(Buffer.from(VERSION, 'utf8'));
  const plain = Buffer.from(JSON.stringify({
    a: session.applicantRef,
    s: session.identityAssertionId,
    i: session.identityRef,
    t: session.authenticatedAtEpochSeconds.toString(),
    e: session.expiresAtEpochSeconds.toString(),
  }), 'utf8');
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return `${VERSION}.${b64u(iv)}.${b64u(body)}.${b64u(cipher.getAuthTag())}`;
}

export type OpenOutcome =
  | { readonly kind: 'VALID'; readonly session: ConsumerSession }
  | { readonly kind: 'EXPIRED'; readonly expiredAtEpochSeconds: bigint }
  | { readonly kind: 'INVALID' };

const INVALID: OpenOutcome = { kind: 'INVALID' };
const isRef = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isEpoch = (v: unknown): v is string => typeof v === 'string' && /^\d{1,12}$/.test(v);

export function openSession(token: string, key: SessionKey, nowEpochSeconds: bigint): OpenOutcome {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return INVALID;
  let plain: Buffer;
  try {
    const iv = unb64u(parts[1] ?? '');
    const tag = unb64u(parts[3] ?? '');
    if (iv.byteLength !== IV_BYTES || tag.byteLength !== 16) return INVALID;
    const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv);
    decipher.setAAD(Buffer.from(VERSION, 'utf8'));
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(unb64u(parts[2] ?? '')), decipher.final()]);
  } catch {
    return INVALID;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(plain.toString('utf8')); } catch { return INVALID; }
  if (typeof parsed !== 'object' || parsed === null) return INVALID;
  const o = parsed as Record<string, unknown>;
  if (!isRef(o['a']) || !isRef(o['s']) || !isRef(o['i']) || !isEpoch(o['t']) || !isEpoch(o['e'])) return INVALID;
  const authenticatedAt = BigInt(o['t']);
  const expiresAt = BigInt(o['e']);
  if (expiresAt <= authenticatedAt || expiresAt - authenticatedAt > SESSION_LIFETIME_SECONDS) return INVALID;
  if (nowEpochSeconds >= expiresAt) return { kind: 'EXPIRED', expiredAtEpochSeconds: expiresAt };
  return { kind: 'VALID', session: { applicantRef: o['a'], identityAssertionId: o['s'], identityRef: o['i'], authenticatedAtEpochSeconds: authenticatedAt, expiresAtEpochSeconds: expiresAt } };
}
