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
import { createHash, randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { type TenantCode, type WaslParties, loadBoardPositions, loadWaslParties } from '@sanad/config/loader.ts';
import type { EvidenceRecord } from '@sanad/core/evidence/evidence.ts';
import type { OutboxEvent } from '@sanad/core/outbox/outbox.ts';
import { type CurrencyCode, type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type TsaInstant, restoreAttestedInstant } from '@sanad/core/time/tsa.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { type Scoped, inTenant } from '@sanad/origination/tenant-scope.ts';
import type { ContractLeg } from '@sanad/products/murabaha-scf/legs/leg.ts';
import type { Transaction, TransactionCore } from '@sanad/products/murabaha-scf/sequencing/state.ts';

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

// -- A step's facts, as its event records them ----------------------------------------

/**
 * JSON for what a step carries beyond the core: whole bigints tagged as
 * strings, attested instants as the three fields they were recorded with —
 * restored through `restoreAttestedInstant`, never re-attested.
 */
function encodeValue(v: unknown): unknown {
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (Array.isArray(v)) return v.map(encodeValue);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (
      keys.length === 3 &&
      typeof o['epochSeconds'] === 'bigint' &&
      typeof o['tokenDigest'] === 'string' &&
      typeof o['authorityId'] === 'string'
    )
      return {
        $instant: {
          epochSeconds: o['epochSeconds'].toString(),
          tokenDigest: o['tokenDigest'],
          authorityId: o['authorityId'],
        },
      };
    return Object.fromEntries(keys.map((k) => [k, encodeValue(o[k])]));
  }
  return v;
}

function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o['$bigint'] === 'string') return BigInt(o['$bigint']);
    const instant = o['$instant'] as { epochSeconds: string; tokenDigest: string; authorityId: string } | undefined;
    if (instant !== undefined)
      return restoreAttestedInstant({
        epochSeconds: BigInt(instant.epochSeconds),
        tokenDigest: instant.tokenDigest,
        authorityId: instant.authorityId,
      });
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decodeValue(x)]));
  }
  return v;
}

/** The state a step left the transaction in, without its core (the opening event holds that). */
export function encodeState(t: Transaction): Record<string, unknown> {
  const { core: _core, ...rest } = t;
  return encodeValue(rest) as Record<string, unknown>;
}

export function decodeState(raw: unknown, core: TransactionCore): Transaction {
  return { ...(decodeValue(raw) as Omit<Transaction, 'core'>), core } as Transaction;
}

export const encodeEvidence = (e: EvidenceRecord): Record<string, unknown> => encodeValue(e) as Record<string, unknown>;
export const decodeEvidence = (raw: unknown): EvidenceRecord => decodeValue(raw) as EvidenceRecord;

/**
 * A name-based UUID (RFC 9562 version 8, from SHA-256) for an identifier the
 * domain writes as text: the board's template version (`murabaha_offer@3`)
 * goes into 0003's uuid column as the same UUID every time.
 */
