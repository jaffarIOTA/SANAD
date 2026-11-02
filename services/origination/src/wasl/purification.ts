/**
 * Purification of income from a defective Wasl transaction (W6b-2; BR-F06),
 * the purification branch of a Shariah incident (W6b-1), decided with the
 * product owner on 26 October 2026.
 *
 *   Proposed. Once an incident on the transaction is remediated as having
 *   affected income, a Shariah reviewer proposes purifying it, at the amount
 *   the board's method fixes (products/murabaha-scf/ledger/purification.ts):
 *   the whole profit, or the reviewer's assessment with a reason.
 *
 *   Confirmed by a second Shariah reviewer, or rejected with a reason (and
 *   proposed again). The amount is split across the instalments in proportion
 *   to each one's part of the sale price.
 *
 *   Raised as collected. When an instalment is paid, its share is raised to
 *   the segregated charity liability — an entry in `core.charity_ledger` with
 *   reason NON_COMPLIANT_INCOME and the posting to the core's charity
 *   liability account, together. Instalments already paid when it is
 *   confirmed are raised then. It is never the institution's income (SH-13).
 *
 *   Disbursed, share by share, as a late amount is: finance proposes a
 *   recipient the board approved for purification, a different person
 *   approves, and the payment is instructed through the payments hub.
 *
 * The incident closes once every share is raised (incidents.ts asks here).
 * Every state is rebuilt from the transaction's event log, so the workbench,
 * the webhooks and the daily cycle read the same thing.
 */
import { randomUUID } from 'node:crypto';

import { type TenantCode, loadMurabahaAccounts } from '@sanad/config/loader.ts';
import { type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type TsaInstant, restoreAttestedInstant } from '@sanad/core/time/tsa.ts';
import { type CharityLedgerEntry, disburse } from '@sanad/products/murabaha-scf/ledger/charity.ts';
import {
  postPurification,
  purificationAmount,
  purificationShares,
} from '@sanad/products/murabaha-scf/ledger/purification.ts';

import { registerPurificationCheck, shariahIncidents } from '../shariah/incidents.ts';
import { type TransactionRecord, type TransactionView, WASL_PRODUCT, getTransaction, hydrate } from './book.ts';
import { coreBankingFor } from './booking.ts';
import { bookedSchedule, obligationPosition } from './settlement.ts';
import { type StepContext, type StepOutcome, fail, step } from './steps.ts';

export type PurificationState = 'PROPOSED' | 'CONFIRMED' | 'REJECTED';

export interface PurifiedShare {
  readonly sequenceNumber: number;
  readonly amount: Money;
  readonly raised?: {
    readonly entryId: string;
    readonly sourceRef: string;
    readonly recordedAt: TsaInstant;
    readonly corePostingRef: string;
  };
  readonly disbursement?: { readonly proposedBy: string; readonly recipientId: string };
  readonly disbursed?: { readonly recipientId: string; readonly disbursementRef: string; readonly by: string };
}

