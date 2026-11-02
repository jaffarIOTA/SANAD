/**
 * Murabaha transactions on PostgreSQL (migrations 0003 and 0027).
 *
 * The figures, the state, the gate instants and the links live in
 * `core.transaction`, so the database's own Murabaha controls bind them: the
 * total is cost plus profit, the executed amounts never change, the risk
 * interval is observed before a sale is offered, one transaction per request.
 * What the domain's state carries beyond those columns — the full core as
 * opened, and each step's facts (evidence ids, legs, instants) — is in the
 * transaction's append-only event log, from which the domain state is rebuilt.
 *
 * The reference rows a transaction points at — the board's approval, the
 * programme and its anchor, the distributor — are written from the tenant's
 * configuration (config/tenants/<t>/wasl/parties.json, shariah/board-positions.json)
 * the first time they are needed, and never changed here.
 *
 * Every statement runs inside the tenant's scope as the runtime role
 * (`inTenant`, SR-003).
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { type TenantCode, type WaslParties, loadBoardPositions, loadWaslParties } from '@sanad/config/loader.ts';
import { type CurrencyCode, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { type Scoped, inTenant } from '@sanad/origination/tenant-scope.ts';
import type { TransactionCore } from '@sanad/products/murabaha-scf/sequencing/state.ts';

export interface TransactionEventRow {
  readonly eventType: string;
  readonly fromState: string | null;
  readonly toState: string | null;
  readonly actor: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly occurredAtEpochSeconds: bigint;
}

export interface PersistedTransaction {
  readonly transactionRef: string;
  readonly requestRef: string;
  readonly state: string;
  readonly events: readonly TransactionEventRow[];
}

// -- The core, as the opening event records it -----------------------------------------

/** The transaction core as JSON: amounts as minor-unit strings, nothing else changed. */
export function encodeCore(core: TransactionCore): Record<string, unknown> {
  const m = (x: { minorUnits: bigint; currency: string }) => ({
    minorUnits: x.minorUnits.toString(),
    currency: x.currency,
  });
  return {
    ...core,
    pricing: {
      costAmount: m(core.pricing.costAmount),
      profitAmount: m(core.pricing.profitAmount),
      salePriceAmount: m(core.pricing.salePriceAmount),
    },
  };
}

export function decodeCore(raw: unknown): TransactionCore {
  const c = raw as TransactionCore & {
    pricing: Record<'costAmount' | 'profitAmount' | 'salePriceAmount', { minorUnits: string; currency: CurrencyCode }>;
  };
  const m = (x: { minorUnits: string; currency: CurrencyCode }) => money(BigInt(x.minorUnits), x.currency);
  return {
    ...c,
    pricing: {
      costAmount: m(c.pricing.costAmount),
      profitAmount: m(c.pricing.profitAmount),
      salePriceAmount: m(c.pricing.salePriceAmount),
    },
  };
}

// -- Reference rows ------------------------------------------------------------------

interface ReferenceIds {
  readonly approvalId: string;
  readonly programmeId: string;
  readonly counterpartyId: string;
}

async function idOf(db: Scoped, sql: string, values: readonly unknown[]): Promise<string | undefined> {
  return (await db.query<{ id: string }>(sql, values)).rows[0]?.id;
}

