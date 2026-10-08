/**
 * The national business registry (CLAUDE.md §5): what the
 * Ministry of Commerce says about a commercial registration. Read-only,
 * by CR number. Signatories come back as references into the identity
 * provider, never as identifiers.
 *
 * Split from the counterparty master on 2026-09-28 (registry deviation 001): a lookup
 * against the state's register and the institution's own customer record are
 * different things with different owners.
 */

import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface RegistrationRecord {
  readonly commercialRegistration: string;
  readonly legalNameAr: string;
  readonly legalNameEn: string;
  readonly legalForm: string;
  readonly status: 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'CANCELLED';
  /** Registered activity classification codes, screened against the board's register. */
  readonly activityCodes: readonly string[];
  readonly registeredAtGregorian?: string;
  readonly paidCapitalMinorUnits?: bigint;
  readonly signatoryRefs: readonly string[];
  /** The registry's own reference for this lookup, for the audit trail. */
  readonly lookupRef: string;
  readonly retrievedAtEpochSeconds: bigint;
}

export interface BusinessRegistryPort {
  /** `REFUSED` with code `NOT_FOUND` when the registration is unknown. */
  lookup(params: {
    readonly tenantId: string;
    readonly commercialRegistration: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<RegistrationRecord>>>;
}
