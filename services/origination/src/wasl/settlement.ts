/**
 * Settlement of a Wasl transaction (W4a): the money that moves around it.
 *
 *   Paying the seller. The purchase instructs the payment of the cost to the
 *   anchor (steps.ts, `executePurchase`). The payments hub reports what became
 *   of it — accepted, settled, rejected, returned — by signed webhook, recorded
 *   here; a rejected or returned payment is instructed again, by finance, as a
 *   new attempt with a new key.
 *
 *   Collecting from the distributor. Once the obligation is booked, the
 *   instalments falling due within the lead window (or overdue) are presented
 *   to SADAD as bills. SADAD reports each bill paid, or a payment returned.
 *   A receipt reduces what is owed — never the total, which is fixed — and
 *   when nothing is owed the transaction is SETTLED. A returned payment takes
 *   the receipt off again and frees the instalment to be presented anew; once
 *   the transaction is settled, a return is not applied automatically but
 *   refused, for operations to resolve.
 *
 * Every result is recorded once: the same result for the same instruction
 * twice changes nothing (`RESULT_ALREADY_RECORDED`, which a webhook answers as
 * delivered). No result changes a price: the obligation's total is the sale
 * price agreed at execution, and the database holds what is paid within it.
 *
 * Reads no clock: "today" is the civil date, in the institution's time zone,
 * of the step's attested instant.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import {
  type FacilityPosition,
  type Repayment,
  type ScheduledInstalment,
  civilDay,
  facilityPosition,
} from '@sanad/core/servicing/instalment-position.ts';
import { type Obligation, applyPayment, reversePayment } from '@sanad/products/murabaha-scf/obligation/obligation.ts';
import { settle } from '@sanad/products/murabaha-scf/sequencing/transitions.ts';

import { civilDateOf } from '../civil-date.ts';
import type { TransactionRecord, TransactionView } from './book.ts';
import { instalmentBill, sellerSettlement } from './instructions.ts';
import type { TransactionEventRow } from './persistence.ts';
import { type StepOutcome, fail, notNow, step } from './steps.ts';

/** How far ahead of its due date an instalment is presented for collection. */
export const COLLECTION_LEAD_DAYS = 7;

export type PaymentStatus = 'ACCEPTED' | 'SETTLED' | 'REJECTED' | 'RETURNED';
export type CollectionStatus = 'PAID' | 'RETURNED';
export type ResultSource = 'LIVE' | 'FIXTURE';

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const outboxOf = (e: TransactionEventRow) =>
  Array.isArray(e.detail['outbox'])
    ? (e.detail['outbox'] as readonly {
        kind: string;
        idempotencyKey: string;
        subjectRef: string;
        payload: Record<string, string>;
      }[])
    : [];

/** The keys instructions.ts gives the seller's payment and an instalment's bill; late amounts have their own. */
const SELLER_KEY = /^wasl:WT-\d{6,10}:seller(:R\d{1,3})?$/;
const INSTALMENT_KEY = /^wasl:WT-\d{6,10}:collect:I\d{1,3}(:R\d{1,3})?$/;

// -- Paying the seller ----------------------------------------------------------------

export interface SellerPayment {
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly amount: Money;
  readonly beneficiaryIban: string;
  /** INSTRUCTED until the hub reports; then the latest status it reported. */
  readonly status: 'INSTRUCTED' | PaymentStatus;
  readonly instructionRef?: string;
  readonly reasonCode?: string;
  readonly source?: ResultSource;
}

