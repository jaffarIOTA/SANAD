 function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }/**
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

import { ok, reject } from '../../../core/kernel/result.js';
import { isStrictlyLater } from '../../../core/time/tsa.js';

 








































/**
 * Append a leg to a chain, validating the two structural invariants.
 *
 * This is the only way a leg enters the aggregate, so there is no path that
 * produces an unchained or out-of-order leg.
 */
export function appendLeg(
  chain,
  leg,
) {
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
export function verifyChain(chain) {
  let rebuilt = [];
  for (const leg of chain) {
    const step = appendLeg(rebuilt, leg);
    if (!step.ok) return step;
    rebuilt = step.value;
  }
  return ok(true);
}

export const findLeg = (
  chain,
  legType,
) => chain.find((l) => l.legType === legType);

export const lastExecutedAt = (chain) =>
  _optionalChain([chain, 'access', _ => _.at, 'call', _2 => _2(-1), 'optionalAccess', _3 => _3.executedAt]);