/** The approval, programme (with its anchor) and distributor rows a transaction points at, written once from configuration. */
async function referenceRows(
  db: Scoped,
  tenantUuid: string,
  tenant: TenantCode,
  core: TransactionCore,
  parties: WaslParties,
): Promise<Result<ReferenceIds>> {
  const board = loadBoardPositions(tenant);
  if (!board.ok) return board;
  const programme = parties.programmes.find((p) => p.programmeId === core.programmeId);
  if (programme === undefined)
    return reject(
      'OP-DETERMINACY',
      'PROGRAMME_NOT_CONFIGURED',
      'The request names a programme that is not configured',
      {
        programmeId: core.programmeId,
      },
    );
  const distributor = parties.distributors.find((d) => d.counterpartyId === core.counterpartyId);
  if (distributor === undefined)
    return reject(
      'OP-DETERMINACY',
      'COUNTERPARTY_NOT_CONFIGURED',
      'The request names a distributor that is not onboarded',
    );
  const correlation = randomUUID();

  await db.query(
    `insert into core.shariah_approval (tenant_id, approval_ref, approving_body, product_code, structure_code, effective_from, correlation_id)
     values ($1, $2, 'Shariah board', 'murabaha-scf', 'MURABAHA', current_date, $3)
     on conflict (tenant_id, approval_ref) do nothing`,
    [tenantUuid, core.shariahApprovalId, correlation],
  );
  const approvalId = await idOf(
    db,
    'select id::text from core.shariah_approval where tenant_id = $1 and approval_ref = $2',
    [tenantUuid, core.shariahApprovalId],
  );
  await db.query(
    `insert into core.anchor (tenant_id, registration_no, name_ar, name_en, correlation_id) values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, registration_no) do nothing`,
    [tenantUuid, programme.anchor.registrationNo, programme.anchor.nameAr, programme.anchor.nameEn, correlation],
  );
  const anchorId = await idOf(db, 'select id::text from core.anchor where tenant_id = $1 and registration_no = $2', [
    tenantUuid,
    programme.anchor.registrationNo,
  ]);
  await db.query(
    `insert into core.programme (tenant_id, anchor_id, code, structure_code, structure_definition_id, currency,
       programme_limit_minor, shariah_approval_id, state, correlation_id)
     values ($1, $2, $3, 'MURABAHA', $4, $5, $6, $7, 'ACTIVE', $8)
     on conflict (tenant_id, code) do nothing`,
    [
      tenantUuid,
      anchorId,
      programme.programmeId,
      core.structureDefinitionId,
      core.pricing.costAmount.currency,
      programme.programmeLimitMinorUnits.toString(),
      approvalId,
      correlation,
    ],
  );
  const programmeId = await idOf(db, 'select id::text from core.programme where tenant_id = $1 and code = $2', [
    tenantUuid,
    programme.programmeId,
  ]);
  await db.query(
    `insert into core.counterparty (tenant_id, registration_no, name_ar, name_en, state, correlation_id)
     values ($1, $2, $3, $4, 'ACTIVE', $5)
     on conflict (tenant_id, registration_no) do nothing`,
    [tenantUuid, distributor.registrationNo, distributor.nameAr, distributor.nameEn, correlation],
  );
  const counterpartyId = await idOf(
    db,
    'select id::text from core.counterparty where tenant_id = $1 and registration_no = $2',
    [tenantUuid, distributor.registrationNo],
  );
  if (approvalId === undefined || programmeId === undefined || counterpartyId === undefined)
    return reject('OP-DETERMINACY', 'PERSISTENCE_FAILED', 'The reference rows could not be written');
  return ok({ approvalId, programmeId, counterpartyId });
}

// -- Writes --------------------------------------------------------------------------

