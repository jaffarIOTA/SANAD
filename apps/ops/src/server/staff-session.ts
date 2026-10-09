/**
 * The workbench's staff session, as a sealed token: no cookie API, no
 * framework, so the middleware and the server components open it with the same
 * code, and a test can exercise it directly.
 *
 * The browser holds an AES-256-GCM sealed token (packages/auth/sealed-token.ts)
 * under a key derived for this purpose only, so an admin or consumer session
 * never opens here. The payload is who signed in, the tenant the identity
 * belongs to, and the authorities granted at sign-in. Lifetime counts from
 * sign-in, is the tenant's staff identity configuration, and is never more than
 * an hour whatever the token claims.
 */

import { type SealKey, deriveSealKey, ephemeralMasterSecret, open, seal } from '@sanad/auth/sealed-token.ts';
import { type TenantCode, isTenantCode } from '@sanad/config/loader.ts';
import {
  MAX_SESSION_LIFETIME_SECONDS,
  STAFF_AUTHORITIES,
  type StaffAuthority,
} from '@sanad/core/config/staff-identity.ts';

import type { StaffPrincipal } from './staff.ts';

export const STAFF_SESSION_COOKIE = 'sanad_ops';
/** The hard ceiling: the staff identity configuration may shorten a session, never lengthen it past this. */
export const STAFF_SESSION_CEILING_SECONDS = BigInt(MAX_SESSION_LIFETIME_SECONDS);
/** Used only when the tenant's configuration cannot be read. */
export const STAFF_SESSION_DEFAULT_SECONDS = 1_800n;

type Env = Readonly<Record<string, string | undefined>>;

interface KeyState {
  master?: Uint8Array;
  key?: SealKey;
  stateKey?: SealKey;
}
const keyState: KeyState = ((globalThis as { __sanadOpsSessionKey?: KeyState }).__sanadOpsSessionKey ??= {});

/**
 * The master secret. Production refuses to run without a configured one;
 * development uses one per process when none is set, so a restart signs
 * everyone out (process-wide, so the middleware and the pages share it).
 */
function masterSecret(env: Env): Uint8Array {
  if (keyState.master !== undefined) return keyState.master;
  const raw = env['OPS_SESSION_SECRET']?.trim();
  if (env['NODE_ENV'] === 'production' && (raw === undefined || raw.length === 0))
    throw new Error('ops session master secret is not configured');
  keyState.master =
    raw === undefined || raw.length === 0
      ? ephemeralMasterSecret()
      : new Uint8Array(Buffer.from(raw, /^[0-9a-f]+$/i.test(raw) ? 'hex' : 'base64'));
  return keyState.master;
}

/** The session seal key. */
export function staffSealKey(env: Env = process.env): SealKey {
  keyState.key ??= deriveSealKey(masterSecret(env), 'ops-staff-session-v1');
  return keyState.key;
}

/** The key for the single sign-on state cookie: its own purpose, so a state never opens as a session or the reverse. */
export function staffStateSealKey(env: Env = process.env): SealKey {
  keyState.stateKey ??= deriveSealKey(masterSecret(env), 'ops-oidc-state-v1');
  return keyState.stateKey;
}

/** The lifetime a session is issued for: the configuration's, bounded to (0, ceiling]. */
export function boundedLifetime(configured: bigint | undefined): bigint {
  if (configured === undefined || configured <= 0n) return STAFF_SESSION_DEFAULT_SECONDS;
  return configured > STAFF_SESSION_CEILING_SECONDS ? STAFF_SESSION_CEILING_SECONDS : configured;
}

/** How the person signed in: a development token, or the institution's identity provider. */
export type SignInMethod = 'DEVELOPMENT' | 'OIDC';

/**
 * p principal · t tenant · a authorities — always. Since single sign-on:
 * at when the person authenticated (for the step-up window; absent in an
 * older session, which then counts from issue), m the method, n a display
 * name for the screen only (sealed, never logged).
 */
interface Payload {
  readonly p: string;
  readonly t: string;
  readonly a: string;
  readonly at?: string;
  readonly m?: string;
  readonly n?: string;
}
const PAYLOAD_KEYS = new Set(['p', 't', 'a', 'at', 'm', 'n']);
const METHODS: Readonly<Record<string, SignInMethod>> = { D: 'DEVELOPMENT', O: 'OIDC' };

