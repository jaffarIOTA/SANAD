/**
 * The SME portal's session (Wasl W3): who is signed in, and for which
 * distributor, as a sealed cookie (`@sanad/auth/sealed-token.ts`).
 *
 * The payload is references only — the institution, the distributor's
 * counterparty id, the signatory's party reference, the identity service's
 * assertion — never a name or a national identifier. The distributor and the
 * institution come from configuration (`signatoryOf`), looked up from the
 * reference the identity service confirmed; nothing the browser sends names
 * them. A session lasts a fixed time from authentication, never extended.
 *
 * A second sealed cookie holds a pending identity request between start and
 * confirmation — sign-in, or the signature on a sale offer — and is spent on
 * use, so a copy confirms nothing twice (SR-043). Signing out spends the
 * session (SR-030).
 *
 * The key is derived from SME_SESSION_SECRET; in development without one, from
 * an ephemeral secret that lives only in this process. A production process
 * without the secret refuses to issue anything.
 */
import { cookies } from 'next/headers';

import { type TenantCode, isTenantCode } from '@sanad/config/loader.ts';
import { type SealKey, deriveSealKey, ephemeralMasterSecret, open, seal } from '@sanad/auth/sealed-token.ts';
import { type SpentTokens, inMemorySpentTokens } from '@sanad/auth/spent-tokens.ts';
import { hostClockInstant } from '@sanad/origination/host-clock.ts';
import { postgresSpentTokens } from '@sanad/origination/spent-tokens-postgres.ts';
import { waslPool } from '@sanad/origination/wasl/book.ts';

const SESSION_COOKIE = 'sanad_sme';
const PENDING_COOKIE = 'sanad_sme_pending';

/** How long a signed-in signatory may act before the identity service must see them again. */
export const SESSION_LIFETIME_SECONDS = 1_800n;
/** How long a pending identity request may wait for the person to approve it in the identity app. */
export const PENDING_LIFETIME_SECONDS = 300n;

export interface SmeSession {
  readonly tenant: TenantCode;
  readonly counterpartyId: string;
  readonly signatoryRef: string;
  readonly identityAssertionId: string;
  readonly authenticatedAtEpochSeconds: bigint;
  readonly expiresAtEpochSeconds: bigint;
}

/** What is waiting for the person to approve in the identity app. */
export type Pending =
  | { readonly kind: 'SIGN_IN'; readonly signatoryRef: string; readonly identityTransactionRef: string }
  | {
      readonly kind: 'SIGN_OFFER';
      readonly signatoryRef: string;
      readonly identityTransactionRef: string;
      readonly transactionRef: string;
      /** The offer instrument's hash the signature is bound to. */
      readonly offerHash: string;
    };

interface KeyState {
  session?: SealKey;
  pending?: SealKey;
  spent?: SpentTokens;
}
const keys: KeyState = ((globalThis as { __sanadSmeKeys?: KeyState }).__sanadSmeKeys ??= {});

function master(): Uint8Array {
  const raw = process.env['SME_SESSION_SECRET']?.trim();
  if (raw !== undefined && raw.length > 0)
    return new Uint8Array(/^[0-9a-fA-F]+$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64'));
  if (process.env['NODE_ENV'] === 'production') throw new Error('SME session master secret is not configured');
  return ephemeralMasterSecret();
}

function sessionKey(): SealKey {
  if (keys.session === undefined || keys.pending === undefined) {
    const m = master();
    keys.session = deriveSealKey(m, 'sme-session-v1');
    keys.pending = deriveSealKey(m, 'sme-pending-v1');
  }
  return keys.session;
}
function pendingKey(): SealKey {
  sessionKey();
  return keys.pending as SealKey;
}

function spent(): SpentTokens {
  if (keys.spent !== undefined) return keys.spent;
  const pool = waslPool();
  keys.spent = pool === undefined ? inMemorySpentTokens() : postgresSpentTokens(pool);
  return keys.spent;
}

/** Now, as the host-clock stand-in attests it: session lifetimes are measured against the same instants as the steps. */
const now = (): bigint => hostClockInstant().epochSeconds;

const REF = /^[A-Za-z0-9:._-]{1,200}$/;
const isRef = (v: unknown): v is string => typeof v === 'string' && REF.test(v);

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env['NODE_ENV'] === 'production',
  path: '/',
};

// -- The session ----------------------------------------------------------------------

