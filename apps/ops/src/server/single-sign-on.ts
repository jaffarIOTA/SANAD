/**
 * The workbench's single sign-on by OpenID Connect: the app's side of
 * packages/auth/staff-oidc.ts — the cookies, the redirect and the callback.
 *
 * - `beginSingleSignOn` seals the chosen institution, the locale, state,
 *   nonce and the PKCE verifier into a short-lived cookie that only the
 *   callback path receives (HttpOnly, SameSite=Lax so the provider's
 *   top-level redirect back carries it, Secure in production) and returns the
 *   provider's authorization URL.
 * - `completeSingleSignOn` is the callback (GET /sign-in/callback). It clears
 *   the state cookie whatever happens, validates everything, and issues the
 *   ordinary sealed staff session with the authentication time recorded.
 *
 * The redirect URI and the post-logout URI are built from OPS_PUBLIC_ORIGIN,
 * never from the Host header. The client secret is
 * OIDC_CLIENT_SECRET_<TENANT>_OPS, read server-side only. Nothing here logs.
 */

import { cookies } from 'next/headers';

import { type TenantCode, isTenantCode } from '@sanad/config/loader.ts';
import { type OidcClient, createOidcClient } from '@sanad/auth/oidc.ts';
import {
  CALLBACK_PATH,
  STATE_LIFETIME_SECONDS,
  type SignInLocale,
  type StaffSignInRefusal,
  type StateReplayGuard,
  beginStaffSignIn,
  completeStaffSignIn,
  continuePage,
  inMemoryReplayGuard,
  providerSignOutUrl,
  signInLocale,
} from '@sanad/auth/staff-oidc.ts';
import { resolveStaffIdentity, singleSignOnInstitutions } from '@sanad/origination/staff-identity.ts';

import type { SignInReason } from './session.ts';
import { STAFF_SESSION_COOKIE, epochNow, issueStaffSession, staffStateSealKey } from './staff-session.ts';
import { deploymentJurisdiction } from '@sanad/origination/jurisdiction.ts';

export const SSO_STATE_COOKIE = 'sanad_ops_sso';

interface Shared {
  client?: OidcClient;
  replay?: StateReplayGuard;
}
const shared: Shared = ((globalThis as { __sanadOpsSso?: Shared }).__sanadOpsSso ??= {});

/** The relying party (its discovery and JWK set caches) and the replay guard, process-wide. Tests replace them. */
export function ssoClient(): OidcClient {
  shared.client ??= createOidcClient();
  return shared.client;
}
export function ssoReplayGuard(): StateReplayGuard {
  shared.replay ??= inMemoryReplayGuard();
  return shared.replay;
}
export function setSsoDependencies(d: { readonly client?: OidcClient; readonly replay?: StateReplayGuard }): void {
  if (d.client !== undefined) shared.client = d.client;
  if (d.replay !== undefined) shared.replay = d.replay;
}

const production = (): boolean => process.env['NODE_ENV'] === 'production';

async function identityOf(tenant: string) {
  if (!isTenantCode(tenant)) return { ok: false as const };
  const resolved = await resolveStaffIdentity(tenant, epochNow());
  return resolved.identity.ok ? { ok: true as const, value: resolved.identity.value } : { ok: false as const };
}

async function active(tenant: string): Promise<boolean> {
  if (!isTenantCode(tenant)) return false;
  return (await deploymentJurisdiction()).activeTenants.includes(tenant);
}

export type BeginResult =
  { readonly ok: true; readonly location: string } | { readonly ok: false; readonly reason: SignInReason };

/**
 * Start sign-in at the chosen institution's provider. The institution must be
 * one the sign-in page lists (active here, configured for OIDC); a tampered
 * choice is refused like an unconfigured one.
 */
