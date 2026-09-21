/**
 * Counterparty distinctness — no 'inah.
 *
 * A sale followed by a buy-back to the original seller is *bay' al-'inah*, and a
 * Murabaha in which the goods return to the party they came from is the same
 * thing wearing a supply chain. So the parties on the declared pairs of legs must
 * be different legal entities.
 *
 * Matched on verified commercial registration number, never on name (BR-D05).
 * Names differ by a suffix, a transliteration or a space; registration numbers do
 * not.
 */

import type { ContractLeg, CounterpartyRole } from '../legs/leg.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { StructureDefinition } from '../structures/definition.ts';

/** A reference of the form `PURCHASE.seller`, as written in a structure definition. */
export interface PartySlot {
  readonly legType: string;
  readonly role: CounterpartyRole;
}

export function parsePartySlot(reference: string): Result<PartySlot> {
  const [legType, role] = reference.split('.');
  if (legType === undefined || role === undefined) {
    return reject('OP-DETERMINACY', 'MALFORMED_PARTY_REFERENCE', 'Expected the form LEG_TYPE.role', {
      reference,
    });
  }
  const upper = role.toUpperCase();
  if (upper !== 'SELLER' && upper !== 'BUYER' && upper !== 'INSTITUTION') {
    return reject('OP-DETERMINACY', 'UNKNOWN_PARTY_ROLE', 'Unknown party role', { reference });
  }
  return ok({ legType: legType.toUpperCase(), role: upper });
}

function resolve(legs: readonly ContractLeg[], slot: PartySlot): ContractLeg | undefined {
  return legs.find((l) => l.legType === slot.legType && l.counterpartyRole === slot.role);
}

/**
 * Check every distinctness pair the structure declares.
 *
 * A pair whose legs have not both executed yet is skipped rather than failed —
 * the check runs again as the chain grows, and the acceptance transition will not
 * complete until it holds.
 */
export function verifyDistinctParties(
  definition: StructureDefinition,
  legs: readonly ContractLeg[],
): Result<true> {
  for (const [leftRef, rightRef] of definition.constraints.distinctParties) {
    const left = parsePartySlot(leftRef);
    if (!left.ok) return left;
    const right = parsePartySlot(rightRef);
    if (!right.ok) return right;

    const leftLeg = resolve(legs, left.value);
    const rightLeg = resolve(legs, right.value);
    if (leftLeg === undefined || rightLeg === undefined) continue;

    if (normaliseCr(leftLeg.counterpartyCr) === normaliseCr(rightLeg.counterpartyCr)) {
      return reject(
        'SH-08',
        'PARTIES_NOT_DISTINCT',
        'The same legal entity appears on both sides of the transaction',
        { left: leftRef, right: rightRef },
      );
    }
  }
  return ok(true);
}

/**
 * The broader check: across the whole chain, the party the institution bought
 * from and the party it sold to must be different entities, however the legs are
 * arranged. This catches an indirect path the declared pairs did not anticipate.
 */
export function verifyNoBuyBack(legs: readonly ContractLeg[]): Result<true> {
  const sellers = new Set(
    legs.filter((l) => l.counterpartyRole === 'SELLER').map((l) => normaliseCr(l.counterpartyCr)),
  );
  for (const leg of legs) {
    if (leg.counterpartyRole !== 'BUYER') continue;
    if (sellers.has(normaliseCr(leg.counterpartyCr))) {
      return reject(
        'SH-08',
        'BUY_BACK_TO_ORIGINAL_SELLER',
        'The goods would return to the entity they were purchased from',
        { legId: leg.legId },
      );
    }
  }
  return ok(true);
}

/** Registration numbers are compared on digits and case-folded characters only. */
function normaliseCr(cr: string): string {
  return cr.trim().toUpperCase().replace(/[\s-]/g, '');
}
