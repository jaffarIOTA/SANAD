/**
 * The audit chain, verified outside the database (SR-011).
 *
 * `audit.verify_chain()` checks the chain inside PostgreSQL. This recomputes it
 * independently: it trusts neither the stored hashes nor the database's own
 * verifier, only the rows. The database supplies each JSON column as its
 * canonical text (`jsonb::text`) and each instant in both encodings, because
 * that is what was hashed; the linking and the SHA-256 are done here.
 *
 * A deleted row breaks the next row's link, an altered row its own hash, a
 * reordered pair the links of both. The newest rows can be removed without
 * trace; anchoring the head outside the database is SR-008.
 */

import { createHash } from 'node:crypto';

import type { Scoped } from './tenant-scope.ts';

export type AuditChainResult =
  | { readonly ok: true; readonly checked: number }
  | {
      readonly ok: false;
      readonly checked: number;
      readonly firstBrokenId: string;
      readonly reason: 'PREV_HASH_MISMATCH' | 'CONTENT_HASH_MISMATCH' | 'UNKNOWN_HASH_VERSION';
    };

interface Row {
  readonly id: string;
  readonly tenant_id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly event_type: string;
  readonly before_text: string | null;
  readonly after_text: string | null;
  readonly actor: string;
  readonly at_v1: string;
  readonly at_v2: string;
  readonly correlation_id: string;
  readonly prev_hash: string | null;
  readonly content_hash: string;
  readonly hash_version: number;
}

/** The hash a row should carry, from its fields and its predecessor's hash (migration 0019, `audit.content_hash`). */
export function auditContentHash(row: Row): string | undefined {
  const at = row.hash_version === 1 ? row.at_v1 : row.hash_version === 2 ? row.at_v2 : undefined;
  if (at === undefined) return undefined;
  const text = [
    row.prev_hash ?? '',
    row.tenant_id,
    row.subject_type,
    row.subject_id,
    row.event_type,
    row.before_text ?? '',
    row.after_text ?? '',
    row.actor,
    at,
    row.correlation_id,
  ].join('|');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * One tenant's chain, oldest first. `db` reads through a scope that can see the
 * tenant's audit rows: `inTenant(pool, tenant, (db) => verifyAuditChain(db, tenant))`.
 */
export async function verifyAuditChain(db: Scoped, tenantId: string): Promise<AuditChainResult> {
  const { rows } = await db.query<Row>(
    // ORDER BY the table's column: a bare `id` would name the text cast above, and text sorts '12' before '2'.
    `select a.id::text as id, a.tenant_id::text as tenant_id, a.subject_type, a.subject_id::text as subject_id,
            a.event_type, a.before_state::text as before_text, a.after_state::text as after_text, a.actor,
            ((a.occurred_at at time zone 'UTC')::text || '+00') as at_v1,
            ((extract(epoch from a.occurred_at) * 1000000)::bigint)::text as at_v2,
            a.correlation_id::text as correlation_id, a.prev_hash, a.content_hash, a.hash_version
       from audit.audit_event a
      where a.tenant_id = $1::uuid
      order by a.id`,
    [tenantId],
  );
  let previous: string | null = null;
  let checked = 0;
  for (const row of rows) {
    checked += 1;
    if (row.prev_hash !== previous) return { ok: false, checked, firstBrokenId: row.id, reason: 'PREV_HASH_MISMATCH' };
    const expected = auditContentHash(row);
    if (expected === undefined) return { ok: false, checked, firstBrokenId: row.id, reason: 'UNKNOWN_HASH_VERSION' };
    if (expected !== row.content_hash)
      return { ok: false, checked, firstBrokenId: row.id, reason: 'CONTENT_HASH_MISMATCH' };
    previous = row.content_hash;
  }
  return { ok: true, checked };
}
