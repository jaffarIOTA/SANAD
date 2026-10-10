/**
 * Staff sign-in by OpenID Connect, for the operations workbench and Admin.
 *
 * Framework-free: no cookie API, no router. The apps supply the cookie, the
 * clock, the tenant's staff identity configuration and the environment; this
 * module decides. So a test drives the whole flow with a local key pair and a
 * stubbed transport, and both apps run exactly the same checks.
 *
 * - Before the redirect: the person picks an institution. The tenant, the
 *   locale, `state`, `nonce` and the PKCE verifier are sealed into a short-
 *   lived cookie (AES-256-GCM, packages/auth/sealed-token.ts) that only the
 *   callback path receives.
 * - At the callback: the sealed cookie is opened and consumed (single use);
 *   `state` must equal the sealed one; the code is exchanged with the
 *   verifier; the ID token is validated (packages/auth/oidc.ts). The tenant is
 *   the sealed one — a tenant in the query or a form is never read — and the
 *   authorities come only from that tenant's mappings applied to the groups
 *   claim it names. A person whose groups map to nothing does not sign in.
 * - The principal id is derived from the stable `sub` claim. A display name
 *   (name, else preferred_username) is returned for the screen only.
 *
 * The client secret is read from the environment, server-side, under a name
 * derived from the tenant and the app (the hosting injects it from its key
 * vault). It is never logged, returned or placed in an outcome.
 */

import { createHash } from 'node:crypto';

import {
  type StaffAuthority,
  type StaffIdentityConfiguration,
  authoritiesFor,
} from '@sanad/core/config/staff-identity.ts';

import { type OidcClient, type OidcRefusal, authorizationUrl, endSessionUrl, randomToken } from './oidc.ts';
import { type SealKey, open, seal } from './sealed-token.ts';
import { type SpentTokens, inMemorySpentTokens } from './spent-tokens.ts';

export type StaffApp = 'OPS' | 'ADMIN';
type Env = Readonly<Record<string, string | undefined>>;

/** The redirect URI path, the same for both apps and both locales; the locale travels in the sealed state. */
export const CALLBACK_PATH = '/sign-in/callback';
/** Where the provider returns the browser after RP-initiated logout. */
export const SIGNED_OUT_PATH = '/sign-in/signed-out';
/** The state cookie lives this long: long enough to sign in at the provider, no longer. */
export const STATE_LIFETIME_SECONDS = 600n;
const LOCALES = ['ar', 'en'] as const;
export type SignInLocale = (typeof LOCALES)[number];
export const signInLocale = (raw: string | undefined): SignInLocale =>
  (LOCALES as readonly string[]).includes(raw ?? '') ? (raw as SignInLocale) : 'ar';

/** `OIDC_CLIENT_SECRET_<TENANT>_<APP>`, upper snake case: `bank-a` + OPS → `OIDC_CLIENT_SECRET_BANK_A_OPS`. */
export const clientSecretVariable = (tenant: string, app: StaffApp): string =>
  `OIDC_CLIENT_SECRET_${tenant.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${app}`;
export const publicOriginVariable = (app: StaffApp): string =>
  app === 'OPS' ? 'OPS_PUBLIC_ORIGIN' : 'ADMIN_PUBLIC_ORIGIN';

/**
 * The app's public origin, from configuration — never from the Host header,
 * which the browser (or anything in front of the app) controls. https in
 * production; an origin only (no path, query or credentials).
 */
export function publicOrigin(app: StaffApp, env: Env): string | undefined {
  const raw = env[publicOriginVariable(app)]?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const production = env['NODE_ENV'] === 'production';
  if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) return undefined;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return undefined;
  if (url.pathname !== '/' && url.pathname !== '') return undefined;
  return url.origin;
}

export const redirectUriFor = (app: StaffApp, env: Env): string | undefined => {
  const origin = publicOrigin(app, env);
  return origin === undefined ? undefined : `${origin}${CALLBACK_PATH}`;
};

const clientSecret = (tenant: string, app: StaffApp, env: Env): string | undefined => {
  const v = env[clientSecretVariable(tenant, app)]?.trim();
  return v === undefined || v.length === 0 ? undefined : v;
};

