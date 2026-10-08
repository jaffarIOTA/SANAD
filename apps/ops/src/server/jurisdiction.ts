/**
 * The workbench's view of the deployment jurisdiction (ADR 0005): which
 * jurisdiction the application behaves as, its currency and profile, and the
 * tenant a screen acts for. Read once per request from the origination
 * service's resolver; never from a query string or a request body, except
 * that a screen may ask for one of the *active* tenants by code.
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
  /** The tenant this screen acts for, or undefined if the jurisdiction has none onboarded. */
  readonly tenant?: TenantCode;
}

export async function workbenchJurisdiction(requestedTenant?: string): Promise<WorkbenchJurisdiction> {
  const d = await deploymentJurisdiction();
  const profile = d.profile.ok ? d.profile.value : undefined;
  const tenant = activeTenantFor(requestedTenant, d.activeTenants);
  return {
    code: d.code,
    currency: profile?.currency ?? (d.code === 'AE' ? 'AED' : 'SAR'),
    ...(profile === undefined ? {} : { profile }),
    activeTenants: d.activeTenants,
    ...(tenant === undefined ? {} : { tenant }),
  };
}

/** The currency word for display beside an amount, in the screen's language. */
export function currencyLabel(currency: CurrencyCode, arabic: boolean): string {
  if (!arabic) return currency;
  return currency === 'AED' ? 'درهم' : 'ريال';
}
