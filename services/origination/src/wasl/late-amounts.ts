/**
 * Late amounts on a Wasl transaction, and the charity they are held for
 * (Wasl W4b-2, decided with the product owner on 21 October 2026).
 *
 *   Proposed. The daily cycle proposes one late amount for each instalment
 *   still unpaid beyond the board's grace days, at the amount the board ruled
 *   (products/murabaha-scf/ledger/late-amounts.ts). A proposal moves nothing:
 *   no bill, no ledger entry, no change to what the distributor owes.
 *
 *   Assessed, then confirmed by a second person. An officer records whether
 *   the distributor was able but unwilling to pay, or unable (hardship), with
 *   a note. A different person confirms it or sends it back. Confirmed
 *   unable, the case is hardship and the amount is never billed (SH-14).
 *   Confirmed able but unwilling, it is presented to SADAD as its own bill —
 *   never on the obligation, whose total is fixed (M-2).
 *
 *   Collected. When SADAD reports the late bill paid (by webhook or in its
 *   paid-bills file, whichever first), the amount is raised to the segregated
 *   charity liability: an entry in `core.charity_ledger` and the posting to
 *   the core banking platform's charity liability account, together — and
 *   only then. It is never the institution's income (M-6, SH-13).
 *
 *   Disbursed. Finance proposes a board-approved recipient; a different
 *   person approves, and the payment is instructed to the recipient's account
 *   through the payments hub. The entry's disbursement is completed once.
 *
 * Every state is rebuilt from the transaction's event log, so the workbench,
 * the webhooks and the cycle read the same thing. Reads no clock: "today" is
 * the civil date of the step's attested instant.
 */
import { randomUUID } from 'node:crypto';

