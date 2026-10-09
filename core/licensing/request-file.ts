/**
 * The licence request file (ADR 0006 §2): what an institution sends the
 * issuer to ask for a licence, a POC extension or a renewal.
 *
 * Four facts and a timestamp — the installation, the licence in force, the
 * deployment's jurisdiction and the product version. No customer, applicant,
 * transaction or staff data, by construction: the type is closed and the
 * builder takes nothing else.
 */

import { formatInstant } from './dates.ts';
import type { LicensedJurisdiction } from './licence.ts';
import type { LicenceState } from './state.ts';

export interface LicenceRequestFile {
  readonly format: 'sanad-licence-request/1';
  readonly installationId: string;
  readonly currentLicenceId: string | null;
  readonly jurisdiction: LicensedJurisdiction;
  readonly productVersion: string;
  readonly requestedAt: string;
}

export function licenceRequestFile(p: {
  readonly installationId: string;
  readonly state: LicenceState;
  readonly jurisdiction: LicensedJurisdiction;
  readonly productVersion: string;
  readonly nowEpochSeconds: bigint;
}): LicenceRequestFile {
  return {
    format: 'sanad-licence-request/1',
    installationId: p.installationId,
    currentLicenceId: p.state.effective?.licenceId ?? null,
    jurisdiction: p.jurisdiction,
    productVersion: p.productVersion,
    requestedAt: formatInstant(p.nowEpochSeconds),
  };
}
