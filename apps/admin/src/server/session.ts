/**
 * Who is administering.
 *
 * Production: the institution's single sign-on by OpenID Connect
 * (single-sign-on.ts). The person signs in at their institution's identity
 * provider and is an administrator only if that institution's staff identity
 * configuration maps one of their groups to PLATFORM_ADMIN. The session
 * records the institution, when they authenticated, and how.
 *
 * Development: an operator signs in once with the platform operations token
 * (compared by digest, constant time). Refused when NODE_ENV is production.
 *
 * Either way the browser holds a sealed session cookie whose lifetime counts
 * from sign-in and is never more than an hour.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

import { type SealKey, deriveSealKey, ephemeralMasterSecret, open, seal } from '@sanad/auth/sealed-token.ts';

import { spentTokens } from './spent-tokens.ts';
import { deploymentProfile } from '@sanad/origination/profile.ts';

export type AdminSignInMethod = 'DEVELOPMENT' | 'OIDC';

export interface AdminPrincipal {
  readonly principalId: string;
  readonly role: 'PLATFORM_ADMIN';
  /** The institution whose identity provider and mappings granted the role (single sign-on only). */
  readonly tenantId?: string;
  readonly method: AdminSignInMethod;
  readonly authenticatedAtEpochSeconds: bigint;
  /** For the screen only. */
  readonly displayName?: string;
}

const COOKIE = 'sanad_admin';
/** The default when no staff identity configuration says otherwise; the ceiling is the configuration's own. */
export const ADMIN_SESSION_SECONDS = 1_800n;
const ADMIN_SESSION_CEILING = 3_600n;

interface KeyState {
  master?: Uint8Array;
  key?: SealKey;
  stateKey?: SealKey;
}
const keyState: KeyState = ((globalThis as { __sanadAdminKey?: KeyState }).__sanadAdminKey ??= {});

function masterSecret(): Uint8Array {
  if (keyState.master !== undefined) return keyState.master;
  const raw = process.env['ADMIN_SESSION_SECRET']?.trim();
  if (process.env['NODE_ENV'] === 'production' && (raw === undefined || raw.length === 0))
    throw new Error('admin session master secret is not configured');
  keyState.master =
    raw === undefined || raw.length === 0
      ? ephemeralMasterSecret()
      : new Uint8Array(Buffer.from(raw, /^[0-9a-f]+$/i.test(raw) ? 'hex' : 'base64'));
  return keyState.master;
}

function sealKey(): SealKey {
  keyState.key ??= deriveSealKey(masterSecret(), 'admin-session-v1');
  return keyState.key;
}

/** The single sign-on state cookie's key: its own purpose, so a state never opens as a session. */
export function adminStateSealKey(): SealKey {
  keyState.stateKey ??= deriveSealKey(masterSecret(), 'admin-oidc-state-v1');
  return keyState.stateKey;
}

export const now = (): bigint => BigInt(Math.floor(Date.now() / 1000));
const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Development tokens are a development stand-in; production authenticates through the institution's single sign-on. */
export const developmentSignInPermitted = (): boolean => deploymentProfile() === 'DEVELOPMENT';

/**
 * Development sign-in: the presented token is compared, in constant time, to
 * the two development tokens, each mapped to one administrator. Two, so four
 * eyes can be exercised locally: what one proposes the other decides. Admin's
 * own variables: no other app reads them, so a token is one person in one app
 * (SR-034).
 */
export function developmentPrincipalFor(presented: string): string | undefined {
  if (!developmentSignInPermitted()) return undefined;
  const candidates: readonly [string | undefined, string][] = [
    [process.env['ADMIN_DEV_TOKEN_01'], 'adm-dev-01'],
    [process.env['ADMIN_DEV_TOKEN_02'], 'adm-dev-02'],
  ];
  const presentedDigest = digest(presented);
  let found: string | undefined;
  for (const [token, principal] of candidates) {
    if (token !== undefined && token.trim().length > 0 && timingSafeEqual(digest(token.trim()), presentedDigest))
      found = principal;
  }
  return found;
}