import { type TenantCode, loadMurabahaAccounts } from '@sanad/config/loader.ts';
import { type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { OutboxEvent } from '@sanad/core/outbox/outbox.ts';
import { type TsaInstant, restoreAttestedInstant } from '@sanad/core/time/tsa.ts';
import {
  type AbilityAssessment,
  type CharityLedgerEntry,
  disburse,
  postLateAmount,
} from '@sanad/products/murabaha-scf/ledger/charity.ts';
import { lateAmountsDue } from '@sanad/products/murabaha-scf/ledger/late-amounts.ts';
import type { TransactionCore } from '@sanad/products/murabaha-scf/sequencing/state.ts';

import { civilDateOf } from '../civil-date.ts';
import type { TransactionRecord, TransactionView } from './book.ts';
import { coreBankingFor } from './booking.ts';
import type { TransactionEventRow } from './persistence.ts';
import { type CollectionStatus, type ResultSource, obligationPosition } from './settlement.ts';
import { type StepContext, type StepOutcome, fail, notNow, step } from './steps.ts';

export type LateAmountStatus =
  'PROPOSED' | 'ASSESSED' | 'HARDSHIP' | 'BILLED' | 'COLLECTED' | 'DISBURSEMENT_PROPOSED' | 'DISBURSED';

export interface LateBill {
  readonly idempotencyKey: string;
  readonly billNumber: string;
  readonly amount: Money;
  readonly result?: CollectionStatus;
}

export interface LateAmount {
  readonly sequenceNumber: number;
  readonly dueDate: string;
  readonly daysPastDue: number;
  readonly amount: Money;
  readonly computationBasisKey: string;
  readonly graceDays: number;
  readonly proposedBy: string;
  readonly proposedAtEpochSeconds: bigint;
  readonly status: LateAmountStatus;
  readonly assessment?: AbilityAssessment;
  readonly assessedBy?: string;
  /** The officer's reason, in their words. Shown on the transaction only. */
  readonly assessmentNote?: string;
  readonly confirmedBy?: string;
  /** The last time a confirmer sent the assessment back, with their reason. */
  readonly sentBack?: { readonly by: string; readonly note: string };
  readonly bills: readonly LateBill[];
  readonly charity?: {
    readonly entryId: string;
    readonly collectedOn: string;
    readonly reference: string;
    readonly source: ResultSource;
    readonly corePostingRef: string;
    /** The attested instant the entry was raised at, as recorded: restored, never re-attested. */
    readonly recordedAt: TsaInstant;
  };
  readonly disbursement?: {
    readonly recipientId: string;
    readonly proposedBy: string;
    readonly approvedBy?: string;
    readonly disbursementRef?: string;
  };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const seqOf = (e: TransactionEventRow): number => Number(str(e.detail['sequenceNumber']) ?? '0');

/** The bill key for a late amount: one per instalment, a new attempt after a return (`:R<n>`). */
export const lateBillKey = (transactionRef: string, sequenceNumber: number, attempt: number): string =>
  `wasl:${transactionRef}:late:I${String(sequenceNumber)}${attempt > 0 ? `:R${String(attempt)}` : ''}`;

export const isLateBillKey = (key: string): boolean => /^wasl:WT-\d{6,10}:late:I\d{1,3}(:R\d{1,3})?$/.test(key);

/** Every late amount on the transaction, by instalment, as the event log leaves it. */
export function lateAmounts(record: TransactionRecord): readonly LateAmount[] {
  const currency = record.transaction.core.pricing.salePriceAmount.currency;
  const out = new Map<number, LateAmount>();
  const update = (n: number, f: (a: LateAmount) => LateAmount) => {
    const a = out.get(n);
    if (a !== undefined) out.set(n, f(a));
  };
  for (const e of record.events) {
    const n = seqOf(e);
    const d = e.detail;
    const billed = Array.isArray(d['outbox'])
      ? (
          d['outbox'] as readonly {
            kind: string;
            idempotencyKey: string;
            subjectRef: string;
            payload: Record<string, string>;
          }[]
        )
          .filter((o) => o.kind === 'BILL_PRESENT' && isLateBillKey(o.idempotencyKey))
          .map((o) => ({
            idempotencyKey: o.idempotencyKey,
            billNumber: o.subjectRef,
            amount: money(BigInt(o.payload['minorUnits'] ?? '0'), currency),
          }))
      : [];
    switch (e.eventType) {
      case 'LATE_AMOUNT_PROPOSED':
        out.set(n, {
          sequenceNumber: n,
          dueDate: str(d['dueDate']) ?? '',
          daysPastDue: Number(str(d['daysPastDue']) ?? '0'),
          amount: money(BigInt(str(d['amountMinor']) ?? '0'), currency),
          computationBasisKey: str(d['computationBasisKey']) ?? '',
          graceDays: Number(str(d['graceDays']) ?? '0'),
          proposedBy: e.actor,
          proposedAtEpochSeconds: e.occurredAtEpochSeconds,
          status: 'PROPOSED',
          bills: [],
        });
        break;
      case 'LATE_AMOUNT_ASSESSED':
        update(n, (a) => ({
          ...a,
          status: 'ASSESSED',
          assessment: d['assessment'] === 'UNABLE' ? 'UNABLE' : 'ABLE_BUT_UNWILLING',
          assessedBy: e.actor,
          assessmentNote: str(d['note']) ?? '',
        }));
        break;
      case 'LATE_AMOUNT_SENT_BACK':
        update(n, ({ assessment: _a, assessedBy: _b, assessmentNote: _c, ...a }) => ({
          ...a,
          status: 'PROPOSED',
          sentBack: { by: e.actor, note: str(d['note']) ?? '' },
        }));
        break;
      case 'LATE_AMOUNT_CONFIRMED':
        update(n, (a) => ({
          ...a,
          status: a.assessment === 'UNABLE' ? 'HARDSHIP' : 'BILLED',
          confirmedBy: e.actor,
          bills: [...a.bills, ...billed],
        }));
        break;
      case 'LATE_BILL_PRESENTED':
        update(n, (a) => ({ ...a, bills: [...a.bills, ...billed] }));
        break;
      case 'LATE_COLLECTION_RETURNED':
        update(n, (a) => ({
          ...a,
          bills: a.bills.map((b) =>
            b.idempotencyKey === d['idempotencyKey'] ? { ...b, result: 'RETURNED' as const } : b,
          ),
        }));
        break;
      case 'LATE_AMOUNT_COLLECTED': {
        const c = d['charity'] as Record<string, string> | undefined;
        update(n, (a) => ({
          ...a,
          status: 'COLLECTED',
          bills: a.bills.map((b) => (b.idempotencyKey === d['idempotencyKey'] ? { ...b, result: 'PAID' as const } : b)),
          charity: {
            entryId: c?.['entryId'] ?? '',
            collectedOn: str(d['receivedOn']) ?? '',
            reference: str(d['reference']) ?? '',
            source: d['source'] === 'LIVE' ? 'LIVE' : 'FIXTURE',
            corePostingRef: str(d['corePostingRef']) ?? '',
            recordedAt: restoreAttestedInstant({
              epochSeconds: BigInt(c?.['recordedAtEpoch'] ?? '0'),
              tokenDigest: c?.['recordedAtDigest'] ?? '',
              authorityId: c?.['recordedAtAuthority'] ?? '',
            }),
          },
        }));
        break;
      }
      case 'CHARITY_DISBURSEMENT_PROPOSED':
        update(n, (a) => ({
          ...a,
          status: 'DISBURSEMENT_PROPOSED',
          disbursement: { recipientId: str(d['recipientId']) ?? '', proposedBy: e.actor },
        }));
        break;
      case 'CHARITY_DISBURSEMENT_DECLINED':
        update(n, ({ disbursement: _d, ...a }) => ({ ...a, status: 'COLLECTED' }));
        break;
      case 'CHARITY_DISBURSED':
        update(n, (a) => ({
          ...a,
          status: 'DISBURSED',
          disbursement: {
            recipientId: str(d['recipientId']) ?? '',
            proposedBy: a.disbursement?.proposedBy ?? '',
            approvedBy: e.actor,
            disbursementRef: str(d['disbursementRef']) ?? '',
          },
        }));
        break;
      default:
        break;
    }
  }
  return [...out.values()].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

/** The late amount on one instalment, or a refusal naming the state it must be in. */
function lateAmountIn(
  record: TransactionRecord,
  sequenceNumber: number,
  expected: readonly LateAmountStatus[],
): Result<LateAmount> {
  const a = lateAmounts(record).find((x) => x.sequenceNumber === sequenceNumber);
  if (a === undefined) return fail('LATE_AMOUNT_NOT_FOUND', 'No late amount was proposed on this instalment');
  if (!expected.includes(a.status))
    return fail('LATE_AMOUNT_NOT_IN_STATE', 'This step does not apply to the late amount as it stands', {
      status: a.status,
    });
  return ok(a);
}

/** States in which a late amount may still be assessed, confirmed or collected: once the obligation is booked. */
const SERVICED = new Set(['ACTIVE', 'SETTLED']);

const NOTE_MAX = 500;

// -- Proposing ------------------------------------------------------------------------

/** One proposal: the earliest instalment now due a late amount, or a refusal when none is. */
async function proposeOne(c: StepContext): Promise<Result<StepOutcome>> {
  const t = c.record.transaction;
  if (t.state !== 'ACTIVE') return notNow(t.state);
  const ruling = c.board.lateAmounts;
  if (ruling === undefined)
    return fail('LATE_AMOUNTS_NOT_RULED', 'The board has ruled no late amounts for this institution');
  const today = civilDateOf(c.tenant, await c.attestation.attest());
  const position = obligationPosition(c.record, today);
  if (position === undefined) return fail('OBLIGATION_NOT_BOOKED', 'The obligation is not booked yet');
  const proposed = new Set(lateAmounts(c.record).map((a) => a.sequenceNumber));
  const due = lateAmountsDue(position, ruling, proposed, t.core.pricing.salePriceAmount.currency)[0];
  if (due === undefined) return fail('NO_LATE_CHARGE_DUE', 'No instalment is unpaid beyond the grace days');
  return ok({
    eventType: 'LATE_AMOUNT_PROPOSED',
    transaction: t,
    detail: {
      sequenceNumber: String(due.sequenceNumber),
      dueDate: due.dueDate,
      daysPastDue: String(due.daysPastDue),
      amountMinor: due.amount.minorUnits.toString(),
      computationBasisKey: due.computationBasisKey,
      graceDays: String(due.graceDays),
      asOf: today,
    },
  });
}

/**
 * Propose a late amount on every instalment now unpaid beyond the grace days
 * that has none, one event each. Refused with NO_LATE_CHARGE_DUE when there is
 * nothing to propose, so the cycle counts it as nothing due.
 */
export async function proposeLateAmounts(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
): Promise<Result<TransactionView>> {
  let last: Result<TransactionView> | undefined;
  // Bounded by the schedule: each pass proposes a different instalment, or stops.
  for (let i = 0; i < 400; i += 1) {
    const r = await step(tenant, transactionRef, actor, proposeOne);
    if (!r.ok) return last ?? r;
    last = r;
  }
  return last ?? fail('NO_LATE_CHARGE_DUE', 'No instalment is unpaid beyond the grace days');
}

// -- Assessing and confirming ---------------------------------------------------------

/** The officer records whether the distributor was able but unwilling to pay, or unable, and why. */
export function assessLateAmount(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  input: { readonly sequenceNumber: number; readonly assessment: AbilityAssessment; readonly note: string },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => {
    const t = c.record.transaction;
    if (!SERVICED.has(t.state)) return Promise.resolve(notNow(t.state));
    const a = lateAmountIn(c.record, input.sequenceNumber, ['PROPOSED']);
    if (!a.ok) return Promise.resolve(a);
    const note = input.note.trim().slice(0, NOTE_MAX);
    if (note.length === 0) return Promise.resolve(fail('ASSESSMENT_NOTE_REQUIRED', 'Say what the assessment rests on'));
    return Promise.resolve(
      ok({
        eventType: 'LATE_AMOUNT_ASSESSED',
        transaction: t,
        detail: { sequenceNumber: String(input.sequenceNumber), assessment: input.assessment, note },
      }),
    );
  });
}

/** The late amount's own SADAD bill: payable by the distributor, numbered apart from the instalments. */
function lateBill(
  transactionRef: string,
  core: TransactionCore,
  payerRef: string,
  late: LateAmount,
  dueDateGregorian: string,
): OutboxEvent {
  const key = lateBillKey(transactionRef, late.sequenceNumber, late.bills.length);
  return {
    eventId: key,
    tenantId: core.tenantId,
    kind: 'BILL_PRESENT',
    // SADAD's bill number: `L` for a late amount, never `I`, so it is never read as an instalment.
    subjectRef: `${transactionRef}-L${String(late.sequenceNumber)}`,
    idempotencyKey: key,
    payload: {
      payerRef,
      minorUnits: late.amount.minorUnits.toString(),
      currency: late.amount.currency,
      dueDateGregorian,
      purpose: 'LATE_AMOUNT_FOR_CHARITY',
    },
    correlationId: core.correlationId,
  };
}

/**
 * A second person confirms the officer's assessment. Able but unwilling: the
 * late amount is presented to SADAD as its own bill. Unable: hardship, and the
 * amount is never billed.
 */
export function confirmLateAmount(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  sequenceNumber: number,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const t = c.record.transaction;
    if (!SERVICED.has(t.state)) return notNow(t.state);
    const a = lateAmountIn(c.record, sequenceNumber, ['ASSESSED']);
    if (!a.ok) return a;
    if (a.value.assessedBy === actor)
      return fail('FOUR_EYES_SELF_CONFIRMATION', 'The person who assessed a late amount may not confirm it');
    const detail = { sequenceNumber: String(sequenceNumber), assessment: a.value.assessment ?? '' };
    if (a.value.assessment === 'UNABLE') return ok({ eventType: 'LATE_AMOUNT_CONFIRMED', transaction: t, detail });
    const today = civilDateOf(c.tenant, await c.attestation.attest());
    return ok({
      eventType: 'LATE_AMOUNT_CONFIRMED',
      transaction: t,
      outbox: [lateBill(transactionRef, t.core, `distributor:${c.distributorCr}`, a.value, today)],
      detail,
    });
  });
}

