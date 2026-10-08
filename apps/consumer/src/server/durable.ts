/**
 * Durability for the consumer journey.
 *
 * `syncConsumerStore()` loads the tenant's offers, acceptances, checkout
 * sessions and idempotency keys from the database once per process, then
 * writes anything changed. `flushConsumerStore()` writes what has changed
 * since the last flush, in one transaction, and appends queued events to the
 * outbox store. Both are awaited before a response that reports a change is
 * sent, so a customer is never shown an offer or an acceptance that a restart
 * would lose.
 *
 * Without `SANAD_DATABASE_URL` nothing is loaded or saved and the outbox store
 * is this process's memory, as before.
 */

import type { OutboxStore } from '@sanad/core/outbox/store.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';

import { postgresOutboxStore } from '../../../../services/outbox/src/postgres-store.ts';
import {
  markAppended,
  markCheckoutSaved,
  outboxStore,
  restoreCheckout,
  unappendedEvents,
  unsavedIdempotency,
  unsavedSessions,
  useOutboxStore,
} from './checkout-store.ts';
import { loadConsumerBook, persistencePool, persistenceUrl, saveConsumerBook } from './persistence.ts';
import { continueSequenceFrom, markSaved, restore, unsavedAcceptances, unsavedOffers } from './store.ts';

const TENANT_CODE = 'bank-a';

interface Flags {
  hydrated?: boolean;
  outboxSwapped?: boolean;
}
const flags: Flags = ((globalThis as { __sanadConsumerDurable?: Flags }).__sanadConsumerDurable ??= {});

export const consumerBacking = (): 'POSTGRESQL' | 'MEMORY' =>
  persistenceUrl() === undefined ? 'MEMORY' : 'POSTGRESQL';

const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * The outbox table keys on the tenant's uuid; the domain's events carry the
 * tenant's code. The translation happens here, at the boundary, on the way in.
 */
function tenantMapped(store: OutboxStore, uuidFor: (code: string) => Promise<string>): OutboxStore {
  return {
    ...store,
    async append(events) {
      const mapped = [];
      for (const e of events) mapped.push(isUuid(e.tenantId) ? e : { ...e, tenantId: await uuidFor(e.tenantId) });
      await store.append(mapped);
    },
    claim: (now, limit, lease) => store.claim(now, limit, lease),
    markDelivered: (id, ref) => store.markDelivered(id, ref),
    markRetry: (id, next, error) => store.markRetry(id, next, error),
    markDead: (id, error) => store.markDead(id, error),
    rows: () => store.rows(),
  };
}

function useDatabaseOutbox(): void {
  if (flags.outboxSwapped === true) return;
  const pool = persistencePool();
  if (pool === undefined) return;
  useOutboxStore(tenantMapped(postgresOutboxStore(pool), (code) => tenantUuidByCode(pool, code)));
  flags.outboxSwapped = true;
}

export async function flushConsumerStore(): Promise<void> {
  useDatabaseOutbox();
  const pool = persistencePool();
  if (pool !== undefined) {
    const offers = unsavedOffers();
    const acceptances = unsavedAcceptances();
    const sessions = unsavedSessions();
    const idempotency = unsavedIdempotency();
    await saveConsumerBook(pool, TENANT_CODE, { offers, acceptances, sessions, idempotency });
    markSaved(
      offers.map((o) => o.offerId),
      acceptances.map((a) => a.acceptanceId),
    );
    markCheckoutSaved(
      sessions.map((s) => s.core.sessionId),
      idempotency,
    );
  }
  // Events go to the outbox store after the rows they describe are durable, and stay queued until it has them.
  const events = unappendedEvents();
  if (events.length > 0) {
    await outboxStore().append(events);
    markAppended(events.map((e) => e.eventId));
  }
}

async function hydrate(): Promise<void> {
  if (flags.hydrated === true) return;
  const pool = persistencePool();
  if (pool === undefined) return;
  const book = await loadConsumerBook(pool, TENANT_CODE);
  restore(book.offers, book.acceptances);
  restoreCheckout(book.sessions, book.idempotency);
  continueSequenceFrom([
    ...book.offers.map((o) => o.offerId),
    ...book.acceptances.map((a) => a.acceptanceId),
    ...book.sessions.flatMap((s) => [
      s.core.sessionId,
      s.core.correlationId,
      'transactionId' in s ? s.transactionId : '',
    ]),
  ]);
  flags.hydrated = true;
}

/** Brings the working set and the database into step. Awaited before any page or route reads the stores. */
export async function syncConsumerStore(): Promise<void> {
  useDatabaseOutbox();
  await hydrate();
  await flushConsumerStore();
}