/** The seller's payment attempts, oldest first, each with what the hub last reported of it. */
export function sellerPayments(record: TransactionRecord): readonly SellerPayment[] {
  const out: SellerPayment[] = [];
  for (const e of record.events) {
    for (const o of outboxOf(e)) {
      // The seller's payments only: a disbursement to charity (W4b-2) is not one of them.
      if (o.kind !== 'PAYMENT_DISBURSE' || !SELLER_KEY.test(o.idempotencyKey)) continue;
      out.push({
        idempotencyKey: o.idempotencyKey,
        attempt: out.length,
        amount: money(BigInt(o.payload['minorUnits'] ?? '0'), (o.payload['currency'] ?? 'SAR') as Money['currency']),
        beneficiaryIban: o.payload['beneficiaryIban'] ?? '',
        status: 'INSTRUCTED',
      });
    }
    if (e.eventType !== 'SELLER_PAYMENT_RESULT') continue;
    const i = out.findIndex((p) => p.idempotencyKey === e.detail['idempotencyKey']);
    const p = out[i];
    if (p === undefined) continue;
    const instructionRef = str(e.detail['instructionRef']);
    const reasonCode = str(e.detail['reasonCode']);
    out[i] = {
      ...p,
      status: e.detail['status'] as PaymentStatus,
      ...(instructionRef === undefined ? {} : { instructionRef }),
      ...(reasonCode === undefined ? {} : { reasonCode }),
      source: e.detail['source'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
    };
  }
  return out;
}

/** What may follow what: a payment is accepted, then settled or rejected; a settled one may come back. */
const NEXT: Readonly<Record<SellerPayment['status'], ReadonlySet<PaymentStatus>>> = {
  INSTRUCTED: new Set(['ACCEPTED', 'SETTLED', 'REJECTED']),
  ACCEPTED: new Set(['SETTLED', 'REJECTED']),
  SETTLED: new Set(['RETURNED']),
  REJECTED: new Set(),
  RETURNED: new Set(),
};

/** Record what the payments hub reported of a seller payment, by its idempotency key. */
export function recordSellerPaymentResult(
  tenant: TenantCode,
  transactionRef: string,
  result: {
    readonly idempotencyKey: string;
    readonly status: PaymentStatus;
    readonly instructionRef?: string;
    readonly reasonCode?: string;
    readonly source: ResultSource;
  },
  actor: string,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => {
    const payment = sellerPayments(c.record).find((p) => p.idempotencyKey === result.idempotencyKey);
    if (payment === undefined)
      return Promise.resolve(fail('PAYMENT_NOT_FOUND', 'No seller payment was instructed under this key'));
    if (payment.status === result.status)
      return Promise.resolve(fail('RESULT_ALREADY_RECORDED', 'This result is already recorded'));
    if (!NEXT[payment.status].has(result.status))
      return Promise.resolve(
        fail('RESULT_OUT_OF_ORDER', 'This result cannot follow what was already reported', {
          from: payment.status,
          to: result.status,
        }),
      );
    return Promise.resolve(
      ok({
        eventType: 'SELLER_PAYMENT_RESULT',
        transaction: c.record.transaction,
        detail: {
          idempotencyKey: result.idempotencyKey,
          status: result.status,
          source: result.source,
          ...(result.instructionRef === undefined ? {} : { instructionRef: result.instructionRef.slice(0, 64) }),
          ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode.slice(0, 16) }),
        },
      }),
    );
  });
}

/** States in which the institution still owes or has paid the seller: from the purchase on, never after an unwind. */
const PURCHASED = new Set([
  'PURCHASE_EXECUTED',
  'OWNERSHIP_ACQUIRED',
  'POSSESSION_CONFIRMED',
  'SALE_OFFERED',
  'OFFER_LAPSED',
  'EXECUTED',
  'ACTIVE',
  'SETTLED',
]);

/** Instruct the seller's payment again after the last attempt was rejected or returned: a new attempt, a new key. */
export function paySellerAgain(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => {
    const t = c.record.transaction;
    if (!PURCHASED.has(t.state)) return Promise.resolve(notNow(t.state));
    const attempts = sellerPayments(c.record);
    const last = attempts.at(-1);
    if (last === undefined || (last.status !== 'REJECTED' && last.status !== 'RETURNED'))
      return Promise.resolve(
        fail('SELLER_PAYMENT_NOT_FAILED', 'The seller’s payment is in hand or under way; nothing to instruct again'),
      );
    const payment = sellerSettlement(c.parties, transactionRef, t.core, attempts.length);
    if (!payment.ok) return Promise.resolve(payment);
    return Promise.resolve(
      ok({
        eventType: 'SELLER_PAYMENT_REINSTRUCTED',
        transaction: t,
        outbox: [payment.value],
        detail: { idempotencyKey: payment.value.idempotencyKey, after: last.idempotencyKey },
      }),
    );
  });
}

// -- The obligation and its position --------------------------------------------------

interface BookedInstalment {
  readonly sequenceNumber: number;
  readonly dueDateGregorian: string;
  readonly amount: Money;
}

/** The schedule as booked (the OBLIGATION_BOOKED event), or undefined before booking. */
export function bookedSchedule(record: TransactionRecord): readonly BookedInstalment[] | undefined {
  const booked = record.events.find((e) => e.eventType === 'OBLIGATION_BOOKED');
  const o = booked?.detail['obligation'] as
    | {
        currency: string;
        instalments: { sequenceNumber: number; dueDateGregorian: string; amountMinor: string }[];
      }
    | undefined;
  if (o === undefined) return undefined;
  return o.instalments.map((i) => ({
    sequenceNumber: i.sequenceNumber,
    dueDateGregorian: i.dueDateGregorian,
    amount: money(BigInt(i.amountMinor), o.currency as Money['currency']),
  }));
}

