/**
 * The workbench's view of the deployment jurisdiction (ADR 0005): which
 * jurisdiction the application behaves as, its currency and profile, and the
 * tenant a screen acts for. Read once per request from the origination
 * service's resolver; never from a query string or a request body.
 *
 * A screen acts for the signed-in principal's own tenant (`staffJurisdiction`),
 * and only when the deployment has that tenant active — never some other
 * active tenant in its place.
 */

import type { TenantCode } from '@sanad/config/loader.ts';
import type { JurisdictionProfile } from '@sanad/core/jurisdiction/profile.ts';
import type { CurrencyCode } from '@sanad/core/kernel/money.ts';
import { activeTenantFor, deploymentJurisdiction } from '@sanad/origination/jurisdiction.ts';

export interface WorkbenchJurisdiction {
  readonly code: 'SA' | 'AE';
  readonly currency: CurrencyCode;
  readonly profile?: JurisdictionProfile;
  readonly activeTenants: readonly TenantCode[];
  /** The tenant this screen acts for, or undefined if there is none it may act for. */
  readonly tenant?: TenantCode;
}

async function resolve(
  pick: (active: readonly TenantCode[]) => TenantCode | undefined,
): Promise<WorkbenchJurisdiction> {
  const d = await deploymentJurisdiction();
  const profile = d.profile.ok ? d.profile.value : undefined;
  const tenant = pick(d.activeTenants);
  return {
    code: d.code,
    currency: profile?.currency ?? (d.code === 'AE' ? 'AED' : 'SAR'),
    ...(profile === undefined ? {} : { profile }),
    activeTenants: d.activeTenants,
    ...(tenant === undefined ? {} : { tenant }),
  };
}

/** The deployment's jurisdiction, for display (the header). Its `tenant` is the first active one; a screen that acts uses `staffJurisdiction`. */
export async function workbenchJurisdiction(): Promise<WorkbenchJurisdiction> {
  return resolve((active) => activeTenantFor(undefined, active));
}

/** The deployment's jurisdiction with `tenant` set to the principal's own tenant if, and only if, it is active here. */
export async function staffJurisdiction(principalTenant: TenantCode): Promise<WorkbenchJurisdiction> {
  return resolve((active) => (active.includes(principalTenant) ? principalTenant : undefined));
}

/** The currency word for display beside an amount, in the screen's language. */
export function currencyLabel(currency: CurrencyCode, arabic: boolean): string {
  if (!arabic) return currency;
  return currency === 'AED' ? 'درهم' : 'ريال';
}
