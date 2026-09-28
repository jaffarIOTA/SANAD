/**
 * Dispatching the outbox: one event, one call to one port, one recorded
 * outcome. Pure apart from the port call itself.
 *
 * The three outcomes are the whole design:
 *   - DELIVERED — the port answered; the reference is kept.
 *   - RETRY     — the port was unavailable; try again after the backoff the
 *                 tenant's policy declares, up to its maximum attempts.
 *   - DEAD      — the port refused, the payload cannot be mapped, or the
 *                 attempts are exhausted. A dead event is an exception for a
 *                 person; it is never silently dropped and never retried
 *                 into a duplicate.
 *
 * The idempotency key on every event goes to the port unchanged, so a retry
 * after a lost acknowledgement cannot pay, report or notify twice.
 */

import { money } from '../kernel/money.ts';
import type { BillCollectionPort } from '../ports/bill-collection.ts';
import type { CreditBureauPort } from '../ports/credit-bureau.ts';
import type { NotificationsPort } from '../ports/notifications.ts';
import type { PaymentsPort } from '../ports/payments.ts';
import type { RailOutcome } from '../ports/rail.ts';
import type { WebhooksPort } from '../ports/webhooks.ts';
import type { OutboxEvent } from './outbox.ts';

export interface DispatchPorts {
  readonly payments: PaymentsPort;
  readonly bureau: CreditBureauPort;
  readonly webhooks: WebhooksPort;
  readonly notifications: NotificationsPort;
  readonly bills: BillCollectionPort;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffSeconds: number;
}

export type DispatchOutcome =
  | { readonly kind: 'DELIVERED'; readonly deliveryRef: string }
  | { readonly kind: 'RETRY'; readonly afterSeconds: number; readonly reason: string }
  | { readonly kind: 'DEAD'; readonly reason: string };

/** Exponential backoff from the tenant's base, capped at a day. */
export function backoffSeconds(policy: RetryPolicy, attempt: number): number {
  const factor = 2 ** Math.max(0, attempt - 1);
  return Math.min(policy.backoffSeconds * factor, 86_400);
}

const field = (event: OutboxEvent, name: string): string | undefined => event.payload[name];
const asMoney = (event: OutboxEvent): ReturnType<typeof money> | undefined => {
  const minor = field(event, 'minorUnits');
  return minor !== undefined && /^\d+$/.test(minor) ? money(BigInt(minor), (field(event, 'currency') as 'SAR' | undefined) ?? 'SAR') : undefined;
};

function fromRail<T>(outcome: RailOutcome<T>, ref: (value: T) => string, attempt: number, policy: RetryPolicy): DispatchOutcome {
  if (outcome.kind === 'ANSWERED') return { kind: 'DELIVERED', deliveryRef: ref(outcome.value) };
  if (outcome.kind === 'REFUSED') return { kind: 'DEAD', reason: `refused: ${outcome.code}` };
  return attempt >= policy.maxAttempts
    ? { kind: 'DEAD', reason: `unavailable after ${String(attempt)} attempts: ${outcome.reason}` }
    : { kind: 'RETRY', afterSeconds: outcome.retryAfterSeconds ?? backoffSeconds(policy, attempt), reason: outcome.reason };
}