/** The obligation as the event log rebuilds it: the total fixed at booking, paid as the receipts and returns left it. */
function obligationOf(record: TransactionRecord): Obligation | undefined {
  const schedule = bookedSchedule(record);
  const booked = record.events.find((e) => e.eventType === 'OBLIGATION_BOOKED');
  if (schedule === undefined || booked === undefined) return undefined;
  const core = record.transaction.core;
  const currency = core.pricing.salePriceAmount.currency;
  const paid = record.events.reduce((s, e) => s + BigInt(str(e.detail['paidDeltaMinor']) ?? '0'), 0n);
  return {
    obligationId: str((booked.detail['obligation'] as { obligationId?: unknown }).obligationId) ?? '',
    tenantId: core.tenantId,
    transactionId: core.transactionId,
    totalAmount: core.pricing.salePriceAmount,
    instalments: schedule.map((i) => ({ ...i, dueDateHijri: '' })),
    waivedAmount: money(0n, currency),
    paidAmount: money(paid, currency),
  };
}

/** The receipts still standing: each one received, less any that came back. */
function standingReceipts(record: TransactionRecord): readonly Repayment[] {
  const returned = new Set(
    record.events.filter((e) => e.eventType === 'PAYMENT_RETURNED').map((e) => str(e.detail['idempotencyKey'])),
  );
  return record.events
    .filter((e) => e.eventType === 'PAYMENT_RECEIVED' && !returned.has(str(e.detail['idempotencyKey'])))
    .map((e) => ({
      repaymentId: str(e.detail['idempotencyKey']) ?? '',
      receivedOn: str(e.detail['receivedOn']) ?? '',
      amount: money(
        BigInt(str(e.detail['paidDeltaMinor']) ?? '0'),
        record.transaction.core.pricing.salePriceAmount.currency,
      ),
    }));
}

/** Where the obligation stands on a civil date: instalments paid, due, overdue, oldest first. */
export function obligationPosition(record: TransactionRecord, asOf: string): FacilityPosition | undefined {
  const schedule = bookedSchedule(record);
  if (schedule === undefined) return undefined;
  const currency = record.transaction.core.pricing.salePriceAmount.currency;
  // A Murabaha instalment is a part of the sale price: the whole of it is "principal", there is no charge on it.
  const scheduled: ScheduledInstalment[] = schedule.map((i) => ({
    number: i.sequenceNumber,
    dueDate: i.dueDateGregorian,
    principal: i.amount,
    charge: money(0n, currency),
  }));
  return facilityPosition(scheduled, standingReceipts(record), asOf, currency);
}

export { civilDateOf };

// -- Collecting -----------------------------------------------------------------------

export interface Presentation {
  readonly idempotencyKey: string;
  readonly sequenceNumber: number;
  readonly amount: Money;
  readonly billNumber: string;
  readonly result?: CollectionStatus;
  /** What the receipt applied, while it stands. */
  readonly paid?: Money;
}

/** Every bill presented, oldest first, with what SADAD reported of it. */
export function presentations(record: TransactionRecord): readonly Presentation[] {
  const out: Presentation[] = [];
  const currency = record.transaction.core.pricing.salePriceAmount.currency;
  for (const e of record.events) {
    for (const o of outboxOf(e)) {
      // An instalment's bills only: a late amount's bill (W4b-2) is never part of the obligation.
      if (o.kind !== 'BILL_PRESENT' || !INSTALMENT_KEY.test(o.idempotencyKey)) continue;
      out.push({
        idempotencyKey: o.idempotencyKey,
        sequenceNumber: Number(/:collect:I(\d+)/.exec(o.idempotencyKey)?.[1] ?? '0'),
        amount: money(BigInt(o.payload['minorUnits'] ?? '0'), currency),
        billNumber: o.subjectRef,
      });
    }
    const key = str(e.detail['idempotencyKey']);
    const i = out.findIndex((p) => p.idempotencyKey === key);
    const p = out[i];
    if (p === undefined) continue;
    if (e.eventType === 'PAYMENT_RECEIVED')
      out[i] = { ...p, result: 'PAID', paid: money(BigInt(str(e.detail['paidDeltaMinor']) ?? '0'), currency) };
    if (e.eventType === 'PAYMENT_RETURNED' || e.eventType === 'COLLECTION_RETURNED') {
      const { paid: _paid, ...rest } = p;
      out[i] = { ...rest, result: 'RETURNED' };
    }
  }
  return out;
}

/** States in which instalments are collected. */
const COLLECTING = new Set(['ACTIVE']);

/**
 * Present to SADAD every instalment with something outstanding that falls due
 * within the lead window or is overdue, and is not already presented and
 * standing. A returned presentation frees its instalment to be presented again.
 */
