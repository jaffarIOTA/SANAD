/**
 * Verification of identity attributes and address against national records. Consent-gated. Stores the result and the reference, never the attributes (CLAUDE.md §5).
 *
 * A port: capability-named, vendor-free. Parties are referenced, never
 * identified by value — no national identifier, phone or address crosses
 * this boundary. Unavailability is a typed outcome, never a throw, and a
 * rail being down approves nothing.
 */

import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface IdentityVerificationPort {
  verify(params: { readonly tenantId: string; readonly applicantRef: string; readonly consentId: string; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly verified: boolean; readonly verificationRef: string; readonly verifiedAtEpochSeconds: bigint; readonly mismatches: readonly string[] }>>>;
}