/** p principal · r role · t institution (SSO) · at authenticated at · m method (D/O) · n display name. */
interface Payload {
  readonly p: string;
  readonly r: 'PLATFORM_ADMIN';
  readonly t?: string;
  readonly at?: string;
  readonly m?: string;
  readonly n?: string;
}
const PAYLOAD_KEYS = new Set(['p', 'r', 't', 'at', 'm', 'n']);
const isPayload = (v: Readonly<Record<string, unknown>>): v is Payload & Record<string, string> =>
  Object.keys(v).every((k) => PAYLOAD_KEYS.has(k)) &&
  typeof v['p'] === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(v['p']) &&
  v['r'] === 'PLATFORM_ADMIN' &&
  (v['t'] === undefined || (typeof v['t'] === 'string' && /^[a-z][a-z0-9-]{1,40}$/.test(v['t']))) &&
  (v['at'] === undefined || (typeof v['at'] === 'string' && /^\d{1,12}$/.test(v['at']))) &&
  (v['m'] === undefined || v['m'] === 'D' || v['m'] === 'O') &&
  (v['n'] === undefined || (typeof v['n'] === 'string' && v['n'].length <= 80));

export async function currentAdmin(): Promise<AdminPrincipal | undefined> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw === undefined || raw.length > 4096) return undefined;
  const opened = open(raw, sealKey(), now(), ADMIN_SESSION_CEILING, isPayload);
  if (opened.kind !== 'VALID') return undefined;
  // Signed out: a copy of the cookie is no session (SR-030).
  if (await spentTokens().isSpent('ADMIN_SESSION', raw)) return undefined;
  const { p, t, at, m, n } = opened.value.payload;
  const authenticatedAt = at === undefined ? opened.value.issuedAtEpochSeconds : BigInt(at);
  if (authenticatedAt > opened.value.issuedAtEpochSeconds) return undefined;
  return {
    principalId: p,
    role: 'PLATFORM_ADMIN',
    method: m === 'O' ? 'OIDC' : 'DEVELOPMENT',
    authenticatedAtEpochSeconds: authenticatedAt,
    ...(t === undefined ? {} : { tenantId: t }),
    ...(n === undefined ? {} : { displayName: n }),
  };
}

export interface AdminSessionOptions {
  readonly method?: AdminSignInMethod;
  readonly tenantId?: string;
  readonly authenticatedAtEpochSeconds?: bigint;
  readonly displayName?: string;
}

/** `lifetimeSeconds` comes from the tenant's staff identity configuration in force; it is bounded here regardless. */
export async function startAdminSession(
  principalId: string,
  lifetimeSeconds: bigint = ADMIN_SESSION_SECONDS,
  options: AdminSessionOptions = {},
): Promise<void> {
  const life =
    lifetimeSeconds <= 0n
      ? ADMIN_SESSION_SECONDS
      : lifetimeSeconds > ADMIN_SESSION_CEILING
        ? ADMIN_SESSION_CEILING
        : lifetimeSeconds;
  const issued = now();
  const authenticatedAt = options.authenticatedAtEpochSeconds ?? issued;
  const name = options.displayName?.slice(0, 80);
  const token = seal(
    {
      payload: {
        p: principalId,
        r: 'PLATFORM_ADMIN',
        at: (authenticatedAt > issued ? issued : authenticatedAt).toString(),
        m: options.method === 'OIDC' ? 'O' : 'D',
        ...(options.tenantId === undefined ? {} : { t: options.tenantId }),
        ...(name === undefined || name.length === 0 ? {} : { n: name }),
      },
      issuedAtEpochSeconds: issued,
      expiresAtEpochSeconds: issued + life,
    },
    sealKey(),
  );
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: Number(life),
  });
}

export async function endAdminSession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  // Spent until it could no longer open anyway: no session outlives issue plus the ceiling.
  if (raw !== undefined && raw.length <= 4096)
    await spentTokens().spend('ADMIN_SESSION', raw, now() + ADMIN_SESSION_CEILING);
  jar.delete(COOKIE);
}
