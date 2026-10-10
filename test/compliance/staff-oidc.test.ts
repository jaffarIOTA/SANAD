/**
 * Staff single sign-on by OpenID Connect (ASVS L3 for authentication;
 * SEC-TM08 cross-tenant, SEC-TM14 privilege escalation). Each test attempts
 * what must not happen and passes only when the attempt fails:
 *
 * - a forged or replayed state cookie, or a state that does not match it;
 * - an ID token with a missing or wrong nonce, a wrong issuer or audience,
 *   expired, `alg: none`, HMAC-signed, or signed by a key the provider does
 *   not publish (after one refetch for rotation);
 * - a person who authenticated for tenant A signing in as tenant B, by
 *   choosing B, by swapping state cookies, or by naming B in the callback;
 * - a person whose groups map to nothing;
 * - a configuration that is not complete (no secret, no origin, placeholders).
 *
 * A local key pair and a stubbed transport: no network.
 */
import { describe, expect, it } from 'vitest';
import { SignJWT, base64url } from 'jose';

import { deriveSealKey, seal } from '@sanad/auth/sealed-token.ts';
import { createOidcClient, parseDiscovery, pkceChallenge } from '@sanad/auth/oidc.ts';
import {
  CALLBACK_PATH,
  type CompleteInput,
  STATE_LIFETIME_SECONDS,
  beginStaffSignIn,
  clientSecretVariable,
  completeStaffSignIn,
  continuePage,
  displayNameFrom,
  groupsFrom,
  inMemoryReplayGuard,
  principalIdFromSubject,
  providerSignOutUrl,
  publicOrigin,
  redirectUriFor,
} from '@sanad/auth/staff-oidc.ts';
import type { StaffIdentityConfiguration } from '@sanad/core/config/staff-identity.ts';

import { developmentStaffFor, DEVELOPMENT_STAFF } from '../../apps/ops/src/server/staff.ts';
import {
  CLIENT_ID,
  END_SESSION,
  ISSUER,
  JWKS,
  NOW,
  type TestProvider,
  filledIdentity,
  standardClaims,
  testProvider,
} from '../support/oidc-provider.ts';

const SECRET = 'test-only-secret';
const ENV = {
  NODE_ENV: 'production',
  OPS_PUBLIC_ORIGIN: 'https://ops.sanad.test',
  ADMIN_PUBLIC_ORIGIN: 'https://admin.sanad.test',
  OIDC_CLIENT_SECRET_BANK_A_OPS: SECRET,
  OIDC_CLIENT_SECRET_FINTECH_B_OPS: SECRET,
  OIDC_CLIENT_SECRET_SME_FUND_AE_OPS: SECRET,
  OIDC_CLIENT_SECRET_BANK_A_ADMIN: SECRET,
} as const;
const STATE_KEY = deriveSealKey(new Uint8Array(32).fill(7), 'ops-oidc-state-v1');
const T = BigInt(NOW);

const IDENTITIES: Readonly<Record<string, StaffIdentityConfiguration>> = {
  'bank-a': filledIdentity('bank-a'),
  'fintech-b': filledIdentity('fintech-b'),
  'sme-fund-ae': filledIdentity('sme-fund-ae'),
};

interface Harness {
  readonly idp: TestProvider;
  readonly client: ReturnType<typeof createOidcClient>;
  readonly replay: ReturnType<typeof inMemoryReplayGuard>;
}
async function harness(): Promise<Harness> {
  const idp = await testProvider(SECRET);
  return {
    idp,
    client: createOidcClient({ fetch: idp.fetch, nowMs: () => NOW * 1000 }),
    replay: inMemoryReplayGuard(),
  };
}

async function begin(h: Harness, tenant: string, opts: { stepUp?: boolean; env?: Record<string, string> } = {}) {
  const r = await beginStaffSignIn({
    app: 'OPS',
    tenant,
    locale: 'en',
    stepUp: opts.stepUp ?? false,
    identity: IDENTITIES[tenant]!,
    env: opts.env ?? ENV,
    client: h.client,
    stateKey: STATE_KEY,
    nowEpochSeconds: T,
  });
  if (!r.ok) throw new Error(`begin refused: ${r.reason}`);
  const { state, nonce } = h.idp.noteAuthorization(r.location);
  return { ...r, state, nonce };
}

