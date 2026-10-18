/**
 * Murabaha transactions in the workbench (Wasl W1): an approved origination
 * request opens one transaction, in DRAFT, and staff can see where every
 * transaction stands.
 *
 * Opening is the product module's `execute()` (products/murabaha-scf/index.ts):
 * the board's structure and positions bind first (SR-025), the invoice's goods
 * are screened against the board's register (SH-11), the profit amount is
 * quoted from the tenant's catalogue, and the result is a `Draft` — never a
 * later state. A checker's approval opens a file; it executes nothing.
 *
 * Stored in `core.transaction` and its event log (murabaha-persistence.ts)
 * when a database is configured, so the database's Murabaha controls bind it;
 * in this process's memory otherwise, as the rest of the workbench does.
 * One transaction per request: opening twice returns the one already open.
 */
import {
  type TenantCode,
  loadBoardPositions,
  loadCreditPolicyVersions,
  loadProductCatalogue,
  loadStructureDefinition,
} from '@sanad/config/loader.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { resolvePricingInputs } from '@sanad/core/pricing/quotation.ts';
import { entryFor } from '@sanad/core/products/catalogue.ts';
import { murabahaScf } from '@sanad/products/murabaha-scf/index.ts';
import { type GateEvaluation, evaluateGates } from '@sanad/products/murabaha-scf/sequencing/gates.ts';
import type { Transaction } from '@sanad/products/murabaha-scf/sequencing/state.ts';
import type { StructureDefinition } from '@sanad/products/murabaha-scf/structures/definition.ts';

import { servicingCalendarOf } from './business.ts';
import { ummAlQuraIso } from './hijri.ts';
import { invoiceGoodsLines } from './invoices.ts';
import type { EvidenceRecord } from '@sanad/core/evidence/evidence.ts';

import {
  type PersistedTransaction,
  type TransactionEventRow,
  decodeCore,
  decodeEvidence,
  decodeState,
  encodeCore,
  insertOpenedTransaction,
  loadTransactions,
} from './murabaha-persistence.ts';
import { persistencePool } from './persistence.ts';
import { developmentAttestation, findApproved } from './store.ts';

const STRUCTURE = 'MURABAHA_DISTRIBUTOR';
const PRODUCT = 'murabaha-scf';

export interface TransactionRecord {
  readonly transactionRef: string;
  readonly requestRef: string;
  readonly transaction: Transaction;
  /** Every evidence record, superseded ones included (marked), in the order recorded. */
  readonly evidence: readonly EvidenceRecord[];
  readonly events: readonly TransactionEventRow[];
}

export interface TransactionView extends TransactionRecord {
  /** Where each of the structure's gates stands, from the transaction's legs and evidence: pure, as the sequencing engine sees it. */
  readonly gates: GateEvaluation;
  readonly openedBy: string;
  readonly openedAtEpochSeconds: bigint;
}

export interface TenantTransactions {
  readonly records: Map<string, TransactionRecord>;
  hydrated: boolean;
  lock: Promise<unknown>;
}

const KEY = Symbol.for('sanad.ops.murabahaTransactions');
const books = (): Map<string, TenantTransactions> => {
  const g = globalThis as { [KEY]?: Map<string, TenantTransactions> };
  g[KEY] ??= new Map();
  return g[KEY];
};

function bookOf(tenant: TenantCode): TenantTransactions {
  let b = books().get(tenant);
  if (b === undefined) {
    b = { records: new Map(), hydrated: false, lock: Promise.resolve() };
    books().set(tenant, b);
  }
  return b;
}

/** Tests only: forget every transaction. */
export function resetTransactions(): void {
  books().clear();
}

/**
 * The domain state as the event log rebuilds it: the core from the opening
 * event, then each step's resulting state (W2: `detail.state`) and each piece
 * of evidence it recorded (`detail.evidence`, superseding `detail.supersedes`).
 */