export async function beginSingleSignOn(tenantChoice: string, locale: string, stepUp: boolean): Promise<BeginResult> {
  const listed = await singleSignOnInstitutions(epochNow());
  const institution = listed.find((x) => x.tenant === tenantChoice);
  if (institution === undefined) return { ok: false, reason: 'SSO_UNAVAILABLE' };
  const identity = await identityOf(institution.tenant);
  if (!identity.ok) return { ok: false, reason: 'SSO_UNAVAILABLE' };
  const begun = await beginStaffSignIn({
    app: 'OPS',
    tenant: institution.tenant,
    locale: signInLocale(locale),
    stepUp,
    identity: identity.value,
    env: process.env,
    client: ssoClient(),
    stateKey: staffStateSealKey(),
    nowEpochSeconds: epochNow(),
  });
  if (!begun.ok) return { ok: false, reason: begun.reason === 'NOT_CONFIGURED' ? 'SSO_UNAVAILABLE' : 'SSO_FAILED' };
  const jar = await cookies();
  jar.set(SSO_STATE_COOKIE, begun.stateCookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: production(),
    path: CALLBACK_PATH,
    maxAge: Number(STATE_LIFETIME_SECONDS),
  });
  return { ok: true, location: begun.location };
}

/** The reason the sign-in page shows. A person whose groups grant nothing gets the same words as a refused token. */
export function reasonFor(refusal: StaffSignInRefusal): SignInReason {
  if (refusal === 'NO_AUTHORITY') return 'SIGN_IN_REFUSED';
  if (refusal === 'TENANT_NOT_ACTIVE') return 'TENANT_NOT_ACTIVE';
  if (refusal === 'NOT_CONFIGURED') return 'SSO_UNAVAILABLE';
  if (refusal === 'STEP_UP_NOT_FRESH') return 'STEP_UP_REQUIRED';
  return 'SSO_FAILED';
}

const seeOther = (location: string): Response =>
  new Response(null, {
    status: 303,
    headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });

/** GET /sign-in/callback. */
export async function completeSingleSignOn(request: Request): Promise<Response> {
  const jar = await cookies();
  const stateCookie = jar.get(SSO_STATE_COOKIE)?.value;
  // Single use: gone from the browser whatever the outcome, and consumed server-side by the replay guard.
  jar.set(SSO_STATE_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: production(),
    path: CALLBACK_PATH,
    maxAge: 0,
  });
  const now = epochNow();
  const outcome = await completeStaffSignIn({
    app: 'OPS',
    query: new URL(request.url).searchParams,
    stateCookie,
    stateKey: staffStateSealKey(),
    replay: ssoReplayGuard(),
    nowEpochSeconds: now,
    resolveIdentity: identityOf,
    tenantActive: active,
    env: process.env,
    client: ssoClient(),
  });
  if (!outcome.ok) return seeOther(`/${outcome.locale}/sign-in?reason=${reasonFor(outcome.reason)}`);
  const s = outcome.staff;
  const issued = issueStaffSession(
    { principalId: s.principalId, tenantId: s.tenant as TenantCode, authorities: s.authorities },
    s.sessionLifetimeSeconds,
    now,
    {
      method: 'OIDC',
      authenticatedAtEpochSeconds: s.authenticatedAtEpochSeconds,
      ...(s.displayName === undefined ? {} : { displayName: s.displayName }),
    },
  );
  jar.set(STAFF_SESSION_COOKIE, issued.token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: production(),
    path: '/',
    maxAge: Number(issued.lifetimeSeconds),
  });
  return new Response(continuePage(`/${outcome.locale}`, outcome.locale), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** Where to send the browser after the local session is cleared: the provider's end-session endpoint, when it has one. */
export async function providerSignOut(tenant: TenantCode, locale: string): Promise<string | undefined> {
  const identity = await identityOf(tenant);
  if (!identity.ok) return undefined;
  return providerSignOutUrl({
    app: 'OPS',
    locale: signInLocale(locale),
    identity: identity.value,
    env: process.env,
    client: ssoClient(),
  });
}

/** GET /sign-in/signed-out: the provider returns here after RP-initiated logout; `state` carries the locale. */
export function signedOut(request: Request): Response {
  const locale: SignInLocale = signInLocale(new URL(request.url).searchParams.get('state') ?? undefined);
  return seeOther(`/${locale}/sign-in?reason=SIGNED_OUT`);
}
