/**
 * Which institution an administrator may configure (SR-033). The institution a
 * form or address names is a request, never an authority: single sign-on binds
 * the session to the institution whose identity provider and mappings granted
 * the role, and that is the only one it may read or change. Development
 * sign-in, refused outside the development profile, may choose any.
 *
 * Pure: the session and the request are passed in.
 */

import { isTenantCode, type TenantCode } from '@sanad/config/loader.ts';

import type { AdminPrincipal } from './session.ts';

/** The institution requested, if this administrator may configure it; otherwise none. */
export function configurableTenant(
  admin: Pick<AdminPrincipal, 'method' | 'tenantId'>,
  requested: string | undefined,
): TenantCode | undefined {
  if (requested === undefined || !isTenantCode(requested)) return undefined;
  if (admin.method === 'DEVELOPMENT') return requested;
  return admin.tenantId === requested ? requested : undefined;
}

/**
 * The institution a screen shows: the one requested when permitted, else the
 * administrator's own (single sign-on), else the first (development).
 */
export function displayedTenant(
  admin: Pick<AdminPrincipal, 'method' | 'tenantId'>,
  requested: string | undefined,
  fallback: TenantCode,
): TenantCode | undefined {
  return (
    configurableTenant(admin, requested) ??
    (admin.method === 'DEVELOPMENT' ? fallback : configurableTenant(admin, admin.tenantId))
  );
}

/** The institutions a screen offers to switch between. */
export const configurableTenants = <T extends { readonly code: string }>(
  admin: Pick<AdminPrincipal, 'method' | 'tenantId'>,
  tenants: readonly T[],
): readonly T[] => tenants.filter((t) => configurableTenant(admin, t.code) !== undefined);