export function presentDueInstalments(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const t = c.record.transaction;
    if (!COLLECTING.has(t.state)) return notNow(t.state);
    const today = civilDateOf(c.tenant, await c.attestation.attest());
    const position = obligationPosition(c.record, today);
    if (position === undefined) return fail('OBLIGATION_NOT_BOOKED', 'The obligation is not booked yet');
    const shown = presentations(c.record);
    const horizon = (civilDay(today) ?? 0) + COLLECTION_LEAD_DAYS;
    const due = position.instalments.filter(
      (i) =>
        i.outstanding.minorUnits > 0n &&
        (civilDay(i.dueDate) ?? 0) <= horizon &&
        !shown.some((p) => p.sequenceNumber === i.number && p.result !== 'RETURNED'),
    );
    if (due.length === 0) return fail('NOTHING_TO_COLLECT', 'No instalment is due for collection now');
    const payerRef = `distributor:${c.distributorCr}`;
    const bills = due.map((i) =>
      instalmentBill(
        transactionRef,
        t.core,
        payerRef,
        { sequenceNumber: i.number, dueDateGregorian: i.dueDate, outstanding: i.outstanding },
        shown.filter((p) => p.sequenceNumber === i.number).length,
      ),
    );
    return ok({
      eventType: 'COLLECTION_PRESENTED',
      transaction: t,
      outbox: bills,
      detail: { asOf: today, instalments: due.map((i) => `I${String(i.number)}`).join(',') },
    });
  });
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Record what SADAD reported of a presented bill. PAID applies the receipt —
 * the amount reported, or the bill's amount where none is — and settles the
 * transaction when nothing remains owed. RETURNED takes a standing receipt
 * off again, or simply frees an unpaid bill to be presented anew.
 */
export function recordCollectionResult(
  tenant: TenantCode,
  transactionRef: string,
  result: {
    readonly idempotencyKey: string;
    readonly status: CollectionStatus;
    readonly amountMinorUnits?: bigint;
    readonly reference: string;
    readonly receivedOn: string;
    readonly source: ResultSource;
  },
  actor: string,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => Promise.resolve(collectionResult(c.record, result)));
}

function collectionResult(
  record: TransactionRecord,
  result: Parameters<typeof recordCollectionResult>[2],
): Result<StepOutcome> {
  const t = record.transaction;
  const bill = presentations(record).find((p) => p.idempotencyKey === result.idempotencyKey);
  if (bill === undefined) return fail('COLLECTION_NOT_FOUND', 'No bill was presented under this key');
  if (!CIVIL_DATE.test(result.receivedOn)) return fail('RECEIVED_ON_MALFORMED', 'The value date is yyyy-mm-dd');
  if (bill.result === result.status || bill.result === 'RETURNED')
    return fail('RESULT_ALREADY_RECORDED', 'This result is already recorded');
  const obligation = obligationOf(record);
  if (obligation === undefined) return fail('OBLIGATION_NOT_BOOKED', 'The obligation is not booked');
  const currency = obligation.totalAmount.currency;
  const detail = {
    idempotencyKey: result.idempotencyKey,
    billNumber: bill.billNumber,
    reference: result.reference.slice(0, 64),
    receivedOn: result.receivedOn,
    source: result.source,
  };

  if (result.status === 'PAID') {
    if (t.state !== 'ACTIVE') return notNow(t.state);
    const amount = money(result.amountMinorUnits ?? bill.amount.minorUnits, currency);
    if (amount.minorUnits <= 0n) return fail('AMOUNT_NOT_POSITIVE', 'A receipt is a positive amount');
    // More than is owed is refused, not absorbed: operations returns the difference (BR-E).
    const paid = applyPayment(obligation, amount);
    if (!paid.ok) return paid;
    const settled = paid.value.paidAmount.minorUnits === obligation.totalAmount.minorUnits;
    return ok({
      eventType: 'PAYMENT_RECEIVED',
      transaction: settled ? settle(t) : t,
      paidDelta: amount,
      detail,
    });
  }

  // RETURNED.
  if (bill.result !== 'PAID' || bill.paid === undefined)
    return ok({ eventType: 'COLLECTION_RETURNED', transaction: t, detail });
  // A settled obligation is closed: a return after it goes to operations rather than reopening it silently.
  if (t.state !== 'ACTIVE')
    return reject(
      'OP-DETERMINACY',
      'RETURN_AFTER_SETTLEMENT',
      'A payment came back on a settled obligation; operations resolves it',
      {
        transactionRef: record.transactionRef,
      },
    );
  const reversed = reversePayment(obligation, bill.paid);
  if (!reversed.ok) return reversed;
  return ok({
    eventType: 'PAYMENT_RETURNED',
    transaction: t,
    paidDelta: money(-bill.paid.minorUnits, currency),
    detail,
  });
}
