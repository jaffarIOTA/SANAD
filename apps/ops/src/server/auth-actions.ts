'use server';

/**
 * Sign in and sign out of the workbench.
 *
 * Development: a staff token from the local environment, compared by digest in
 * constant time against the one registry (staff.ts); its person's authorities
 * come from the tenant's staff identity configuration in force, and so does the
 * session's lifetime (bounded to an hour regardless). Refused outright when
 * NODE_ENV is production: production staff sign in through the institution's
 * SSO, which is not built. The token is read once and never echoed into a
 * redirect, a log or an error.
 */

import { redirect } from 'next/navigation';

import { resolveStaffIdentity } from '@sanad/origination/staff-identity.ts';

import { developmentStaffFor, developmentTokensPermitted, principalFor } from './staff.ts';
import { endStaffSession, localeSegmentOf, signInPath, startStaffSession, tenantActive } from './session.ts';
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

export async function signOutAction(form: FormData): Promise<void> {
  await endStaffSession();
  redirect(signInPath(field(form, 'locale'), 'SIGNED_OUT'));
}