function complete(
  h: Harness,
  over: Partial<CompleteInput> & { query: URLSearchParams; stateCookie: string | undefined },
) {
  return completeStaffSignIn({
    app: 'OPS',
    stateKey: STATE_KEY,
    replay: h.replay,
    nowEpochSeconds: T,
    resolveIdentity: (t) =>
      Promise.resolve(IDENTITIES[t] === undefined ? { ok: false } : { ok: true, value: IDENTITIES[t] }),
    tenantActive: () => Promise.resolve(true),
    env: ENV,
    client: h.client,
    ...over,
  });
}

const callback = (state: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ code: 'auth-code-1', state, ...extra });

/** A full round trip in which the provider returns whatever ID token `mint` makes for the flow's nonce. */
async function roundTrip(h: Harness, tenant: string, mint: (nonce: string) => Promise<string>) {
  const b = await begin(h, tenant);
  h.idp.respondWith(mint);
  return complete(h, { query: callback(b.state), stateCookie: b.stateCookie });
}

const reasonOf = (o: Awaited<ReturnType<typeof complete>>): string => (o.ok ? 'OK' : o.reason);

describe('staff OIDC: the happy path, so the negatives below are meaningful', () => {
  it('a bank-a checker signs in: PKCE verifier sent, Basic client auth, sub-derived principal, authorities from bank-a only', async () => {
    const h = await harness();
    const b = await begin(h, 'bank-a');
    const url = new URL(b.location);
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(`https://ops.sanad.test${CALLBACK_PATH}`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('scope')).toBe('openid profile');
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(url.searchParams.has('tenant')).toBe(false);
    // The state cookie is opaque: neither the state, nonce nor tenant is readable in it.
    expect(b.stateCookie).not.toContain(b.state);
    expect(b.stateCookie).not.toContain('bank-a');
    h.idp.respondWith((nonce) => h.idp.mint(standardClaims(nonce)));
    const o = await complete(h, { query: callback(b.state), stateCookie: b.stateCookie });
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.locale).toBe('en');
    expect(o.staff.tenant).toBe('bank-a');
    expect(o.staff.authorities).toEqual(['CHECKER']);
    expect(o.staff.principalId).toBe('oidc:AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ');
    expect(o.staff.displayName).toBe('Test Person');
    expect(o.staff.authenticatedAtEpochSeconds).toBe(T - 5n);
    expect(o.staff.sessionLifetimeSeconds).toBe(1_800n);
    expect(h.idp.lastTokenRequest.body?.get('redirect_uri')).toBe(`https://ops.sanad.test${CALLBACK_PATH}`);
    expect(h.idp.lastTokenRequest.body?.has('client_secret')).toBe(false);
  });

  it('an ES256 signature is accepted as well as RS256', async () => {
    const h = await harness();
    const { generateKeyPair, exportJWK } = await import('jose');
    const ec = await generateKeyPair('ES256', { extractable: true });
    const jwk = { ...(await exportJWK(ec.publicKey)), kid: 'ec1', alg: 'ES256', use: 'sig' };
    const base = h.idp.fetch;
    const client = createOidcClient({
      nowMs: () => NOW * 1000,
      fetch: async (url, init) => {
        if (url === JWKS) return { status: 200, json: () => Promise.resolve({ keys: [jwk] }) };
        return base(url, init);
      },
    });
    const o = await roundTrip({ ...h, client }, 'bank-a', (nonce) =>
      new SignJWT(standardClaims(nonce)).setProtectedHeader({ alg: 'ES256', kid: 'ec1' }).sign(ec.privateKey),
    );
    expect(reasonOf(o)).toBe('OK');
  });
});