export interface Purification {
  readonly incidentRef: string;
  readonly method: 'WHOLE_PROFIT' | 'ASSESSED_AMOUNT';
  readonly amount: Money;
  readonly computationBasisKey: string;
  /** The reviewer's reason, in their words. */
  readonly note: string;
  readonly proposedBy: string;
  readonly state: PurificationState;
  readonly decidedBy?: string;
  readonly decisionNote?: string;
  /** Each instalment's share, once confirmed. */
  readonly shares: readonly PurifiedShare[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The share key: what the charity entry, the core posting and the database's check all name. */
export const purifiedShareKey = (transactionRef: string, incidentRef: string, sequenceNumber: number): string =>
  `wasl:${transactionRef}:purify:${incidentRef}:I${String(sequenceNumber)}`;

/** Every purification on the transaction, by incident, as its event log rebuilds them. */
export function purifications(record: TransactionRecord): readonly Purification[] {
  const currency = record.transaction.core.pricing.salePriceAmount.currency;
  const out = new Map<string, Purification>();
  const update = (ref: string, f: (p: Purification) => Purification) => {
    const p = out.get(ref);
    if (p !== undefined) out.set(ref, f(p));
  };
  const share = (p: Purification, n: number, f: (s: PurifiedShare) => PurifiedShare): Purification => ({
    ...p,
    shares: p.shares.map((s) => (s.sequenceNumber === n ? f(s) : s)),
  });
  for (const e of record.events) {
    const d = e.detail;
    const ref = str(d['incidentRef']) ?? '';
    const n = Number(str(d['sequenceNumber']) ?? '0');
    switch (e.eventType) {
      case 'PURIFICATION_PROPOSED':
        out.set(ref, {
          incidentRef: ref,
          method: d['method'] === 'ASSESSED_AMOUNT' ? 'ASSESSED_AMOUNT' : 'WHOLE_PROFIT',
          amount: money(BigInt(str(d['amountMinor']) ?? '0'), currency),
          computationBasisKey: str(d['computationBasisKey']) ?? '',
          note: str(d['note']) ?? '',
          proposedBy: e.actor,
          state: 'PROPOSED',
          shares: [],
        });
        break;
      case 'PURIFICATION_REJECTED':
        update(ref, (p) => ({ ...p, state: 'REJECTED', decidedBy: e.actor, decisionNote: str(d['note']) ?? '' }));
        break;
      case 'PURIFICATION_CONFIRMED': {
        const split = JSON.parse(str(d['shares']) ?? '[]') as { n: number; m: string }[];
        update(ref, (p) => ({
          ...p,
          state: 'CONFIRMED',
          decidedBy: e.actor,
          shares: split.map((s) => ({ sequenceNumber: s.n, amount: money(BigInt(s.m), currency) })),
        }));
        break;
      }
      case 'PURIFICATION_RAISED': {
        const c = d['charity'] as Record<string, string> | undefined;
        update(ref, (p) =>
          share(p, n, (s) => ({
            ...s,
            raised: {
              entryId: c?.['entryId'] ?? '',
              sourceRef: c?.['sourceRef'] ?? '',
              corePostingRef: str(d['corePostingRef']) ?? '',
              recordedAt: restoreAttestedInstant({
                epochSeconds: BigInt(c?.['recordedAtEpoch'] ?? '0'),
                tokenDigest: c?.['recordedAtDigest'] ?? '',
                authorityId: c?.['recordedAtAuthority'] ?? '',
              }),
            },
          })),
        );
        break;
      }
      case 'PURIFICATION_DISBURSEMENT_PROPOSED':
        update(ref, (p) =>
          share(p, n, (s) => ({
            ...s,
            disbursement: { proposedBy: e.actor, recipientId: str(d['recipientId']) ?? '' },
          })),
        );
        break;
      case 'PURIFICATION_DISBURSEMENT_DECLINED':
        update(ref, (p) => share(p, n, ({ disbursement: _d, ...s }) => s));
        break;
      case 'PURIFICATION_DISBURSED':
        update(ref, (p) =>
          share(p, n, (s) => ({
            ...s,
            disbursed: {
              recipientId: str(d['recipientId']) ?? '',
              disbursementRef: str(d['disbursementRef']) ?? '',
              by: e.actor,
            },
          })),
        );
        break;
      default:
        break;
    }
  }
  return [...out.values()];
}

/** Purified in full: confirmed, and every share raised to the charity liability. */
export const purifiedInFull = (p: Purification | undefined): boolean =>
  p?.state === 'CONFIRMED' && p.shares.length > 0 && p.shares.every((s) => s.raised !== undefined);

// The incident closes only once its income is purified in full (core/shariah/incidents.ts asks through this).
registerPurificationCheck(WASL_PRODUCT, async (tenant, subjectRef, incidentRef) => {
  const record = (await hydrate(tenant)).records.get(subjectRef);
  return record !== undefined && purifiedInFull(purifications(record).find((p) => p.incidentRef === incidentRef));
});

// -- Proposing and deciding -----------------------------------------------------------

/** The incident a purification belongs to: on this transaction, remediated as having affected income. */
async function incidentFor(tenant: TenantCode, transactionRef: string, incidentRef: string): Promise<Result<true>> {
  const incident = (await shariahIncidents(tenant)).find((i) => i.incidentRef === incidentRef);
  if (incident?.subjectRef !== transactionRef)
    return fail('INCIDENT_NOT_FOUND', 'No such incident on this transaction');
  if (incident.status !== 'REMEDIATED' || !incident.purificationRequired)
    return fail(
      'INCIDENT_NOT_AWAITING_PURIFICATION',
      'Purification follows an incident remediated as having affected income',
    );
  return ok(true);
}

/** A Shariah reviewer proposes purifying the income an incident affected, at the amount the board's method fixes. */
export function proposePurification(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  input: { readonly incidentRef: string; readonly assessedMinorUnits?: bigint; readonly note: string },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const incident = await incidentFor(tenant, transactionRef, input.incidentRef);
    if (!incident.ok) return incident;
    const existing = purifications(c.record).find((p) => p.incidentRef === input.incidentRef);
    if (existing !== undefined && existing.state !== 'REJECTED')
      return fail('PURIFICATION_ALREADY_PROPOSED', 'This incident’s purification is already proposed or confirmed');
    const ruling = c.board.purification;
    if (ruling === undefined)
      return reject('SH-13', 'PURIFICATION_NOT_RULED', 'The board has ruled no purification method');
    const note = input.note.trim().slice(0, 1000);
    if (note.length < 3) return fail('PURIFICATION_REASON_REQUIRED', 'Say why, and how the amount was reached');
    const amount = purificationAmount(ruling, c.record.transaction.core.pricing.profitAmount, input.assessedMinorUnits);
    if (!amount.ok) return amount;
    return ok({
      eventType: 'PURIFICATION_PROPOSED',
      transaction: c.record.transaction,
      detail: {
        incidentRef: input.incidentRef,
        method: ruling.method,
        amountMinor: amount.value.minorUnits.toString(),
        computationBasisKey: ruling.computationBasisKey,
        note,
      },
    });
  });
}

