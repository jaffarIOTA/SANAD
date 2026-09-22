/**
 * Idempotency.
 *
 * §8 requires an `Idempotency-Key` on every state-changing request, the
 * response persisted against it, and a replay returning the original result.
 * In this product that is not a convenience: a retried instruction that
 * executes twice is a duplicate purchase leg or a duplicate payment.
 *
 * Three decisions worth stating.
 *
 * **The body is never stored — only its digest.** A request body carries
 * counterparty and trade detail. An idempotency store that keeps bodies is a
 * second copy of that data, with a different lifetime and usually weaker
 * controls. A digest is enough to answer the only question being asked: is
 * this the same instruction?
 *
 * **A key reused with a different body is refused, not resolved.** Returning
 * the stored response would answer a question the caller did not ask;
 * executing the new body would break the guarantee the key exists to provide.
 * One of the two systems has a defect and both should hear about it.
 *
 * **A record in flight is refused rather than queued.** Two concurrent
 * requests with one key means the caller retried before the first answered.
 * Serving the second would risk executing twice; holding it open risks
 * holding it forever.
 *
 * **A key is scoped to the caller, not to the tenant.** This one is a security
 * property rather than a correctness one. Several partners operate inside one
 * tenant, so scoping by tenant alone means partner B presenting partner A's
 * key receives A's stored response — which carries A's counterparty, trade and
 * amounts. A caller must never be able to read another caller's result by
 * guessing or obtaining a key, so the scope is `(tenant, partner, key)`.
 *
 * The port below is deliberately narrow so the durable implementation is a
 * single table with a unique constraint on `(tenant_id, partner_id, key)`. See
 * ClaudeRecommendations.md R-14 for why this belongs in PostgreSQL rather
 * than in a cache that may evict it.
 */

import { createHash } from 'node:crypto';

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type Reservation =
  /** Nothing has used this key. Proceed, then `complete`. */
  | { readonly kind: 'FRESH' }
  /** Same key, same instruction, already answered. */
  | { readonly kind: 'REPLAY'; readonly response: StoredResponse }
  /** Same key, a different instruction. */
  | { readonly kind: 'CONFLICT' }
  /** Same key, still being processed. */
  | { readonly kind: 'IN_FLIGHT' };

export interface IdempotencyStore {
  /**
   * Claim a key for this instruction.
   *
   * Must be atomic: in the durable implementation this is an
   * `insert … on conflict do nothing returning …`, which is why the port
   * offers no separate "check then write".
   */
  reserve(params: {
    readonly tenantId: string;
    readonly partnerId: string;
    readonly key: string;
    readonly fingerprint: string;
  }): Promise<Reservation>;

  /** Record the outcome so a replay can be served from it. */
  complete(params: {
    readonly tenantId: string;
    readonly partnerId: string;
    readonly key: string;
    readonly response: StoredResponse;
  }): Promise<void>;

  /**
   * Release a key whose request failed before producing a recorded outcome.
   *
   * Without this, a crash mid-request would wedge the key permanently and the
   * caller could never retry the instruction it never got an answer to.
   */
  release(params: {
    readonly tenantId: string;
    readonly partnerId: string;
    readonly key: string;
  }): Promise<void>;
}

/**
 * The instruction's identity.
 *
 * Method and path are included because the same key used on two different
 * operations is a different instruction, not a replay.
 */
export function fingerprint(method: string, path: string, rawBody: string): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${rawBody}`, 'utf8')
    .digest('hex');
}

interface Record_ {
  readonly fingerprint: string;
  response?: StoredResponse;
}

/**
 * In-memory implementation, for development and tests.
 *
 * Process-local and lost on restart, which is precisely why it is not the
 * production one — see ADR 0001.
 */
export function inMemoryIdempotencyStore(): IdempotencyStore {
  const records = new Map<string, Record_>();
  // NUL-separated, so a partner identifier containing the separator cannot be
  // crafted to collide with another scope.
  const at = (tenantId: string, partnerId: string, key: string): string =>
    `${tenantId}\u0000${partnerId}\u0000${key}`;

  return {
    reserve({ tenantId, partnerId, key, fingerprint: fp }): Promise<Reservation> {
      const id = at(tenantId, partnerId, key);
      const existing = records.get(id);

      if (existing === undefined) {
        records.set(id, { fingerprint: fp });
        return Promise.resolve({ kind: 'FRESH' });
      }
      if (existing.fingerprint !== fp) return Promise.resolve({ kind: 'CONFLICT' });
      if (existing.response === undefined) return Promise.resolve({ kind: 'IN_FLIGHT' });
      return Promise.resolve({ kind: 'REPLAY', response: existing.response });
    },

    complete({ tenantId, partnerId, key, response }): Promise<void> {
      const record = records.get(at(tenantId, partnerId, key));
      if (record !== undefined) record.response = response;
      return Promise.resolve();
    },

    release({ tenantId, partnerId, key }): Promise<void> {
      const id = at(tenantId, partnerId, key);
      if (records.get(id)?.response === undefined) records.delete(id);
      return Promise.resolve();
    },
  };
}
