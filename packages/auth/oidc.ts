/**
 * An OpenID Connect relying party: authorization code flow with PKCE (S256),
 * `state` and `nonce`, discovery, a cached JWK set, and ID token validation.
 *
 * Generic OIDC (OpenID Connect Core 1.0, Discovery 1.0, RP-Initiated Logout
 * 1.0, RFC 7636). No provider's vocabulary lives here; an institution plugs in
 * its own provider by configuration (its issuer, discovery URL and client id).
 *
 * The JOSE cryptography is the `jose` library's: signature against the JWK
 * set, an explicit algorithm allow-list (RS256 and ES256 only — `none` and the
 * HMAC algorithms are refused before any key is looked up), and iss, aud, exp,
 * nbf and iat with a bounded clock tolerance. What this module adds: exact
 * issuer equality between configuration, discovery and token; azp when the
 * audience is shared; nonce equality; the JWK set cache with one refetch on
 * an unknown key id; and https for every endpoint.
 *
 * Nothing here logs, and no outcome carries a token, a claim value or a
 * secret: a refusal is a typed reason code only.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { type JSONWebKeySet, type JWTPayload, createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

/** The algorithms an ID token may be signed with. Asymmetric only. */
export const ID_TOKEN_ALGORITHMS = ['RS256', 'ES256'] as const;
/** Clock skew tolerated on exp, nbf and iat. */
export const CLOCK_SKEW_SECONDS = 60;
/** An ID token older than this (by iat) is refused, however long it claims to live. */
export const ID_TOKEN_MAX_AGE = 600;
const METADATA_TTL_MS = 3_600_000;
const JWKS_TTL_MS = 3_600_000;
/** An unknown kid refetches the JWK set at most this often, so a spray of made-up kids cannot hammer the provider. */
const JWKS_REFETCH_MIN_INTERVAL_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;

export type OidcRefusal =
  | 'DISCOVERY_FAILED'
  | 'DISCOVERY_ISSUER_MISMATCH'
  | 'DISCOVERY_UNSUPPORTED'
  | 'ENDPOINT_NOT_HTTPS'
  | 'JWKS_FAILED'
  | 'TOKEN_EXCHANGE_FAILED'
  | 'ID_TOKEN_MISSING'
  | 'ID_TOKEN_MALFORMED'
  | 'ID_TOKEN_ALG_REFUSED'
  | 'ID_TOKEN_KEY_UNKNOWN'
  | 'ID_TOKEN_SIGNATURE'
  | 'ID_TOKEN_ISSUER'
  | 'ID_TOKEN_AUDIENCE'
  | 'ID_TOKEN_AZP'
  | 'ID_TOKEN_EXPIRED'
  | 'ID_TOKEN_NOT_YET_VALID'
  | 'ID_TOKEN_IAT'
  | 'ID_TOKEN_NONCE'
  | 'ID_TOKEN_SUBJECT';

export type OidcResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: OidcRefusal };
const refuse = (reason: OidcRefusal): OidcResult<never> => ({ ok: false, reason });

/** The transport. Production is `fetch` with no redirects and a timeout; tests stub it, with no network. */
export type OidcFetch = (
  url: string,
  init: { readonly method: 'GET' | 'POST'; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

export const httpsFetch: OidcFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    redirect: 'error',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
};

export interface ProviderMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly endSessionEndpoint?: string;
  readonly tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post';
}

export interface VerifiedIdToken {
  readonly subject: string;
  readonly claims: Readonly<JWTPayload>;
  readonly issuedAtEpochSeconds: number;
  /** The provider's auth_time, when it asserts one. */
  readonly authTimeEpochSeconds?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isHttps = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^https:\/\/\S+$/.test(v)) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};
const equalText = (a: string, b: string): boolean => {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db) && a.length === b.length;
};

/** 256 bits from the CSPRNG, base64url: for state, nonce and the PKCE verifier (RFC 7636 §4.1: 43 characters). */
export const randomToken = (): string => randomBytes(32).toString('base64url');
/** RFC 7636 §4.2, S256. */
export const pkceChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url');

