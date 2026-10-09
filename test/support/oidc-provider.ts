/**
 * A stand-in OpenID provider for tests: a local key pair, a discovery
 * document, a JWK set that can be rotated, and a token endpoint that checks
 * the PKCE verifier and the client's Basic credentials before minting the ID
 * token the test asks for. No network: it is an `OidcFetch`.
 */

import { createHash } from 'node:crypto';

import { type JWK, type JWTPayload, SignJWT, exportJWK, generateKeyPair } from 'jose';

import type { OidcFetch } from '@sanad/auth/oidc.ts';
import { parseStaffIdentity, type StaffIdentityConfiguration } from '@sanad/core/config/staff-identity.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import bankA from '@sanad/config/tenants/bank-a/identity/staff-identity.json' with { type: 'json' };
import fintechB from '@sanad/config/tenants/fintech-b/identity/staff-identity.json' with { type: 'json' };
import fundAe from '@sanad/config/tenants/sme-fund-ae/identity/staff-identity.json' with { type: 'json' };

export const ENTRA_TENANT = '00000000-0000-0000-0000-000000000001';
export const CLIENT_ID = '00000000-0000-0000-0000-000000000002';
export const ISSUER = `https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0`;
export const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
export const AUTHORIZE = `https://login.microsoftonline.com/${ENTRA_TENANT}/oauth2/v2.0/authorize`;
export const TOKEN = `https://login.microsoftonline.com/${ENTRA_TENANT}/oauth2/v2.0/token`;
export const JWKS = `https://login.microsoftonline.com/${ENTRA_TENANT}/discovery/v2.0/keys`;
export const END_SESSION = `https://login.microsoftonline.com/${ENTRA_TENANT}/oauth2/v2.0/logout`;
type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

/** A fixed clock, in seconds. */
export const NOW = 1_800_000_000;

/** The checked-in tenant files with the hosted environment's placeholders filled in. */
const FILES = { 'bank-a': bankA, 'fintech-b': fintechB, 'sme-fund-ae': fundAe } as const;
export function filledIdentity(tenant: keyof typeof FILES): StaffIdentityConfiguration {
  const filled: unknown = JSON.parse(
    JSON.stringify(FILES[tenant]).replaceAll('<ENTRA_TENANT_ID>', ENTRA_TENANT).replaceAll('<ENTRA_CLIENT_ID>', CLIENT_ID),
  );
  return expectOk(parseStaffIdentity(filled, 'DEPLOYED'));
}

export interface TestProvider {
  readonly fetch: OidcFetch;
  /** How many times each URL was fetched. */
  readonly calls: Map<string, number>;
  /** Sign an ID token with the current key (or another one) for the nonce the flow sent. */
  mint(claims: JWTPayload, opts?: { readonly kid?: string; readonly key?: SigningKey; readonly alg?: string }): Promise<string>;
  /** What the token endpoint returns next: a function of the nonce the authorization request carried. */
  respondWith(f: (nonce: string) => Promise<string>): void;
  /** Rotate: a new signing key with a new kid, published (or not yet) in the JWK set. */
  rotate(publish: boolean): Promise<string>;
  /** The nonce the last authorization URL carried (set by `noteAuthorization`). */
  noteAuthorization(location: string): { readonly state: string; readonly nonce: string };
  readonly lastTokenRequest: { body?: URLSearchParams; authorization?: string | undefined };
  discovery: Record<string, unknown>;
}

export async function testProvider(secret: string): Promise<TestProvider> {
  const calls = new Map<string, number>();
  const keys: { kid: string; privateKey: SigningKey; jwk: JWK; published: boolean }[] = [];
  const addKey = async (kid: string, published: boolean): Promise<void> => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
    keys.push({ kid, privateKey, jwk, published });
  };
  await addKey('k1', true);
  let current = 'k1';
  let challenge = '';
  let nonce = '';
  let respond: (n: string) => Promise<string> = () => Promise.reject(new Error('no token configured'));
  const lastTokenRequest: { body?: URLSearchParams; authorization?: string | undefined } = {};
  const discovery: Record<string, unknown> = {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZE,
    token_endpoint: TOKEN,
    jwks_uri: JWKS,
    end_session_endpoint: END_SESSION,
    response_types_supported: ['code', 'id_token', 'code id_token'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'private_key_jwt', 'client_secret_basic'],
    id_token_signing_alg_values_supported: ['RS256'],
  };
  const json = (status: number, body: unknown) => ({ status, json: () => Promise.resolve(body) });
  const provider: TestProvider = {
    calls,
    lastTokenRequest,
    discovery,
    fetch: async (url, init) => {
      calls.set(url, (calls.get(url) ?? 0) + 1);
      if (url === DISCOVERY && init.method === 'GET') return json(200, provider.discovery);
      if (url === JWKS && init.method === 'GET') return json(200, { keys: keys.filter((k) => k.published).map((k) => k.jwk) });
      if (url === TOKEN && init.method === 'POST') {
        const body = new URLSearchParams(init.body ?? '');
        lastTokenRequest.body = body;
        lastTokenRequest.authorization = init.headers['authorization'];
        const expectedBasic = `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(secret)}`).toString('base64')}`;
        if (init.headers['authorization'] !== expectedBasic) return json(401, { error: 'invalid_client' });
        const verifier = body.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== challenge) return json(400, { error: 'invalid_grant' });
        if (body.get('grant_type') !== 'authorization_code' || body.get('code') === null)
          return json(400, { error: 'invalid_request' });
        return json(200, { token_type: 'Bearer', id_token: await respond(nonce), access_token: 'opaque' });
      }
      return json(404, {});
    },
    async mint(claims, opts = {}) {
      const kid = opts.kid ?? current;
      const key = opts.key ?? keys.find((k) => k.kid === kid)?.privateKey ?? keys[0]!.privateKey;
      return new SignJWT(claims).setProtectedHeader({ alg: opts.alg ?? 'RS256', kid, typ: 'JWT' }).sign(key);
    },
    respondWith(f) {
      respond = f;
    },
    async rotate(publish) {
      const kid = `k${String(keys.length + 1)}`;
      await addKey(kid, publish);
      current = kid;
      return kid;
    },
    noteAuthorization(location) {
      const u = new URL(location);
      challenge = u.searchParams.get('code_challenge') ?? '';
      nonce = u.searchParams.get('nonce') ?? '';
      return { state: u.searchParams.get('state') ?? '', nonce };
    },
  };
  return provider;
}

/** A valid ID token's claims for a bank-a checker, for the nonce the flow sent; `over` changes any of them. */
export function standardClaims(nonce: string, over: JWTPayload = {}): JWTPayload {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ',
    iat: NOW - 5,
    nbf: NOW - 5,
    exp: NOW + 3_600,
    nonce,
    name: 'Test Person',
    roles: ['sanad.bank-a.checkers'],
    ...over,
  };
}
