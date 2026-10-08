/**
 * Checkout sessions and the events they emit. The state machine is the
 * domain's (core/checkout/session.ts); this file holds the working set and
 * turns transitions into events the outbox delivers to the merchant's
 * webhook.
 *
 * With a database configured the sessions, the merchant's idempotency keys
 * and the outbox are durable (durable.ts writes them before a response is
 * sent); without one they are this process's memory, as before.
 */

import type { CheckoutSession } from '@sanad/core/checkout/session.ts';
import { type Outbox, type OutboxEvent, emptyOutbox, enqueue } from '@sanad/core/outbox/outbox.ts';
import { type OutboxStore, inMemoryOutboxStore } from '@sanad/core/outbox/store.ts';

interface State {
  readonly sessions: Map<string, CheckoutSession>;
  outbox: Outbox;
  readonly byIdempotency: Map<string, string>;
  durable?: OutboxStore;
  /** Written since the last flush. Optional: a state kept across hot reloads may predate these. */
  dirtySessions?: Set<string>;
  dirtyIdempotency?: Set<string>;
  /** Events queued for the outbox store and not yet appended to it. */
  unappended?: OutboxEvent[];
}
const KEY = Symbol.for('sanad.consumer.checkout');
const scope = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (scope[KEY] ??= {
  sessions: new Map(),
  outbox: emptyOutbox(),
  byIdempotency: new Map(),
  durable: inMemoryOutboxStore(),
});

export function findSession(sessionId: string): CheckoutSession | undefined {
  return state.sessions.get(sessionId);
}

/** Save, and queue the merchant's webhook event for the new state — once per (session, state). */
export function saveSession(session: CheckoutSession): void {
  const previous = state.sessions.get(session.core.sessionId);
  state.sessions.set(session.core.sessionId, session);
  state.dirtySessions ??= new Set<string>();
  state.dirtySessions.add(session.core.sessionId);
  if (previous?.state === session.state) return;
  const queued = enqueue(state.outbox, {
    eventId: `${session.core.sessionId}:${session.state}`,
    tenantId: session.core.tenantId,
    kind: 'PARTNER_CALLBACK',
    subjectRef: session.core.sessionId,
    idempotencyKey: `${session.core.sessionId}:${session.state}`,
    payload: {
      merchantId: session.core.merchantId,
      merchantOrderRef: session.core.merchantOrderRef,
      state: session.state,
      webhook: 'checkoutSessionChanged',
    },
    correlationId: session.core.correlationId,
  });
  if (!queued.ok) return;
  state.outbox = queued.value;
  const event = queued.value.events[queued.value.events.length - 1];
  if (event === undefined) return;
  state.unappended ??= [];
  state.unappended.push(event);
}

export const pendingEvents = (): Outbox => state.outbox;

/** The store the dispatcher reads. A state kept across hot reloads may predate the field. */
export function outboxStore(): OutboxStore {
  state.durable ??= inMemoryOutboxStore();
  return state.durable;
}
/** The durability layer swaps in the database-backed store once, when a database is configured. */
export function useOutboxStore(store: OutboxStore): void {
  state.durable = store;
}

export const sessionIdFor = (merchantId: string, idempotencyKey: string): string | undefined =>
  state.byIdempotency.get(`${merchantId}:${idempotencyKey}`);
export const rememberIdempotency = (merchantId: string, idempotencyKey: string, sessionId: string): void => {
  const key = `${merchantId}:${idempotencyKey}`;
  state.byIdempotency.set(key, sessionId);
  state.dirtyIdempotency ??= new Set<string>();
  state.dirtyIdempotency.add(key);
};

// -- For the durability layer (durable.ts) -------------------------------------

export function unsavedSessions(): readonly CheckoutSession[] {
  return [...(state.dirtySessions ?? [])].flatMap((id) => {
    const s = state.sessions.get(id);
    return s === undefined ? [] : [s];
  });
}
export function unsavedIdempotency(): readonly {
  readonly merchantId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
}[] {
  return [...(state.dirtyIdempotency ?? [])].flatMap((key) => {
    const sessionId = state.byIdempotency.get(key);
    const at = key.indexOf(':');
    return sessionId === undefined || at < 0
      ? []
      : [{ merchantId: key.slice(0, at), idempotencyKey: key.slice(at + 1), sessionId }];
  });
}
export function markCheckoutSaved(
  sessionIds: readonly string[],
  idempotency: readonly { readonly merchantId: string; readonly idempotencyKey: string }[],
): void {
  for (const id of sessionIds) state.dirtySessions?.delete(id);
  for (const i of idempotency) state.dirtyIdempotency?.delete(`${i.merchantId}:${i.idempotencyKey}`);
}

/** Events queued and not yet in the outbox store; removed only once the store has them. */
export function unappendedEvents(): readonly OutboxEvent[] {
  return [...(state.unappended ?? [])];
}
export function markAppended(eventIds: readonly string[]): void {
  const done = new Set(eventIds);
  state.unappended = (state.unappended ?? []).filter((e) => !done.has(e.eventId));
}

/** Puts stored records back into the working set without marking them as changed or re-queuing their events. */
export function restoreCheckout(
  sessions: readonly CheckoutSession[],
  idempotency: readonly { readonly merchantId: string; readonly idempotencyKey: string; readonly sessionId: string }[],
): void {
  for (const s of sessions) state.sessions.set(s.core.sessionId, s);
  for (const i of idempotency) state.byIdempotency.set(`${i.merchantId}:${i.idempotencyKey}`, i.sessionId);
}
