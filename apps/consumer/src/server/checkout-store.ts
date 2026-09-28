/**
 * Checkout sessions and the events they emit, on `globalThis` for
 * development. The state machine is the domain's (core/checkout/session.ts);
 * this file only holds rows and turns transitions into events the outbox
 * would deliver to the merchant's webhook.
 */

import type { CheckoutSession } from '@sanad/core/checkout/session.ts';
import { type Outbox, emptyOutbox, enqueue } from '@sanad/core/outbox/outbox.ts';
import { type OutboxStore, inMemoryOutboxStore } from '@sanad/core/outbox/store.ts';

interface State { readonly sessions: Map<string, CheckoutSession>; outbox: Outbox; readonly byIdempotency: Map<string, string>; durable?: OutboxStore }
const KEY = Symbol.for('sanad.consumer.checkout');
const scope = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (scope[KEY] ??= { sessions: new Map(), outbox: emptyOutbox(), byIdempotency: new Map(), durable: inMemoryOutboxStore() });

export function findSession(sessionId: string): CheckoutSession | undefined { return state.sessions.get(sessionId); }

/** Save, and queue the merchant's webhook event for the new state — once per (session, state). */
export function saveSession(session: CheckoutSession): void {
  const previous = state.sessions.get(session.core.sessionId);
  state.sessions.set(session.core.sessionId, session);
  if (previous?.state === session.state) return;
  const queued = enqueue(state.outbox, {
    eventId: `${session.core.sessionId}:${session.state}`, tenantId: session.core.tenantId, kind: 'PARTNER_CALLBACK', subjectRef: session.core.sessionId,
    idempotencyKey: `${session.core.sessionId}:${session.state}`, payload: { merchantId: session.core.merchantId, merchantOrderRef: session.core.merchantOrderRef, state: session.state, webhook: 'checkoutSessionChanged' }, correlationId: session.core.correlationId,
  });
  if (queued.ok) { state.outbox = queued.value; void durable().append([queued.value.events[queued.value.events.length - 1]!]); }
}

export const pendingEvents = (): Outbox => state.outbox;
/** The durable store the dispatcher reads. In development, the same process. */
/** A store kept across hot reloads may predate this field. */
const durable = (): OutboxStore => (state.durable ??= inMemoryOutboxStore());
export const outboxStore = (): OutboxStore => durable();
export const sessionIdFor = (merchantId: string, idempotencyKey: string): string | undefined => state.byIdempotency.get(`${merchantId}:${idempotencyKey}`);
export const rememberIdempotency = (merchantId: string, idempotencyKey: string, sessionId: string): void => { state.byIdempotency.set(`${merchantId}:${idempotencyKey}`, sessionId); };