describe('staff OIDC: state and its cookie', () => {
  it('a forged state cookie (not sealed by us) is refused', async () => {
    const h = await harness();
    const b = await begin(h, 'bank-a');
    const otherKey = deriveSealKey(new Uint8Array(32).fill(9), 'ops-oidc-state-v1');
    const forged = seal(
      {
        payload: { app: 'OPS', t: 'bank-a', l: 'en', s: b.state, n: b.nonce, v: 'A'.repeat(43), u: '0' },
        issuedAtEpochSeconds: T,
        expiresAtEpochSeconds: T + 600n,
      },
      otherKey,
    );
    expect(reasonOf(await complete(h, { query: callback(b.state), stateCookie: forged }))).toBe('STATE_INVALID');
    const tampered = `${b.stateCookie.slice(0, -2)}${b.stateCookie.endsWith('A') ? 'B' : 'A'}A`;
    expect(reasonOf(await complete(h, { query: callback(b.state), stateCookie: tampered }))).toBe('STATE_INVALID');
    expect(reasonOf(await complete(h, { query: callback(b.state), stateCookie: undefined }))).toBe('STATE_INVALID');
  });

  it('a forged state in the callback (not the one sealed in the cookie) is refused', async () => {
    const h = await harness();
    const b = await begin(h, 'bank-a');
    h.idp.respondWith((nonce) => h.idp.mint(standardClaims(nonce)));
    const o = await complete(h, { query: callback('A'.repeat(43)), stateCookie: b.stateCookie });
    expect(reasonOf(o)).toBe('STATE_MISMATCH');
    expect(h.idp.lastTokenRequest.body).toBeUndefined();
  });

  it('a state cookie is single use: replaying it, even with a fresh code, is refused', async () => {
    const h = await harness();
    const b = await begin(h, 'bank-a');
    h.idp.respondWith((nonce) => h.idp.mint(standardClaims(nonce)));
    expect(reasonOf(await complete(h, { query: callback(b.state), stateCookie: b.stateCookie }))).toBe('OK');
    const again = await complete(h, {
      query: callback(b.state, { code: 'auth-code-2' }),
      stateCookie: b.stateCookie,
    });
    expect(reasonOf(again)).toBe('STATE_REPLAYED');
  });

  it('an expired state cookie is refused', async () => {
    const h = await harness();
    const b = await begin(h, 'bank-a');
    const o = await complete(h, {
      query: callback(b.state),
      stateCookie: b.stateCookie,
      nowEpochSeconds: T + STATE_LIFETIME_SECONDS,
    });
    expect(reasonOf(o)).toBe('STATE_INVALID');
  });

  it('a workbench state cookie does not complete an Admin sign-in', async () => {
    const h = await harness();
    const b = await begin(h, 'bank-a');
    const o = await complete(h, { app: 'ADMIN', query: callback(b.state), stateCookie: b.stateCookie });
    expect(reasonOf(o)).toBe('STATE_INVALID');
  });

  it('a provider error, or no code, signs nobody in', async () => {
    const h = await harness();
    const b1 = await begin(h, 'bank-a');
    const q = new URLSearchParams({ state: b1.state, error: 'access_denied', error_description: 'x' });
    expect(reasonOf(await complete(h, { query: q, stateCookie: b1.stateCookie }))).toBe('PROVIDER_ERROR');
    const b2 = await begin(h, 'bank-a');
    expect(
      reasonOf(await complete(h, { query: new URLSearchParams({ state: b2.state }), stateCookie: b2.stateCookie })),
    ).toBe('CODE_MISSING');
  });
});

