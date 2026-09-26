/**
 * Authenticity check of a national digital document or certificate presented by the applicant. Consent-gated. Scope to be confirmed with the provider (CLAUDE.md §5).
 *
 * A port: capability-named, vendor-free. Parties are referenced, never
 * identified by value — no national identifier, phone or address crosses
 * this boundary. Unavailability is a typed outcome, never a throw, and a
 * rail being down approves nothing.
 */

import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface DocumentVerificationPort {
  verifyDocument(params: { readonly tenantId: string; readonly applicantRef: string; readonly documentType: string; readonly documentRef: string; readonly consentId: string; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly authentic: boolean; readonly verificationRef: string; readonly issuedAtEpochSeconds?: bigint; readonly expiresAtEpochSeconds?: bigint }>>>;
}
