/**
 * Who the workbench is acting as: the signed-in member of staff.
 *
 * The principal is read from the sealed session cookie on the server — never
 * from a form, a header or a query string, because "who is approving this"
 * must not be something a browser can assert (BE-09). Every server action asks
 * `authorise()` for the principal it acts as; without a session it is sent to
 * sign in, and without the authority the act needs it is refused with a typed
 * reason. The tenant is the principal's own, and it must be one the deployment
 * jurisdiction has active.
 *
 * Four eyes is between people: the domain compares the principal ids of who
 * keyed and who checks, and each id is now one person's sign-in.
 */

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import type { TenantCode } from '@sanad/config/loader.ts';
import type { Principal } from '@sanad/core/origination/request.ts';
import { LOCALE_SEGMENTS, type LocaleSegment } from '@sanad/i18n/strings.ts';
import { deploymentJurisdiction } from '@sanad/origination/jurisdiction.ts';

import { type WorkbenchAct, permits } from './authority.ts';
import type { StaffPrincipal } from './staff.ts';
import { STAFF_SESSION_COOKIE, epochNow, issueStaffSession, openStaffSession } from './staff-session.ts';

export type { StaffPrincipal } from './staff.ts';

/** A locale segment from untrusted input, or the default. Never a path a form supplies. */
export const localeSegmentOf = (raw: string | undefined): LocaleSegment =>
  (LOCALE_SEGMENTS as readonly string[]).includes(raw ?? '') ? (raw as LocaleSegment) : 'ar';

export type SignInReason =
  'SIGNED_OUT' | 'SESSION_REQUIRED' | 'SIGN_IN_REFUSED' | 'TENANT_NOT_ACTIVE' | 'DEVELOPMENT_SIGN_IN_REFUSED';
export const signInPath = (locale: string, reason?: SignInReason): string =>
  `/${localeSegmentOf(locale)}/sign-in${reason === undefined ? '' : `?reason=${reason}`}`;

/** The signed-in principal, or undefined. A forged, tampered or expired cookie is no session. */
export async function currentStaff(): Promise<StaffPrincipal | undefined> {
  const jar = await cookies();
  const opened = openStaffSession(jar.get(STAFF_SESSION_COOKIE)?.value, epochNow());
  return opened.kind === 'VALID' ? opened.principal : undefined;
}

/** `lifetimeSeconds` is the tenant's staff identity configuration in force; it is bounded by the session layer regardless. */
export async function startStaffSession(principal: StaffPrincipal, lifetimeSeconds: bigint | undefined): Promise<void> {
  const issued = issueStaffSession(principal, lifetimeSeconds, epochNow());
  const jar = await cookies();
  jar.set(STAFF_SESSION_COOKIE, issued.token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: Number(issued.lifetimeSeconds),
  });
}

export async function endStaffSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(STAFF_SESSION_COOKIE);
}

/** Is this tenant one the deployment jurisdiction has active (ADR 0005)? */
export async function tenantActive(tenant: TenantCode): Promise<boolean> {
  const d = await deploymentJurisdiction();
  return d.activeTenants.includes(tenant);
}

/**
 * The principal an act is performed as. No session: sent to sign in (the
 * locale kept). A session whose tenant the deployment no longer has active:
 * sent to sign in with that reason, and nothing is done.
 */
export async function actingPrincipal(locale: string): Promise<StaffPrincipal> {
  const staff = await currentStaff();
  if (staff === undefined) redirect(signInPath(locale, 'SESSION_REQUIRED'));
  if (!(await tenantActive(staff.tenantId))) redirect(signInPath(locale, 'TENANT_NOT_ACTIVE'));
  return staff;
}

/**
 * The principal, if it may perform `act`; otherwise the browser goes back to
 * `back` with the control and the typed reason (and the authorities needed, as
 * codes), which the screen words in both languages. `back` is a path the
 * action built from fixed segments, never one from the form.
 */
export async function authorise(locale: string, act: WorkbenchAct, back: string): Promise<StaffPrincipal> {
  const staff = await actingPrincipal(locale);
  const p = permits(staff, act);
  if (!p.allowed) {
    const query = new URLSearchParams({ control: 'OP-DETERMINACY', reason: p.reason, needs: p.needs.join(',') });
    redirect(`${back}${back.includes('?') ? '&' : '?'}${query.toString()}`);
  }
  return staff;
}

/** For a page: the signed-in principal, or off to sign in. The middleware does this first; this is the second line. */
export async function pageStaff(locale: string): Promise<StaffPrincipal> {
  const staff = await currentStaff();
  if (staff === undefined) redirect(signInPath(locale, 'SESSION_REQUIRED'));
  return staff;
}

/**
 * Could this principal review this request?
 *
 * A convenience for the screens, and **not** the control. The control is in
 * `core/origination/request.ts`, which refuses the transition regardless of
 * what any screen decided to render. This exists so the queue can explain why
 * an item is not actionable instead of letting someone open it, write a
 * justification and then be refused.
 */
export function canReview(
  reviewer: Pick<Principal, 'principalId'>,
  makerPrincipalId: string | undefined,
): { readonly allowed: boolean; readonly reason?: 'OWN_WORK' } {
  if (makerPrincipalId !== undefined && makerPrincipalId === reviewer.principalId) {
    return { allowed: false, reason: 'OWN_WORK' };
  }
  return { allowed: true };
}
