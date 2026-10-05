/**
 * Who is administering.
 *
 * Development: an operator signs in once with the platform operations token
 * (compared by digest, constant time) and receives a sealed session cookie
 * good for thirty minutes from sign-in. Production: the institution's
 * identity provider (SAML or OIDC) issues the principal and this module reads
 * the session, with nothing that calls it changing.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

import { type SealKey, deriveSealKey, ephemeralMasterSecret, open, seal } from '@sanad/auth/sealed-token.ts';

export interface AdminPrincipal { readonly principalId: string; readonly role: 'PLATFORM_ADMIN' }

const COOKIE = 'sanad_admin';
/** The default when no staff identity configuration says otherwise; the ceiling is the configuration's own. */
export const ADMIN_SESSION_SECONDS = 1_800n;
const ADMIN_SESSION_CEILING = 3_600n;

interface KeyState { key?: SealKey }
const keyState: KeyState = ((globalThis as { __sanadAdminKey?: KeyState }).__sanadAdminKey ??= {});

function sealKey(): SealKey {
  if (keyState.key !== undefined) return keyState.key;
  const raw = process.env['ADMIN_SESSION_SECRET'];
  if (process.env['NODE_ENV'] === 'production' && (raw === undefined || raw.trim().length === 0)) throw new Error('admin session master secret is not configured');
  const master = raw === undefined || raw.trim().length === 0 ? ephemeralMasterSecret() : new Uint8Array(Buffer.from(raw.trim(), /^[0-9a-f]+$/i.test(raw.trim()) ? 'hex' : 'base64'));
  keyState.key = deriveSealKey(master, 'admin-session-v1');
  return keyState.key;
}

const now = (): bigint => BigInt(Math.floor(Date.now() / 1000));
const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * Development sign-in: the presented token is compared, in constant time, to
 * the two development tokens, each mapped to one administrator. Two, so four
 * eyes can be exercised locally: what one proposes the other decides.
 */
export function developmentPrincipalFor(presented: string): string | undefined {
  if (process.env['NODE_ENV'] === 'production') return undefined;
  const candidates: readonly [string | undefined, string][] = [[process.env['PLATFORM_OPS_DEV_TOKEN'], 'adm-dev-01'], [process.env['STAFF_DEV_TOKEN_SENIOR'], 'adm-dev-02']];
  const presentedDigest = digest(presented);
  let found: string | undefined;
  for (const [token, principal] of candidates) {
    if (token !== undefined && token.trim().length > 0 && timingSafeEqual(digest(token.trim()), presentedDigest)) found = principal;
  }
  return found;
}

interface Payload { readonly p: string; readonly r: 'PLATFORM_ADMIN' }
const isPayload = (v: Readonly<Record<string, unknown>>): v is Payload & Record<string, string> => typeof v['p'] === 'string' && v['p'].length > 0 && v['r'] === 'PLATFORM_ADMIN';

export async function currentAdmin(): Promise<AdminPrincipal | undefined> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw === undefined) return undefined;
  const opened = open(raw, sealKey(), now(), ADMIN_SESSION_CEILING, isPayload);
  return opened.kind === 'VALID' ? { principalId: opened.value.payload.p, role: 'PLATFORM_ADMIN' } : undefined;
}

/** `lifetimeSeconds` comes from the tenant's staff identity configuration in force; it is bounded here regardless. */
export async function startAdminSession(principalId: string, lifetimeSeconds: bigint = ADMIN_SESSION_SECONDS): Promise<void> {
  const life = lifetimeSeconds <= 0n ? ADMIN_SESSION_SECONDS : lifetimeSeconds > ADMIN_SESSION_CEILING ? ADMIN_SESSION_CEILING : lifetimeSeconds;
  const issued = now();
  const token = seal({ payload: { p: principalId, r: 'PLATFORM_ADMIN' }, issuedAtEpochSeconds: issued, expiresAtEpochSeconds: issued + life }, sealKey());
  const jar = await cookies();
  jar.set(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: process.env['NODE_ENV'] === 'production', path: '/', maxAge: Number(life) });
}

export async function endAdminSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