/** The confirmer sends the assessment back to the officer, with their reason. Nothing is billed. */
export function sendBackLateAmount(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  input: { readonly sequenceNumber: number; readonly note: string },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => {
    const t = c.record.transaction;
    const a = lateAmountIn(c.record, input.sequenceNumber, ['ASSESSED']);
    if (!a.ok) return Promise.resolve(a);
    if (a.value.assessedBy === actor)
      return Promise.resolve(
        fail('FOUR_EYES_SELF_CONFIRMATION', 'The person who assessed a late amount may not decide on it'),
      );
    const note = input.note.trim().slice(0, NOTE_MAX);
    if (note.length === 0) return Promise.resolve(fail('SEND_BACK_NOTE_REQUIRED', 'Say why it goes back'));
    return Promise.resolve(
      ok({
        eventType: 'LATE_AMOUNT_SENT_BACK',
        transaction: t,
        detail: { sequenceNumber: String(input.sequenceNumber), note },
      }),
    );
  });
}

/** Present a confirmed late amount again after SADAD returned the last payment of its bill: a new attempt, a new key. */
export function presentLateBillAgain(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  sequenceNumber: number,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const t = c.record.transaction;
    if (!SERVICED.has(t.state)) return notNow(t.state);
    const a = lateAmountIn(c.record, sequenceNumber, ['BILLED']);
    if (!a.ok) return a;
    if (a.value.bills.at(-1)?.result !== 'RETURNED')
      return fail('LATE_BILL_STANDING', 'The late amount’s bill is still standing at SADAD');
    const today = civilDateOf(c.tenant, await c.attestation.attest());
    return ok({
      eventType: 'LATE_BILL_PRESENTED',
      transaction: t,
      outbox: [lateBill(transactionRef, t.core, `distributor:${c.distributorCr}`, a.value, today)],
      detail: { sequenceNumber: String(sequenceNumber) },
    });
  });
}