/** Parse a discovery document, refusing one whose issuer is not exactly the configured issuer. */
export function parseDiscovery(raw: unknown, expectedIssuer: string): OidcResult<ProviderMetadata> {
  if (!isRecord(raw)) return refuse('DISCOVERY_FAILED');
  if (typeof raw['issuer'] !== 'string' || raw['issuer'] !== expectedIssuer) return refuse('DISCOVERY_ISSUER_MISMATCH');
  const endpoints = [raw['authorization_endpoint'], raw['token_endpoint'], raw['jwks_uri']];
  if (!endpoints.every(isHttps)) return refuse('ENDPOINT_NOT_HTTPS');
  const endSession = raw['end_session_endpoint'];
  if (endSession !== undefined && !isHttps(endSession)) return refuse('ENDPOINT_NOT_HTTPS');
  const responseTypes = raw['response_types_supported'];
  if (Array.isArray(responseTypes) && !responseTypes.includes('code')) return refuse('DISCOVERY_UNSUPPORTED');
  const challenge = raw['code_challenge_methods_supported'];
  if (Array.isArray(challenge) && !challenge.includes('S256')) return refuse('DISCOVERY_UNSUPPORTED');
  const methods = raw['token_endpoint_auth_methods_supported'];
  let method: ProviderMetadata['tokenEndpointAuthMethod'] = 'client_secret_basic';
  if (Array.isArray(methods) && !methods.includes('client_secret_basic')) {
    if (!methods.includes('client_secret_post')) return refuse('DISCOVERY_UNSUPPORTED');
    method = 'client_secret_post';
  }
  return {
    ok: true,
    value: {
      issuer: raw['issuer'],
      authorizationEndpoint: raw['authorization_endpoint'] as string,
      tokenEndpoint: raw['token_endpoint'] as string,
      jwksUri: raw['jwks_uri'] as string,
      ...(typeof endSession === 'string' ? { endSessionEndpoint: endSession } : {}),
      tokenEndpointAuthMethod: method,
    },
  };
}

export interface AuthorizationRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  /** Force a fresh authentication at the provider (a step-up). */
  readonly forceAuthentication?: boolean;
}

