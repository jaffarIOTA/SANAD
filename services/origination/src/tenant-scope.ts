/**
 * Every statement against tenant data runs here: inside a transaction, as the
 * runtime role, with the tenant set for that transaction only (SR-003).
 *
 * The tables' row-level security policies compare `tenant_id` with
 * `core.current_tenant_id()`, which reads `sanad.tenant_id`. Setting it with
 * `set_config(…, true)` scopes it to the transaction, so a pooled connection
 * never carries one tenant's setting into another's work. `set local role`
 * drops to `sanad_app` (NOBYPASSRLS, not the owner) for the same transaction,
 * so the policies bind even while the connection itself logs in as a more
 * privileged role; connected as `sanad_runtime` (migration 0018), it is
 * merely what that login already is.
 *
 * A `where tenant_id = $1` in the statement stays: the policy is the floor,
 * not a replacement for saying what is meant.
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/** What work inside a scope may do: query. Not begin, commit or release; the scope owns those. */
export interface Scoped {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<R>>;
}

/** The roles a scope may drop to. Each is NOBYPASSRLS and owns nothing (migrations 0003, 0018). */
export type RuntimeRole = 'sanad_app' | 'sanad_outbox';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Thrown from inside a scope to roll back without an error: the scope returns the carried value. */
export class Rollback<T> {
  readonly value: T;
  constructor(value: T) {
    this.value = value;
  }
}

async function scoped<T>(
  pool: Pool,
  role: RuntimeRole,
  tenantId: string | undefined,
  work: (db: Scoped) => Promise<T>,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('begin');
    // Identifiers cannot be parameters; the role is one of a closed set, never input.
    await client.query(role === 'sanad_outbox' ? 'set local role sanad_outbox' : 'set local role sanad_app');
    if (tenantId !== undefined) await client.query("select set_config('sanad.tenant_id', $1, true)", [tenantId]);
    const result = await work({ query: (text, values) => client.query(text, values as unknown[]) });
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // The connection is gone; nothing was committed. The original error is the one that matters.
    }
    if (error instanceof Rollback) return error.value as T;
    throw error;
  } finally {
    client.release();
  }
}

/** Work on one tenant's rows, and only that tenant's: RLS refuses every other row, read or write. */
export function inTenant<T>(pool: Pool, tenantId: string, work: (db: Scoped) => Promise<T>): Promise<T> {
  // An empty or malformed tenant would leave the setting null and the policies matching nothing; say so instead.
  if (!UUID.test(tenantId)) return Promise.reject(new Error('inTenant needs the tenant uuid, not a code'));
  return scoped(pool, 'sanad_app', tenantId, work);
}

/**
 * The outbox dispatcher's view: every tenant's events, and nothing else.
 * `sanad_outbox` can read and update `core.outbox_event` only (migration 0018).
 */
export function asOutboxDispatcher<T>(pool: Pool, work: (db: Scoped) => Promise<T>): Promise<T> {
  return scoped(pool, 'sanad_outbox', undefined, work);
}