/** `attempt` is the number of this attempt, starting at 1. */
export async function dispatchOnce(event: OutboxEvent, ports: DispatchPorts, policy: RetryPolicy, attempt: number): Promise<DispatchOutcome> {
  const dead = (reason: string): DispatchOutcome => ({ kind: 'DEAD', reason });
  const retryOrDead = (reason: string): DispatchOutcome =>
    attempt >= policy.maxAttempts ? dead(`${reason} after ${String(attempt)} attempts`) : { kind: 'RETRY', afterSeconds: backoffSeconds(policy, attempt), reason };

  switch (event.kind) {
    case 'PAYMENT_DISBURSE': {
      const amount = asMoney(event); const beneficiaryRef = field(event, 'beneficiaryRef');
      if (amount === undefined || beneficiaryRef === undefined) return dead('payload lacks beneficiaryRef or minorUnits');
      const r = await ports.payments.disburse({ tenantId: event.tenantId, beneficiaryRef, amount, purposeCode: field(event, 'reason') ?? 'FINANCE_DISBURSEMENT', reference: event.subjectRef, idempotencyKey: event.idempotencyKey, correlationId: event.correlationId });
      return r.ok ? fromRail(r.value, (v) => v.instructionRef, attempt, policy) : dead(r.error.reason);
    }
    case 'PAYMENT_COLLECT': {
      const amount = asMoney(event); const payerRef = field(event, 'payerRef');
      if (amount === undefined || payerRef === undefined) return dead('payload lacks payerRef or minorUnits');
      const r = await ports.payments.collect({ tenantId: event.tenantId, payerRef, amount, reference: event.subjectRef, idempotencyKey: event.idempotencyKey, correlationId: event.correlationId });
      return r.ok ? fromRail(r.value, (v) => v.instructionRef, attempt, policy) : dead(r.error.reason);
    }
    case 'BUREAU_REPORT': {
      const amount = asMoney(event); const facilityRef = field(event, 'facilityRef'); const ev = field(event, 'event');
      if (amount === undefined || facilityRef === undefined || ev === undefined) return dead('payload lacks facilityRef, event or minorUnits');
      const r = await ports.bureau.report({ tenantId: event.tenantId, facilityRef, counterpartyId: field(event, 'counterpartyId') ?? '', event: ev as 'OPENED', amount, asOfEpochSeconds: BigInt(field(event, 'asOfEpochSeconds') ?? '0'), idempotencyKey: event.idempotencyKey, correlationId: event.correlationId });
      if (!r.ok) return dead(r.error.reason);
      return r.value.kind === 'ACKNOWLEDGED' ? { kind: 'DELIVERED', deliveryRef: r.value.acknowledgementRef } : retryOrDead(r.value.reason);
    }
    case 'PARTNER_CALLBACK': {
      const partnerRef = field(event, 'partnerRef') ?? field(event, 'merchantId');
      const webhook = field(event, 'webhook') ?? 'requestStateChanged';
      if (partnerRef === undefined) return dead('payload lacks partnerRef');
      const r = await ports.webhooks.deliver({ tenantId: event.tenantId, partnerRef, event: webhook, payload: { eventId: event.eventId, subjectRef: event.subjectRef, ...event.payload }, idempotencyKey: event.idempotencyKey, correlationId: event.correlationId });
      return r.ok ? fromRail(r.value, (v) => v.deliveryRef, attempt, policy) : dead(r.error.reason);
    }
    case 'NOTIFICATION': {
      const recipientKind = field(event, 'recipientKind'); const recipientRef = field(event, 'recipientRef'); const notificationEvent = field(event, 'event');
      if (recipientKind === undefined || recipientRef === undefined || notificationEvent === undefined) return dead('payload lacks recipient or event');
      const recipient = recipientKind === 'PARTNER' ? { kind: 'PARTNER' as const, partnerId: recipientRef } : recipientKind === 'PRINCIPAL' ? { kind: 'PRINCIPAL' as const, principalId: recipientRef } : { kind: 'COUNTERPARTY' as const, counterpartyId: recipientRef };
      const r = await ports.notifications.send({ tenantId: event.tenantId, event: notificationEvent as 'REQUEST_RECEIVED', recipient, channels: (field(event, 'channels') ?? 'SMS').split(',') as ('SMS' | 'EMAIL' | 'PUSH' | 'IN_APP' | 'PARTNER_CALLBACK')[], variables: Object.fromEntries(Object.entries(event.payload).filter(([k]) => !['recipientKind', 'recipientRef', 'event', 'channels'].includes(k))), correlationId: event.correlationId, dedupeKey: event.idempotencyKey });
      return r.ok ? { kind: 'DELIVERED', deliveryRef: r.value.deliveryRef } : retryOrDead(r.error.reason);
    }
    case 'BILL_PRESENT': {
      const amount = asMoney(event); const payerRef = field(event, 'payerRef'); const due = field(event, 'dueDateGregorian');
      if (amount === undefined || payerRef === undefined || due === undefined) return dead('payload lacks payerRef, dueDateGregorian or minorUnits');
      const r = await ports.bills.present({ tenantId: event.tenantId, obligationRef: event.subjectRef, payerRef, amount, dueDateGregorian: due, idempotencyKey: event.idempotencyKey, correlationId: event.correlationId });
      return r.ok ? fromRail(r.value, (v) => v.billRef, attempt, policy) : dead(r.error.reason);
    }
  }
}
