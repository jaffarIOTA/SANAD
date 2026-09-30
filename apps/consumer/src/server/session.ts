/**
 * The applicant's session cookie: an opaque sealed token (see session-token.ts).
 *
 * Issued only by the identity step. Read on every request and refused when the
 * seal fails or the assertion's window has passed. The key is derived from a
 * master secret that, in every non-development environment, comes from the
 * vault; in development, from `CONSUMER_SESSION_SECRET` when set, otherwise an
 * ephemeral secret that lives only in this process (sessions end with it).
 */

import { cookies } from 'next/headers';

import { type ConsumerSession, type SessionKey, deriveSessionKey, ephemeralMasterSecret, issueSession, openSession, sealSession } from './session-token.ts';

export type { ConsumerSession } from './session-token.ts';

const COOKIE = 'sanad_consumer';

interface KeyState { key?: SessionKey }
const keyState: KeyState = ((globalThis as { __sanadConsumerKey?: KeyState }).__sanadConsumerKey ??= {});

function masterSecretFromEnvironment(): Uint8Array | undefined {
  const raw = process.env['CONSUMER_SESSION_SECRET'];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const bytes = /^[0-9a-fA-F]+$/.test(raw.trim()) ? Buffer.from(raw.trim(), 'hex') : Buffer.from(raw.trim(), 'base64');
  return new Uint8Array(bytes);
}

function sessionKey(): SessionKey {
  if (keyState.key !== undefined) return keyState.key;
  if (process.env['NODE_ENV'] === 'production' && masterSecretFromEnvironment() === undefined) {
    // The production wiring reads the master from the vault reference; until
    // that is wired a deployment must not silently fall back to an ephemeral key.
    throw new Error('consumer session master secret is not configured');
  }
  keyState.key = deriveSessionKey(masterSecretFromEnvironment() ?? ephemeralMasterSecret());
  return keyState.key;
}

const now = (): bigint => BigInt(Math.floor(Date.now() / 1000));

export async function currentSession(): Promise<ConsumerSession | undefined> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (raw === undefined) return undefined;
  const opened = openSession(raw, sessionKey(), now());
  return opened.kind === 'VALID' ? opened.session : undefined;
}

/** Called by the identity step only, with the rail's confirmed assertion. */
export async function startSession(p: { readonly applicantRef: string; readonly identityAssertionId: string; readonly identityRef: string; readonly authenticatedAtEpochSeconds: bigint }): Promise<ConsumerSession> {
  const session = issueSession(p);
  const jar = await cookies();
  const maxAge = Number(session.expiresAtEpochSeconds - now());
  jar.set(COOKIE, sealSession(session, sessionKey()), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: maxAge > 0 ? maxAge : 0,
  });
  return session;
}

export async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