/**
 * A different Shariah reviewer confirms the purification, fixing each
 * instalment's share, or rejects it with a reason. Confirmed, the shares of
 * instalments already paid are raised at once.
 */
export async function decidePurification(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  input: { readonly incidentRef: string; readonly confirm: boolean; readonly note: string },
): Promise<Result<TransactionView>> {
  const decided = await step(tenant, transactionRef, actor, async (c) => {
    const p = purifications(c.record).find((x) => x.incidentRef === input.incidentRef);
    if (p?.state !== 'PROPOSED') return fail('PURIFICATION_NOT_PROPOSED', 'No purification awaits a decision');
    if (p.proposedBy === actor)
      return fail('FOUR_EYES_SELF_APPROVAL', 'The reviewer who proposed a purification may not decide it');
    const note = input.note.trim().slice(0, 1000);
    if (!input.confirm) {
      if (note.length < 3) return fail('REJECTION_REASON_REQUIRED', 'A rejection says why');
      return ok({
        eventType: 'PURIFICATION_REJECTED',
        transaction: c.record.transaction,
        detail: { incidentRef: input.incidentRef, note },
      });
    }
    const incident = await incidentFor(tenant, transactionRef, input.incidentRef);
    if (!incident.ok) return incident;
    const schedule = bookedSchedule(c.record);
    if (schedule === undefined)
      return fail('PURIFICATION_BEFORE_BOOKING', 'The obligation is not booked, so there is no income to purify yet');
    const shares = purificationShares(p.amount, schedule);
    return ok({
      eventType: 'PURIFICATION_CONFIRMED',
      transaction: c.record.transaction,
      detail: {
        incidentRef: input.incidentRef,
        amountMinor: p.amount.minorUnits.toString(),
        shares: JSON.stringify([...shares].map(([n, m]) => ({ n, m: m.minorUnits.toString() }))),
      },
    });
  });
  if (!decided.ok || !input.confirm) return decided;
  // The shares of instalments already paid: raised now. If the core cannot take them, the daily review raises them.
  await raisePurificationsDue(tenant, transactionRef, actor);
  return ok((await getTransaction(tenant, transactionRef)) ?? decided.value);
}

// -- Raising as collected -------------------------------------------------------------

/**
 * Raise every confirmed share whose instalment is paid and is not yet raised,
 * one step each. Idempotent: called after each collection, on confirmation
 * and by the daily Shariah review, and raises nothing twice (the share key is
 * unique in the ledger too). Answers how many it raised.
 */
export async function raisePurificationsDue(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
): Promise<Result<number>> {
  let raised = 0;
  for (;;) {
    const record = (await hydrate(tenant)).records.get(transactionRef);
    if (record === undefined) return fail('TRANSACTION_NOT_FOUND', 'No such transaction');
    const due = nextShareDue(tenant, record);
    if (due === undefined) return ok(raised);
    const r = await step(tenant, transactionRef, actor, (c) => raiseShare(c, due.incidentRef, due.sequenceNumber));
    if (!r.ok) return r;
    raised += 1;
  }
}

