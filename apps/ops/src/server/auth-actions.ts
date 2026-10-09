'use server';

/**
 * Sign in and sign out of the workbench.
 *
 * Production: the institution's single sign-on by OpenID Connect
 * (single-sign-on.ts). The person picks their institution; it is sealed
 * server-side into the state cookie before the redirect, and on the way back
 * the principal's tenant is that sealed one and its authorities come only from
 * that tenant's mappings. Sign-out clears the session and, where the provider
 * publishes an end-session endpoint, signs out there too.
 *
 * Development: a staff token from the local environment, compared by digest in
 * constant time against the one registry (staff.ts); its person's authorities
 * come from the tenant's staff identity configuration in force, and so does the
 * session's lifetime (bounded to an hour regardless). Refused outright when
 * NODE_ENV is production. The token is read once and never echoed into a
 * redirect, a log or an error.
 */

import { redirect } from 'next/navigation';

import { resolveStaffIdentity } from '@sanad/origination/staff-identity.ts';

import { developmentStaffFor, developmentTokensPermitted, principalFor } from './staff.ts';
import {
  currentStaffSession,
  endStaffSession,
  localeSegmentOf,
  signInPath,
  startStaffSession,
  tenantActive,
} from './session.ts';
import { beginSingleSignOn, providerSignOut } from './single-sign-on.ts';
import { epochNow } from './staff-session.ts';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

export async function signInAction(form: FormData): Promise<void> {
  const locale = localeSegmentOf(field(form, 'locale'));
  if (!developmentTokensPermitted()) redirect(signInPath(locale, 'DEVELOPMENT_SIGN_IN_REFUSED'));
  const staff = developmentStaffFor(field(form, 'token'));
  if (staff === undefined) redirect(signInPath(locale, 'SIGN_IN_REFUSED'));
  const resolved = await resolveStaffIdentity(staff.tenantId, epochNow());
  const principal = principalFor(staff, resolved.identity);
  if (principal === undefined) redirect(signInPath(locale, 'SIGN_IN_REFUSED'));
  if (!(await tenantActive(principal.tenantId))) redirect(signInPath(locale, 'TENANT_NOT_ACTIVE'));
  await startStaffSession(
    principal,
    resolved.identity.ok ? BigInt(resolved.identity.value.sessionLifetimeSeconds) : undefined,
  );
  redirect(`/${locale}`);
}

/**
 * Begin single sign-on at the chosen institution's identity provider. The
 * `institution` field is a choice made before authentication: it only selects
 * whose provider and mappings apply, and it must be one the page lists.
 */
export async function singleSignOnAction(form: FormData): Promise<void> {
  const locale = localeSegmentOf(field(form, 'locale'));
  const begun = await beginSingleSignOn(field(form, 'institution'), locale, field(form, 'stepUp') === '1');
  if (!begun.ok) redirect(signInPath(locale, begun.reason));
  redirect(begun.location);
}

export async function signOutAction(form: FormData): Promise<void> {
  const locale = localeSegmentOf(field(form, 'locale'));
  const session = await currentStaffSession();
  await endStaffSession();
  if (session?.method === 'OIDC') {
    const atProvider = await providerSignOut(session.principal.tenantId, locale);
    if (atProvider !== undefined) redirect(atProvider);
  }
  redirect(signInPath(locale, 'SIGNED_OUT'));
}
