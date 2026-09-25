/**
 * Port: notifications to counterparties, partners and staff.
 *
 * BRD §22. Templated, bilingual by construction, and addressed by reference
 * — a counterparty id, a partner id, a principal — never by a raw phone
 * number or address passing through the domain. The adapter resolves the
 * destination; the domain says what happened and to whom.
 *
 * The transactional outbox (§8) is what carries these. A notification is an
 * external side effect and is never sent from inside a domain transition.
 */

import type { Result } from '../kernel/result.ts';

export type NotificationChannel = 'SMS' | 'EMAIL' | 'PUSH' | 'IN_APP' | 'PARTNER_CALLBACK';

export type NotificationEvent =
  | 'REQUEST_RECEIVED'
  | 'INFORMATION_REQUESTED'
  | 'DOCUMENT_MISSING'
  | 'DOCUMENT_EXPIRING'
  | 'REQUEST_RETURNED'
  | 'REQUEST_APPROVED'
  | 'REQUEST_REJECTED'
  | 'REQUEST_EXPIRED'
  | 'SLA_BREACHED'
  | 'SERVICING_UNAVAILABLE';

export interface Notification {
  readonly tenantId: string;
  readonly event: NotificationEvent;
  readonly recipient:
    | { readonly kind: 'COUNTERPARTY'; readonly counterpartyId: string }
    | { readonly kind: 'PARTNER'; readonly partnerId: string }
    | { readonly kind: 'PRINCIPAL'; readonly principalId: string };
  readonly channels: readonly NotificationChannel[];
  /** Template variables. Never a credential, identifier or personal datum. */
  readonly variables: Readonly<Record<string, string>>;
  readonly correlationId: string;
  /** Idempotency across the outbox. */
  readonly dedupeKey: string;
}

export interface NotificationsPort {
  send(n: Notification): Promise<Result<{ readonly deliveryRef: string }>>;
}