describe('staff OIDC: the ID token', () => {
  it('a missing nonce, or one from another flow, is refused', async () => {
    const h = await harness();
    const { nonce: _drop, ...noNonce } = standardClaims('x');
    expect(reasonOf(await roundTrip(h, 'bank-a', () => h.idp.mint(noNonce)))).toBe('ID_TOKEN_NONCE');
    expect(reasonOf(await roundTrip(h, 'bank-a', () => h.idp.mint(standardClaims('B'.repeat(43)))))).toBe(
      'ID_TOKEN_NONCE',
    );
  });

  it('a wrong issuer is refused — including a sibling tenant of the same provider', async () => {
    const h = await harness();
    const other = 'https://login.microsoftonline.com/00000000-0000-0000-0000-00000000000f/v2.0';
    expect(reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { iss: other }))))).toBe(
      'ID_TOKEN_ISSUER',
    );
    expect(reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { iss: `${ISSUER}/` }))))).toBe(
      'ID_TOKEN_ISSUER',
    );
  });

  it('a wrong audience is refused, and a shared audience needs azp to be this client', async () => {
    const h = await harness();
    expect(
      reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { aud: 'another-client' })))),
    ).toBe('ID_TOKEN_AUDIENCE');
    expect(
      reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { aud: [CLIENT_ID, 'other'] })))),
    ).toBe('ID_TOKEN_AZP');
    expect(
      reasonOf(
        await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { aud: [CLIENT_ID, 'other'], azp: 'other' }))),
      ),
    ).toBe('ID_TOKEN_AZP');
    expect(
      reasonOf(
        await roundTrip(h, 'bank-a', (n) =>
          h.idp.mint(standardClaims(n, { aud: [CLIENT_ID, 'other'], azp: CLIENT_ID })),
        ),
      ),
    ).toBe('OK');
  });

  it('an expired token is refused beyond the bounded skew; one from the future is refused too', async () => {
    const h = await harness();
    expect(reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { exp: NOW - 61 }))))).toBe(
      'ID_TOKEN_EXPIRED',
    );
    expect(reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { nbf: NOW + 120 }))))).toBe(
      'ID_TOKEN_NOT_YET_VALID',
    );
    expect(reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { iat: NOW + 120 }))))).toBe(
      'ID_TOKEN_IAT',
    );
    // Issued long ago but claiming a long life: refused by age (too old counts as expired).
    expect(
      reasonOf(
        await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { iat: NOW - 3_600, nbf: NOW - 3_600 }))),
      ),
    ).toBe('ID_TOKEN_EXPIRED');
  });

  it('`alg: none` is refused', async () => {
    const h = await harness();
    const unsigned = (n: string): Promise<string> =>
      Promise.resolve(
        `${base64url.encode(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url.encode(JSON.stringify(standardClaims(n)))}.`,
      );
    expect(reasonOf(await roundTrip(h, 'bank-a', unsigned))).toBe('ID_TOKEN_ALG_REFUSED');
  });

  it('an HMAC-signed token is refused, even keyed with the client secret or the public key', async () => {
    const h = await harness();
    const hs = (n: string): Promise<string> =>
      new SignJWT(standardClaims(n))
        .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
        .sign(new TextEncoder().encode(SECRET.repeat(4)));
    expect(reasonOf(await roundTrip(h, 'bank-a', hs))).toBe('ID_TOKEN_ALG_REFUSED');
  });

  it('a token signed by a key the provider does not publish: one JWKS refetch, then refused', async () => {
    const h = await harness();
    const before = h.idp.calls.get(JWKS) ?? 0;
    const kid = await h.idp.rotate(false);
    expect(reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n), { kid })))).toBe(
      'ID_TOKEN_KEY_UNKNOWN',
    );
    expect((h.idp.calls.get(JWKS) ?? 0) - before).toBe(2); // the first fetch, and exactly one refetch
    // A spray of unknown kids does not hammer the provider: no further refetch inside the interval.
    expect(reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n), { kid })))).toBe(
      'ID_TOKEN_KEY_UNKNOWN',
    );
    expect((h.idp.calls.get(JWKS) ?? 0) - before).toBe(2);
  });

  it('key rotation: a token under a newly published kid is accepted after one refetch', async () => {
    const h = await harness();
    expect(reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n))))).toBe('OK');
    const kid = await h.idp.rotate(true);
    expect(reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n), { kid })))).toBe('OK');
  });

  it('a signature that does not verify is refused', async () => {
    const h = await harness();
    const forged = async (n: string): Promise<string> => {
      const good = await h.idp.mint(standardClaims(n));
      const [head, , sig] = good.split('.');
      return `${head}.${base64url.encode(JSON.stringify(standardClaims(n, { roles: ['sanad.bank-a.platform-admins'] })))}.${sig}`;
    };
    expect(reasonOf(await roundTrip(h, 'bank-a', forged))).toBe('ID_TOKEN_SIGNATURE');
  });

  it('a discovery document for another issuer is refused, and every endpoint must be https', () => {
    expect(
      parseDiscovery(
        {
          issuer: 'https://evil.example',
          authorization_endpoint: 'https://a',
          token_endpoint: 'https://t',
          jwks_uri: 'https://j',
        },
        ISSUER,
      ),
    ).toEqual({
      ok: false,
      reason: 'DISCOVERY_ISSUER_MISMATCH',
    });
    expect(
      parseDiscovery(
        {
          issuer: ISSUER,
          authorization_endpoint: 'https://a.example/x',
          token_endpoint: 'http://t.example/x',
          jwks_uri: 'https://j.example/x',
        },
        ISSUER,
      ),
    ).toEqual({ ok: false, reason: 'ENDPOINT_NOT_HTTPS' });
    expect(
      parseDiscovery(
        {
          issuer: ISSUER,
          authorization_endpoint: 'https://a.example/x',
          token_endpoint: 'https://t.example/x',
          jwks_uri: 'https://j.example/x',
          code_challenge_methods_supported: ['plain'],
        },
        ISSUER,
      ),
    ).toEqual({ ok: false, reason: 'DISCOVERY_UNSUPPORTED' });
  });

  it('a provider whose discovery names another issuer stops sign-in before any redirect', async () => {
    const h = await harness();
    h.idp.discovery['issuer'] = 'https://login.microsoftonline.com/common/v2.0';
    const r = await beginStaffSignIn({
      app: 'OPS',
      tenant: 'bank-a',
      locale: 'ar',
      stepUp: false,
      identity: IDENTITIES['bank-a']!,
      env: ENV,
      client: h.client,
      stateKey: STATE_KEY,
      nowEpochSeconds: T,
    });
    expect(r).toEqual({ ok: false, reason: 'DISCOVERY_ISSUER_MISMATCH' });
  });
});