// -- Collecting: the charity liability is raised -------------------------------------

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What SADAD reported of a late amount's bill. PAID raises the charity
 * liability — the ledger entry and the core's posting, together — for exactly
 * the amount billed; anything else is refused for operations. RETURNED on an
 * unpaid bill frees it to be presented again; on a collected one it is refused,
 * because the charity entry is written once and is not taken back silently.
 */
export function recordLateCollectionResult(
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
  return step(tenant, transactionRef, actor, async (c) => {
    const late = lateAmounts(c.record).find((a) => a.bills.some((b) => b.idempotencyKey === result.idempotencyKey));
    const bill = late?.bills.find((b) => b.idempotencyKey === result.idempotencyKey);
    if (late === undefined || bill === undefined)
      return fail('COLLECTION_NOT_FOUND', 'No late amount was billed under this key');
    if (!CIVIL_DATE.test(result.receivedOn)) return fail('RECEIVED_ON_MALFORMED', 'The value date is yyyy-mm-dd');
    if (bill.result === result.status || bill.result === 'RETURNED')
      return fail('RESULT_ALREADY_RECORDED', 'This result is already recorded');
    const detail = {
      sequenceNumber: String(late.sequenceNumber),
      idempotencyKey: result.idempotencyKey,
      billNumber: bill.billNumber,
      reference: result.reference.slice(0, 64),
      receivedOn: result.receivedOn,
      source: result.source,
    };
    if (result.status === 'RETURNED') {
      if (bill.result === 'PAID')
        return reject(
          'SH-13',
          'RETURN_AFTER_CHARITY_RAISED',
          'A late amount’s payment came back after it was raised to charity; operations resolves it',
          { transactionRef },
        );
      return ok({ eventType: 'LATE_COLLECTION_RETURNED', transaction: c.record.transaction, detail });
    }
    if (late.status !== 'BILLED') return fail('LATE_AMOUNT_NOT_IN_STATE', 'This late amount is not awaiting payment');
    const paid = result.amountMinorUnits ?? bill.amount.minorUnits;
    if (paid !== bill.amount.minorUnits)
      return fail('LATE_AMOUNT_DIFFERS', 'What was paid differs from the late amount billed; operations resolves it');
    return collect(c, late, bill, result, detail);
  });
}

