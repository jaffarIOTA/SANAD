/**
 * The operations workbench's staff sign-in (SEC-TM08 cross-tenant, SEC-TM12
 * BOLA, SEC-TM14 privilege escalation). Each test attempts what must not
 * happen and passes only when the attempt fails:
 *
 * - a forged, tampered, over-long or expired session cookie is no session;
 * - a development token is refused in production, at sign-in and as a bearer;
 * - one token is one person, whose authorities come from the tenant's staff
 *   identity configuration — FINANCE included, for every tenant;
 * - a session never lives longer than the configuration, nor an hour;
 * - the middleware sends a page request without a session to sign in, keeping
 *   the locale, and leaves /api and static files alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  options: new Map<string, Record<string, unknown>>(),
}));

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
        jar.values.set(name, value);
        jar.options.set(name, options);
      },
      delete: (name: string) => {
        jar.values.delete(name);
      },
    }),
}));

import { NextRequest } from 'next/server';

import { deriveSealKey, seal } from '@sanad/auth/sealed-token.ts';
import { TENANT_CODES, loadStaffIdentity } from '@sanad/config/loader.ts';
import { STAFF_AUTHORITIES } from '@sanad/core/config/staff-identity.ts';

import { frontDoor, middleware } from '../../apps/ops/src/middleware.ts';
import { signInAction, signOutAction } from '../../apps/ops/src/server/auth-actions.ts';
import { permits } from '../../apps/ops/src/server/authority.ts';
import {
  DEVELOPMENT_STAFF,
  authenticateStaff,
  developmentStaffFor,
  principalFor,
  requestPrincipal,
} from '../../apps/ops/src/server/staff.ts';
import {
  STAFF_SESSION_CEILING_SECONDS,
  STAFF_SESSION_COOKIE,
  issueStaffSession,
  openStaffSession,
  staffSealKey,
} from '../../apps/ops/src/server/staff-session.ts';

const NOW = 2_000_000_000n;
const OFFICER = { principalId: 'stf-ae-officer-01', tenantId: 'sme-fund-ae', authorities: ['MAKER'] } as const;

const TOKENS = {
  NODE_ENV: 'test',
  STAFF_DEV_TOKEN_MAKER: 'test-tok-maker-7f3a',
  STAFF_DEV_TOKEN_CHECKER: 'test-tok-checker-2b9c',
  STAFF_DEV_TOKEN_SENIOR: 'test-tok-senior-91de',
  STAFF_DEV_TOKEN_AE_OFFICER: 'test-tok-ae-officer-44aa',
  STAFF_DEV_TOKEN_AE_CHECKER: 'test-tok-ae-checker-55bb',
  STAFF_DEV_TOKEN_AE_COMMITTEE: 'test-tok-ae-committee-66cc',
  STAFF_DEV_TOKEN_AE_FINANCE: 'test-tok-ae-finance-77dd',
} as const;

describe('the sealed staff session', () => {
  it('opens to exactly the principal that was sealed', () => {
    const issued = issueStaffSession(OFFICER, 1_800n, NOW);
    const opened = openStaffSession(issued.token, NOW + 10n);
    expect(opened.kind).toBe('VALID');
    if (opened.kind === 'VALID') expect(opened.principal).toEqual(OFFICER);
  });

  it('refuses a tampered cookie, a hand-written one, and one sealed for another purpose', () => {
    const token = issueStaffSession(OFFICER, 1_800n, NOW).token;
    const [v, iv, body, tag] = token.split('.');
    // Flip the first character: the last base64url character can carry only padding bits, so changing it may change nothing.
    const flip = (s: string): string => `${s.startsWith('A') ? 'B' : 'A'}${s.slice(1)}`;
    for (const forged of [
      `${v}.${iv}.${flip(body ?? '')}.${tag}`,
      `${v}.${iv}.${body}.${flip(tag ?? '')}`,
      `${v}.${flip(iv ?? '')}.${body}.${tag}`,
      `v2.${iv}.${body}.${tag}`,
      JSON.stringify({ p: 'stf-ae-checker-01', t: 'sme-fund-ae', a: 'CHECKER' }),
      '',
    ]) {
      expect(openStaffSession(forged, NOW + 1n).kind).toBe('INVALID');
    }
    // The admin app's key (another HKDF purpose) seals a perfectly well-formed payload that the workbench refuses.
    const otherKey = deriveSealKey(new Uint8Array(32).fill(7), 'admin-session-v1');
    const elsewhere = seal(
      {
        payload: { p: 'stf-ae-checker-01', t: 'sme-fund-ae', a: 'CHECKER' },
        issuedAtEpochSeconds: NOW,
        expiresAtEpochSeconds: NOW + 60n,
      },
      otherKey,
    );
    expect(openStaffSession(elsewhere, NOW + 1n).kind).toBe('INVALID');
  });

  it('refuses a session sealed with an authority the platform does not define, a tenant it does not know, or extra fields', () => {
    const key = staffSealKey();
    const sealWith = (payload: Record<string, string>): string =>
      seal({ payload, issuedAtEpochSeconds: NOW, expiresAtEpochSeconds: NOW + 60n }, key);
    expect(openStaffSession(sealWith({ p: 'x-1', t: 'sme-fund-ae', a: 'ROOT' }), NOW).kind).toBe('INVALID');
    expect(openStaffSession(sealWith({ p: 'x-1', t: 'evil-bank', a: 'CHECKER' }), NOW).kind).toBe('INVALID');
    expect(openStaffSession(sealWith({ p: 'x-1', t: 'sme-fund-ae', a: 'CHECKER,CHECKER' }), NOW).kind).toBe('INVALID');
    expect(
      openStaffSession(sealWith({ p: 'x-1', t: 'sme-fund-ae', a: 'CHECKER', tenantOverride: 'bank-a' }), NOW).kind,
    ).toBe('INVALID');
  });

  it('expires a fixed time after sign-in, and is refused after', () => {
    const issued = issueStaffSession(OFFICER, 1_800n, NOW);
    expect(openStaffSession(issued.token, NOW + 1_799n).kind).toBe('VALID');
    expect(openStaffSession(issued.token, NOW + 1_800n).kind).toBe('EXPIRED');
    expect(openStaffSession(issued.token, NOW + 99_999n).kind).toBe('EXPIRED');
  });

  it('never lives longer than an hour, whatever the configuration or the token claims', () => {
    expect(issueStaffSession(OFFICER, 86_400n, NOW).lifetimeSeconds).toBe(STAFF_SESSION_CEILING_SECONDS);
    expect(STAFF_SESSION_CEILING_SECONDS).toBe(3_600n);
    const greedy = seal(
      {
        payload: { p: 'stf-ae-officer-01', t: 'sme-fund-ae', a: 'MAKER' },
        issuedAtEpochSeconds: NOW,
        expiresAtEpochSeconds: NOW + 7_200n,
      },
      staffSealKey(),
    );
    expect(openStaffSession(greedy, NOW + 1n).kind).toBe('INVALID');
  });
});

describe('development tokens', () => {
  it('one token is one person: every development identity is distinct', () => {
    const ids = DEVELOPMENT_STAFF.map((s) => s.principalId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(DEVELOPMENT_STAFF.map((s) => s.environmentName)).size).toBe(DEVELOPMENT_STAFF.length);
  });

  it('resolve to their person, with the authorities the tenant configuration grants their groups', () => {
    const expectations: readonly [string, string, string, readonly string[]][] = [
      [TOKENS.STAFF_DEV_TOKEN_MAKER, 'stf-maker-01', 'bank-a', ['MAKER']],
      [TOKENS.STAFF_DEV_TOKEN_CHECKER, 'stf-checker-01', 'bank-a', ['CHECKER']],
      [TOKENS.STAFF_DEV_TOKEN_SENIOR, 'stf-senior-01', 'bank-a', ['SENIOR_CHECKER']],
      [TOKENS.STAFF_DEV_TOKEN_AE_OFFICER, 'stf-ae-officer-01', 'sme-fund-ae', ['MAKER']],
      [TOKENS.STAFF_DEV_TOKEN_AE_CHECKER, 'stf-ae-checker-01', 'sme-fund-ae', ['CHECKER']],
      [TOKENS.STAFF_DEV_TOKEN_AE_COMMITTEE, 'stf-ae-committee-01', 'sme-fund-ae', ['CREDIT_COMMITTEE']],
      [TOKENS.STAFF_DEV_TOKEN_AE_FINANCE, 'stf-ae-finance-01', 'sme-fund-ae', ['FINANCE']],
    ];
    for (const [token, principalId, tenantId, authorities] of expectations) {
      const staff = developmentStaffFor(token, TOKENS);
      expect(staff?.principalId, principalId).toBe(principalId);
      const principal =
        staff === undefined ? undefined : principalFor(staff, loadStaffIdentity(staff.tenantId, 'DEVELOPMENT'));
      expect(principal).toEqual({ principalId, tenantId, authorities });
    }
  });

  it('refuse an unknown, empty or near-miss token', () => {
    for (const presented of [
      '',
      '   ',
      'test-tok-maker-7f3',
      'test-tok-maker-7f3a ',
      'DEV-TOK-MAKER-7F3A',
      'Bearer test-tok-maker-7f3a',
    ]) {
      const staff = developmentStaffFor(presented, TOKENS);
      // A trailing space is trimmed, as a pasted token would be; anything else that differs is refused.
      if (presented === 'test-tok-maker-7f3a ') expect(staff?.principalId).toBe('stf-maker-01');
      else expect(staff, JSON.stringify(presented)).toBeUndefined();
    }
  });

  it('are refused when NODE_ENV is production, at sign-in and as a bearer', () => {
    const production = { ...TOKENS, NODE_ENV: 'production' };
    expect(developmentStaffFor(TOKENS.STAFF_DEV_TOKEN_CHECKER, production)).toBeUndefined();
    expect(authenticateStaff(`Bearer ${TOKENS.STAFF_DEV_TOKEN_CHECKER}`, production)).toBeUndefined();
    expect(authenticateStaff(`Bearer ${TOKENS.STAFF_DEV_TOKEN_CHECKER}`, TOKENS)?.principalId).toBe('stf-checker-01');
  });

  it('confer nothing when the tenant’s configuration does not parse (a development provider in a deployed profile)', () => {
    const staff = developmentStaffFor(TOKENS.STAFF_DEV_TOKEN_AE_FINANCE, TOKENS);
    expect(staff).toBeDefined();
    if (staff !== undefined) expect(principalFor(staff, loadStaffIdentity(staff.tenantId, 'DEPLOYED'))).toBeUndefined();
  });
});

describe('authorities', () => {
  it('every tenant maps a group to FINANCE, and FINANCE is a platform authority', () => {
    expect(STAFF_AUTHORITIES).toContain('FINANCE');
    for (const tenant of TENANT_CODES) {
      const identity = loadStaffIdentity(tenant, 'DEVELOPMENT');
      expect(identity.ok, tenant).toBe(true);
      if (identity.ok)
        expect(
          identity.value.mappings.map((m) => m.authority),
          tenant,
        ).toContain('FINANCE');
    }
  });

  it('the domain sees the highest approval tier held, and none for a maker or finance user', () => {
    expect(
      requestPrincipal({ principalId: 'a', tenantId: 'bank-a', authorities: ['MAKER'] }).authority,
    ).toBeUndefined();
    expect(
      requestPrincipal({ principalId: 'a', tenantId: 'bank-a', authorities: ['FINANCE'] }).authority,
    ).toBeUndefined();
    expect(
      requestPrincipal({ principalId: 'a', tenantId: 'bank-a', authorities: ['CHECKER', 'SENIOR_CHECKER'] }).authority,
    ).toBe('SENIOR_CHECKER');
  });

  it('an act needs its authority: a maker reviews nothing, a checker releases no money, finance approves nothing', () => {
    const maker = { principalId: 'm', tenantId: 'sme-fund-ae', authorities: ['MAKER'] } as const;
    const checker = { principalId: 'c', tenantId: 'sme-fund-ae', authorities: ['CHECKER'] } as const;
    const finance = { principalId: 'f', tenantId: 'sme-fund-ae', authorities: ['FINANCE'] } as const;
    expect(permits(maker, 'REVIEW').allowed).toBe(false);
    expect(permits(maker, 'BUSINESS_VERIFY').allowed).toBe(false);
    expect(permits(checker, 'BUSINESS_DISBURSE').allowed).toBe(false);
    expect(permits(checker, 'BUSINESS_COMMITTEE').allowed).toBe(false);
    expect(permits(finance, 'BUSINESS_APPROVE').allowed).toBe(false);
    expect(permits(finance, 'BUSINESS_DISBURSE').allowed).toBe(true);
    expect(permits(undefined, 'ORIGINATE').allowed).toBe(false);
  });
});

describe('sign-in and sign-out', () => {
  const signInForm = (token: string, locale = 'ar'): FormData => {
    const f = new FormData();
    f.set('locale', locale);
    f.set('token', token);
    return f;
  };
  const redirectOf = async (run: () => Promise<void>): Promise<URL> => {
    try {
      await run();
    } catch (error) {
      const url = (error as { url?: string }).url;
      if (url !== undefined) return new URL(url, 'http://ops.test');
      throw error;
    }
    throw new Error('did not redirect');
  };

  beforeEach(() => {
    jar.values.clear();
    jar.options.clear();
    for (const [k, v] of Object.entries(TOKENS)) if (k !== 'NODE_ENV') vi.stubEnv(k, v);
    vi.stubEnv('SANAD_JURISDICTION', 'AE');
  });

  it('issues a sealed, httpOnly, same-site-strict cookie bounded by the tenant’s configuration', async () => {
    const url = await redirectOf(() => signInAction(signInForm(TOKENS.STAFF_DEV_TOKEN_AE_FINANCE, 'en')));
    expect(url.pathname).toBe('/en');
    const token = jar.values.get(STAFF_SESSION_COOKIE);
    expect(token).toBeDefined();
    expect(token).not.toContain('stf-ae-finance-01');
    const options = jar.options.get(STAFF_SESSION_COOKIE) ?? {};
    expect(options['httpOnly']).toBe(true);
    expect(options['sameSite']).toBe('strict');
    expect(options['path']).toBe('/');
    expect(Number(options['maxAge'])).toBe(1_800);
    const opened = openStaffSession(token, BigInt(Math.floor(Date.now() / 1000)));
    expect(opened.kind === 'VALID' ? opened.principal : undefined).toEqual({
      principalId: 'stf-ae-finance-01',
      tenantId: 'sme-fund-ae',
      authorities: ['FINANCE'],
    });
  });

  it('refuses a wrong token without setting anything', async () => {
    const url = await redirectOf(() => signInAction(signInForm('not-a-token')));
    expect(url.pathname).toBe('/ar/sign-in');
    expect(url.searchParams.get('reason')).toBe('SIGN_IN_REFUSED');
    expect(jar.values.size).toBe(0);
  });

  it('refuses development sign-in in production, even with a valid token', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const url = await redirectOf(() => signInAction(signInForm(TOKENS.STAFF_DEV_TOKEN_AE_CHECKER)));
      expect(url.searchParams.get('reason')).toBe('DEVELOPMENT_SIGN_IN_REFUSED');
      expect(jar.values.size).toBe(0);
    } finally {
      vi.stubEnv('NODE_ENV', 'test');
    }
  });

  it('refuses a person whose institution the deployment does not have active', async () => {
    const url = await redirectOf(() => signInAction(signInForm(TOKENS.STAFF_DEV_TOKEN_CHECKER)));
    expect(url.searchParams.get('reason')).toBe('TENANT_NOT_ACTIVE');
    expect(jar.values.size).toBe(0);
  });

  it('never redirects anywhere but a locale path, whatever the form says', async () => {
    const url = await redirectOf(() => signInAction(signInForm('nope', '//evil.example')));
    expect(url.host).toBe('ops.test');
    expect(url.pathname).toBe('/ar/sign-in');
  });

  it('signs out by removing the session', async () => {
    await redirectOf(() => signInAction(signInForm(TOKENS.STAFF_DEV_TOKEN_AE_OFFICER)));
    expect(jar.values.has(STAFF_SESSION_COOKIE)).toBe(true);
    const f = new FormData();
    f.set('locale', 'en');
    const url = await redirectOf(() => signOutAction(f));
    expect(url.pathname).toBe('/en/sign-in');
    expect(jar.values.has(STAFF_SESSION_COOKIE)).toBe(false);
  });
});

describe('the middleware', () => {
  const now = (): bigint => BigInt(Math.floor(Date.now() / 1000));

  it('sends a page request without a valid session to sign in, keeping the locale', () => {
    expect(frontDoor('/en/queue', undefined, NOW)).toEqual({
      kind: 'SIGN_IN',
      location: '/en/sign-in?reason=SESSION_REQUIRED',
      clearCookie: false,
    });
    expect(frontDoor('/ar/business/FR-1/offer', undefined, NOW)).toMatchObject({
      kind: 'SIGN_IN',
      location: '/ar/sign-in?reason=SESSION_REQUIRED',
    });
    expect(frontDoor('/en/business/export', undefined, NOW).kind).toBe('SIGN_IN');
    expect(frontDoor('/', undefined, NOW).kind).toBe('SIGN_IN');
    expect(frontDoor('/en/queue', 'v1.forged.cookie.value', NOW)).toMatchObject({ kind: 'SIGN_IN', clearCookie: true });
    const expired = issueStaffSession(OFFICER, 60n, NOW).token;
    expect(frontDoor('/en/queue', expired, NOW + 61n)).toMatchObject({ kind: 'SIGN_IN', clearCookie: true });
  });

  it('lets a valid session, the sign-in page, /api and static files through', () => {
    const valid = issueStaffSession(OFFICER, 600n, NOW).token;
    expect(frontDoor('/en/queue', valid, NOW + 1n).kind).toBe('PASS');
    expect(frontDoor('/ar/sign-in', undefined, NOW).kind).toBe('PASS');
    expect(frontDoor('/en/sign-in', undefined, NOW).kind).toBe('PASS');
    for (const path of [
      '/api/review/v1/queue',
      '/api/origination/v1/requests',
      '/api',
      '/_next/static/chunks/app.js',
      '/favicon.ico',
      '/kit/logo.svg',
    ]) {
      expect(frontDoor(path, undefined, NOW).kind, path).toBe('PASS');
    }
    // A path that merely starts like the sign-in page is not it.
    expect(frontDoor('/en/sign-in-elsewhere', undefined, NOW).kind).toBe('SIGN_IN');
  });

  it('answers a real request: a redirect for a page, nothing for /api', () => {
    const page = middleware(new NextRequest('http://ops.test/ar/queue'));
    expect(page.status).toBe(303);
    expect(page.headers.get('location')).toBe('http://ops.test/ar/sign-in?reason=SESSION_REQUIRED');
    const api = middleware(new NextRequest('http://ops.test/api/review/v1/queue'));
    expect(api.headers.get('location')).toBeNull();
    expect(api.headers.get('x-middleware-next')).toBe('1');
    const signedIn = new NextRequest('http://ops.test/en/queue', {
      headers: { cookie: `${STAFF_SESSION_COOKIE}=${issueStaffSession(OFFICER, 600n, now()).token}` },
    });
    expect(middleware(signedIn).headers.get('x-middleware-next')).toBe('1');
  });
});
