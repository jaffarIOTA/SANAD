/**
 * National bill presentment and collection through the institution's own biller registration; reconciliation of paid bills. Sanad never becomes the biller (CLAUDE.md §5).
 *
 * A port: capability-named, vendor-free. Parties are referenced, never
 * identified by value — no national identifier, phone or address crosses
 * this boundary. Unavailability is a typed outcome, never a throw, and a
 * rail being down approves nothing.
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface BillCollectionPort {
  present(params: { readonly tenantId: string; readonly obligationRef: string; readonly payerRef: string; readonly amount: Money; readonly dueDateGregorian: string; readonly idempotencyKey: string; readonly correlationId: string }): Promise<Result<RailOutcome<{ readonly billRef: string; readonly presentedAtEpochSeconds: bigint }>>>;
  paid(params: { readonly tenantId: string; readonly sinceEpochSeconds: bigint; readonly correlationId: string }): Promise<Result<RailOutcome<readonly { readonly billRef: string; readonly amount: Money; readonly paidAtEpochSeconds: bigint; readonly settlementRef: string }[]>>>;
}
