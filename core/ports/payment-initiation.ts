/**
 * Open Banking payment initiation (PIS): a collection or disbursement instruction the customer authorises. Consent-gated, idempotent, outbox-driven (CLAUDE.md §5).
 *
 * A port: capability-named, vendor-free. Parties are referenced, never
 * identified by value — no national identifier, phone or address crosses
 * this boundary. Unavailability is a typed outcome, never a throw, and a
 * rail being down approves nothing.
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface PaymentInitiationPort {
  initiate(params: { readonly tenantId: string; readonly applicantRef: string; readonly consentId: string; readonly amount: Money; readonly direction: 'COLLECT' | 'DISBURSE'; readonly reference: string; readonly idempotencyKey: string; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly instructionRef: string; readonly status: 'INITIATED' | 'AUTHORISED' | 'REJECTED'; readonly initiatedAtEpochSeconds: bigint }>>>;
  status(params: { readonly tenantId: string; readonly instructionRef: string; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly status: 'INITIATED' | 'AUTHORISED' | 'SETTLED' | 'REJECTED' | 'RETURNED' }>>>;
}