/**
 * The principal id for a subject: `oidc:` and the `sub` claim itself where it
 * is a plain token; otherwise a stable digest of it (a provider may use any
 * characters up to 255). Either way the same person gets the same id at every
 * sign-in, which is what four eyes compares.
 */
export function principalIdFromSubject(sub: string): string {
  if (/^[A-Za-z0-9._-]{1,120}$/.test(sub)) return `oidc:${sub}`;
  return `oidc:h:${createHash('sha256').update(sub, 'utf8').digest('base64url')}`;
}

/** The groups the configured claim carries. Anything other than a string or an array of strings carries none. */
export function groupsFrom(claims: Readonly<Record<string, unknown>>, claim: string): readonly string[] {
  const v = claims[claim];
  if (typeof v === 'string') return v.length > 0 && v.length <= 256 ? [v] : [];
  if (!Array.isArray(v) || v.length > 1_000) return [];
  return v.filter((g): g is string => typeof g === 'string' && g.length > 0 && g.length <= 256);
}

/** A name for the screen only: name, else preferred_username; control characters removed, bounded. */
export function displayNameFrom(claims: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ['name', 'preferred_username']) {
    const v = claims[key];
    if (typeof v !== 'string') continue;
    // eslint-disable-next-line no-control-regex
    const clean = v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim();
    if (clean.length > 0) return clean.slice(0, 80);
  }
  return undefined;
}

// -- The sealed state ------------------------------------------------------------------

/** app · t tenant · l locale · s state · n nonce · v PKCE verifier · u step-up. */
type StatePayload = {
  readonly app: StaffApp;
  readonly t: string;
  readonly l: SignInLocale;
  readonly s: string;
  readonly n: string;
  readonly v: string;
  readonly u: '0' | '1';
};
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const isStatePayload = (p: Readonly<Record<string, unknown>>): p is StatePayload & Record<string, string> =>
  Object.keys(p).length === 7 &&
  (p['app'] === 'OPS' || p['app'] === 'ADMIN') &&
  typeof p['t'] === 'string' &&
  /^[a-z][a-z0-9-]{1,40}$/.test(p['t']) &&
  (p['l'] === 'ar' || p['l'] === 'en') &&
  typeof p['s'] === 'string' &&
  TOKEN.test(p['s']) &&
  typeof p['n'] === 'string' &&
  TOKEN.test(p['n']) &&
  typeof p['v'] === 'string' &&
  TOKEN.test(p['v']) &&
  (p['u'] === '0' || p['u'] === '1');

/**
 * Consumed states, so a state cookie (copied, or replayed by a browser) opens
 * exactly once. Over spent tokens shared by every replica (SR-043); in memory,
 * one process's.
 */
export interface StateReplayGuard {
  /** True the first time a state is presented before it expires; false ever after. */
  consume(state: string, expiresAtEpochSeconds: bigint): Promise<boolean>;
}

export const stateReplayGuard = (spent: SpentTokens, app: StaffApp): StateReplayGuard => ({
  consume: (state, expiresAt) => spent.spend(app === 'ADMIN' ? 'ADMIN_OIDC_STATE' : 'OPS_OIDC_STATE', state, expiresAt),
});

export const inMemoryReplayGuard = (): StateReplayGuard => stateReplayGuard(inMemorySpentTokens(), 'OPS');

// -- Begin -------------------------------------------------------------------------------

/** Why staff sign-in by OIDC did not happen. Typed codes; never a claim, token or secret. */
export type StaffSignInRefusal =
  | 'NOT_CONFIGURED'
  | 'STATE_INVALID'
  | 'STATE_REPLAYED'
  | 'STATE_MISMATCH'
  | 'PROVIDER_ERROR'
  | 'CODE_MISSING'
  | 'NO_AUTHORITY'
  | 'TENANT_NOT_ACTIVE'
  | 'STEP_UP_NOT_FRESH'
  | OidcRefusal;

export type BeginOutcome =
  | { readonly ok: true; readonly location: string; readonly stateCookie: string }
  | { readonly ok: false; readonly reason: StaffSignInRefusal };

