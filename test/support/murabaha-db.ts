/**
 * A minimal Murabaha graph in a real database, for the DB-level control tests:
 * a Shariah approval, an anchor, a programme, a counterparty and a transaction,
 * and on request the policy version, snapshot, decision and facility a limit
 * reservation needs. Written as the owner (migrations' role), with fresh
 * identifiers each time, because every table here is append-only.
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

export interface MurabahaGraph {
  readonly tenantId: string;
  readonly approvalId: string;
  readonly programmeId: string;
  readonly counterpartyId: string;
  readonly transactionId: string;
}

const code = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

export async function murabahaGraph(
  pool: Pool,
  tenantCode = 'bank-a',
  transaction: { readonly state?: string; readonly cost?: bigint; readonly profit?: bigint } = {},
): Promise<MurabahaGraph> {
  const tenantId = (await pool.query<{ id: string }>('select id::text from core.tenant where code = $1', [tenantCode]))
    .rows[0]?.id as string;
  const one = async (sql: string, values: unknown[]) =>
    (await pool.query<{ id: string }>(`${sql} returning id::text`, values)).rows[0]?.id as string;

  const approvalId = await one(
    `insert into core.shariah_approval (tenant_id, approval_ref, approving_body, product_code, structure_code, effective_from)
     values ($1, $2, 'Test Board', 'murabaha-scf', 'MURABAHA', current_date)`,
    [tenantId, code('SSB')],
  );
  const anchorId = await one(
    `insert into core.anchor (tenant_id, registration_no, name_ar, name_en) values ($1, $2, 'مرساة', 'Anchor')`,
    [tenantId, code('ANC')],
  );
  const programmeId = await one(
    `insert into core.programme (tenant_id, anchor_id, code, structure_code, structure_definition_id, programme_limit_minor,
       shariah_approval_id, state)
     values ($1, $2, $3, 'MURABAHA', 'murabaha-v1', 100000000, $4, 'ACTIVE')`,
    [tenantId, anchorId, code('PRG'), approvalId],
  );
  const counterpartyId = await one(
    `insert into core.counterparty (tenant_id, registration_no, name_ar, name_en, state)
     values ($1, $2, 'طرف', 'Counterparty', 'ACTIVE')`,
    [tenantId, code('CP')],
  );
  const cost = transaction.cost ?? 1_000_000n;
  const profit = transaction.profit ?? 50_000n;
  const transactionId = await one(
    `insert into core.transaction (tenant_id, programme_id, counterparty_id, structure_code, structure_definition_id,
       structure_version, state, cost_amount_minor, profit_amount_minor, sale_price_amount_minor, tenor_days,
       maturity_date_g, maturity_date_h, risk_period_required_s, shariah_approval_id, credit_policy_version, correlation_id)
     values ($1, $2, $3, 'MURABAHA', 'murabaha-v1', 1, $4, $5, $6, $7, 90, current_date + 90, '1448-06-01', 3600, $8,
             'policy-v1', gen_random_uuid())`,
    [
      tenantId,
      programmeId,
      counterpartyId,
      transaction.state ?? 'DRAFT',
      cost.toString(),
      profit.toString(),
      (cost + profit).toString(),
      approvalId,
    ],
  );
  return { tenantId, approvalId, programmeId, counterpartyId, transactionId };
}

/** A facility of `limitMinor` for the graph's counterparty and programme, with the decision it rests on. */
export async function facility(pool: Pool, g: MurabahaGraph, limitMinor: bigint): Promise<string> {
  const one = async (sql: string, values: unknown[]) =>
    (await pool.query<{ id: string }>(`${sql} returning id::text`, values)).rows[0]?.id as string;
  const policyId = await one(
    `insert into config.credit_policy_version (tenant_id, policy_id, version, effective_from, credit_approval_ref,
       approved_by_role, approved_on, document, document_hash)
     values ($1, $2, 'v1', now() - interval '1 day', 'CRC-1', 'CRO', now() - interval '1 day', '{}'::jsonb, 'h')`,
    [g.tenantId, code('POL')],
  );
  const snapshotId = await one(
    `insert into core.applicant_snapshot (tenant_id, counterparty_id, programme_id, captured_at, facts, facts_hash, correlation_id)
     values ($1, $2, $3, now(), '{}'::jsonb, 'h', gen_random_uuid())`,
    [g.tenantId, g.counterpartyId, g.programmeId],
  );
  const decisionId = await one(
    `insert into core.decision (tenant_id, counterparty_id, programme_id, snapshot_id, policy_version_id, outcome, score,
       assigned_limit_minor, correlation_id)
     values ($1, $2, $3, $4, $5, 'APPROVE', 700, $6, gen_random_uuid())`,
    [g.tenantId, g.counterpartyId, g.programmeId, snapshotId, policyId, limitMinor.toString()],
  );
  return one(
    `insert into core.facility (tenant_id, counterparty_id, programme_id, decision_id, limit_minor, correlation_id)
     values ($1, $2, $3, $4, $5, gen_random_uuid())`,
    [g.tenantId, g.counterpartyId, g.programmeId, decisionId, limitMinor.toString()],
  );
}