async function collect(
  c: StepContext,
  late: LateAmount,
  bill: LateBill,
  result: Parameters<typeof recordLateCollectionResult>[2],
  detail: Readonly<Record<string, string>>,
): Promise<Result<StepOutcome>> {
  const t = c.record.transaction;
  const at = await c.attestation.attest();
  // The product module's own gate: never on an assessment of inability, never without the board's basis (SH-13, SH-14).
  const entry = postLateAmount({
    entryId: randomUUID(),
    tenantId: t.core.tenantId,
    transactionId: t.core.transactionId,
    amount: bill.amount,
    assessment: late.assessment ?? 'UNABLE',
    computationBasisConfigKey: late.computationBasisKey,
    shariahApprovalId: t.core.shariahApprovalId,
    recordedAt: at,
  });
  if (!entry.ok) return entry;
  const accounts = loadMurabahaAccounts(c.tenant);
  if (!accounts.ok) return accounts;
  const charityAccount = accounts.value.institutionAccounts['CHARITY_LIABILITY'];
  if (charityAccount === undefined)
    return reject('SH-13', 'CHARITY_ACCOUNT_UNMAPPED', 'No segregated charity liability account is configured');
  const reached = await coreBankingFor(c.tenant, at);
  if (!reached.ok) return reached;
  const posted = await reached.value.core.postCharityLiability(
    {
      tenantId: c.tenant,
      transactionId: c.record.transactionRef,
      account: { value: charityAccount },
      amount: bill.amount,
      reasonCode: 'LATE_PAYMENT',
      correlationId: t.core.correlationId,
    },
    { value: `${result.idempotencyKey}:charity` },
  );
  if (!posted.ok) return posted;
  return ok({
    eventType: 'LATE_AMOUNT_COLLECTED',
    transaction: t,
    charity: {
      kind: 'RAISE',
      entryId: entry.value.entryId,
      amount: entry.value.amount,
      sourceRef: result.idempotencyKey,
      computationBasisKey: entry.value.computationBasisConfigKey,
      recordedAt: at,
    },
    detail: { ...detail, corePostingRef: posted.value.value.slice(0, 64), coreBanking: reached.value.source },
  });
}