function nextShareDue(
  tenant: TenantCode,
  record: TransactionRecord,
): { readonly incidentRef: string; readonly sequenceNumber: number } | undefined {
  const confirmed = purifications(record).filter((p) => p.state === 'CONFIRMED');
  if (confirmed.length === 0) return undefined;
  // Whether an instalment is paid does not depend on the day asked: every standing receipt counts, whatever its
  // value date (a receipt can be value-dated after the moment it is recorded).
  const position = obligationPosition(record, '9999-12-31');
  const paid = new Set(
    (position?.instalments ?? []).filter((i) => i.outstanding.minorUnits === 0n).map((i) => i.number),
  );
  for (const p of confirmed)
    for (const s of p.shares)
      if (s.raised === undefined && s.amount.minorUnits > 0n && paid.has(s.sequenceNumber))
        return { incidentRef: p.incidentRef, sequenceNumber: s.sequenceNumber };
  return undefined;
}

async function raiseShare(c: StepContext, incidentRef: string, sequenceNumber: number): Promise<Result<StepOutcome>> {
  const p = purifications(c.record).find((x) => x.incidentRef === incidentRef);
  const s = p?.shares.find((x) => x.sequenceNumber === sequenceNumber);
  if (p === undefined || s === undefined || s.raised !== undefined)
    return fail('PURIFICATION_SHARE_NOT_DUE', 'This share is not awaiting its collection');
  const t = c.record.transaction;
  const at = await c.attestation.attest();
  // The product module's own gate: a positive share, under the board's basis, as charity and nothing else.
  const entry = postPurification({
    entryId: randomUUID(),
    tenantId: t.core.tenantId,
    transactionId: t.core.transactionId,
    amount: s.amount,
    computationBasisConfigKey: p.computationBasisKey,
    shariahApprovalId: t.core.shariahApprovalId,
    recordedAt: at,
  });
  if (!entry.ok) return entry;
  const accounts = loadMurabahaAccounts(c.tenant);
  if (!accounts.ok) return accounts;
  const charityAccount = accounts.value.institutionAccounts['CHARITY_LIABILITY'];
  if (charityAccount === undefined)
    return reject('SH-13', 'CHARITY_ACCOUNT_UNMAPPED', 'No segregated charity liability account is configured');
  const key = purifiedShareKey(c.record.transactionRef, incidentRef, sequenceNumber);
  const reached = await coreBankingFor(c.tenant, at);
  if (!reached.ok) return reached;
  const posted = await reached.value.core.postCharityLiability(
    {
      tenantId: c.tenant,
      transactionId: c.record.transactionRef,
      account: { value: charityAccount },
      amount: s.amount,
      reasonCode: 'NON_COMPLIANT_INCOME',
      correlationId: t.core.correlationId,
    },
    { value: `${key}:charity` },
  );
  if (!posted.ok) return posted;
  return ok({
    eventType: 'PURIFICATION_RAISED',
    transaction: t,
    charity: {
      kind: 'RAISE',
      entryId: entry.value.entryId,
      amount: entry.value.amount,
      reason: 'NON_COMPLIANT_INCOME',
      sourceRef: key,
      computationBasisKey: entry.value.computationBasisConfigKey,
      recordedAt: at,
    },
    detail: {
      incidentRef,
      sequenceNumber: String(sequenceNumber),
      corePostingRef: posted.value.value.slice(0, 64),
      coreBanking: reached.value.source,
    },
  });
}

// -- Disbursing to a board-approved recipient ----------------------------------------

function raisedShare(
  record: TransactionRecord,
  incidentRef: string,
  sequenceNumber: number,
): Result<{ readonly p: Purification; readonly s: PurifiedShare }> {
  const p = purifications(record).find((x) => x.incidentRef === incidentRef);
  const s = p?.shares.find((x) => x.sequenceNumber === sequenceNumber);
  if (p === undefined || s?.raised === undefined)
    return fail('PURIFICATION_SHARE_NOT_RAISED', 'Nothing is held for charity for this share yet');
  if (s.disbursed !== undefined) return reject('SH-13', 'ALREADY_DISBURSED', 'This share has already been disbursed');
  return ok({ p, s });
}

/** Finance proposes the board-approved recipient a raised share goes to. */
export function proposePurificationDisbursement(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  input: { readonly incidentRef: string; readonly sequenceNumber: number; readonly recipientId: string },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => {
    const held = raisedShare(c.record, input.incidentRef, input.sequenceNumber);
    if (!held.ok) return Promise.resolve(held);
    if (held.value.s.disbursement !== undefined)
      return Promise.resolve(fail('DISBURSEMENT_ALREADY_PROPOSED', 'A recipient is already proposed for this share'));
    const recipient = c.board.purification?.approvedRecipients.find((r) => r.recipientId === input.recipientId);
    if (recipient === undefined)
      return Promise.resolve(
        reject('SH-13', 'RECIPIENT_NOT_APPROVED', 'Purified income goes only to recipients the board approved for it'),
      );
    return Promise.resolve(
      ok({
        eventType: 'PURIFICATION_DISBURSEMENT_PROPOSED',
        transaction: c.record.transaction,
        detail: {
          incidentRef: input.incidentRef,
          sequenceNumber: String(input.sequenceNumber),
          recipientId: recipient.recipientId,
        },
      }),
    );
  });
}

