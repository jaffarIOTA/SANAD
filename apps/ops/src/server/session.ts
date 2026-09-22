/**
 * Who the workbench is acting as.
 *
 * Development identities, standing in for the authenticated principal until
 * enterprise SSO arrives (SDD §4.7). They live here rather than in
 * `actions.ts` for two reasons: a `'use server'` module may only export async
 * functions, and the review screens need to *read* the acting principal to
 * decide what a person is allowed to do.
 *
 * The important property is that these are resolved **on the server**. A
 * principal is never taken from a form, a header or a query string, because
 * "who is approving this" must not be something a browser can assert (BE-09).
 * When SSO arrives, `actingPrincipal()` reads the session and nothing that
 * calls it changes.
 *
 * Note that this build holds the maker and the checker at once. That is a
 * development convenience and a four-eyes violation, so the header says so
 * rather than presenting a tidy single user that does not exist yet.
 */

import type { Principal } from '@sanad/core/origination/request.ts';

export const MAKER: Principal = { principalId: 'stf-maker-01', tenantId: 'bank-a' };
export const CHECKER: Principal = { principalId: 'stf-checker-01', tenantId: 'bank-a' };

export type WorkbenchRole = 'MAKER' | 'CHECKER';

/**
 * The principal a given act is performed as.
 *
 * Separate from the *display* identity in the header: a screen asks for the
 * principal that would perform the act it is about to offer, so the four-eyes
 * check can be evaluated before the button is drawn rather than after it is
 * pressed.
 */
export function actingPrincipal(role: WorkbenchRole): Principal {
  return role === 'MAKER' ? MAKER : CHECKER;
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
  reviewer: Principal,
  makerPrincipalId: string | undefined,
): { readonly allowed: boolean; readonly reason?: 'OWN_WORK' } {
  if (makerPrincipalId !== undefined && makerPrincipalId === reviewer.principalId) {
    return { allowed: false, reason: 'OWN_WORK' };
  }
  return { allowed: true };
}