/** Insert the opened transaction (DRAFT) and its opening event, in one tenant-scoped database transaction. */
export async function insertOpenedTransaction(
  pool: Pool,
  tenant: TenantCode,
  opened: {
    readonly transactionRef: string;
    readonly requestRef: string;
    readonly core: TransactionCore;
    readonly event: TransactionEventRow;
  },
): Promise<Result<true>> {
  const parties = loadWaslParties(tenant);
  if (!parties.ok) return parties;
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  const { core } = opened;
  const trade = core.tradeReference;
  try {
    return await inTenant(pool, tenantUuid, async (db) => {
      const refs = await referenceRows(db, tenantUuid, tenant, core, parties.value);
      if (!refs.ok) return refs;
      const correlation = /^[0-9a-f-]{36}$/i.test(core.correlationId) ? core.correlationId : randomUUID();
      const row = await idOf(
        db,
        `insert into core.transaction (tenant_id, programme_id, counterparty_id, structure_code, structure_definition_id,
           structure_version, state, currency, cost_amount_minor, profit_amount_minor, sale_price_amount_minor,
           tenor_days, maturity_date_g, maturity_date_h, risk_period_required_s, shariah_approval_id,
           credit_policy_version, correlation_id, transaction_ref, request_ref, trade_invoice_uuid,
           trade_invoice_hash, trade_issuer_cr, trade_recipient_cr)
         values ($1, $2, $3, $4, $5, $6, 'DRAFT', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
           $21, $22, $23)
         returning id::text`,
        [
          tenantUuid,
          refs.value.programmeId,
          refs.value.counterpartyId,
          core.structureCode,
          core.structureDefinitionId,
          core.structureVersion,
          core.pricing.costAmount.currency,
          core.pricing.costAmount.minorUnits.toString(),
          core.pricing.profitAmount.minorUnits.toString(),
          core.pricing.salePriceAmount.minorUnits.toString(),
          core.tenorDays,
          core.maturityDateGregorian,
          core.maturityDateHijri,
          core.riskPeriodRequiredSeconds,
          refs.value.approvalId,
          core.creditPolicyVersion,
          correlation,
          opened.transactionRef,
          opened.requestRef,
          trade.invoiceUuid ?? null,
          trade.invoiceHash ?? null,
          trade.issuerCr,
          trade.recipientCr,
        ],
      );
      if (row === undefined) return reject('OP-DETERMINACY', 'PERSISTENCE_FAILED', 'The transaction was not written');
      await insertEvent(db, tenantUuid, row, opened.event, core.correlationId);
      return ok(true as const);
    });
  } catch (error) {
    const e = error as { code?: string; constraint?: string };
    // The one-transaction-per-request index: the file is already open.
    if (e.code === '23505' && e.constraint === 'transaction_request_once')
      return reject('OP-DETERMINACY', 'TRANSACTION_ALREADY_OPEN', 'A transaction is already open for this request');
    // Another process took the reference first; nothing was written, and opening again takes the next one.
    if (e.code === '23505' && e.constraint === 'transaction_ref_once')
      return reject(
        'OP-DETERMINACY',
        'TRANSACTION_REF_TAKEN',
        'Another transaction took that reference; open it again',
      );
    return reject('OP-DETERMINACY', 'PERSISTENCE_FAILED', 'The transaction was not written');
  }
}

async function insertEvent(
  db: Scoped,
  tenantUuid: string,
  transactionId: string,
  event: TransactionEventRow,
  correlationId: string,
): Promise<void> {
  await db.query(
    `insert into core.transaction_event (tenant_id, transaction_id, event_type, from_state, to_state, actor, detail,
       occurred_at_epoch, correlation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      tenantUuid,
      transactionId,
      event.eventType,
      event.fromState,
      event.toState,
      event.actor,
      JSON.stringify(event.detail),
      event.occurredAtEpochSeconds.toString(),
      correlationId,
    ],
  );
}

// -- Reads ---------------------------------------------------------------------------

/** The tenant's workbench transactions with their events, oldest first. */
export async function loadTransactions(pool: Pool, tenant: TenantCode): Promise<readonly PersistedTransaction[]> {
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  return inTenant(pool, tenantUuid, async (db) => {
    const { rows } = await db.query<{
      id: string;
      transaction_ref: string;
      request_ref: string;
      state: string;
    }>(
      `select id::text, transaction_ref, request_ref, state from core.transaction
        where tenant_id = $1 and transaction_ref is not null order by created_at, transaction_ref`,
      [tenantUuid],
    );
    const events = await db.query<{
      transaction_id: string;
      event_type: string;
      from_state: string | null;
      to_state: string | null;
      actor: string;
      detail: Record<string, unknown>;
      occurred_at_epoch: string;
    }>(
      `select transaction_id::text, event_type, from_state, to_state, actor, detail, occurred_at_epoch::text
         from core.transaction_event where tenant_id = $1 order by occurred_at_epoch, created_at`,
      [tenantUuid],
    );
    return rows.map((r) => ({
      transactionRef: r.transaction_ref,
      requestRef: r.request_ref,
      state: r.state,
      events: events.rows
        .filter((e) => e.transaction_id === r.id)
        .map((e) => ({
          eventType: e.event_type,
          fromState: e.from_state,
          toState: e.to_state,
          actor: e.actor,
          detail: e.detail,
          occurredAtEpochSeconds: BigInt(e.occurred_at_epoch),
        })),
    }));
  });
}
