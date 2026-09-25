/**
 * Port: identity, KYC, AML/sanctions, PEP and fraud screening.
 *
 * BRD §14. One port, several checks, four outcomes: CLEAR, REFER, REJECT,
 * PENDING_INVESTIGATION. A REJECT here is a compliance outcome and is
 * surfaced with its control (SH-12, permissible counterparty activity); a
 * PENDING_INVESTIGATION opens an exception rather than parking silently.
 *
 * Inputs reference the counterparty and its registration. They do not carry
 * personal identifiers in a form that reaches a log: the screening adapter
 * resolves those from the identity provider by reference.
 */

import type { Result } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';

export const SCREENING_CHECKS = ['IDENTITY', 'KYC_STATUS', 'SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'FRAUD', 'DUPLICATE_APPLICATION'] as const;
export type ScreeningCheck = (typeof SCREENING_CHECKS)[number];

export type ScreeningOutcome = 'CLEAR' | 'REFER' | 'REJECT' | 'PENDING_INVESTIGATION';

export interface ScreeningRequest {
  readonly tenantId: string;
  readonly counterpartyId: string;
  readonly commercialRegistration: string;
  readonly signatoryRefs: readonly string[];
  readonly checks: readonly ScreeningCheck[];
  /** The consent record that authorises screening. */
  readonly consentId: string;
  readonly correlationId: string;
}

export interface ScreeningResult {
  readonly screeningReference: string;
  readonly screenedAt: TsaInstant;
  readonly overall: ScreeningOutcome;
  readonly perCheck: readonly { readonly check: ScreeningCheck; readonly outcome: ScreeningOutcome; readonly listRef?: string }[];
}

export interface ScreeningPort {
  screen(req: ScreeningRequest): Promise<Result<ScreeningResult | { readonly kind: 'UNAVAILABLE'; readonly reason: string }>>;
}
