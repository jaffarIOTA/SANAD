/**
 * Employment status, employer and registered salary, for affordability and salary-assignment products. Consent-gated; the salary is a snapshot with the provider reference (CLAUDE.md §5).
 *
 * A port: capability-named, vendor-free. Parties are referenced, never
 * identified by value — no national identifier, phone or address crosses
 * this boundary. Unavailability is a typed outcome, never a throw, and a
 * rail being down approves nothing.
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface EmploymentVerificationPort {
  employment(params: { readonly tenantId: string; readonly applicantRef: string; readonly consentId: string; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly employed: boolean; readonly employerRef?: string; readonly registeredSalary?: Money; readonly employedSinceEpochSeconds?: bigint; readonly retrievedAtEpochSeconds: bigint; readonly referenceId: string }>>>;
}