// -- Disbursing to a board-approved recipient ----------------------------------------

/** Finance proposes the board-approved recipient a collected late amount goes to. */
export function proposeDisbursement(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  input: { readonly sequenceNumber: number; readonly recipientId: string },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => {
    const a = lateAmountIn(c.record, input.sequenceNumber, ['COLLECTED']);
    if (!a.ok) return Promise.resolve(a);
    const recipient = c.board.lateAmounts?.approvedRecipients.find((r) => r.recipientId === input.recipientId);
    if (recipient === undefined)
      return Promise.resolve(
        reject('SH-13', 'RECIPIENT_NOT_APPROVED', 'Disbursement is only to recipients on the board-approved register'),
      );
    return Promise.resolve(
      ok({
        eventType: 'CHARITY_DISBURSEMENT_PROPOSED',
        transaction: c.record.transaction,
        detail: { sequenceNumber: String(input.sequenceNumber), recipientId: recipient.recipientId },
      }),
    );
  });
}

/** A different person declines the proposed disbursement; the amount stays held for charity. */
export function declineDisbursement(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  sequenceNumber: number,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => {
    const a = lateAmountIn(c.record, sequenceNumber, ['DISBURSEMENT_PROPOSED']);
    if (!a.ok) return Promise.resolve(a);
    if (a.value.disbursement?.proposedBy === actor)
      return Promise.resolve(
        fail('FOUR_EYES_SELF_CONFIRMATION', 'The person who proposed a disbursement may not decide on it'),
      );
    return Promise.resolve(
      ok({
        eventType: 'CHARITY_DISBURSEMENT_DECLINED',
        transaction: c.record.transaction,
        detail: { sequenceNumber: String(sequenceNumber) },
      }),
    );
  });
}