export interface BeginInput {
  readonly app: StaffApp;
  readonly tenant: string;
  readonly locale: SignInLocale;
  /** Force a fresh authentication at the provider: a step-up before an approval. */
  readonly stepUp: boolean;
  readonly identity: StaffIdentityConfiguration;
  readonly env: Env;
  readonly client: OidcClient;
  readonly stateKey: SealKey;
  readonly nowEpochSeconds: bigint;
}

/** The provider's authorization URL and the sealed state cookie to set before sending the browser there. */
export async function beginStaffSignIn(i: BeginInput): Promise<BeginOutcome> {
  const p = i.identity.provider;
  const redirectUri = redirectUriFor(i.app, i.env);
  if (
    p.protocol !== 'OIDC' ||
    p.metadataUrl === undefined ||
    p.clientId === undefined ||
    redirectUri === undefined ||
    clientSecret(i.tenant, i.app, i.env) === undefined
  )
    return { ok: false, reason: 'NOT_CONFIGURED' };
  const metadata = await i.client.discover(p.metadataUrl, p.issuer);
  if (!metadata.ok) return metadata;
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  const payload: StatePayload = {
    app: i.app,
    t: i.tenant,
    l: i.locale,
    s: state,
    n: nonce,
    v: verifier,
    u: i.stepUp ? '1' : '0',
  };
  const stateCookie = seal(
    {
      payload,
      issuedAtEpochSeconds: i.nowEpochSeconds,
      expiresAtEpochSeconds: i.nowEpochSeconds + STATE_LIFETIME_SECONDS,
    },
    i.stateKey,
  );
  const location = authorizationUrl(metadata.value, {
    clientId: p.clientId,
    redirectUri,
    state,
    nonce,
    codeVerifier: verifier,
    forceAuthentication: i.stepUp,
  });
  return { ok: true, location, stateCookie };
}

// -- Complete ----------------------------------------------------------------------------

export interface SignedInStaff {
  readonly tenant: string;
  readonly principalId: string;
  readonly displayName?: string;
  readonly authorities: readonly StaffAuthority[];
  /** When the person authenticated at the provider: auth_time when asserted, else the token's iat. */
  readonly authenticatedAtEpochSeconds: bigint;
  readonly sessionLifetimeSeconds: bigint;
}

export type CompleteOutcome =
  | { readonly ok: true; readonly locale: SignInLocale; readonly staff: SignedInStaff }
  | { readonly ok: false; readonly locale: SignInLocale; readonly reason: StaffSignInRefusal };

export interface CompleteInput {
  readonly app: StaffApp;
  /** The callback's query string. Only `state`, `code` and `error` are read from it. */
  readonly query: URLSearchParams;
  readonly stateCookie: string | undefined;
  readonly stateKey: SealKey;
  readonly replay: StateReplayGuard;
  readonly nowEpochSeconds: bigint;
  /** The tenant's staff identity configuration in force (approved revision, else file). */
  readonly resolveIdentity: (
    tenant: string,
  ) => Promise<{ readonly ok: true; readonly value: StaffIdentityConfiguration } | { readonly ok: false }>;
  readonly tenantActive: (tenant: string) => Promise<boolean>;
  readonly env: Env;
  readonly client: OidcClient;
}

const STEP_UP_FRESH_SECONDS = 120n;

