/**
 * The Wasl transaction book: every Murabaha transaction a tenant holds, as
 * its event log rebuilds it, shared by the operations workbench and the SME
 * portal (Wasl W3). Each surface is its own deployable and trust boundary, so
 * neither imports the other; both read and write the book through here.
 *
 * Where it lives: `core.transaction` and its append-only event log when a
 * database is configured (persistence.ts), so the database's Murabaha
 * controls bind it — and then every read reloads from the database, because
 * the workbench and the portal are separate processes and either may have
 * moved a transaction since. Without a database, this process's memory, for
 * development and tests on one process.
 *
 * Writes are serialised per tenant within a process (`withLock`); across
 * processes, a step writes only from the state it read (`recordStep`'s
 * expected state), so a second writer is refused rather than overwritten.
 */
import type { Pool } from 'pg';

import { type TenantCode, loadStructureDefinition } from '@sanad/config/loader.ts';
import type { EvidenceRecord } from '@sanad/core/evidence/evidence.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import { type GateEvaluation, evaluateGates } from '@sanad/products/murabaha-scf/sequencing/gates.ts';
import type { Transaction } from '@sanad/products/murabaha-scf/sequencing/state.ts';
import type { StructureDefinition } from '@sanad/products/murabaha-scf/structures/definition.ts';

import { sharedPool } from '../credentials.ts';
import { hostClockInstant } from '../host-clock.ts';
import {
  type PersistedTransaction,
  type TransactionEventRow,
  decodeCore,
  decodeEvidence,
  decodeState,
  loadTransactions,
} from './persistence.ts';

/** The structure every Wasl transaction runs under. */
export const WASL_STRUCTURE = 'MURABAHA_DISTRIBUTOR';
export const WASL_PRODUCT = 'murabaha-scf';

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

type Env = Readonly<Record<string, string | undefined>>;

/** The database the book lives in, or undefined where it lives in this process's memory. */
export function waslPool(env: Env = process.env): Pool | undefined {
  const url = env['SANAD_DATABASE_URL'];
  return url === undefined || url.trim().length === 0 ? undefined : sharedPool(url.trim());
}

const KEY = Symbol.for('sanad.wasl.transactionBook');
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
 * event, then each step's resulting state (`detail.state`) and each piece of
 * evidence it recorded (`detail.evidence`, superseding `detail.supersedes`).
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

/** The tenant's book: reloaded from the database on every call where there is one, loaded once in memory otherwise. */
export async function hydrate(tenant: TenantCode): Promise<TenantTransactions> {
  const book = bookOf(tenant);
  const pool = waslPool();
  if (pool === undefined) {
    book.hydrated = true;
    return book;
  }
  const loaded = await loadTransactions(pool, tenant);
  book.records.clear();
  for (const p of loaded) {
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

export function structureOf(tenant: TenantCode): Result<StructureDefinition> {
  return loadStructureDefinition(tenant, WASL_STRUCTURE);
}

/** The view a screen reads: the record, and the gates as the engine evaluates them now (an attested instant, never a clock). */
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
        observedAt: hostClockInstant(),
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
