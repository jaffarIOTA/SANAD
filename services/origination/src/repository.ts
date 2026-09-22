/**
 * Where requests are kept.
 *
 * A port with an in-memory implementation. The port exists so the durable one
 * is a drop-in; the in-memory one exists so the service is walkable before the
 * in-Kingdom database is provisioned (ADR 0001).
 *
 * **Known gap while this is in memory.** The ops workbench has its own store
 * (`apps/ops/src/server/store.ts`), so a request raised over this API does not
 * appear in the review queue and vice versa. That is an artefact of there
 * being no shared database yet, not a design: both collapse onto the same
 * `core.origination_request` table, and this file and that one are what get
 * deleted. Recorded in ClaudeRecommendations.md.
 *
 * Every mutation goes through the domain functions in `core/origination`, so
 * what is exercised is the real state machine with a toy repository behind it.
 */

import type { OriginationRequest } from '@sanad/core/origination/request.ts';

export interface StoredRequest {
  readonly requestId: string;
  readonly tenantId: string;
  /** Which partner raised it. Scopes every read. */
  readonly partnerId: string;
  readonly request: OriginationRequest;
  readonly partnerReference?: string;
  /** Ordering key, so a page is stable. */
  readonly sequence: number;
}

export interface Page {
  readonly items: readonly StoredRequest[];
  readonly nextCursor: string | null;
}

export interface RequestRepository {
  nextRequestId(): Promise<string>;
  save(record: StoredRequest): Promise<void>;
  /**
   * Scoped by tenant *and* partner. A partner reading another partner's
   * request is reported as absent rather than forbidden, so the API never
   * confirms the existence of other partners' business.
   */
  find(tenantId: string, partnerId: string, requestId: string): Promise<StoredRequest | undefined>;
  list(params: {
    readonly tenantId: string;
    readonly partnerId: string;
    readonly states?: readonly OriginationRequest['state'][];
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<Page>;
}

export function inMemoryRequestRepository(): RequestRepository {
  const records = new Map<string, StoredRequest>();
  let sequence = 0;

  const scoped = (record: StoredRequest, tenantId: string, partnerId: string): boolean =>
    record.tenantId === tenantId && record.partnerId === partnerId;

  return {
    nextRequestId(): Promise<string> {
      sequence += 1;
      return Promise.resolve(crypto.randomUUID());
    },

    save(record): Promise<void> {
      records.set(record.requestId, record);
      return Promise.resolve();
    },

    find(tenantId, partnerId, requestId): Promise<StoredRequest | undefined> {
      const record = records.get(requestId);
      return Promise.resolve(
        record !== undefined && scoped(record, tenantId, partnerId) ? record : undefined,
      );
    },

    list({ tenantId, partnerId, states, cursor, limit }): Promise<Page> {
      const all = [...records.values()]
        .filter((r) => scoped(r, tenantId, partnerId))
        .filter((r) => states === undefined || states.includes(r.request.state))
        // Newest first: a partner polling its own submissions wants the most
        // recent. This is a feed, not a work queue — contrast the review
        // queue, which is strictly oldest-first so nothing starves.
        .sort((a, b) => b.sequence - a.sequence);

      const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
      const from = Number.isFinite(start) && start >= 0 ? start : 0;
      const items = all.slice(from, from + limit);
      const next = from + limit;

      return Promise.resolve({
        items,
        nextCursor: next < all.length ? String(next) : null,
      });
    },
  };
}

/** Monotonic sequence for a newly stored record. */
export function nextSequence(): () => number {
  let n = 0;
  return () => {
    n += 1;
    return n;
  };
}
