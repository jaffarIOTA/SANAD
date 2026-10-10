/**
 * SR-045: the consumer session's applicant is the identity the provider
 * confirmed, whatever the sign-in form named. With a live-shaped identity
 * port (one whose confirmation names its own subject), a form that types
 * someone else's reference still signs in only the confirmed person.
 */
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  process.env['CONSUMER_SESSION_SECRET'] = 'f6'.repeat(32);
  delete process.env['SANAD_DATABASE_URL'];
  return { cookies: new Map<string, string>(), started: [] as string[] };
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined),
      set: (name: string, value: string) => {
        state.cookies.set(name, value);
      },
      delete: (name: string) => {
        state.cookies.delete(name);
      },
    }),
}));
/** A live-shaped provider: it confirms its own subject, not the reference it was started with. */
vi.mock('../../apps/consumer/src/server/identity.ts', () => ({
  demonstrationSignInPermitted: () => Promise.resolve(false),
  consumerIdentity: () =>
    Promise.resolve({
      startAuthentication: (p: { applicantRef: string }) => {
        state.started.push(p.applicantRef);
        return Promise.resolve({
          ok: true,
          value: { kind: 'ANSWERED', value: { transactionRef: 'txn-live-1', expiresAtEpochSeconds: 9_999_999_999n } },
        });
      },
      confirmAuthentication: () =>
        Promise.resolve({
          ok: true,
          value: {
            kind: 'ANSWERED',
            value: {
              assertionId: 'asr-live-0001',
              identityRef: 'subject-confirmed-01',
              authenticatedAtEpochSeconds: BigInt(Math.floor(Date.now() / 1000)),
            },
          },
        }),
    }),
}));

import { signInAction } from '../../apps/consumer/src/server/actions.ts';
import { currentSession } from '../../apps/consumer/src/server/session.ts';

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('the consumer session binds the confirmed identity (SR-045)', () => {
  it('signs in the subject the provider confirmed, not the reference typed', async () => {
    await expect(signInAction(form({ locale: 'en', applicantRef: 'someone-else-07' }))).rejects.toMatchObject({
      url: '/en/apply',
    });
    expect(state.started).toEqual(['someone-else-07']);
    const session = await currentSession();
    expect(session?.applicantRef).toBe('subject-confirmed-01');
    expect(session?.identityAssertionId).toBe('asr-live-0001');
  });
});
