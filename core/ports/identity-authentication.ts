/**
 * The national digital identity service: login, step-up, binding an applicant to a verified national identity (CLAUDE.md §5).
 *
 * A port: capability-named, vendor-free. Parties are referenced, never
 * identified by value — no national identifier, phone or address crosses
 * this boundary. Unavailability is a typed outcome, never a throw, and a
 * rail being down approves nothing.
 */

import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface IdentityAuthenticationPort {
  startAuthentication(params: { readonly tenantId: string; readonly applicantRef: string; readonly purpose: 'LOGIN' | 'STEP_UP' | 'SIGNATURE_INTENT'; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly transactionRef: string; readonly expiresAtEpochSeconds: bigint }>>>;
  confirmAuthentication(params: { readonly tenantId: string; readonly transactionRef: string; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly assertionId: string; readonly identityRef: string; readonly authenticatedAtEpochSeconds: bigint }>>>;
}