export function replay(persisted: PersistedTransaction): TransactionRecord | undefined {
  const opened = persisted.events.find((e) => e.eventType === 'TRANSACTION_OPENED');
  if (opened === undefined) return undefined;
  const core = decodeCore(opened.detail['core']);
  let transaction: Transaction = { state: 'DRAFT', core };
  const evidence = new Map<string, EvidenceRecord>();
  for (const e of persisted.events) {
    if (e.detail['state'] !== undefined) transaction = decodeState(e.detail['state'], core);
    if (e.detail['evidence'] === undefined) continue;
    const record = decodeEvidence(e.detail['evidence']);
    const superseded = e.detail['supersedes'];
    const old = typeof superseded === 'string' ? evidence.get(superseded) : undefined;
    if (old !== undefined) evidence.set(old.evidenceId, { ...old, supersededBy: record.evidenceId });
    evidence.set(record.evidenceId, record);
  }
  return {
    transactionRef: persisted.transactionRef,
    requestRef: persisted.requestRef,
    transaction,
    evidence: [...evidence.values()],
    events: persisted.events,
  };
}

export async function hydrate(tenant: TenantCode): Promise<TenantTransactions> {
  const book = bookOf(tenant);
  if (book.hydrated) return book;
  const pool = persistencePool();
  if (pool !== undefined)
    for (const p of await loadTransactions(pool, tenant)) {
      const r = replay(p);
      if (r !== undefined) book.records.set(r.transactionRef, r);
    }
  book.hydrated = true;
  return book;
}

export function withLock<T>(tenant: TenantCode, work: () => Promise<T>): Promise<T> {
  const book = bookOf(tenant);
  const run = book.lock.then(work, work);
  book.lock = run.catch(() => undefined);
  return run;
}

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

export function structureOf(tenant: TenantCode): Result<StructureDefinition> {
  return loadStructureDefinition(tenant, STRUCTURE);
}

export function viewOf(tenant: TenantCode, record: TransactionRecord): TransactionView {
  const opened = record.events.find((e) => e.eventType === 'TRANSACTION_OPENED');
  const structure = structureOf(tenant);
  const legs = 'legs' in record.transaction ? record.transaction.legs : [];
  const gates: GateEvaluation = structure.ok
    ? evaluateGates({
        definition: structure.value,
        legs,
        evidence: record.evidence,
        riskPeriodRequiredSeconds: record.transaction.core.riskPeriodRequiredSeconds,
        observedAt: developmentAttestation(),
      })
    : { gates: [], unsatisfied: [], allSatisfied: false };
  return {
    ...record,
    gates,
    openedBy: opened?.actor ?? '',
    openedAtEpochSeconds: opened?.occurredAtEpochSeconds ?? 0n,
  };
}

export async function listTransactions(tenant: TenantCode): Promise<readonly TransactionView[]> {
  const book = await hydrate(tenant);
  return [...book.records.values()]
    .map((r) => viewOf(tenant, r))
    .sort((a, b) => b.transactionRef.localeCompare(a.transactionRef));
}

export async function getTransaction(tenant: TenantCode, transactionRef: string): Promise<TransactionView | undefined> {
  const book = await hydrate(tenant);
  const r = book.records.get(transactionRef);
  return r === undefined ? undefined : viewOf(tenant, r);
}

export async function transactionForRequest(
  tenant: TenantCode,
  requestRef: string,
): Promise<TransactionView | undefined> {
  const book = await hydrate(tenant);
  const r = [...book.records.values()].find((x) => x.requestRef === requestRef);
  return r === undefined ? undefined : viewOf(tenant, r);
}

const DAY_MS = 86_400_000;
/** A civil date plus whole days (yyyy-mm-dd), by calendar arithmetic on the date itself; no clock is read. */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((x) => Number(x));
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Open the transaction an approved request authorises, in DRAFT. Idempotent on
 * the request: a second call returns the transaction already open.
 */
