/**
 * SR-030: signing out ends the session, not only the cookie. Each case keeps
 * a copy of the cookie, signs out, presents the copy again, and passes only
 * when it is refused. A session issued afterwards is unaffected: revocation is
 * of a token, not of a person.
 *
 * In memory (no database configured); the shared store is
 * test/contract/spent-tokens-postgres.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => {
  process.env['ADMIN_SESSION_SECRET'] = 'c3'.repeat(32);
  process.env['OPS_SESSION_SECRET'] = 'd4'.repeat(32);
  process.env['CONSUMER_SESSION_SECRET'] = 'e5'.repeat(32);
  delete process.env['SANAD_DATABASE_URL'];
  return new Map<string, string>();
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: (name: string, value: string) => {
        jar.set(name, value);
      },
      delete: (name: string) => {
        jar.delete(name);
      },
    }),
}));

import { currentAdmin, endAdminSession, startAdminSession } from '../../apps/admin/src/server/session.ts';
import { currentSession, clearSession, startSession } from '../../apps/consumer/src/server/session.ts';
import { currentStaff, endStaffSession, startStaffSession } from '../../apps/ops/src/server/session.ts';

beforeEach(() => {
  jar.clear();
});

/** Sign in, keep a copy of the one cookie set, sign out, and put the copy back. */
async function copiedAcrossSignOut(signIn: () => Promise<unknown>, signOut: () => Promise<void>): Promise<string> {
  await signIn();
  const [name, copy] = [...jar.entries()][0] ?? ['', ''];
  expect(copy.length).toBeGreaterThan(0);
  await signOut();
  expect(jar.has(name)).toBe(false);
  jar.set(name, copy);
  return copy;
}

describe('a session cookie copied before sign-out is refused after it (SR-030)', () => {
  it('Admin', async () => {
    const signIn = () => startAdminSession('adm-dev-01');
    await signIn();
    expect((await currentAdmin())?.principalId).toBe('adm-dev-01');
    jar.clear();
    await copiedAcrossSignOut(signIn, endAdminSession);
    expect(await currentAdmin()).toBeUndefined();
    jar.clear();
    await signIn();
    expect((await currentAdmin())?.principalId).toBe('adm-dev-01');
  });

  it('the workbench', async () => {
    const signIn = () =>
      startStaffSession({ principalId: 'stf-maker-01', tenantId: 'bank-a', authorities: ['MAKER'] }, undefined);
    await signIn();
    expect((await currentStaff())?.principalId).toBe('stf-maker-01');
    jar.clear();
    await copiedAcrossSignOut(signIn, endStaffSession);
    expect(await currentStaff()).toBeUndefined();
    jar.clear();
    await signIn();
    expect((await currentStaff())?.principalId).toBe('stf-maker-01');
  });

  it('the consumer site', async () => {
    const signIn = () =>
      startSession({
        applicantRef: 'applicant-revocation',
        identityAssertionId: 'assert-revocation',
        identityRef: 'idref-revocation',
        authenticatedAtEpochSeconds: BigInt(Math.floor(Date.now() / 1000)),
      });
    await signIn();
    expect((await currentSession())?.applicantRef).toBe('applicant-revocation');
    jar.clear();
    await copiedAcrossSignOut(signIn, clearSession);
    expect(await currentSession()).toBeUndefined();
    jar.clear();
    await signIn();
    expect((await currentSession())?.applicantRef).toBe('applicant-revocation');
  });
});
