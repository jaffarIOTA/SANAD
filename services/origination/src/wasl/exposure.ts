/**
 * What the Wasl book holds against each limit (W5a): the cost of every
 * transaction from the moment its limit is held until it settles or is
 * unwound. Read from the transactions' own states, so the workbench, the
 * facility approvals and trade validation all count the same thing.
 */
import type { WaslParties } from '@sanad/config/loader.ts';

import type { TransactionRecord } from './book.ts';

/** States in which a transaction's cost counts against its limits: from the hold until it is settled or unwound. */
export const HOLDING: ReadonlySet<string> = new Set([
  'LIMIT_RESERVED',
  'WAAD_EXECUTED',
  'PURCHASE_EXECUTED',
  'OWNERSHIP_ACQUIRED',
  'POSSESSION_CONFIRMED',
  'SALE_OFFERED',
  'OFFER_LAPSED',
  'EXECUTED',
  'ACTIVE',
  'DELINQUENT',
  'HARDSHIP',
  'RESCHEDULED',
]);

/** States in which the institution has bought the goods: the hold has become utilisation. */
export const PURCHASED: ReadonlySet<string> = new Set([
  'PURCHASE_EXECUTED',
  'OWNERSHIP_ACQUIRED',
  'POSSESSION_CONFIRMED',
  'SALE_OFFERED',
  'OFFER_LAPSED',
  'EXECUTED',
  'ACTIVE',
  'DELINQUENT',
  'HARDSHIP',
  'RESCHEDULED',
  'SETTLED',
]);

const held = (book: readonly TransactionRecord[], keep: (r: TransactionRecord) => boolean): bigint =>
  book
    .filter((r) => HOLDING.has(r.transaction.state) && keep(r))
    .reduce((s, r) => s + r.transaction.core.pricing.costAmount.minorUnits, 0n);

export interface BookExposure {
  /** The distributor's holdings in this programme. */
  readonly facilityHeld: bigint;
  readonly programmeHeld: bigint;
  /** Every programme of the same anchor. */
  readonly anchorHeld: bigint;
  /** The sum of the institution's programme limits. */
  readonly bookLimit: bigint;
}

/** What the book holds for a distributor in a programme, the programme, its anchor, and the book's capacity. */
export function exposureOf(
  book: readonly TransactionRecord[],
  parties: WaslParties,
  counterpartyId: string,
  programmeId: string,
): BookExposure {
  const anchorCr = parties.programmes.find((p) => p.programmeId === programmeId)?.anchor.registrationNo;
  const ofAnchor = new Set(
    parties.programmes.filter((p) => p.anchor.registrationNo === anchorCr).map((p) => p.programmeId),
  );
  return {
    facilityHeld: held(
      book,
      (r) => r.transaction.core.programmeId === programmeId && r.transaction.core.counterpartyId === counterpartyId,
    ),
    programmeHeld: held(book, (r) => r.transaction.core.programmeId === programmeId),
    anchorHeld: held(book, (r) => ofAnchor.has(r.transaction.core.programmeId)),
    bookLimit: parties.programmes.reduce((s, p) => s + p.programmeLimitMinorUnits, 0n),
  };
}