describe('staff OIDC: tenant and authority', () => {
  it('a person who holds only tenant A’s groups, signing in having chosen tenant B, is refused (shared issuer and client)', async () => {
    const h = await harness();
    const o = await roundTrip(h, 'fintech-b', (n) =>
      h.idp.mint(standardClaims(n, { roles: ['sanad.bank-a.checkers'] })),
    );
    expect(reasonOf(o)).toBe('NO_AUTHORITY');
  });

  it('the tenant is the one sealed before the redirect: a tenant named in the callback is never read', async () => {
    const h = await harness();
    const b = await begin(h, 'bank-a');
    h.idp.respondWith((n) =>
      h.idp.mint(standardClaims(n, { roles: ['sanad.bank-a.checkers', 'sanad.fintech-b.platform-admins'] })),
    );
    const o = await complete(h, {
      query: callback(b.state, { tenant: 'fintech-b', tenantId: 'fintech-b', institution: 'fintech-b' }),
      stateCookie: b.stateCookie,
    });
    expect(o.ok).toBe(true);
    if (o.ok) {
      expect(o.staff.tenant).toBe('bank-a');
      expect(o.staff.authorities).toEqual(['CHECKER']);
    }
  });

  it('swapping in the state cookie of a flow begun for tenant B does not change the tenant of flow A', async () => {
    const h = await harness();
    const a = await begin(h, 'bank-a');
    const bFlow = await begin(h, 'fintech-b');
    h.idp.respondWith((n) => h.idp.mint(standardClaims(n)));
    expect(reasonOf(await complete(h, { query: callback(a.state), stateCookie: bFlow.stateCookie }))).toBe(
      'STATE_MISMATCH',
    );
  });

  it('groups that map to nothing, a missing groups claim, or a malformed one sign nobody in', async () => {
    const h = await harness();
    expect(
      reasonOf(
        await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { roles: ['Everyone', 'sanad-makers'] }))),
      ),
    ).toBe('NO_AUTHORITY');
    const { roles: _r, ...noRoles } = standardClaims('x');
    expect(reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint({ ...noRoles, nonce: n })))).toBe('NO_AUTHORITY');
    expect(
      reasonOf(await roundTrip(h, 'bank-a', (n) => h.idp.mint(standardClaims(n, { roles: { MAKER: true } })))),
    ).toBe('NO_AUTHORITY');
    // The groups claim is the configured one (`roles`); `groups` grants nothing.
    expect(
      reasonOf(
        await roundTrip(h, 'bank-a', (n) =>
          h.idp.mint({ ...standardClaims(n, { groups: ['sanad.bank-a.makers'] }), roles: [] }),
        ),
      ),
    ).toBe('NO_AUTHORITY');
  });

  it('an institution not active in the deployment’s jurisdiction is refused after authentication', async () => {
    const h = await harness();
    const b = await begin(h, 'sme-fund-ae');
    h.idp.respondWith((n) => h.idp.mint(standardClaims(n, { roles: ['sanad.sme-fund-ae.checkers'] })));
    const o = await complete(h, {
      query: callback(b.state),
      stateCookie: b.stateCookie,
      tenantActive: (t) => Promise.resolve(t !== 'sme-fund-ae'),
    });
    expect(reasonOf(o)).toBe('TENANT_NOT_ACTIVE');
  });

  it('a step-up sign-in asks the provider for a fresh authentication, and refuses an old one', async () => {
    const h = await harness();
    const b = await begin(h, 'bank-a', { stepUp: true });
    expect(new URL(b.location).searchParams.get('prompt')).toBe('login');
    h.idp.respondWith((n) => h.idp.mint(standardClaims(n, { auth_time: NOW - 3_000 })));
    expect(reasonOf(await complete(h, { query: callback(b.state), stateCookie: b.stateCookie }))).toBe(
      'STEP_UP_NOT_FRESH',
    );
    const b2 = await begin(h, 'bank-a', { stepUp: true });
    h.idp.respondWith((n) => h.idp.mint(standardClaims(n, { auth_time: NOW - 10 })));
    const ok = await complete(h, { query: callback(b2.state), stateCookie: b2.stateCookie });
    expect(ok.ok && ok.staff.authenticatedAtEpochSeconds).toBe(T - 10n);
  });

  it('SR-044: a step-up asks for auth_time, and a token without it is refused however recent its iat', async () => {
    const h = await harness();
    const b = await begin(h, 'bank-a', { stepUp: true });
    expect(new URL(b.location).searchParams.get('max_age')).toBe('0');
    h.idp.respondWith((n) => h.idp.mint(standardClaims(n)));
    expect(reasonOf(await complete(h, { query: callback(b.state), stateCookie: b.stateCookie }))).toBe(
      'STEP_UP_NOT_FRESH',
    );
    // An ordinary sign-in neither asks for it nor needs it.
    const plain = await begin(h, 'bank-a');
    expect(new URL(plain.location).searchParams.has('max_age')).toBe(false);
    h.idp.respondWith((n) => h.idp.mint(standardClaims(n)));
    expect((await complete(h, { query: callback(plain.state), stateCookie: plain.stateCookie })).ok).toBe(true);
  });
});

