/**
 * Purifying income from a defective Murabaha (BR-F06, Wasl W6b-2).
 *
 * When a Shariah incident finds that a transaction's income was affected, the
 * income is given away, never kept. How much is the board's ruling
 * (`PurificationPositions.method`): the transaction's whole profit, or an
 * amount the Shariah reviewer assesses — never more than the profit, which is
 * all the income a Murabaha earns.
 *
 * It is raised to the segregated charity liability as it is collected —
 * decided with the product owner on 26 October 2026 — so each instalment
 * carries a share of the amount in proportion to its part of the sale price,
 * and that share is raised when that instalment is paid. The shares are whole
 * minor units and sum to the amount exactly: each is rounded down and the last
 * instalment takes what remains. No rate, no proportion of time: the split is
 * of amounts already fixed.
 */

import { type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';

import type { PurificationPositions } from '../structures/board-positions.ts';
import type { CharityLedgerEntry } from './charity.ts';

/** The amount to purify under the board's method: the whole profit, or the reviewer's assessment within it. */
export function purificationAmount(
  ruling: PurificationPositions,
  profit: Money,
  assessedMinorUnits?: bigint,
): Result<Money> {
  if (profit.minorUnits <= 0n)
    return reject('SH-13', 'NO_INCOME_TO_PURIFY', 'This transaction earns no profit, so there is no income to purify');
  if (ruling.method === 'WHOLE_PROFIT') return ok(profit);
  if (assessedMinorUnits === undefined || assessedMinorUnits <= 0n)
    return reject('OP-DETERMINACY', 'PURIFICATION_AMOUNT_REQUIRED', 'The board rules an assessed amount: state it');
  if (assessedMinorUnits > profit.minorUnits)
    return reject('SH-13', 'PURIFICATION_ABOVE_PROFIT', 'A Murabaha’s income is its profit; no more is purified');
  return ok(money(assessedMinorUnits, profit.currency));
}

/**
 * Each instalment's share of the amount, in proportion to the instalment's
 * part of the sale price, by sequence number. Rounded down, the last taking
 * the remainder, so the shares sum to the amount.
 */
export function purificationShares(
  amount: Money,
  instalments: readonly { readonly sequenceNumber: number; readonly amount: Money }[],
): ReadonlyMap<number, Money> {
  const total = instalments.reduce((s, i) => s + i.amount.minorUnits, 0n);
  const shares = new Map<number, Money>();
  if (total <= 0n) return shares;
  let given = 0n;
  instalments.forEach((i, n) => {
    const share =
      n === instalments.length - 1 ? amount.minorUnits - given : (amount.minorUnits * i.amount.minorUnits) / total;
    given += share;
    shares.set(i.sequenceNumber, money(share, amount.currency));
  });
  return shares;
}

export interface PurificationRaise {
  readonly entryId: string;
  readonly tenantId: string;
  readonly transactionId: string;
  readonly amount: Money;
  readonly computationBasisConfigKey: string;
  readonly shariahApprovalId: string;
  readonly recordedAt: TsaInstant;
}

/** A collected share of purified income, as a charity ledger entry: never anything income could be. */
export function postPurification(request: PurificationRaise): Result<CharityLedgerEntry> {
  if (request.amount.minorUnits <= 0n)
    return reject('OP-DETERMINACY', 'PURIFICATION_SHARE_NOT_POSITIVE', 'A purified share is positive');
  if (request.computationBasisConfigKey.trim().length === 0)
    return reject('SH-13', 'NO_COMPUTATION_BASIS', 'Purified income names the board’s basis for its amount');
  return ok({
    entryId: request.entryId,
    tenantId: request.tenantId,
    transactionId: request.transactionId,
    accountClass: 'CHARITY_LIABILITY',
    amount: request.amount,
    reason: 'NON_COMPLIANT_INCOME',
    computationBasisConfigKey: request.computationBasisConfigKey,
    shariahApprovalId: request.shariahApprovalId,
    recordedAt: request.recordedAt,
  });
}