/**
 * A different person approves the disbursement: the recipient is checked
 * against the board's register as it stands now, the entry's disbursement is
 * completed once, and the payment to the recipient is instructed through the
 * payments hub.
 */
export function approveDisbursement(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  sequenceNumber: number,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const a = lateAmountIn(c.record, sequenceNumber, ['DISBURSEMENT_PROPOSED']);
    if (!a.ok) return a;
    const late = a.value;
    const proposal = late.disbursement;
    const held = late.charity;
    if (proposal === undefined || held === undefined)
      return fail('LATE_AMOUNT_NOT_IN_STATE', 'Nothing is held for this late amount');
    if (proposal.proposedBy === actor)
      return fail('FOUR_EYES_SELF_CONFIRMATION', 'The person who proposed a disbursement may not approve it');
    const register = c.board.lateAmounts?.approvedRecipients ?? [];
    const t = c.record.transaction;
    const key = `wasl:${transactionRef}:charity:I${String(sequenceNumber)}:pay`;
    const entry: CharityLedgerEntry = {
      entryId: held.entryId,
      tenantId: t.core.tenantId,
      transactionId: t.core.transactionId,
      accountClass: 'CHARITY_LIABILITY',
      amount: late.amount,
      reason: 'LATE_PAYMENT',
      computationBasisConfigKey: late.computationBasisKey,
      shariahApprovalId: t.core.shariahApprovalId,
      recordedAt: held.recordedAt,
    };
    // The product module's own gate: only to a recipient on the register it is handed, and only once.
    const disbursed = disburse(
      entry,
      proposal.recipientId,
      register.map((r) => r.recipientId),
      key,
    );
    if (!disbursed.ok) return disbursed;
    const recipient = register.find((r) => r.recipientId === proposal.recipientId);
    if (recipient === undefined)
      return reject(
        'SH-13',
        'RECIPIENT_NOT_APPROVED',
        'Disbursement is only to recipients on the board-approved register',
      );
    const at = await c.attestation.attest();
    return ok({
      eventType: 'CHARITY_DISBURSED',
      transaction: t,
      charity: {
        kind: 'DISBURSE',
        entryId: held.entryId,
        recipientId: recipient.recipientId,
        disbursementRef: key,
        disbursedAt: at,
      },
      outbox: [
        {
          eventId: key,
          tenantId: t.core.tenantId,
          kind: 'PAYMENT_DISBURSE',
          subjectRef: transactionRef,
          idempotencyKey: key,
          payload: {
            rail: 'PAYMENTS_HUB',
            beneficiaryRef: `charity:${recipient.recipientId}`,
            beneficiaryIban: recipient.iban,
            minorUnits: late.amount.minorUnits.toString(),
            currency: late.amount.currency,
            reason: 'CHARITY_DISBURSEMENT',
          },
          correlationId: t.core.correlationId,
        },
      ],
      detail: { sequenceNumber: String(sequenceNumber), recipientId: recipient.recipientId, disbursementRef: key },
    });
  });
}

// -- The tenant's charity ledger, as the transactions hold it ------------------------

export interface CharityHolding {
  readonly transactionRef: string;
  readonly late: LateAmount;
}

/** Every late amount raised to charity across the given transactions, oldest first. */
export function charityHoldings(views: readonly TransactionRecord[]): readonly CharityHolding[] {
  const raisedAt = (h: CharityHolding): bigint => h.late.charity?.recordedAt.epochSeconds ?? 0n;
  return views
    .flatMap((v) => lateAmounts(v).map((late) => ({ transactionRef: v.transactionRef, late })))
    .filter((h) => h.late.charity !== undefined)
    .sort((a, b) => (raisedAt(a) < raisedAt(b) ? -1 : 1));
}
