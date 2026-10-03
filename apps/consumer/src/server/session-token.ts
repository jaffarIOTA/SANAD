/**
 * The applicant's session token (R-23), a sealed token (`@sanad/auth`) whose
 * payload is the applicant reference, the assertion reference and the
 * identity-provider reference. Not a name, not an identifier. It expires at a
 * fixed offset from the moment the rail authenticated the applicant and is
 * never extended by activity.
 */

import { type SealKey, deriveSealKey, ephemeralMasterSecret as ephemeral, open, seal } from '@sanad/auth/sealed-token.ts';

export interface ConsumerSession {
  readonly applicantRef: string;
  readonly identityAssertionId: string;
  readonly identityRef: string;
  /** When the rail authenticated the applicant. The session's lifetime counts from here. */
  readonly authenticatedAtEpochSeconds: bigint;
  /** Fixed at issue. Never slid forward. */
  readonly expiresAtEpochSeconds: bigint;
}

/** How long an authenticated applicant may act before the rail must see them again. Never extended per request. */
export const SESSION_LIFETIME_SECONDS = 1_800n;

export type SessionKey = SealKey;

export function deriveSessionKey(masterSecret: Uint8Array): SessionKey {
  return deriveSealKey(masterSecret, 'consumer-session-v1');
}

export const ephemeralMasterSecret = ephemeral;

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
  return { applicantRef: p.applicantRef, identityAssertionId: p.identityAssertionId, identityRef: p.identityRef, authenticatedAtEpochSeconds: p.authenticatedAtEpochSeconds, expiresAtEpochSeconds: p.authenticatedAtEpochSeconds + lifetime };
}

interface Payload { readonly a: string; readonly s: string; readonly i: string }
const isRef = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isPayload = (p: Readonly<Record<string, unknown>>): p is Payload & Record<string, string> => isRef(p['a']) && isRef(p['s']) && isRef(p['i']);

export function sealSession(session: ConsumerSession, key: SessionKey): string {
  return seal({ payload: { a: session.applicantRef, s: session.identityAssertionId, i: session.identityRef }, issuedAtEpochSeconds: session.authenticatedAtEpochSeconds, expiresAtEpochSeconds: session.expiresAtEpochSeconds }, key);
}

export type OpenOutcome =
  | { readonly kind: 'VALID'; readonly session: ConsumerSession }
  | { readonly kind: 'EXPIRED'; readonly expiredAtEpochSeconds: bigint }
  | { readonly kind: 'INVALID' };

export function openSession(token: string, key: SessionKey, nowEpochSeconds: bigint): OpenOutcome {
  const opened = open(token, key, nowEpochSeconds, SESSION_LIFETIME_SECONDS, isPayload);
  if (opened.kind !== 'VALID') return opened;
  const { payload: p, issuedAtEpochSeconds, expiresAtEpochSeconds } = opened.value;
  return { kind: 'VALID', session: { applicantRef: p.a, identityAssertionId: p.s, identityRef: p.i, authenticatedAtEpochSeconds: issuedAtEpochSeconds, expiresAtEpochSeconds } };
}