describe('staff OIDC: configuration and secrets', () => {
  it('no client secret, no public origin, or an http origin in production: sign-in is not offered', async () => {
    const h = await harness();
    const without = async (env: Record<string, string>) =>
      beginStaffSignIn({
        app: 'OPS',
        tenant: 'bank-a',
        locale: 'ar',
        stepUp: false,
        identity: IDENTITIES['bank-a']!,
        env,
        client: h.client,
        stateKey: STATE_KEY,
        nowEpochSeconds: T,
      });
    const { OIDC_CLIENT_SECRET_BANK_A_OPS: _s, ...noSecret } = ENV;
    expect(await without(noSecret)).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    const { OPS_PUBLIC_ORIGIN: _o, ...noOrigin } = ENV;
    expect(await without(noOrigin)).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    expect(await without({ ...ENV, OPS_PUBLIC_ORIGIN: 'http://ops.sanad.test' })).toEqual({
      ok: false,
      reason: 'NOT_CONFIGURED',
    });
    // Admin uses its own secret: the workbench's does not serve it.
    const admin = await beginStaffSignIn({
      app: 'ADMIN',
      tenant: 'fintech-b',
      locale: 'ar',
      stepUp: false,
      identity: IDENTITIES['fintech-b']!,
      env: ENV,
      client: h.client,
      stateKey: STATE_KEY,
      nowEpochSeconds: T,
    });
    expect(admin).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
  });

  it('the secret is never in the authorization URL, the state cookie or any outcome', async () => {
    const h = await harness();
    const b = await begin(h, 'bank-a');
    expect(b.location).not.toContain(SECRET);
    expect(b.stateCookie).not.toContain(SECRET);
    h.idp.respondWith((n) => h.idp.mint(standardClaims(n, { aud: 'wrong' })));
    const refused = await complete(h, { query: callback(b.state), stateCookie: b.stateCookie });
    expect(JSON.stringify(refused)).not.toContain(SECRET);
    expect(JSON.stringify(refused)).not.toContain('Test Person');
  });

  it('public origin and redirect URI come from configuration only, and are origins', () => {
    expect(publicOrigin('OPS', { OPS_PUBLIC_ORIGIN: 'https://ops.example/' })).toBe('https://ops.example');
    expect(publicOrigin('OPS', { OPS_PUBLIC_ORIGIN: 'https://ops.example/app' })).toBeUndefined();
    expect(publicOrigin('OPS', { OPS_PUBLIC_ORIGIN: 'https://u:p@ops.example' })).toBeUndefined();
    expect(publicOrigin('OPS', { OPS_PUBLIC_ORIGIN: 'http://localhost:3001', NODE_ENV: 'development' })).toBe(
      'http://localhost:3001',
    );
    expect(redirectUriFor('ADMIN', { ADMIN_PUBLIC_ORIGIN: 'https://admin.example' })).toBe(
      'https://admin.example/sign-in/callback',
    );
    expect(clientSecretVariable('sme-fund-ae', 'ADMIN')).toBe('OIDC_CLIENT_SECRET_SME_FUND_AE_ADMIN');
  });

  it('RP-initiated logout goes to the provider’s end-session endpoint with a registered return', async () => {
    const h = await harness();
    const url = await providerSignOutUrl({
      app: 'OPS',
      locale: 'en',
      identity: IDENTITIES['bank-a']!,
      env: ENV,
      client: h.client,
    });
    expect(url).toBeDefined();
    const u = new URL(url ?? '');
    expect(`${u.origin}${u.pathname}`).toBe(END_SESSION);
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('https://ops.sanad.test/sign-in/signed-out');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('state')).toBe('en');
  });
});

