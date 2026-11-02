/**
 * Reconciling Wasl collections against SADAD's paid-bills file (Wasl W4b).
 *
 * SADAD tells the institution twice that a bill was paid: at once, by the
 * collection-results webhook (W4a), and at the end of the day, in its
 * paid-bills file. The file is the record of what was settled. Each paid bill
 * is matched to the Wasl instalment it was presented for, and a receipt the
 * webhook never delivered is applied through the same path the webhook takes
 * — so a receipt is recorded once, whichever arrives first.
 *
 * What is applied and what is not:
 *   - a bill matched to an unpaid presentation for the same amount: applied;
 *   - a bill already recorded as paid: counted, nothing changes;
 *   - an amount that differs, a transaction or presentation that cannot be
 *     found, or a receipt the obligation refuses: an exception for operations,
 *     never applied by guesswork;
 *   - a bill of another product (not a Wasl bill number): counted and left to
 *     that product's own reconciliation.
 *
 * The file is read over a fixed window, not from a cursor: matching is
 * idempotent, so re-reading what was already reconciled changes nothing, and
 * a day the cycle did not run is picked up the next.
 *
 * Which SADAD: the institution's own biller registration, live once
 * KSA-RAIL-SADAD-01 is verified (its biller id configured); until then, only
 * where a synthetic demonstration is permitted, the real adapter over the
 * demonstration transport, labelled FIXTURE.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { BillCollectionPort } from '@sanad/core/ports/bill-collection.ts';
import type { ConsentLedger } from '@sanad/core/ports/consent-ledger.ts';
import { type CredentialProvider, SecretValue } from '@sanad/core/ports/credentials.ts';

import { DEMO_SADAD_BILLER_ID, KsaDemonstrationTransport } from '../../../../adapters/ksa/demonstration/transport.ts';
import { SadadAdapter } from '../../../../adapters/ksa/sadad/adapter.ts';
import { civilDateOf } from '../civil-date.ts';
import { hostClockInstant } from '../host-clock.ts';
import { syntheticDemonstrationPermitted } from '../profile.ts';
import { getTransaction, waslPool } from './book.ts';
import { recordBillResult } from './collection-results.ts';
import { lateAmounts } from './late-amounts.ts';
import { presentations } from './settlement.ts';

/** How far back each reading of the paid-bills file looks. Matching is idempotent, so overlap is harmless. */
export const RECONCILIATION_WINDOW_DAYS = 35;

/**
 * A Wasl bill number: the transaction, then `I` and the instalment (instructions.ts `instalmentBill`) or `L` and
 * the instalment a late amount was raised on (late-amounts.ts, W4b-2).
 */
const WASL_BILL = /^(WT-\d{6,10})-([IL])(\d{1,3})$/;

export type ReconciliationExceptionCode =
  'TRANSACTION_NOT_FOUND' | 'NOT_PRESENTED' | 'AMOUNT_DIFFERS' | 'RECEIPT_REFUSED';

export interface ReconciliationException {
  /** SADAD's own bill reference and settlement reference: never a party, never an account. */
  readonly billRef: string;
  readonly settlementRef: string;
  readonly code: ReconciliationExceptionCode;
  readonly transactionRef?: string;
  /** For AMOUNT_DIFFERS: what was presented and what SADAD says was paid. */
  readonly presented?: Money;
  readonly paid?: Money;
  /** For RECEIPT_REFUSED: the obligation's own reason. */
  readonly reason?: string;
}

export interface ReconciliationReport {
  readonly tenantId: string;
  readonly atEpochSeconds: bigint;
  readonly sinceEpochSeconds: bigint;
  readonly source: 'LIVE' | 'FIXTURE';
  /** Paid bills in the file, of every product. */
  readonly paidBills: number;
  /** Receipts applied by this reading. */
  readonly applied: readonly { readonly transactionRef: string; readonly billNumber: string }[];
  /** Already recorded (by the webhook, or an earlier reading): nothing changed. */
  readonly alreadyRecorded: number;
  /** Bills of other products, left to their own reconciliation. */
  readonly otherBills: number;
  readonly exceptions: readonly ReconciliationException[];
}

const NO_CONSENTS: ConsentLedger = {
  live: () => Promise.resolve(reject('OP-DETERMINACY', 'CONSENT_NOT_REQUIRED', 'Bill collection is not consent-gated')),
};

/**
 * The demonstration transport needs no credential, but the adapter asks for
 * one exactly as it will of the vault; this answers with a value that reaches
 * nothing and says what it is.
 */
const DEMONSTRATION_CREDENTIALS: CredentialProvider = {
  get: () => Promise.resolve(new SecretValue('demonstration-transport-needs-no-credential')),
};

