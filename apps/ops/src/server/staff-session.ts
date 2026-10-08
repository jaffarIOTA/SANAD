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
  key?: SealKey;
}
const keyState: KeyState = ((globalThis as { __sanadOpsSessionKey?: KeyState }).__sanadOpsSessionKey ??= {});

/**
 * The seal key. Production refuses to run without a configured master secret;
 * development uses one per process when none is set, so a restart signs
 * everyone out (process-wide, so the middleware and the pages share it).
 */
export function staffSealKey(env: Env = process.env): SealKey {
  if (keyState.key !== undefined) return keyState.key;
  const raw = env['OPS_SESSION_SECRET']?.trim();
  if (env['NODE_ENV'] === 'production' && (raw === undefined || raw.length === 0))
    throw new Error('ops session master secret is not configured');
  const master =
    raw === undefined || raw.length === 0
      ? ephemeralMasterSecret()
      : new Uint8Array(Buffer.from(raw, /^[0-9a-f]+$/i.test(raw) ? 'hex' : 'base64'));
  keyState.key = deriveSealKey(master, 'ops-staff-session-v1');
  return keyState.key;
}

/** The lifetime a session is issued for: the configuration's, bounded to (0, ceiling]. */
export function boundedLifetime(configured: bigint | undefined): bigint {
  if (configured === undefined || configured <= 0n) return STAFF_SESSION_DEFAULT_SECONDS;
  return configured > STAFF_SESSION_CEILING_SECONDS ? STAFF_SESSION_CEILING_SECONDS : configured;
}

interface Payload {
  readonly p: string;
  readonly t: string;
  readonly a: string;
}

const PRINCIPAL_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const authoritiesOf = (raw: string): StaffAuthority[] | undefined => {
  const parts = raw.split(',');
  if (parts.length === 0 || new Set(parts).size !== parts.length) return undefined;
  return parts.every((x) => (STAFF_AUTHORITIES as readonly string[]).includes(x))
    ? (parts as StaffAuthority[])
    : undefined;
};
const isPayload = (v: Readonly<Record<string, unknown>>): v is Payload & Record<string, string> =>
  Object.keys(v).length === 3 &&
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

export function issueStaffSession(
  principal: StaffPrincipal,
  lifetimeSeconds: bigint | undefined,
  nowEpochSeconds: bigint,
  key: SealKey = staffSealKey(),
): IssuedSession {
  if (principal.authorities.length === 0) throw new Error('a staff session carries at least one authority');
  const life = boundedLifetime(lifetimeSeconds);
  const expires = nowEpochSeconds + life;
  const token = seal(
    {
      payload: { p: principal.principalId, t: principal.tenantId, a: principal.authorities.join(',') },
      issuedAtEpochSeconds: nowEpochSeconds,
      expiresAtEpochSeconds: expires,
    },
    key,
  );
  return { token, lifetimeSeconds: life, expiresAtEpochSeconds: expires };
}

export type OpenedStaffSession =
  | { readonly kind: 'VALID'; readonly principal: StaffPrincipal; readonly expiresAtEpochSeconds: bigint }
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
  const { p, t, a } = opened.value.payload;
  return {
    kind: 'VALID',
    principal: { principalId: p, tenantId: t as TenantCode, authorities: authoritiesOf(a) ?? [] },
    expiresAtEpochSeconds: opened.value.expiresAtEpochSeconds,
  };
}

export const epochNow = (): bigint => BigInt(Math.floor(Date.now() / 1000));
