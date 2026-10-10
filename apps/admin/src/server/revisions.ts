/**
 * Configuration revisions, as the administration surface uses them: the
 * database functions of migration 0009, and nothing written to the table
 * directly. The rules (four eyes, immutability, effectiveness) live in the
 * database and in core/config/revision.ts; this module only carries calls.
 */

import { Pool } from 'pg';

import type { RevisionArea } from '@sanad/core/config/revision.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';

export interface RevisionRow {
  readonly id: string;
  readonly summary: string;
  readonly effectiveFrom: string;
  readonly status: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly rejectionReason: string | null;
}

export async function listRevisions(
  pool: Pool,
  tenantCode: string,
  area: RevisionArea,
): Promise<readonly RevisionRow[]> {
  const t = await tenantUuidByCode(pool, tenantCode);
  const r = await pool.query<{
    id: string;
    summary: string;
    effective_from: Date;
    status: RevisionRow['status'];
    proposed_by: string;
    proposed_at: Date;
    decided_by: string | null;
    decided_at: Date | null;
    rejection_reason: string | null;
  }>('select * from config.list_revisions($1::uuid, $2)', [t, area]);
  return r.rows.map((x) => ({
    id: x.id,
    summary: x.summary,
    effectiveFrom: x.effective_from.toISOString(),
    status: x.status,
    proposedBy: x.proposed_by,
    proposedAt: x.proposed_at.toISOString(),
    decidedBy: x.decided_by,
    decidedAt: x.decided_at === null ? null : x.decided_at.toISOString(),
    rejectionReason: x.rejection_reason,
  }));
}

/** One revision's payload, of this tenant only: another tenant's revision is absent (SR-029). */
export async function revisionPayload(pool: Pool, tenantCode: string, id: string): Promise<unknown> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  return (
    await pool.query<{ payload: unknown }>('select config.revision_payload($1::uuid, $2::uuid) as payload', [
      tenant,
      id,
    ])
  ).rows[0]?.payload;
}

export async function proposeRevision(
  pool: Pool,
  p: {
    readonly tenantCode: string;
    readonly area: RevisionArea;
    readonly payload: unknown;
    readonly summary: string;
    readonly effectiveFromEpochSeconds: bigint;
    readonly proposedBy: string;
    readonly correlationId: string;
  },
): Promise<string> {
  const t = await tenantUuidByCode(pool, p.tenantCode);
  const r = await pool.query<{ id: string }>(
    'select config.propose_revision($1::uuid, $2, $3::jsonb, $4, to_timestamp($5::bigint), $6, $7::uuid) as id',
    [
      t,
      p.area,
      JSON.stringify(p.payload),
      p.summary,
      p.effectiveFromEpochSeconds.toString(),
      p.proposedBy,
      p.correlationId,
    ],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('propose returned no id');
  return id;
}

export async function decideRevision(
  pool: Pool,
  p: {
    readonly id: string;
    readonly decidedBy: string;
    readonly approve: boolean;
    readonly reason?: string;
    readonly correlationId: string;
  },
): Promise<void> {
  await pool.query('select config.decide_revision($1::uuid, $2, $3, $4, $5::uuid)', [
    p.id,
    p.decidedBy,
    p.approve,
    p.reason ?? null,
    p.correlationId,
  ]);
}
