/**
 * Partner and merchant webhooks: delivery of an event to the URL a partner
 * registered, signed so the receiver can verify it came from the platform.
 * The registration (URL, signing secret reference) is the tenant's
 * configuration; the port takes the partner by reference and the adapter
 * resolves the rest from the vault.
 */

import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface WebhookDelivery {
  readonly tenantId: string;
  readonly partnerRef: string;
  /** The contract's webhook operation, e.g. `requestStateChanged`, `checkoutSessionChanged`. */
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface WebhooksPort {
  deliver(delivery: WebhookDelivery): Promise<Result<RailOutcome<{ readonly deliveryRef: string; readonly statusCode: number }>>>;
}