export function nameUuid(name: string): string {
  const h = createHash('sha256').update(`sanad:template-version:${name}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x80;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const asUuid = (id: string): string => (/^[0-9a-f-]{36}$/i.test(id) ? id : randomUUID());

// -- Reference rows ------------------------------------------------------------------

interface ReferenceIds {
  readonly approvalId: string;
  readonly programmeId: string;
  readonly counterpartyId: string;
}

async function idOf(db: Scoped, sql: string, values: readonly unknown[]): Promise<string | undefined> {
  return (await db.query<{ id: string }>(sql, values)).rows[0]?.id;
}

/** What the reference rows are found by: a transaction's core, or a facility's distributor and programme (W5a). */
export type ReferenceKey = Pick<
  TransactionCore,
  'programmeId' | 'counterpartyId' | 'shariahApprovalId' | 'structureDefinitionId'
> & { readonly currency: string };

/**
 * The approval, programme (with its anchor) and distributor rows a transaction or a facility points at, written
 * once from configuration.
 */
export async function referenceRows(
  db: Scoped,
  tenantUuid: string,
  tenant: TenantCode,
  core: ReferenceKey,
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
     on conflict (tenant_id, code) do update set programme_limit_minor = excluded.programme_limit_minor`,
    [
      tenantUuid,
      anchorId,
      programme.programmeId,
      core.structureDefinitionId,
      core.currency,
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
    /** The programmes in force (configuration.ts `resolveWaslParties`); the checked-in file where none is given. */
    readonly parties?: WaslParties;
  },
): Promise<Result<true>> {
  const parties = opened.parties === undefined ? loadWaslParties(tenant) : { ok: true as const, value: opened.parties };
  if (!parties.ok) return parties;
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  const { core } = opened;
  const trade = core.tradeReference;
  try {
    return await inTenant(pool, tenantUuid, async (db) => {
      const refs = await referenceRows(
        db,
        tenantUuid,
        tenant,
        { ...core, currency: core.pricing.costAmount.currency },
        parties.value,
      );
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

/**
 * One step of the sequence, as written: what the step found (the state it
 * expects), where it leaves the transaction, the leg it executed or the
 * evidence it recorded, and its event.
 */
export interface StepWrite {
  readonly transactionRef: string;
  /** The state the step was taken from. If the row has moved meanwhile, nothing is written. */
  readonly expectedState: string;
  /** Where the step leaves it; the same as `expectedState` for a step that records evidence only. */
  readonly toState: string;
  readonly event: TransactionEventRow;
  readonly leg?: ContractLeg;
  readonly evidence?: EvidenceRecord;
  /** The evidence id the new evidence supersedes (a checker's validation of an earlier record). */
  readonly supersedes?: string;
  readonly riskPeriodStartAt?: TsaInstant;
  readonly saleOfferedAt?: TsaInstant;
  /** The obligation an executed sale books: its fixed total, the core's reference, and the schedule. */
  readonly obligation?: ObligationWrite;
  /**
   * What the obligation's paid amount moves by: a receipt adds, a returned payment takes off. The total never
   * moves; the database holds paid within what is payable.
   */
  readonly paidDelta?: Money;
  /** External side effects, written in the same transaction as the step that caused them (the transactional outbox). */
  readonly outbox?: readonly OutboxEvent[];
  /** A charity ledger entry raised, or its disbursement completed (W4b-2). */
  readonly charity?: CharityWrite;
  /** What the move does to the distributor's facility (W5a; steps.ts `limitMovement`). */
  readonly limit?: LimitMovement;
  readonly correlationId: string;
}

/**
 * The facility in the database (0004, 0031): HOLD a reservation for the cost at trade validation; CONSUME it into
 * utilisation at the purchase, registering the invoice as financed (SH-10); RELEASE it on an unwind before the
 * purchase; REPAY the utilisation on settlement or an unwind after it.
 */
export type LimitMovement = 'HOLD' | 'CONSUME' | 'RELEASE' | 'REPAY';

/**
 * The expiry 0004 requires of a reservation. A Wasl hold does not lapse on it: it counts against the facility until
 * the purchase consumes it or an unwind releases it, so capacity is never overstated.
 */
const HOLD_STANDS_SECONDS = 30 * 86_400;

/**
 * The segregated charity ledger (0003, 0030): an entry raised when a late
 * amount is collected, and later its disbursement to a board-approved
 * recipient, once. The database's write-once trigger refuses anything else.
 */
export type CharityWrite =
  | {
      readonly kind: 'RAISE';
      readonly entryId: string;
      readonly amount: Money;
      readonly sourceRef: string;
      readonly computationBasisKey: string;
      readonly recordedAt: TsaInstant;
    }
  | {
      readonly kind: 'DISBURSE';
      readonly entryId: string;
      readonly recipientId: string;
      readonly disbursementRef: string;
      readonly disbursedAt: TsaInstant;
    };

export interface ObligationWrite {
  readonly obligationId: string;
  readonly total: Money;
  readonly bookingRef: string;
  readonly instalments: readonly {
    readonly sequenceNumber: number;
    readonly dueDateGregorian: string;
    readonly dueDateHijri: string;
    readonly amount: Money;
  }[];
}

/** A database refusal, said in the domain's terms: the database is the second lock on the same rule. */
function refusalOf(error: unknown): Result<never> {
  const e = error as { code?: string; constraint?: string };
  if (e.constraint === 'obligation_paid_within_payable' || e.constraint === 'obligation_paid_amount_minor_check')
    return reject('OP-DETERMINACY', 'OVERPAYMENT', 'The database refused a paid amount outside what is payable');
  if (e.constraint === 'transaction_risk_interval_observed')
    return reject(
      'SH-06',
      'RISK_PERIOD_NOT_ELAPSED',
      'The database refused a sale offered inside the risk-holding interval',
    );
  if (e.constraint === 'transaction_post_possession_states_have_risk_start')
    return reject(
      'SH-05',
      'RISK_PERIOD_START_UNDETERMINED',
      'The database refused possession without its attested start',
    );
  if (e.code === '23001' && /schedule for obligation/.test(String((error as { message?: string }).message)))
    return reject('SH-02', 'SCHEDULE_NOT_TOTAL', 'The database refused a schedule that does not sum to the total');
  if (e.constraint === 'contract_leg_one_document_per_leg')
    return reject('SH-07', 'DOCUMENT_ALREADY_BOUND_TO_A_LEG', 'The database refused a document on a second leg');
  if (e.constraint === 'financed_invoice_unique')
    return reject('SH-10', 'DUPLICATE_FINANCING', 'The database refused financing an invoice a second time');
  if (e.code === '23001' && /over-committed/.test(String((error as { message?: string }).message)))
    return reject('OP-LIMIT', 'FACILITY_LIMIT_EXCEEDED', 'The database refused a hold beyond the facility');
  if (e.constraint === 'charity_ledger_source_once')
    return reject('SH-13', 'CHARITY_ALREADY_RAISED', 'The database refused a second charity entry for one collection');
  if (e.code === '23001' || e.code === '23505' || e.code === '23514')
    return reject('OP-CHAIN', 'DATABASE_REFUSED', 'The database refused the step; nothing was written', {
      constraint: e.constraint ?? e.code,
    });
  return reject('OP-DETERMINACY', 'PERSISTENCE_FAILED', 'The step was not written');
}

const at = (i: TsaInstant | undefined): string | null => (i === undefined ? null : i.epochSeconds.toString());

/** Write one step: the leg or evidence, the state and instants, and the event, in one tenant-scoped transaction. */
export async function recordStep(pool: Pool, tenant: TenantCode, w: StepWrite): Promise<Result<true>> {
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  const correlation = asUuid(w.correlationId);
  try {
    return await inTenant(pool, tenantUuid, async (db) => {
      const row = (
        await db.query<{ id: string; state: string }>(
          `select id::text, state from core.transaction where tenant_id = $1 and transaction_ref = $2 for update`,
          [tenantUuid, w.transactionRef],
        )
      ).rows[0];
      if (row === undefined)
        return reject('OP-DETERMINACY', 'TRANSACTION_NOT_FOUND', 'No such transaction', {
          transactionRef: w.transactionRef,
        });
      if (row.state !== w.expectedState)
        return reject('OP-DETERMINACY', 'TRANSACTION_MOVED', 'The transaction moved on meanwhile; reload it', {
          transactionRef: w.transactionRef,
        });
      const leg = w.leg;
      if (leg !== undefined)
        await db.query(
          `insert into core.contract_leg (id, tenant_id, transaction_id, leg_type, sequence_no, document_id,
             content_hash, prev_leg_hash, executed_at, tsa_token_digest, tsa_token, template_version_id,
             counterparty_role, counterparty_cr, correlation_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), $10, $11, $12, $13, $14, $15)`,
          [
            leg.legId,
            tenantUuid,
            row.id,
            leg.legType,
            leg.sequenceNo,
            leg.documentId,
            leg.contentHash,
            leg.prevLegHash ?? null,
            leg.executedAt.epochSeconds.toString(),
            leg.tsaTokenDigest,
            // The token as retained. The host-clock stand-in issues none, so its labelled digest stands in (SR-006).
            Buffer.from(leg.tsaTokenDigest, 'utf8'),
            nameUuid(leg.templateVersionId),
            leg.counterpartyRole,
            leg.counterpartyCr,
            correlation,
          ],
        );
      const ev = w.evidence;
      if (ev !== undefined) {
        await db.query(
          `insert into evidence.evidence (id, tenant_id, transaction_id, evidence_type, gate_satisfied, source,
             artefact_uri, artefact_hash, captured_at, captured_tsa_digest, validation_status, validation_detail,
             extraction_confidence_bp, correlation_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), $10, $11, $12, $13, $14)`,
          [
            ev.evidenceId,
            tenantUuid,
            row.id,
            ev.evidenceType,
            ev.gateSatisfied,
            ev.source,
            ev.artefactUri,
            ev.artefactHash,
            ev.capturedAt.epochSeconds.toString(),
            ev.capturedAt.tokenDigest,
            ev.validationStatus,
            ev.validationDetail === undefined ? null : JSON.stringify(ev.validationDetail),
            ev.extractionConfidencePerTenThousand ?? null,
            correlation,
          ],
        );
        if (w.supersedes !== undefined) {
          const superseded = await db.query(
            `update evidence.evidence set superseded_by = $3
              where tenant_id = $1 and id = $2::uuid and transaction_id = $4 and superseded_by is null`,
            [tenantUuid, w.supersedes, ev.evidenceId, row.id],
          );
          if (superseded.rowCount !== 1)
            return reject('OP-DETERMINACY', 'EVIDENCE_ALREADY_DECIDED', 'That evidence has already been decided', {
              evidenceId: w.supersedes,
            });
        }
      }
      const ob = w.obligation;
      if (ob !== undefined) {
        // The total and the schedule in one transaction: the deferred constraint checks their sum at commit (SH-02).
        await db.query(
          `insert into core.obligation (id, tenant_id, transaction_id, currency, total_amount_minor, booking_ref,
             correlation_id)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            ob.obligationId,
            tenantUuid,
            row.id,
            ob.total.currency,
            ob.total.minorUnits.toString(),
            ob.bookingRef,
            correlation,
          ],
        );
        for (const i of ob.instalments)
          await db.query(
            `insert into core.instalment (tenant_id, obligation_id, instalment_no, due_date_g, due_date_h, amount_minor)
             values ($1, $2, $3, $4, $5, $6)`,
            [
              tenantUuid,
              ob.obligationId,
              i.sequenceNumber,
              i.dueDateGregorian,
              i.dueDateHijri,
              i.amount.minorUnits.toString(),
            ],
          );
      }
      if (w.paidDelta !== undefined) {
        const moved = await db.query(
          `update core.obligation set paid_amount_minor = paid_amount_minor + $3
            where tenant_id = $1 and transaction_id = $2 and currency = $4`,
          [tenantUuid, row.id, w.paidDelta.minorUnits.toString(), w.paidDelta.currency],
        );
        if (moved.rowCount !== 1)
          return reject(
            'OP-DETERMINACY',
            'OBLIGATION_NOT_BOOKED',
            'The transaction has no obligation to apply this to',
          );
      }
      if (w.charity !== undefined) {
        const written = await writeCharity(db, tenantUuid, row.id, w.charity, correlation);
        if (!written.ok) return written;
      }
      if (w.limit !== undefined) {
        const moved = await moveLimit(db, tenantUuid, row.id, w.limit, w.event.occurredAtEpochSeconds, correlation);
        if (!moved.ok) return moved;
      }
      // The outbox table keys on the tenant's uuid; the events carry its code. One event per (tenant, kind, key).
      for (const o of w.outbox ?? [])
        await db.query(
          `insert into core.outbox_event (tenant_id, event_id, kind, subject_ref, idempotency_key, payload, correlation_id)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [tenantUuid, o.eventId, o.kind, o.subjectRef, o.idempotencyKey, JSON.stringify(o.payload), o.correlationId],
        );
      if (w.toState !== w.expectedState || w.riskPeriodStartAt !== undefined || w.saleOfferedAt !== undefined)
        await db.query(
          `update core.transaction
              set state = $3,
                  risk_period_start_at = coalesce(to_timestamp($4::bigint), risk_period_start_at),
                  sale_offered_at = coalesce(to_timestamp($5::bigint), sale_offered_at)
            where tenant_id = $1 and id = $2`,
          [tenantUuid, row.id, w.toState, at(w.riskPeriodStartAt), at(w.saleOfferedAt)],
        );
      await insertEvent(db, tenantUuid, row.id, w.event, w.correlationId);
      return ok(true as const);
    });
  } catch (error) {
    return refusalOf(error);
  }
}

/**
 * Move the facility inside the step's transaction. The capacity triggers (0004, 0031) check the facility at commit.
 * A transaction held before W5a has no reservation: its later moves leave the facility alone, and the purchase still
 * registers its invoice.
 */
async function moveLimit(
  db: Scoped,
  tenantUuid: string,
  transactionId: string,
  movement: LimitMovement,
  atEpochSeconds: bigint,
  correlation: string,
): Promise<Result<true>> {
  const at = atEpochSeconds.toString();
  // The facility row first, FOR UPDATE, before any reservation or utilisation is written: every writer on a facility
  // then queues on that one lock. Taken later — after an insert's foreign-key share lock — two writers upgrading at
  // commit (the capacity triggers' own FOR UPDATE) deadlock each other.
  await db.query(
    movement === 'HOLD'
      ? `select f.id from core.facility f join core.transaction t
           on f.tenant_id = t.tenant_id and f.counterparty_id = t.counterparty_id and f.programme_id = t.programme_id
          where t.tenant_id = $1 and t.id = $2 for update of f`
      : `select f.id from core.facility f join core.limit_reservation r on r.facility_id = f.id
          where r.tenant_id = $1 and r.transaction_id = $2 for update of f`,
    [tenantUuid, transactionId],
  );
  if (movement === 'HOLD') {
    const held = await db.query(
      `insert into core.limit_reservation (tenant_id, facility_id, transaction_id, amount_minor, state, held_at,
         expires_at, correlation_id)
       select t.tenant_id, f.id, t.id, t.cost_amount_minor, 'HELD', to_timestamp($3::bigint),
              to_timestamp($3::bigint + $4::bigint), $5
         from core.transaction t
         join core.facility f on f.tenant_id = t.tenant_id and f.counterparty_id = t.counterparty_id
                             and f.programme_id = t.programme_id and f.state = 'ACTIVE'
        where t.tenant_id = $1 and t.id = $2`,
      [tenantUuid, transactionId, at, String(HOLD_STANDS_SECONDS), correlation],
    );
    return held.rowCount === 1
      ? ok(true)
      : reject('OP-LIMIT', 'NO_FACILITY', 'The database has no active facility for this distributor and programme');
  }
  if (movement === 'RELEASE') {
    await db.query(
      `update core.limit_reservation set state = 'RELEASED', settled_at = to_timestamp($3::bigint)
        where tenant_id = $1 and transaction_id = $2 and state = 'HELD'`,
      [tenantUuid, transactionId, at],
    );
    return ok(true);
  }
  if (movement === 'CONSUME') {
    const consumed = await db.query<{ facility_id: string }>(
      `update core.limit_reservation set state = 'CONSUMED', settled_at = to_timestamp($3::bigint)
        where tenant_id = $1 and transaction_id = $2 and state = 'HELD'
        returning facility_id::text`,
      [tenantUuid, transactionId, at],
    );
    const facility = consumed.rows[0]?.facility_id;
    if (facility !== undefined)
      await db.query(
        `update core.facility f set utilised_minor = f.utilised_minor + t.cost_amount_minor, updated_at = now()
           from core.transaction t where f.tenant_id = $1 and f.id = $2::uuid and t.id = $3`,
        [tenantUuid, facility, transactionId],
      );
    // The registry has no ON CONFLICT: a second financing of the invoice is the control firing (0003).
    await db.query(
      `insert into core.financed_invoice_registry (tenant_id, invoice_uuid, invoice_hash, issuer_cr, recipient_cr,
         financed_amount_minor, currency, transaction_id, financed_at, correlation_id)
       select t.tenant_id, t.trade_invoice_uuid, coalesce(t.trade_invoice_hash, ''), t.trade_issuer_cr,
              t.trade_recipient_cr, t.cost_amount_minor, t.currency, t.id, to_timestamp($3::bigint), $4
         from core.transaction t where t.tenant_id = $1 and t.id = $2 and t.trade_invoice_uuid is not null`,
      [tenantUuid, transactionId, at, correlation],
    );
    return ok(true);
  }
  // REPAY: the utilisation this transaction consumed, back to its facility.
  await db.query(
    `update core.facility f set utilised_minor = f.utilised_minor - t.cost_amount_minor, updated_at = now()
       from core.transaction t, core.limit_reservation r
      where t.tenant_id = $1 and t.id = $2 and r.transaction_id = t.id and r.state = 'CONSUMED'
        and f.id = r.facility_id`,
    [tenantUuid, transactionId],
  );
  return ok(true);
}

/** Raise a charity entry, or complete its disbursement, inside the step's transaction. */
async function writeCharity(
  db: Scoped,
  tenantUuid: string,
  transactionId: string,
  charity: CharityWrite,
  correlation: string,
): Promise<Result<true>> {
  if (charity.kind === 'RAISE') {
    // Under the board approval the transaction runs under; the account class is the only one the table admits.
    await db.query(
      `insert into core.charity_ledger (id, tenant_id, transaction_id, currency, amount_minor, reason,
         computation_basis_config_key, shariah_approval_id, recorded_at, source_ref, correlation_id)
       select $1, $2, t.id, $3, $4, 'LATE_PAYMENT', $5, t.shariah_approval_id, to_timestamp($6), $7, $8
         from core.transaction t where t.tenant_id = $2 and t.id = $9`,
      [
        charity.entryId,
        tenantUuid,
        charity.amount.currency,
        charity.amount.minorUnits.toString(),
        charity.computationBasisKey,
        charity.recordedAt.epochSeconds.toString(),
        charity.sourceRef,
        correlation,
        transactionId,
      ],
    );
    return ok(true);
  }
  const disbursed = await db.query(
    `update core.charity_ledger
        set disbursement_ref = $3, disbursed_at = to_timestamp($4), recipient_id = $5
      where tenant_id = $1 and id = $2::uuid and transaction_id = $6 and disbursement_ref is null`,
    [
      tenantUuid,
      charity.entryId,
      charity.disbursementRef,
      charity.disbursedAt.epochSeconds.toString(),
      charity.recipientId,
      transactionId,
    ],
  );
  return disbursed.rowCount === 1
    ? ok(true)
    : reject('SH-13', 'ALREADY_DISBURSED', 'This charity entry is disbursed already, or is not this one', {
        entryId: charity.entryId,
      });
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