export async function currentSession(): Promise<SmeSession | undefined> {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (raw === undefined || raw.length > 4096) return undefined;
  const opened = open(
    raw,
    sessionKey(),
    now(),
    SESSION_LIFETIME_SECONDS,
    (p): p is Record<'t' | 'c' | 's' | 'a', string> =>
      isTenantCode(String(p['t'])) && typeof p['c'] === 'string' && isRef(p['s']) && isRef(p['a']),
  );
  if (opened.kind !== 'VALID') return undefined;
  if (await spent().isSpent('SME_SESSION', raw)) return undefined;
  const p = opened.value.payload;
  return {
    tenant: p.t as TenantCode,
    counterpartyId: p.c,
    signatoryRef: p.s,
    identityAssertionId: p.a,
    authenticatedAtEpochSeconds: opened.value.issuedAtEpochSeconds,
    expiresAtEpochSeconds: opened.value.expiresAtEpochSeconds,
  };
}

/** Called by the sign-in step only, with the identity service's confirmed assertion and the configured distributor. */
export async function startSession(s: {
  readonly tenant: TenantCode;
  readonly counterpartyId: string;
  readonly signatoryRef: string;
  readonly identityAssertionId: string;
  readonly authenticatedAtEpochSeconds: bigint;
}): Promise<void> {
  const expires = s.authenticatedAtEpochSeconds + SESSION_LIFETIME_SECONDS;
  const token = seal(
    {
      payload: { t: s.tenant, c: s.counterpartyId, s: s.signatoryRef, a: s.identityAssertionId },
      issuedAtEpochSeconds: s.authenticatedAtEpochSeconds,
      expiresAtEpochSeconds: expires,
    },
    sessionKey(),
  );
  const maxAge = Number(expires - now());
  (await cookies()).set(SESSION_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: maxAge > 0 ? maxAge : 0 });
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value;
  if (raw !== undefined && raw.length <= 4096)
    await spent().spend('SME_SESSION', raw, now() + SESSION_LIFETIME_SECONDS);
  jar.delete(SESSION_COOKIE);
}

// -- The pending identity request -----------------------------------------------------

export async function holdPending(p: Pending): Promise<void> {
  const issued = now();
  const payload: Record<string, string> =
    p.kind === 'SIGN_IN'
      ? { k: p.kind, s: p.signatoryRef, x: p.identityTransactionRef }
      : { k: p.kind, s: p.signatoryRef, x: p.identityTransactionRef, w: p.transactionRef, h: p.offerHash };
  const token = seal(
    { payload, issuedAtEpochSeconds: issued, expiresAtEpochSeconds: issued + PENDING_LIFETIME_SECONDS },
    pendingKey(),
  );
  (await cookies()).set(PENDING_COOKIE, token, { ...COOKIE_OPTIONS, maxAge: Number(PENDING_LIFETIME_SECONDS) });
}

/** The pending request, spent as it is read: a second read of the same cookie finds nothing. */
export async function takePending(): Promise<Pending | undefined> {
  const jar = await cookies();
  const raw = jar.get(PENDING_COOKIE)?.value;
  jar.delete(PENDING_COOKIE);
  if (raw === undefined || raw.length > 4096) return undefined;
  const opened = open(
    raw,
    pendingKey(),
    now(),
    PENDING_LIFETIME_SECONDS,
    (p): p is Record<string, string> =>
      (p['k'] === 'SIGN_IN' || p['k'] === 'SIGN_OFFER') && isRef(p['s']) && isRef(p['x']),
  );
  if (opened.kind !== 'VALID') return undefined;
  // Of two confirmations racing on one cookie, one wins.
  if (!(await spent().spend('SME_PENDING', raw, opened.value.expiresAtEpochSeconds))) return undefined;
  const p = opened.value.payload;
  if (p['k'] === 'SIGN_IN')
    return { kind: 'SIGN_IN', signatoryRef: p['s'] ?? '', identityTransactionRef: p['x'] ?? '' };
  const w = p['w'];
  const h = p['h'];
  if (!isRef(w) || typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return undefined;
  return {
    kind: 'SIGN_OFFER',
    signatoryRef: p['s'] ?? '',
    identityTransactionRef: p['x'] ?? '',
    transactionRef: w,
    offerHash: h,
  };
}

/** Whether a request is waiting, without spending it: the screen shows the "approve in the app" step. */
export async function pendingKind(): Promise<Pending['kind'] | undefined> {
  const raw = (await cookies()).get(PENDING_COOKIE)?.value;
  if (raw === undefined || raw.length > 4096) return undefined;
  const opened = open(
    raw,
    pendingKey(),
    now(),
    PENDING_LIFETIME_SECONDS,
    (p): p is Record<string, string> => p['k'] === 'SIGN_IN' || p['k'] === 'SIGN_OFFER',
  );
  return opened.kind === 'VALID' ? (opened.value.payload['k'] as Pending['kind']) : undefined;
}