export async function completeStaffSignIn(i: CompleteInput): Promise<CompleteOutcome> {
  const raw = i.stateCookie;
  if (raw === undefined || raw.length === 0 || raw.length > 4096)
    return { ok: false, locale: 'ar', reason: 'STATE_INVALID' };
  const opened = open(raw, i.stateKey, i.nowEpochSeconds, STATE_LIFETIME_SECONDS, isStatePayload);
  if (opened.kind !== 'VALID' || opened.value.payload.app !== i.app)
    return { ok: false, locale: 'ar', reason: 'STATE_INVALID' };
  const sealed = opened.value.payload;
  const locale = sealed.l;
  const no = (reason: StaffSignInRefusal): CompleteOutcome => ({ ok: false, locale, reason });
  if (!(await i.replay.consume(sealed.s, opened.value.expiresAtEpochSeconds))) return no('STATE_REPLAYED');
  const presentedState = i.query.get('state') ?? '';
  if (presentedState !== sealed.s) return no('STATE_MISMATCH');
  if (i.query.get('error') !== null) return no('PROVIDER_ERROR');
  const code = i.query.get('code') ?? '';
  if (code.length === 0 || code.length > 4096) return no('CODE_MISSING');

  // The tenant is the one sealed before the redirect. Nothing in the query names it.
  const tenant = sealed.t;
  const identity = await i.resolveIdentity(tenant);
  if (!identity.ok) return no('NOT_CONFIGURED');
  const p = identity.value.provider;
  const redirectUri = redirectUriFor(i.app, i.env);
  const secret = clientSecret(tenant, i.app, i.env);
  if (
    p.protocol !== 'OIDC' ||
    p.metadataUrl === undefined ||
    p.clientId === undefined ||
    redirectUri === undefined ||
    secret === undefined
  )
    return no('NOT_CONFIGURED');
  const metadata = await i.client.discover(p.metadataUrl, p.issuer);
  if (!metadata.ok) return no(metadata.reason);
  const verified = await i.client.exchangeCode({
    metadata: metadata.value,
    clientId: p.clientId,
    clientSecret: secret,
    redirectUri,
    code,
    codeVerifier: sealed.v,
    expectations: {
      issuer: p.issuer,
      clientId: p.clientId,
      nonce: sealed.n,
      nowEpochSeconds: Number(i.nowEpochSeconds),
    },
  });
  if (!verified.ok) return no(verified.reason);

  const authorities = authoritiesFor(groupsFrom(verified.value.claims, p.groupsClaim), identity.value);
  if (authorities.length === 0) return no('NO_AUTHORITY');
  if (!(await i.tenantActive(tenant))) return no('TENANT_NOT_ACTIVE');
  // A step-up asked for max_age, so the provider owes auth_time: without it the token's issue time would say
  // only when a token was minted, perhaps from an old sign-in, and freshness cannot be established (SR-044).
  if (sealed.u === '1' && verified.value.authTimeEpochSeconds === undefined) return no('STEP_UP_NOT_FRESH');
  const authenticatedAt = BigInt(verified.value.authTimeEpochSeconds ?? verified.value.issuedAtEpochSeconds);
  if (sealed.u === '1' && i.nowEpochSeconds - authenticatedAt > STEP_UP_FRESH_SECONDS) return no('STEP_UP_NOT_FRESH');
  const displayName = displayNameFrom(verified.value.claims);
  return {
    ok: true,
    locale,
    staff: {
      tenant,
      principalId: principalIdFromSubject(verified.value.subject),
      ...(displayName === undefined ? {} : { displayName }),
      authorities,
      authenticatedAtEpochSeconds: authenticatedAt > i.nowEpochSeconds ? i.nowEpochSeconds : authenticatedAt,
      sessionLifetimeSeconds: BigInt(identity.value.sessionLifetimeSeconds),
    },
  };
}

// -- Sign out ----------------------------------------------------------------------------

/** The provider's end-session URL for this tenant's provider, or undefined (then the local sign-out is all there is). */
export async function providerSignOutUrl(i: {
  readonly app: StaffApp;
  readonly locale: SignInLocale;
  readonly identity: StaffIdentityConfiguration;
  readonly env: Env;
  readonly client: OidcClient;
}): Promise<string | undefined> {
  const p = i.identity.provider;
  const origin = publicOrigin(i.app, i.env);
  if (p.protocol !== 'OIDC' || p.metadataUrl === undefined || p.clientId === undefined || origin === undefined)
    return undefined;
  const metadata = await i.client.discover(p.metadataUrl, p.issuer);
  if (!metadata.ok) return undefined;
  return endSessionUrl(metadata.value, p.clientId, `${origin}${SIGNED_OUT_PATH}`, i.locale);
}

/**
 * The page the callback answers with on success. A document, not a redirect:
 * the session cookie is SameSite=Strict, and a browser does not send it on a
 * redirect chain that began at another site (the provider). Navigating from
 * this same-site page does send it.
 */
export function continuePage(destination: string, locale: SignInLocale): string {
  const safe = destination.replace(/[^A-Za-z0-9/_-]/g, '');
  const words = locale === 'ar' ? 'المتابعة' : 'Continue';
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  return `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${safe}"><title>Sanad</title></head><body><p><a href="${safe}">${words}</a></p></body></html>`;
}