/** A different person declines the proposed recipient; the share stays held for charity. */
export function declinePurificationDisbursement(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  input: { readonly incidentRef: string; readonly sequenceNumber: number },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => {
    const held = raisedShare(c.record, input.incidentRef, input.sequenceNumber);
    if (!held.ok) return Promise.resolve(held);
    const proposal = held.value.s.disbursement;
    if (proposal === undefined)
      return Promise.resolve(fail('DISBURSEMENT_NOT_PROPOSED', 'No recipient is proposed for this share'));
    if (proposal.proposedBy === actor)
      return Promise.resolve(
        fail('FOUR_EYES_SELF_CONFIRMATION', 'The person who proposed a disbursement may not decide on it'),
      );
    return Promise.resolve(
      ok({
        eventType: 'PURIFICATION_DISBURSEMENT_DECLINED',
        transaction: c.record.transaction,
        detail: { incidentRef: input.incidentRef, sequenceNumber: String(input.sequenceNumber) },
      }),
    );
  });
}

/**
 * A different person approves: the recipient is checked against the board's
 * purification register as it stands now, the entry's disbursement completed
 * once, and the payment instructed through the payments hub.
 */
export function approvePurificationDisbursement(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  input: { readonly incidentRef: string; readonly sequenceNumber: number },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const held = raisedShare(c.record, input.incidentRef, input.sequenceNumber);
    if (!held.ok) return held;
    const { p, s } = held.value;
    const proposal = s.disbursement;
    const raised = s.raised;
    if (proposal === undefined || raised === undefined)
      return fail('DISBURSEMENT_NOT_PROPOSED', 'No recipient is proposed for this share');
    if (proposal.proposedBy === actor)
      return fail('FOUR_EYES_SELF_CONFIRMATION', 'The person who proposed a disbursement may not approve it');
    const register = c.board.purification?.approvedRecipients ?? [];
    const t = c.record.transaction;
    const key = `${raised.sourceRef}:pay`;
    const entry: CharityLedgerEntry = {
      entryId: raised.entryId,
      tenantId: t.core.tenantId,
      transactionId: t.core.transactionId,
      accountClass: 'CHARITY_LIABILITY',
      amount: s.amount,
      reason: 'NON_COMPLIANT_INCOME',
      computationBasisConfigKey: p.computationBasisKey,
      shariahApprovalId: t.core.shariahApprovalId,
      recordedAt: raised.recordedAt,
    };
    const disbursed = disburse(
      entry,
      proposal.recipientId,
      register.map((r) => r.recipientId),
      key,
    );
    if (!disbursed.ok) return disbursed;
    const recipient = register.find((r) => r.recipientId === proposal.recipientId);
    if (recipient === undefined)
      return reject('SH-13', 'RECIPIENT_NOT_APPROVED', 'Purified income goes only to recipients the board approved');
    const at = await c.attestation.attest();
    return ok({
      eventType: 'PURIFICATION_DISBURSED',
      transaction: t,
      charity: {
        kind: 'DISBURSE',
        entryId: raised.entryId,
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
            minorUnits: s.amount.minorUnits.toString(),
            currency: s.amount.currency,
            reason: 'CHARITY_DISBURSEMENT',
          },
          correlationId: t.core.correlationId,
        },
      ],
      detail: {
        incidentRef: input.incidentRef,
        sequenceNumber: String(input.sequenceNumber),
        recipientId: recipient.recipientId,
        disbursementRef: key,
      },
    });
  });
}

// -- The tenant's purifications ------------------------------------------------------

export interface PurificationHolding {
  readonly transactionRef: string;
  readonly purification: Purification;
}

/** Every purification across the tenant's Wasl book. */
export async function purificationsOf(tenant: TenantCode): Promise<readonly PurificationHolding[]> {
  return [...(await hydrate(tenant)).records.values()].flatMap((r) =>
    purifications(r).map((purification) => ({ transactionRef: r.transactionRef, purification })),
  );
}
