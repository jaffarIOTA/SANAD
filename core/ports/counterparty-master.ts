/**
 * The institution's own counterparty master (its CIF): who it has onboarded,
 * under which identifier, with what KYC standing. The platform reads and
 * begins onboarding; the master owns the record.
 */

import type { Result } from '../kernel/result.ts';

export interface CounterpartyProfile {
  readonly counterpartyId: string;
  readonly tenantId: string;
  readonly commercialRegistration: string;
  readonly legalNameAr: string;
  readonly legalNameEn: string;
  readonly legalForm: string;
  readonly segment: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  /** References into the identity provider — never the identifiers themselves. */
  readonly signatoryRefs: readonly string[];
  readonly kycStatus: 'VERIFIED' | 'PENDING' | 'EXPIRED' | 'FAILED';
}

export interface CounterpartyMasterPort {
  /** By commercial registration. Absent means not onboarded, not an error. */
  findByRegistration(tenantId: string, commercialRegistration: string): Promise<Result<CounterpartyProfile | undefined>>;
  get(tenantId: string, counterpartyId: string): Promise<Result<CounterpartyProfile>>;
  /** Begins onboarding; returns the id under which KYC will proceed. */
  beginOnboarding(tenantId: string, registration: { readonly commercialRegistration: string; readonly legalNameAr: string; readonly legalNameEn: string }, correlationId: string): Promise<Result<{ readonly counterpartyId: string }>>;
}
