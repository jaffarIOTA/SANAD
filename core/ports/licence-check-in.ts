/**
 * Optional online licence check-in (ADR 0006 §3), as a port.
 *
 * Where the institution allows outbound traffic, the installation checks in
 * daily with the issuer. It sends exactly four things — the licence id, the
 * installation id, the product version and the licence state — and nothing
 * about a customer, an applicant or a transaction. The request type below is
 * closed so nothing else can be added by accident.
 *
 * The answer may carry signed files: a newer licence (a renewal picked up
 * automatically) or a revocation. Both are verified with the same compiled-in
 * keyring as an uploaded file, by `core/licensing/check-in.ts`; the transport
 * is trusted for nothing.
 *
 * Unavailable is a typed outcome, and it changes nothing: the offline file
 * governs. Network trouble never stops an institution.
 *
 * Fixture transport only (`adapters/licensing/check-in/`): the issuer's
 * check-in server does not exist yet, so there is no live transport.
 */

import type { LicenceStatus } from '../licensing/state.ts';

export interface LicenceCheckInRequest {
  /** The effective licence, or null if none is installed. */
  readonly licenceId: string | null;
  readonly installationId: string;
  readonly productVersion: string;
  readonly state: LicenceStatus;
}

export type LicenceCheckInOutcome =
  | {
      readonly kind: 'ANSWERED';
      /** Signed files, each `{"licence":…,"signature":…}` or `{"revocation":…,"signature":…}`. Possibly none. */
      readonly files: readonly string[];
    }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

export interface LicenceCheckInPort {
  checkIn(request: LicenceCheckInRequest): Promise<LicenceCheckInOutcome>;
}