const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const authoritiesOf = (raw: string): StaffAuthority[] | undefined => {
  const parts = raw.split(',');
  if (parts.length === 0 || new Set(parts).size !== parts.length) return undefined;
  return parts.every((x) => (STAFF_AUTHORITIES as readonly string[]).includes(x))
    ? (parts as StaffAuthority[])
    : undefined;
};
const isPayload = (v: Readonly<Record<string, unknown>>): v is Payload & Record<string, string> =>
  Object.keys(v).every((k) => PAYLOAD_KEYS.has(k)) &&
  (v['at'] === undefined || (typeof v['at'] === 'string' && /^\d{1,12}$/.test(v['at']))) &&
  (v['m'] === undefined || (typeof v['m'] === 'string' && METHODS[v['m']] !== undefined)) &&
  (v['n'] === undefined || (typeof v['n'] === 'string' && v['n'].length <= 80)) &&
  typeof v['p'] === 'string' &&
  PRINCIPAL_ID.test(v['p']) &&
  typeof v['t'] === 'string' &&
  isTenantCode(v['t']) &&
  typeof v['a'] === 'string' &&
  authoritiesOf(v['a']) !== undefined;

export interface IssuedSession {
  readonly token: string;
  readonly lifetimeSeconds: bigint;
  readonly expiresAtEpochSeconds: bigint;
}

export interface SessionOptions {
  readonly key?: SealKey;
  readonly method?: SignInMethod;
  /** When the person authenticated; defaults to issue time (a development token is presented at sign-in). */
  readonly authenticatedAtEpochSeconds?: bigint;
  readonly displayName?: string;
}

export function issueStaffSession(
  principal: StaffPrincipal,
  lifetimeSeconds: bigint | undefined,
  nowEpochSeconds: bigint,
  options: SessionOptions = {},
): IssuedSession {
  if (principal.authorities.length === 0) throw new Error('a staff session carries at least one authority');
  const life = boundedLifetime(lifetimeSeconds);
  const expires = nowEpochSeconds + life;
  const authenticatedAt = options.authenticatedAtEpochSeconds ?? nowEpochSeconds;
  if (authenticatedAt > nowEpochSeconds) throw new Error('a person cannot have authenticated in the future');
  const name = options.displayName?.slice(0, 80);
  const token = seal(
    {
      payload: {
        p: principal.principalId,
        t: principal.tenantId,
        a: principal.authorities.join(','),
        at: authenticatedAt.toString(),
        m: options.method === 'OIDC' ? 'O' : 'D',
        ...(name === undefined || name.length === 0 ? {} : { n: name }),
      },
      issuedAtEpochSeconds: nowEpochSeconds,
      expiresAtEpochSeconds: expires,
    },
    options.key ?? staffSealKey(),
  );
  return { token, lifetimeSeconds: life, expiresAtEpochSeconds: expires };
}

export type OpenedStaffSession =
  | {
      readonly kind: 'VALID';
      readonly principal: StaffPrincipal;
      readonly expiresAtEpochSeconds: bigint;
      readonly authenticatedAtEpochSeconds: bigint;
      readonly method: SignInMethod;
      readonly displayName?: string;
    }
  | { readonly kind: 'EXPIRED' }
  | { readonly kind: 'INVALID' };

/** Open a presented cookie value. Forged, tampered, over-long or expired is not a session. */
export function openStaffSession(
  raw: string | undefined,
  nowEpochSeconds: bigint,
  key: SealKey = staffSealKey(),
): OpenedStaffSession {
  if (raw === undefined || raw.length === 0 || raw.length > 4096) return { kind: 'INVALID' };
  const opened = open(raw, key, nowEpochSeconds, STAFF_SESSION_CEILING_SECONDS, isPayload);
  if (opened.kind === 'EXPIRED') return { kind: 'EXPIRED' };
  if (opened.kind === 'INVALID') return { kind: 'INVALID' };
  const { p, t, a, at, m, n } = opened.value.payload;
  const issuedAt = opened.value.issuedAtEpochSeconds;
  const authenticatedAt = at === undefined ? issuedAt : BigInt(at);
  if (authenticatedAt > issuedAt) return { kind: 'INVALID' };
  return {
    kind: 'VALID',
    principal: { principalId: p, tenantId: t as TenantCode, authorities: authoritiesOf(a) ?? [] },
    expiresAtEpochSeconds: opened.value.expiresAtEpochSeconds,
    authenticatedAtEpochSeconds: authenticatedAt,
    method: m === undefined ? 'DEVELOPMENT' : (METHODS[m] ?? 'DEVELOPMENT'),
    ...(n === undefined ? {} : { displayName: n }),
  };
}

/** Is the authentication behind a session fresh enough for an act that needs a step-up? Undefined window: always. */
export function freshEnough(
  authenticatedAtEpochSeconds: bigint,
  windowSeconds: bigint | undefined,
  nowEpochSeconds: bigint,
): boolean {
  return windowSeconds === undefined || nowEpochSeconds - authenticatedAtEpochSeconds <= windowSeconds;
}

export const epochNow = (): bigint => BigInt(Math.floor(Date.now() / 1000));
