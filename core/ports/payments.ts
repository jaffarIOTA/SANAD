/**
 * The institution's payments hub: disbursement to the customer or a seller, collection sweeps. One port; the hub chooses the rail (instant transfer, card scheme, internal). Every instruction is idempotent and outbox-driven (CLAUDE.md §5).
 *
 * A port: capability-named, vendor-free. Parties are referenced, never
 * identified by value — no national identifier, phone or address crosses
 * this boundary. Unavailability is a typed outcome, never a throw, and a
 * rail being down approves nothing.
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface PaymentsPort {
  disburse(params: { readonly tenantId: string; readonly beneficiaryRef: string; readonly amount: Money; readonly purposeCode: string; readonly reference: string; readonly idempotencyKey: string; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly instructionRef: string; readonly status: 'ACCEPTED' | 'SETTLED' | 'REJECTED'; readonly acceptedAtEpochSeconds: bigint }>>>;
  collect(params: { readonly tenantId: string; readonly payerRef: string; readonly amount: Money; readonly reference: string; readonly idempotencyKey: string; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly instructionRef: string; readonly status: 'ACCEPTED' | 'SETTLED' | 'REJECTED' | 'RETURNED'; readonly acceptedAtEpochSeconds: bigint }>>>;
}
