/**
 * Single sign-on as the workbench and Admin run it, in production mode:
 * the cookies they set, the session the callback issues, and what they refuse.
 *
 * - the state cookie is HttpOnly, Secure, SameSite=Lax, scoped to the callback
 *   path, short-lived, and cleared by the callback whatever the outcome;
 * - an institution the page does not list cannot be chosen by a crafted form;
 * - the session's tenant is the sealed one; a tenant in the callback is ignored;
 * - groups that map to nothing get the same refusal as an unknown token;
 * - an approval needs a recent authentication (stepUpForApprovalSeconds);
 * - Admin signs in only someone the institution maps to PLATFORM_ADMIN;
 * - development tokens are refused in production by both apps;
 * - sign-out clears the session and goes to the provider's end-session endpoint.
 *
 * A stand-in provider (local key pair, stubbed transport): no network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => {
  process.env['NODE_ENV'] = 'production';
  process.env['OPS_SESSION_SECRET'] = 'a1'.repeat(32);
  process.env['ADMIN_SESSION_SECRET'] = 'b2'.repeat(32);
  process.env['OPS_PUBLIC_ORIGIN'] = 'https://ops.sanad.test';
  process.env['ADMIN_PUBLIC_ORIGIN'] = 'https://admin.sanad.test';
  for (const t of ['BANK_A', 'FINTECH_B', 'SME_FUND_AE'])
    for (const a of ['OPS', 'ADMIN']) process.env[`OIDC_CLIENT_SECRET_${t}_${a}`] = 'test-only-secret';
  return { values: new Map<string, string>(), options: new Map<string, Record<string, unknown>>() };
});

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  },
}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name) } : undefined),
      set: (name: string, value: string, options: Record<string, unknown>) => {
        if (options['maxAge'] === 0) jar.values.delete(name);
        else jar.values.set(name, value);
        jar.options.set(name, options);
      },
      delete: (name: string) => {
        jar.values.delete(name);
      },
    }),
}));
/** The hosted configuration: every tenant's file with its OIDC placeholders filled in, selected as deployed. */
vi.mock('@sanad/origination/staff-identity.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('@sanad/origination/staff-identity.ts')>();
  const support = await import('../support/oidc-provider.ts');
  const { deploymentJurisdiction } = await import('@sanad/origination/jurisdiction.ts');
  const { loadTenantOnboarding } = await import('@sanad/config/loader.ts');
  type Tenant = 'bank-a' | 'fintech-b' | 'sme-fund-ae';
  const resolveStaffIdentity = (tenant: Tenant) =>
    Promise.resolve({ identity: { ok: true, value: support.filledIdentity(tenant) }, source: 'FILE', profile: 'DEPLOYED' });
  return {
    ...original,
    resolveStaffIdentity,
    singleSignOnInstitutions: async () => {
      const { activeTenants } = await deploymentJurisdiction();
      return activeTenants.map((tenant) => {
        const o = loadTenantOnboarding(tenant);
        return { tenant, nameEn: o.ok ? o.value.legalNameEn : tenant, nameAr: o.ok ? o.value.legalNameAr : tenant };
      });
    },
  };
});

import { createOidcClient } from '@sanad/auth/oidc.ts';
import { inMemoryReplayGuard } from '@sanad/auth/staff-oidc.ts';

import { frontDoor } from '../../apps/ops/src/middleware.ts';
import { signInAction, signOutAction, singleSignOnAction } from '../../apps/ops/src/server/auth-actions.ts';
import { authorise } from '../../apps/ops/src/server/session.ts';
import {
  SSO_STATE_COOKIE,
  completeSingleSignOn,
  setSsoDependencies,
} from '../../apps/ops/src/server/single-sign-on.ts';
import {
  STAFF_SESSION_COOKIE,
  epochNow,
  issueStaffSession,
  openStaffSession,
} from '../../apps/ops/src/server/staff-session.ts';
import { currentAdmin, developmentPrincipalFor } from '../../apps/admin/src/server/session.ts';
import * as adminSso from '../../apps/admin/src/server/single-sign-on.ts';
import { END_SESSION, NOW, type TestProvider, standardClaims, testProvider } from '../support/oidc-provider.ts';