export async function openTransactionForRequest(
  tenant: TenantCode,
  requestRef: string,
  actor: string,
): Promise<Result<TransactionView>> {
  return withLock(tenant, async () => {
    const book = await hydrate(tenant);
    const existing = [...book.records.values()].find((r) => r.requestRef === requestRef);
    if (existing !== undefined) return ok(viewOf(tenant, existing));
    const approved = findApproved(requestRef);
    if (approved?.core.tenantId !== tenant)
      return fail('REQUEST_NOT_APPROVED', 'Only an approved request opens a transaction', { requestRef });

    const at = developmentAttestation();
    const catalogue = loadProductCatalogue(tenant);
    if (!catalogue.ok) return catalogue;
    const entry = entryFor(catalogue.value, PRODUCT, approved.core.programmeId, at.epochSeconds);
    if (!entry.ok) return entry;
    const terms = murabahaScf.validateTerms(entry.value.terms);
    if (!terms.ok) return terms;
    const inputs = resolvePricingInputs(entry.value.pricingRule, {
      principal: approved.core.requestedAmount,
      tenorDays: approved.core.requestedTenorDays,
      asOfEpochSeconds: at.epochSeconds,
    });
    if (!inputs.ok) return inputs;
    const quote = murabahaScf.quote(terms.value, {
      tenantId: tenant,
      programmeId: approved.core.programmeId,
      counterpartyId: approved.core.counterpartyId,
      requestedAmount: approved.core.requestedAmount,
      tradeReference: approved.core.tradeReference,
      requestedTenorDays: approved.core.requestedTenorDays,
      asOf: at,
      pricing: inputs.value,
    });
    if (!quote.ok) return quote;

    const structure = structureOf(tenant);
    if (!structure.ok) return structure;
    const board = loadBoardPositions(tenant);
    if (!board.ok) return board;
    const riskGate = structure.value.gates.find((g) => g.id === 'GATE_3_RISK_PERIOD');
    if (riskGate?.kind !== 'ELAPSE')
      return fail('STRUCTURE_HAS_NO_RISK_PERIOD', 'The structure declares no risk-holding interval');
    const invoiceUuid = approved.core.tradeReference.invoiceUuid ?? '';
    const lines = invoiceGoodsLines(invoiceUuid);
    if (lines === undefined)
      return fail(
        'GOODS_LINES_UNKNOWN',
        'The invoice’s goods lines are not known, so they cannot be screened against the board’s register',
      );
    const policy = loadCreditPolicyVersions(tenant, 'wasl-distributor');
    if (!policy.ok) return policy;
    const latest = policy.value.at(-1);
    const calendar = servicingCalendarOf(tenant);
    if (latest === undefined || calendar === undefined)
      return fail('CONFIGURATION_INCOMPLETE', 'The credit policy or the tenant calendar is not configured');
    const maturity = addDays(calendar.dateAt(approved.approvedAt.epochSeconds), approved.core.requestedTenorDays);

    const transactionRef = `WT-${String(book.records.size + 1).padStart(6, '0')}`;
    const draft = murabahaScf.execute(terms.value, approved, quote.value, {
      transactionId: transactionRef,
      structure: structure.value,
      board: board.value,
      invoiceLines: lines,
      riskPeriodRequiredSeconds: riskGate.minimumSeconds,
      maturityDateGregorian: maturity,
      maturityDateHijri: ummAlQuraIso(maturity),
      decisionId: `approval:${requestRef}`,
      creditPolicyVersion: `${latest.policyId}@${latest.version}`,
      correlationId: approved.core.correlationId,
    });
    if (!draft.ok) return draft;

    const event: TransactionEventRow = {
      eventType: 'TRANSACTION_OPENED',
      fromState: null,
      toState: 'DRAFT',
      actor,
      detail: { requestRef, approvedBy: approved.checker.principalId, core: encodeCore(draft.value.core) },
      occurredAtEpochSeconds: at.epochSeconds,
    };
    const pool = persistencePool();
    if (pool !== undefined) {
      const saved = await insertOpenedTransaction(pool, tenant, {
        transactionRef,
        requestRef,
        core: draft.value.core,
        event,
      });
      if (!saved.ok) {
        // Another process opened a transaction meanwhile: this book is behind, so it reloads before the next attempt.
        if (saved.error.reason === 'TRANSACTION_REF_TAKEN' || saved.error.reason === 'TRANSACTION_ALREADY_OPEN') {
          book.records.clear();
          book.hydrated = false;
        }
        return saved;
      }
    }
    const record: TransactionRecord = {
      transactionRef,
      requestRef,
      transaction: draft.value,
      evidence: [],
      events: [event],
    };
    book.records.set(transactionRef, record);
    return ok(viewOf(tenant, record));
  });
}
