/**
 * Contract legs.
 *
 * Each leg of a structure is a separate instrument: separately executed,
 * separately timestamped, hash-chained to its predecessor (SH-07). The chain is
 * what lets the Board verify the order mathematically, from the documents alone,
 * without trusting our logs.
 *
 * Two constraints are carried here and mirrored as database constraints:
 *   - a document belongs to exactly one leg, so two legs cannot be rendered into
 *     one instrument;
 *   - leg timestamps are strictly increasing, so a sale cannot be back-dated
 *     behind the possession it depends on.
 */

import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type TsaInstant, isStrictlyLater } from '@sanad/core/time/tsa.ts';

export type LegType =
  | 'WAAD' // binding promise to purchase
  | 'PURCHASE' // institution buys the goods
  | 'SALE_OFFER' // Murabaha offer: cost and profit disclosed
  | 'ACCEPTANCE'
  | 'DELIVERY'
  | 'TITLE_TRANSFER';

export type CounterpartyRole = 'SELLER' | 'BUYER' | 'INSTITUTION';

export interface ContractLeg {
  readonly legId: string;
  readonly tenantId: string;
  readonly transactionId: string;

  readonly legType: LegType;
  /** Position in the structure's declared sequence. Unique per transaction. */
  readonly sequenceNo: number;

  /** Exactly one document per leg. Never a list. */
  readonly documentId: string;
  /** Hash of the executed rendition — the rendition that was actually presented. */
  readonly contentHash: string;
  /** Predecessor's content hash. Undefined only for the first leg. */
  readonly prevLegHash?: string;

  readonly executedAt: TsaInstant;
  /** Digest of the retained RFC 3161 token; the token itself is stored alongside. */
  readonly tsaTokenDigest: string;

  /** Exactly which approved template version produced this instrument. */
  readonly templateVersionId: string;

  readonly counterpartyRole: CounterpartyRole;
  /** Verified commercial registration number. Distinctness is matched on this. */
  readonly counterpartyCr: string;

  /** Set on execution. A database trigger rejects any subsequent update. */
  readonly immutable: true;
}

/**
 * Append a leg to a chain, validating the two structural invariants.
 *
 * This is the only way a leg enters the aggregate, so there is no path that
 * produces an unchained or out-of-order leg.
 */
export function appendLeg(
  chain: readonly ContractLeg[],
  leg: ContractLeg,
): Result<readonly ContractLeg[]> {
  const previous = chain.at(-1);

  if (previous === undefined) {
    if (leg.prevLegHash !== undefined) {
      return reject(
        'OP-CHAIN',
        'FIRST_LEG_HAS_PREDECESSOR',
        'The first leg of a transaction cannot reference a predecessor hash',
        { legId: leg.legId },
      );
    }
  } else {
    if (leg.prevLegHash !== previous.contentHash) {
      return reject('OP-CHAIN', 'HASH_CHAIN_BROKEN', 'Leg does not chain to its predecessor', {
        legId: leg.legId,
        expectedPrevHash: previous.contentHash,
      });
    }
    if (!isStrictlyLater(leg.executedAt, previous.executedAt)) {
      return reject(
        'OP-CHAIN',
        'TIMESTAMPS_NOT_MONOTONIC',
        'Leg timestamp is not strictly later than its predecessor',
        { legId: leg.legId },
      );
    }
    if (leg.sequenceNo <= previous.sequenceNo) {
      return reject('OP-CHAIN', 'SEQUENCE_NOT_MONOTONIC', 'Leg sequence number must increase', {
        legId: leg.legId,
        sequenceNo: leg.sequenceNo,
      });
    }
  }

  const documentClash = chain.find((existing) => existing.documentId === leg.documentId);
  if (documentClash !== undefined) {
    return reject(
      'SH-07',
      'DOCUMENT_ALREADY_BOUND_TO_A_LEG',
      'Each leg is a distinct instrument; a document may reference only one leg',
      { documentId: leg.documentId, boundToLegId: documentClash.legId },
    );
  }

  return ok([...chain, leg]);
}

/**
 * Verify a whole chain from the legs themselves. This is what the Board's
 * "verify full chain" action runs, and it depends on nothing but the legs.
 */
export function verifyChain(chain: readonly ContractLeg[]): Result<true> {
  let rebuilt: readonly ContractLeg[] = [];
  for (const leg of chain) {
    const step = appendLeg(rebuilt, leg);
    if (!step.ok) return step;
    rebuilt = step.value;
  }
  return ok(true);
}

export const findLeg = (
  chain: readonly ContractLeg[],
  legType: LegType,
): ContractLeg | undefined => chain.find((l) => l.legType === legType);

export const lastExecutedAt = (chain: readonly ContractLeg[]): TsaInstant | undefined =>
  chain.at(-1)?.executedAt;