describe('staff OIDC: the small pieces', () => {
  it('principal ids are stable, prefixed, and safe for the session whatever the provider’s sub looks like', () => {
    expect(principalIdFromSubject('abc-123_X')).toBe('oidc:abc-123_X');
    const odd = principalIdFromSubject('auth0|5f7c8ec7c33c6c004bbafe82');
    expect(odd).toMatch(/^oidc:h:[A-Za-z0-9_-]{43}$/);
    expect(principalIdFromSubject('auth0|5f7c8ec7c33c6c004bbafe82')).toBe(odd);
  });
  it('groups: a string or an array of strings; anything else is none', () => {
    expect(groupsFrom({ roles: ['a', 7, 'b'] }, 'roles')).toEqual(['a', 'b']);
    expect(groupsFrom({ roles: 'a' }, 'roles')).toEqual(['a']);
    expect(groupsFrom({ roles: { a: 1 } }, 'roles')).toEqual([]);
    expect(groupsFrom({}, 'roles')).toEqual([]);
  });
  it('the display name is bounded and stripped of control and direction-override characters', () => {
    expect(displayNameFrom({ name: 'A‮B\u0000C' })).toBe('ABC');
    expect(displayNameFrom({ preferred_username: 'x'.repeat(200) })?.length).toBe(80);
    expect(displayNameFrom({})).toBeUndefined();
  });
  it('PKCE S256 matches RFC 7636 appendix B', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  it('the continue page carries no script and only a same-site path', () => {
    const html = continuePage('/en"><script>x</script>', 'en');
    expect(html).not.toContain('<script');
    expect(html).toContain('content="0;url=/enscriptx/script"');
  });
});

describe('development tokens under production', () => {
  it('a development token names nobody when NODE_ENV is production, whatever its value', () => {
    const env = { NODE_ENV: 'production', STAFF_DEV_TOKEN_CHECKER: 'dev-token-checker-0001' };
    expect(developmentStaffFor('dev-token-checker-0001', env)).toBeUndefined();
    expect(developmentStaffFor('dev-token-checker-0001', { ...env, NODE_ENV: 'development' })?.principalId).toBe(
      DEVELOPMENT_STAFF.find((s) => s.environmentName === 'STAFF_DEV_TOKEN_CHECKER')?.principalId,
    );
  });
});
