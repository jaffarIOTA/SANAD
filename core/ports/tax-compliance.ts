/**
 * Zakat and tax certificate status for SME eligibility (CLAUDE.md §5).
 *
 * A port: capability-named, vendor-free. Parties are referenced, never
 * identified by value — no national identifier, phone or address crosses
 * this boundary. Unavailability is a typed outcome, never a throw, and a
 * rail being down approves nothing.
 */

import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface TaxCompliancePort {
  certificateStatus(params: { readonly tenantId: string; readonly crNumber: string; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly status: 'VALID' | 'EXPIRED' | 'NOT_FOUND' | 'SUSPENDED'; readonly certificateRef?: string; readonly validUntilEpochSeconds?: bigint; readonly retrievedAtEpochSeconds: bigint }>>>;
}
