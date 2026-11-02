/**
 * The civil date of an instant where the institution is: the date a due date,
 * a reading date or a document's expiry is compared with. The time zone is
 * the tenant's jurisdiction's (config/jurisdictions/), never the server's.
 */
import { type TenantCode, loadJurisdictionProfile, loadTenantOnboarding } from '@sanad/config/loader.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';

/** The civil date (yyyy-mm-dd) of an attested instant in the institution's time zone. */
export function civilDateOf(tenant: TenantCode, at: TsaInstant): string {
  const onboarding = loadTenantOnboarding(tenant);
  const profile = onboarding.ok ? loadJurisdictionProfile(onboarding.value.jurisdiction) : undefined;
  const timeZone = profile?.ok === true ? profile.value.timeZone : 'UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(Number(at.epochSeconds) * 1000),
  );
}