let idp: TestProvider;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  idp = await testProvider('test-only-secret');
  const client = createOidcClient({ fetch: idp.fetch, nowMs: () => Date.now() });
  setSsoDependencies({ client, replay: inMemoryReplayGuard() });
  adminSso.setSsoDependencies({ client, replay: inMemoryReplayGuard() });
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(() => {
  jar.values.clear();
  jar.options.clear();
});

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const redirectOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as { url?: string }).url ?? `threw: ${String(e)}`;
  }
  return 'no redirect';
};

/** Begin at the workbench for an institution; return the provider URL's state. */
async function beginOps(institution: string, extra: Record<string, string> = {}): Promise<string> {
  const to = await redirectOf(singleSignOnAction(form({ locale: 'en', institution, ...extra })));
  expect(to.startsWith('https://login.microsoftonline.com/')).toBe(true);
  return idp.noteAuthorization(to).state;
}
const callbackRequest = (origin: string, state: string, extra: Record<string, string> = {}) =>
  new Request(`${origin}/sign-in/callback?${new URLSearchParams({ code: 'c-1', state, ...extra }).toString()}`);

describe('workbench single sign-on', () => {
  it('the state cookie is HttpOnly, Secure, SameSite=Lax, scoped to the callback and short-lived', async () => {
    await beginOps('bank-a');
    expect(jar.values.has(SSO_STATE_COOKIE)).toBe(true);
    expect(jar.options.get(SSO_STATE_COOKIE)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/sign-in/callback',
      maxAge: 600,
    });
  });

  it('an institution the page does not list (not active here, or made up) cannot be chosen', async () => {
    expect(await redirectOf(singleSignOnAction(form({ locale: 'en', institution: 'sme-fund-ae' })))).toBe(
      '/en/sign-in?reason=SSO_UNAVAILABLE',
    );
    expect(await redirectOf(singleSignOnAction(form({ locale: 'en', institution: 'evil-bank' })))).toBe(
      '/en/sign-in?reason=SSO_UNAVAILABLE',
    );
    expect(jar.values.has(SSO_STATE_COOKIE)).toBe(false);
  });

  it('the callback issues the session for the sealed tenant, ignores a tenant in the query, and clears the state cookie', async () => {
    const state = await beginOps('bank-a');
    idp.respondWith((n) => idp.mint(standardClaims(n, { roles: ['sanad.bank-a.makers', 'sanad.fintech-b.checkers'] })));
    const res = await completeSingleSignOn(callbackRequest('https://ops.sanad.test', state, { tenant: 'fintech-b', tenantId: 'fintech-b' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('url=/en"');
    expect(jar.values.has(SSO_STATE_COOKIE)).toBe(false);
    const opened = openStaffSession(jar.values.get(STAFF_SESSION_COOKIE), epochNow());
    expect(opened.kind).toBe('VALID');
    if (opened.kind !== 'VALID') return;
    expect(opened.principal.tenantId).toBe('bank-a');
    expect(opened.principal.authorities).toEqual(['MAKER']);
    expect(opened.method).toBe('OIDC');
    expect(opened.authenticatedAtEpochSeconds).toBe(BigInt(NOW - 5));
    expect(opened.displayName).toBe('Test Person');
    expect(jar.options.get(STAFF_SESSION_COOKIE)).toMatchObject({ httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge: 1800 });
  });

  it('groups that map to nothing in the chosen tenant: refused with the same reason as an unknown token, no session', async () => {
    const state = await beginOps('fintech-b');
    idp.respondWith((n) => idp.mint(standardClaims(n, { roles: ['sanad.bank-a.checkers'] })));
    const res = await completeSingleSignOn(callbackRequest('https://ops.sanad.test', state));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/en/sign-in?reason=SIGN_IN_REFUSED');
    expect(jar.values.has(STAFF_SESSION_COOKIE)).toBe(false);
  });

  it('a callback without its state cookie (or a replay after it was consumed) signs nobody in', async () => {
    const state = await beginOps('bank-a');
    idp.respondWith((n) => idp.mint(standardClaims(n)));
    const cookie = jar.values.get(SSO_STATE_COOKIE) ?? '';
    expect((await completeSingleSignOn(callbackRequest('https://ops.sanad.test', state))).status).toBe(200);
    jar.values.clear();
    const noCookie = await completeSingleSignOn(callbackRequest('https://ops.sanad.test', state));
    expect(noCookie.headers.get('location')).toBe('/ar/sign-in?reason=SSO_FAILED');
    jar.values.set(SSO_STATE_COOKIE, cookie);
    const replay = await completeSingleSignOn(callbackRequest('https://ops.sanad.test', state, { code: 'c-2' }));
    expect(replay.headers.get('location')).toBe('/en/sign-in?reason=SSO_FAILED');
    expect(jar.values.has(STAFF_SESSION_COOKIE)).toBe(false);
  });

  it('the callback and post-logout return pass the front door without a session; nothing beneath them does', () => {
    expect(frontDoor('/sign-in/callback', undefined, epochNow()).kind).toBe('PASS');
    expect(frontDoor('/sign-in/signed-out', undefined, epochNow()).kind).toBe('PASS');
    expect(frontDoor('/sign-in/callback/x', undefined, epochNow()).kind).toBe('SIGN_IN');
    expect(frontDoor('/sign-in', undefined, epochNow()).kind).toBe('SIGN_IN');
  });

  it('a development token is refused in production', async () => {
    process.env['STAFF_DEV_TOKEN_CHECKER'] = 'dev-token-checker-0001';
    expect(await redirectOf(signInAction(form({ locale: 'en', token: 'dev-token-checker-0001' })))).toBe(
      '/en/sign-in?reason=DEVELOPMENT_SIGN_IN_REFUSED',
    );
    delete process.env['STAFF_DEV_TOKEN_CHECKER'];
    expect(jar.values.has(STAFF_SESSION_COOKIE)).toBe(false);
  });

  it('sign-out clears the session and continues to the provider’s end-session endpoint', async () => {
    const t = epochNow();
    jar.values.set(
      STAFF_SESSION_COOKIE,
      issueStaffSession({ principalId: 'oidc:abc', tenantId: 'bank-a', authorities: ['MAKER'] }, 1_800n, t, { method: 'OIDC' }).token,
    );
    const to = await redirectOf(signOutAction(form({ locale: 'en' })));
    expect(to.startsWith(`${END_SESSION}?`)).toBe(true);
    expect(new URL(to).searchParams.get('post_logout_redirect_uri')).toBe('https://ops.sanad.test/sign-in/signed-out');
    expect(jar.values.has(STAFF_SESSION_COOKIE)).toBe(false);
  });
});

describe('step-up before an approval (stepUpForApprovalSeconds = 300)', () => {
  const sessionAuthenticatedAt = (secondsAgo: bigint) => {
    const t = epochNow();
    jar.values.set(
      STAFF_SESSION_COOKIE,
      issueStaffSession({ principalId: 'oidc:chk', tenantId: 'bank-a', authorities: ['MAKER', 'CHECKER'] }, 1_800n, t, {
        method: 'OIDC',
        authenticatedAtEpochSeconds: t - secondsAgo,
      }).token,
    );
  };

  it('an approval with an authentication older than the window is sent to sign in again', async () => {
    sessionAuthenticatedAt(301n);
    expect(await redirectOf(authorise('en', 'REVIEW', '/en/queue'))).toBe('/en/sign-in?reason=STEP_UP_REQUIRED');
  });
  it('a fresh authentication approves; keying work needs no step-up', async () => {
    sessionAuthenticatedAt(30n);
    expect((await authorise('en', 'REVIEW', '/en/queue')).principalId).toBe('oidc:chk');
    sessionAuthenticatedAt(1_000n);
    expect((await authorise('en', 'ORIGINATE', '/en/originate')).principalId).toBe('oidc:chk');
  });
  it('the step-up sign-in asks the provider for a fresh authentication', async () => {
    const to = await redirectOf(singleSignOnAction(form({ locale: 'en', institution: 'bank-a', stepUp: '1' })));
    expect(new URL(to).searchParams.get('prompt')).toBe('login');
  });
});

describe('Admin single sign-on', () => {
  async function beginAdmin(institution: string): Promise<string> {
    const begun = await adminSso.beginSingleSignOn(institution, 'en');
    if (!begun.ok) throw new Error(begun.notice);
    expect(new URL(begun.location).searchParams.get('redirect_uri')).toBe('https://admin.sanad.test/sign-in/callback');
    return idp.noteAuthorization(begun.location).state;
  }

  it('a person the institution maps to PLATFORM_ADMIN is signed in, with the institution recorded', async () => {
    const state = await beginAdmin('bank-a');
    expect(jar.options.get(adminSso.ADMIN_SSO_STATE_COOKIE)).toMatchObject({ path: '/sign-in/callback', sameSite: 'lax', httpOnly: true, secure: true });
    idp.respondWith((n) => idp.mint(standardClaims(n, { roles: ['sanad.bank-a.platform-admins'] })));
    const res = await adminSso.completeSingleSignOn(callbackRequest('https://admin.sanad.test', state, { tenant: 'fintech-b' }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('url=/en/credentials"');
    const admin = await currentAdmin();
    expect(admin).toMatchObject({ role: 'PLATFORM_ADMIN', method: 'OIDC', tenantId: 'bank-a', principalId: 'oidc:AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ' });
  });

  it('a checker (any authority but PLATFORM_ADMIN) is refused, and so is another tenant’s administrator', async () => {
    const s1 = await beginAdmin('bank-a');
    idp.respondWith((n) => idp.mint(standardClaims(n, { roles: ['sanad.bank-a.checkers', 'sanad.bank-a.senior-checkers'] })));
    const r1 = await adminSso.completeSingleSignOn(callbackRequest('https://admin.sanad.test', s1));
    expect(r1.headers.get('location')).toBe('/en?notice=SIGN_IN_REFUSED');
    const s2 = await beginAdmin('bank-a');
    idp.respondWith((n) => idp.mint(standardClaims(n, { roles: ['sanad.fintech-b.platform-admins'] })));
    const r2 = await adminSso.completeSingleSignOn(callbackRequest('https://admin.sanad.test', s2));
    expect(r2.headers.get('location')).toBe('/en?notice=SIGN_IN_REFUSED');
    expect(await currentAdmin()).toBeUndefined();
  });

  it('a workbench state cookie presented to Admin’s callback signs nobody in', async () => {
    const state = await beginOps('bank-a');
    const opsState = jar.values.get(SSO_STATE_COOKIE) ?? '';
    jar.values.set(adminSso.ADMIN_SSO_STATE_COOKIE, opsState);
    idp.respondWith((n) => idp.mint(standardClaims(n, { roles: ['sanad.bank-a.platform-admins'] })));
    const res = await adminSso.completeSingleSignOn(callbackRequest('https://admin.sanad.test', state));
    expect(res.headers.get('location')).toBe('/ar?notice=SSO_FAILED');
    expect(await currentAdmin()).toBeUndefined();
  });

  it('an institution Admin’s page does not list cannot be chosen', async () => {
    expect(await adminSso.beginSingleSignOn('sme-fund-ae', 'en')).toEqual({ ok: false, notice: 'SSO_UNAVAILABLE' });
  });

  it('a development token names no administrator in production', async () => {
    process.env['PLATFORM_OPS_DEV_TOKEN'] = 'dev-token-platform-0001';
    expect(developmentPrincipalFor('dev-token-platform-0001')).toBeUndefined();
    delete process.env['PLATFORM_OPS_DEV_TOKEN'];
    expect(await currentAdmin()).toBeUndefined();
  });
});
