/**
 * Open Banking account information (AIS) under the SAMA Open Banking Framework, through a licensed TPP or the institution's own connection. Consent-gated. Affordability facts as a snapshot, never a mirrored statement (CLAUDE.md §5).
 *
 * A port: capability-named, vendor-free. Parties are referenced, never
 * identified by value — no national identifier, phone or address crosses
 * this boundary. Unavailability is a typed outcome, never a throw, and a
 * rail being down approves nothing.
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface AccountInformationPort {
  affordabilityFacts(params: { readonly tenantId: string; readonly applicantRef: string; readonly consentId: string; readonly months: number; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly averageMonthlyInflow: Money; readonly lowestMonthEndBalance: Money; readonly returnedPaymentsLast6Months: number; readonly salaryCreditsObserved: number; readonly retrievedAtEpochSeconds: bigint; readonly referenceId: string }>>>;
}
