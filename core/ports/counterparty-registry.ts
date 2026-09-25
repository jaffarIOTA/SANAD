/**
 * Port: the institution's counterparty master (CIF).
 *
 * BRD §8 and BR-004: retrieve an existing customer, or begin onboarding a
 * new one. The shape is SME — a legal entity identified by its commercial
 * registration, with authorised signatories — not a retail applicant with a
 * salary and a date of birth. Distinctness (SH-08) is matched on the
 * registration number, never on a name.
 *
 * Nothing here carries a national identifier of a person in a form that
 * would be logged: signatories are referenced, not embedded (§10).
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

export interface CounterpartyRegistryPort {
  /** By commercial registration. Absent means unknown, not an error. */
  findByRegistration(tenantId: string, commercialRegistration: string): Promise<Result<CounterpartyProfile | undefined>>;
  get(tenantId: string, counterpartyId: string): Promise<Result<CounterpartyProfile>>;
  /** Begins onboarding; returns the id under which KYC will proceed. */
  beginOnboarding(tenantId: string, registration: { readonly commercialRegistration: string; readonly legalNameAr: string; readonly legalNameEn: string }, correlationId: string): Promise<Result<{ readonly counterpartyId: string }>>;
}
