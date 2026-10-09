/**
 * Admin's single sign-on by OpenID Connect: the same flow and checks as the
 * workbench (packages/auth/staff-oidc.ts), with Admin's own client secret
 * (OIDC_CLIENT_SECRET_<TENANT>_ADMIN), public origin (ADMIN_PUBLIC_ORIGIN),
 * state key and cookies. A person is an administrator only when the chosen
 * institution's mappings grant PLATFORM_ADMIN from their groups; any other
 * authority they hold signs nobody in here.
 *
 * Redirect URI: `<ADMIN_PUBLIC_ORIGIN>/sign-in/callback`. Nothing here logs.
 */

import { cookies } from 'next/headers';

import { isTenantCode } from '@sanad/config/loader.ts';
import { type OidcClient, createOidcClient } from '@sanad/auth/oidc.ts';
import {
  CALLBACK_PATH,
  STATE_LIFETIME_SECONDS,
  type StaffSignInRefusal,
  type StateReplayGuard,
  beginStaffSignIn,
  completeStaffSignIn,
  continuePage,
  inMemoryReplayGuard,
  providerSignOutUrl,
  signInLocale,
} from '@sanad/auth/staff-oidc.ts';
import { deploymentJurisdiction } from '@sanad/origination/jurisdiction.ts';
import { resolveStaffIdentity, singleSignOnInstitutions } from '@sanad/origination/staff-identity.ts';

import { adminStateSealKey, now, startAdminSession } from './session.ts';

export const ADMIN_SSO_STATE_COOKIE = 'sanad_admin_sso';

/** The notices the sign-in page words. */
export type AdminSignInNotice =
  | 'SIGN_IN_REFUSED'
  | 'SSO_FAILED'
  | 'SSO_UNAVAILABLE'
  | 'TENANT_NOT_ACTIVE'
  | 'SIGNED_OUT'
  | 'DEVELOPMENT_SIGN_IN_REFUSED';

interface Shared {
  client?: OidcClient;
  replay?: StateReplayGuard;
}
const shared: Shared = ((globalThis as { __sanadAdminSso?: Shared }).__sanadAdminSso ??= {});

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
  const resolved = await resolveStaffIdentity(tenant, now());
  return resolved.identity.ok ? { ok: true as const, value: resolved.identity.value } : { ok: false as const };
}

async function active(tenant: string): Promise<boolean> {
  if (!isTenantCode(tenant)) return false;
  return (await deploymentJurisdiction()).activeTenants.includes(tenant);
}

export type BeginResult =
  | { readonly ok: true; readonly location: string }
  | { readonly ok: false; readonly notice: AdminSignInNotice };

export async function beginSingleSignOn(tenantChoice: string, locale: string): Promise<BeginResult> {
  const listed = await singleSignOnInstitutions(now());
  const institution = listed.find((x) => x.tenant === tenantChoice);
  if (institution === undefined) return { ok: false, notice: 'SSO_UNAVAILABLE' };
  const identity = await identityOf(institution.tenant);
  if (!identity.ok) return { ok: false, notice: 'SSO_UNAVAILABLE' };
  const begun = await beginStaffSignIn({
    app: 'ADMIN',
    tenant: institution.tenant,
    locale: signInLocale(locale),
    stepUp: false,
    identity: identity.value,
    env: process.env,
    client: ssoClient(),
    stateKey: adminStateSealKey(),
    nowEpochSeconds: now(),
  });
  if (!begun.ok) return { ok: false, notice: begun.reason === 'NOT_CONFIGURED' ? 'SSO_UNAVAILABLE' : 'SSO_FAILED' };
  const jar = await cookies();
  jar.set(ADMIN_SSO_STATE_COOKIE, begun.stateCookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: production(),
    path: CALLBACK_PATH,
    maxAge: Number(STATE_LIFETIME_SECONDS),
  });
  return { ok: true, location: begun.location };
}

export function noticeFor(refusal: StaffSignInRefusal | 'NOT_ADMINISTRATOR'): AdminSignInNotice {
  if (refusal === 'NO_AUTHORITY' || refusal === 'NOT_ADMINISTRATOR') return 'SIGN_IN_REFUSED';
  if (refusal === 'TENANT_NOT_ACTIVE') return 'TENANT_NOT_ACTIVE';
  if (refusal === 'NOT_CONFIGURED') return 'SSO_UNAVAILABLE';
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
  const stateCookie = jar.get(ADMIN_SSO_STATE_COOKIE)?.value;
  jar.set(ADMIN_SSO_STATE_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: production(),
    path: CALLBACK_PATH,
    maxAge: 0,
  });
  const outcome = await completeStaffSignIn({
    app: 'ADMIN',
    query: new URL(request.url).searchParams,
    stateCookie,
    stateKey: adminStateSealKey(),
    replay: ssoReplayGuard(),
    nowEpochSeconds: now(),
    resolveIdentity: identityOf,
    tenantActive: active,
    env: process.env,
    client: ssoClient(),
  });
  if (!outcome.ok) return seeOther(`/${outcome.locale}?notice=${noticeFor(outcome.reason)}`);
  const s = outcome.staff;
  if (!s.authorities.includes('PLATFORM_ADMIN'))
    return seeOther(`/${outcome.locale}?notice=${noticeFor('NOT_ADMINISTRATOR')}`);
  await startAdminSession(s.principalId, s.sessionLifetimeSeconds, {
    method: 'OIDC',
    tenantId: s.tenant,
    authenticatedAtEpochSeconds: s.authenticatedAtEpochSeconds,
    ...(s.displayName === undefined ? {} : { displayName: s.displayName }),
  });
  return new Response(continuePage(`/${outcome.locale}/credentials`, outcome.locale), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

export async function providerSignOut(tenant: string, locale: string): Promise<string | undefined> {
  const identity = await identityOf(tenant);
  if (!identity.ok) return undefined;
  return providerSignOutUrl({
    app: 'ADMIN',
    locale: signInLocale(locale),
    identity: identity.value,
    env: process.env,
    client: ssoClient(),
  });
}

/** GET /sign-in/signed-out: the provider returns here after RP-initiated logout; `state` carries the locale. */
export function signedOut(request: Request): Response {
  const locale = signInLocale(new URL(request.url).searchParams.get('state') ?? undefined);
  return seeOther(`/${locale}?notice=SIGNED_OUT`);
}