export function authorizationUrl(metadata: ProviderMetadata, r: AuthorizationRequest): string {
  const url = new URL(metadata.authorizationEndpoint);
  const params: Record<string, string> = {
    response_type: 'code',
    response_mode: 'query',
    client_id: r.clientId,
    redirect_uri: r.redirectUri,
    scope: 'openid profile',
    state: r.state,
    nonce: r.nonce,
    code_challenge: pkceChallenge(r.codeVerifier),
    code_challenge_method: 'S256',
    ...(r.forceAuthentication === true ? { prompt: 'login' } : {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/** RP-Initiated Logout 1.0: where to send the browser after the local session is gone, or undefined when the provider has no such endpoint. */
export function endSessionUrl(
  metadata: ProviderMetadata,
  clientId: string,
  postLogoutRedirectUri: string,
  state: string,
): string | undefined {
  if (metadata.endSessionEndpoint === undefined) return undefined;
  const url = new URL(metadata.endSessionEndpoint);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface IdTokenExpectations {
  readonly issuer: string;
  readonly clientId: string;
  readonly nonce: string;
  readonly nowEpochSeconds: number;
}

/** Map a jose failure to a reason. The error's message is never surfaced: it can quote a claim. */
function joseRefusal(e: unknown): OidcRefusal {
  const code = isRecord(e) && typeof e['code'] === 'string' ? e['code'] : '';
  const claim = isRecord(e) && typeof e['claim'] === 'string' ? e['claim'] : '';
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return 'ID_TOKEN_EXPIRED';
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return 'ID_TOKEN_ALG_REFUSED';
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return 'ID_TOKEN_KEY_UNKNOWN';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'ID_TOKEN_SIGNATURE';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (claim === 'iss') return 'ID_TOKEN_ISSUER';
      if (claim === 'aud') return 'ID_TOKEN_AUDIENCE';
      if (claim === 'nbf') return 'ID_TOKEN_NOT_YET_VALID';
      if (claim === 'iat') return 'ID_TOKEN_IAT';
      if (claim === 'sub') return 'ID_TOKEN_SUBJECT';
      if (claim === 'exp') return 'ID_TOKEN_EXPIRED';
      if (claim === 'nonce') return 'ID_TOKEN_NONCE';
      return 'ID_TOKEN_MALFORMED';
    default:
      return 'ID_TOKEN_MALFORMED';
  }
}

/** The claims the platform checks itself, after jose has checked signature, iss, aud, exp, nbf and iat. */
function checkClaims(payload: JWTPayload, x: IdTokenExpectations): OidcResult<VerifiedIdToken> {
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 255) return refuse('ID_TOKEN_SUBJECT');
  const iat = payload.iat;
  if (typeof iat !== 'number' || iat > x.nowEpochSeconds + CLOCK_SKEW_SECONDS) return refuse('ID_TOKEN_IAT');
  const nonce = payload['nonce'];
  if (typeof nonce !== 'string' || !equalText(nonce, x.nonce)) return refuse('ID_TOKEN_NONCE');
  const aud = payload.aud;
  const azp = payload['azp'];
  // OIDC Core §3.1.3.7: with several audiences azp is required and is this client; when present it is this client.
  if (Array.isArray(aud) && aud.length > 1 && azp === undefined) return refuse('ID_TOKEN_AZP');
  if (azp !== undefined && azp !== x.clientId) return refuse('ID_TOKEN_AZP');
  const authTime = payload['auth_time'];
  if (authTime !== undefined && (typeof authTime !== 'number' || authTime > x.nowEpochSeconds + CLOCK_SKEW_SECONDS))
    return refuse('ID_TOKEN_IAT');
  return {
    ok: true,
    value: {
      subject: sub,
      claims: payload,
      issuedAtEpochSeconds: iat,
      ...(typeof authTime === 'number' ? { authTimeEpochSeconds: authTime } : {}),
    },
  };
}

interface Cached<T> {
  readonly value: T;
  readonly fetchedAtMs: number;
}

export interface OidcClientOptions {
  readonly fetch?: OidcFetch;
  readonly nowMs?: () => number;
}

/**
 * A relying party with its caches: discovery documents and JWK sets per URL.
 * One per process is enough; tests make their own with a stubbed transport.
 */
export function createOidcClient(options: OidcClientOptions = {}) {
  const transport = options.fetch ?? httpsFetch;
  const nowMs = options.nowMs ?? Date.now;
  const metadataCache = new Map<string, Cached<ProviderMetadata>>();
  const jwksCache = new Map<string, Cached<JSONWebKeySet>>();
  const lastRefetchMs = new Map<string, number>();

  async function getJson(url: string): Promise<unknown> {
    const r = await transport(url, { method: 'GET', headers: { accept: 'application/json' } });
    if (r.status !== 200) throw new Error('unexpected status');
    return r.json();
  }

  async function discover(metadataUrl: string, expectedIssuer: string): Promise<OidcResult<ProviderMetadata>> {
    if (!isHttps(metadataUrl)) return refuse('ENDPOINT_NOT_HTTPS');
    const hit = metadataCache.get(metadataUrl);
    if (hit !== undefined && nowMs() - hit.fetchedAtMs < METADATA_TTL_MS && hit.value.issuer === expectedIssuer)
      return { ok: true, value: hit.value };
    let raw: unknown;
    try {
      raw = await getJson(metadataUrl);
    } catch {
      return refuse('DISCOVERY_FAILED');
    }
    const parsed = parseDiscovery(raw, expectedIssuer);
    if (parsed.ok) metadataCache.set(metadataUrl, { value: parsed.value, fetchedAtMs: nowMs() });
    return parsed;
  }

  async function fetchJwks(jwksUri: string): Promise<JSONWebKeySet | undefined> {
    try {
      const raw = await getJson(jwksUri);
      if (!isRecord(raw) || !Array.isArray(raw['keys'])) return undefined;
      const keys = raw as unknown as JSONWebKeySet;
      jwksCache.set(jwksUri, { value: keys, fetchedAtMs: nowMs() });
      return keys;
    } catch {
      return undefined;
    }
  }

  async function verifyWith(
    token: string,
    keys: JSONWebKeySet,
    x: IdTokenExpectations,
  ): Promise<OidcResult<VerifiedIdToken>> {
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(keys), {
        algorithms: [...ID_TOKEN_ALGORITHMS],
        issuer: x.issuer,
        audience: x.clientId,
        clockTolerance: CLOCK_SKEW_SECONDS,
        maxTokenAge: ID_TOKEN_MAX_AGE,
        requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub'],
        currentDate: new Date(x.nowEpochSeconds * 1000),
      });
      return checkClaims(payload, x);
    } catch (e) {
      return refuse(joseRefusal(e));
    }
  }

  /**
   * Validate an ID token: algorithm, signature, iss, aud, azp, exp, nbf, iat
   * and nonce. An unknown key id refetches the JWK set once (key rotation).
   */
  async function verifyIdToken(
    token: string,
    metadata: ProviderMetadata,
    x: IdTokenExpectations,
  ): Promise<OidcResult<VerifiedIdToken>> {
    let alg: unknown;
    try {
      alg = decodeProtectedHeader(token).alg;
    } catch {
      return refuse('ID_TOKEN_MALFORMED');
    }
    if (!(ID_TOKEN_ALGORITHMS as readonly unknown[]).includes(alg)) return refuse('ID_TOKEN_ALG_REFUSED');
    // The configured issuer is the one compared; discovery was already held to it.
    if (metadata.issuer !== x.issuer) return refuse('DISCOVERY_ISSUER_MISMATCH');
    const cached = jwksCache.get(metadata.jwksUri);
    let keys =
      cached !== undefined && nowMs() - cached.fetchedAtMs < JWKS_TTL_MS
        ? cached.value
        : await fetchJwks(metadata.jwksUri);
    if (keys === undefined) return refuse('JWKS_FAILED');
    const first = await verifyWith(token, keys, x);
    if (first.ok || first.reason !== 'ID_TOKEN_KEY_UNKNOWN') return first;
    const last = lastRefetchMs.get(metadata.jwksUri);
    if (last !== undefined && nowMs() - last < JWKS_REFETCH_MIN_INTERVAL_MS) return first;
    lastRefetchMs.set(metadata.jwksUri, nowMs());
    keys = await fetchJwks(metadata.jwksUri);
    if (keys === undefined) return refuse('JWKS_FAILED');
    return verifyWith(token, keys, x);
  }

  /** Exchange the code at the token endpoint (with the PKCE verifier) and validate the ID token it returns. */
  async function exchangeCode(input: {
    readonly metadata: ProviderMetadata;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly redirectUri: string;
    readonly code: string;
    readonly codeVerifier: string;
    readonly expectations: IdTokenExpectations;
  }): Promise<OidcResult<VerifiedIdToken>> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (input.metadata.tokenEndpointAuthMethod === 'client_secret_basic') {
      // RFC 6749 §2.3.1: each part form-encoded before Basic encoding.
      const user = encodeURIComponent(input.clientId);
      const pass = encodeURIComponent(input.clientSecret);
      headers['authorization'] = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
    } else {
      body.set('client_id', input.clientId);
      body.set('client_secret', input.clientSecret);
    }
    let raw: unknown;
    try {
      const r = await transport(input.metadata.tokenEndpoint, { method: 'POST', headers, body: body.toString() });
      if (r.status !== 200) return refuse('TOKEN_EXCHANGE_FAILED');
      raw = await r.json();
    } catch {
      return refuse('TOKEN_EXCHANGE_FAILED');
    }
    if (!isRecord(raw)) return refuse('TOKEN_EXCHANGE_FAILED');
    const idToken = raw['id_token'];
    if (typeof idToken !== 'string' || idToken.length === 0 || idToken.length > 16_384)
      return refuse('ID_TOKEN_MISSING');
    return verifyIdToken(idToken, input.metadata, input.expectations);
  }

  return { discover, verifyIdToken, exchangeCode };
}

export type OidcClient = ReturnType<typeof createOidcClient>;