/** The tenant's SADAD and its biller id, or undefined where none may be reached. */
async function billCollectionFor(
  tenant: TenantCode,
): Promise<{ readonly port: BillCollectionPort; readonly billerId: string; readonly source: 'FIXTURE' } | undefined> {
  if (!(await syntheticDemonstrationPermitted(waslPool(), process.env))) return undefined;
  const now = () => Number(hostClockInstant().epochSeconds);
  return {
    port: new SadadAdapter(
      {
        tenantId: tenant,
        provider: 'BILL_COLLECTION',
        environment: 'sandbox',
        freshnessWindowSeconds: 0,
        failurePosture: 'FAIL_CLOSED',
        credentialTtlSeconds: 600,
        breaker: { failureThreshold: 3, resetAfterSeconds: 30, successThreshold: 1 },
        nowEpochSeconds: now,
        baseUrl: 'https://demonstration.invalid',
        consents: NO_CONSENTS,
      },
      DEMONSTRATION_CREDENTIALS,
      new KsaDemonstrationTransport(now),
      DEMO_SADAD_BILLER_ID,
    ),
    billerId: DEMO_SADAD_BILLER_ID,
    source: 'FIXTURE',
  };
}

const REPORTS = Symbol.for('sanad.wasl.reconciliation');
const reports = (): Map<string, ReconciliationReport> => {
  const g = globalThis as { [REPORTS]?: Map<string, ReconciliationReport> };
  g[REPORTS] ??= new Map();
  return g[REPORTS];
};

/** The tenant's latest reading of the paid-bills file in this process, if any. */
export const lastReconciliation = (tenant: TenantCode): ReconciliationReport | undefined => reports().get(tenant);

/** Tests only: forget the latest readings. */
export function resetReconciliations(): void {
  reports().clear();
}

/** Read SADAD's paid-bills file over the window and apply what matches. */
export async function reconcilePaidBills(tenant: TenantCode, actor: string): Promise<Result<ReconciliationReport>> {
  const sadad = await billCollectionFor(tenant);
  if (sadad === undefined)
    return reject('OP-DETERMINACY', 'RAIL_UNAVAILABLE', 'SADAD is not connected here; nothing was reconciled', {
      rail: 'BILL_COLLECTION',
    });
  const at = hostClockInstant();
  const since = at.epochSeconds - BigInt(RECONCILIATION_WINDOW_DAYS * 86_400);
  const file = await sadad.port.paid({ tenantId: tenant, sinceEpochSeconds: since, correlationId: `recon:${tenant}` });
  if (!file.ok) return file;
  if (file.value.kind !== 'ANSWERED')
    return reject('OP-DETERMINACY', 'RAIL_UNAVAILABLE', 'SADAD did not return its paid-bills file', {
      rail: 'BILL_COLLECTION',
      outcome: file.value.kind,
    });

  const applied: { transactionRef: string; billNumber: string }[] = [];
  const exceptions: ReconciliationException[] = [];
  let alreadyRecorded = 0;
  let otherBills = 0;
  const prefix = `${sadad.billerId}-`;
  for (const bill of file.value.value) {
    const billNumber = bill.billRef.startsWith(prefix) ? bill.billRef.slice(prefix.length) : bill.billRef;
    const m = WASL_BILL.exec(billNumber);
    if (m === null) {
      otherBills += 1;
      continue;
    }
    const transactionRef = m[1] ?? '';
    const sequenceNumber = Number(m[3]);
    const base = { billRef: bill.billRef, settlementRef: bill.settlementRef, transactionRef };
    const view = await getTransaction(tenant, transactionRef);
    if (view === undefined) {
      exceptions.push({ ...base, code: 'TRANSACTION_NOT_FOUND' });
      continue;
    }
    // A late amount's bill is matched to that late amount's presentations, never to the instalment's.
    const ofInstalment =
      m[2] === 'L'
        ? (lateAmounts(view).find((a) => a.sequenceNumber === sequenceNumber)?.bills ?? [])
        : presentations(view).filter((p) => p.sequenceNumber === sequenceNumber);
    if (ofInstalment.some((p) => p.result === 'PAID')) {
      alreadyRecorded += 1;
      continue;
    }
    const open = ofInstalment.filter((p) => p.result === undefined).at(-1);
    if (open === undefined) {
      exceptions.push({ ...base, code: 'NOT_PRESENTED' });
      continue;
    }
    if (open.amount.minorUnits !== bill.amount.minorUnits || open.amount.currency !== bill.amount.currency) {
      exceptions.push({
        ...base,
        code: 'AMOUNT_DIFFERS',
        presented: open.amount,
        paid: money(bill.amount.minorUnits, bill.amount.currency),
      });
      continue;
    }
    const r = await recordBillResult(
      tenant,
      transactionRef,
      {
        idempotencyKey: open.idempotencyKey,
        status: 'PAID',
        amountMinorUnits: bill.amount.minorUnits,
        reference: bill.settlementRef.slice(0, 64),
        receivedOn: civilDateOf(tenant, { ...at, epochSeconds: bill.paidAtEpochSeconds }),
        source: sadad.source,
      },
      actor,
    );
    if (r.ok) applied.push({ transactionRef, billNumber });
    else if (r.error.reason === 'RESULT_ALREADY_RECORDED') alreadyRecorded += 1;
    else exceptions.push({ ...base, code: 'RECEIPT_REFUSED', reason: r.error.reason });
  }

  const report: ReconciliationReport = {
    tenantId: tenant,
    atEpochSeconds: at.epochSeconds,
    sinceEpochSeconds: since,
    source: sadad.source,
    paidBills: file.value.value.length,
    applied,
    alreadyRecorded,
    otherBills,
    exceptions,
  };
  reports().set(tenant, report);
  return ok(report);
}
