/**
 * R-23. The applicant's session is an opaque sealed token: it reveals nothing,
 * it cannot be altered, it is not accepted under another key, and it ends at a
 * fixed offset from the rail's assertion — never later.
 */
import { describe, expect, it } from 'vitest';

import { SESSION_LIFETIME_SECONDS, deriveSessionKey, issueSession, openSession, sealSession } from '../../apps/consumer/src/server/session-token.ts';

const KEY = deriveSessionKey(new Uint8Array(32).fill(7));
const OTHER = deriveSessionKey(new Uint8Array(32).fill(9));
const T0 = 1_791_000_000n;
const session = issueSession({ applicantRef: 'app-77', identityAssertionId: 'asr-1', identityRef: 'idp-ref-77', authenticatedAtEpochSeconds: T0 });

describe('the consumer session token', () => {
  it('round-trips through seal and open', () => {
    const opened = openSession(sealSession(session, KEY), KEY, T0 + 10n);
    expect(opened.kind).toBe('VALID');
    if (opened.kind === 'VALID') expect(opened.session).toEqual(session);
  });
  it('reveals nothing in the token itself', () => {
    const token = sealSession(session, KEY);
    expect(token).not.toContain('app-77'); expect(token).not.toContain('asr-1'); expect(token).not.toContain('idp-ref');
    expect(Buffer.from(token.split('.')[2] ?? '', 'base64url').toString('utf8')).not.toContain('app-77');
  });
  it('expires exactly at the assertion time plus the lifetime, and not a second before', () => {
    const token = sealSession(session, KEY);
    expect(openSession(token, KEY, T0 + SESSION_LIFETIME_SECONDS - 1n).kind).toBe('VALID');
    const expired = openSession(token, KEY, T0 + SESSION_LIFETIME_SECONDS);
    expect(expired.kind).toBe('EXPIRED');
    if (expired.kind === 'EXPIRED') expect(expired.expiredAtEpochSeconds).toBe(T0 + SESSION_LIFETIME_SECONDS);
  });
  it('cannot be issued for longer than the lifetime', () => {
    expect(() => issueSession({ applicantRef: 'a', identityAssertionId: 's', identityRef: 'i', authenticatedAtEpochSeconds: T0, lifetimeSeconds: SESSION_LIFETIME_SECONDS + 1n })).toThrow();
    expect(() => issueSession({ applicantRef: 'a', identityAssertionId: 's', identityRef: 'i', authenticatedAtEpochSeconds: T0, lifetimeSeconds: 0n })).toThrow();
  });
  it('refuses a token altered in any byte', () => {
    const token = sealSession(session, KEY);
    const [v, iv, body, tag] = token.split('.') as [string, string, string, string];
    const flip = (s: string): string => { const b = Buffer.from(s, 'base64url'); b[0] = (b[0] ?? 0) ^ 1; return b.toString('base64url'); };
    expect(openSession(`${v}.${iv}.${flip(body)}.${tag}`, KEY, T0).kind).toBe('INVALID');
    expect(openSession(`${v}.${flip(iv)}.${body}.${tag}`, KEY, T0).kind).toBe('INVALID');
    expect(openSession(`${v}.${iv}.${body}.${flip(tag)}`, KEY, T0).kind).toBe('INVALID');
    expect(openSession(`v2.${iv}.${body}.${tag}`, KEY, T0).kind).toBe('INVALID');
  });
  it('refuses a token sealed under another key, and anything that is not a token', () => {
    expect(openSession(sealSession(session, OTHER), KEY, T0).kind).toBe('INVALID');
    expect(openSession('', KEY, T0).kind).toBe('INVALID');
    expect(openSession(JSON.stringify({ applicantRef: 'app-77', identityAssertionId: 'asr-1', identityRef: 'x' }), KEY, T0).kind).toBe('INVALID');
    expect(openSession('v1.a.b', KEY, T0).kind).toBe('INVALID');
  });
  it('binds every request to the assertion it was issued from', () => {
    const opened = openSession(sealSession(session, KEY), KEY, T0 + 1n);
    if (opened.kind !== 'VALID') throw new Error(opened.kind);
    expect(opened.session.identityAssertionId).toBe('asr-1');
    expect(opened.session.authenticatedAtEpochSeconds).toBe(T0);
  });
  it('derives the key from a master of at least 32 bytes, never using the master directly', () => {
    expect(() => deriveSessionKey(new Uint8Array(16))).toThrow();
    expect(Buffer.from(deriveSessionKey(new Uint8Array(32).fill(7)).bytes).equals(Buffer.from(new Uint8Array(32).fill(7)))).toBe(false);
    expect(deriveSessionKey(new Uint8Array(32).fill(7)).bytes).toEqual(KEY.bytes);
  });
});
