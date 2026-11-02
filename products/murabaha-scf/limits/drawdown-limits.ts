/**
 * What a trade's cost must fit within before it is held (Wasl W5a). Pure.
 *
 * In order, the first that does not fit refuses the trade, and nothing is held:
 *
 *   1. the distributor's facility in the programme — approved by two people,
 *      and the only authority to draw at all (no facility, no trade);
 *   2. the programme's limit;
 *   3. the concentration rules the institution has chosen (configuration,
 *      changed through the administration platform under four eyes):
 *        - a cap on any single trade's cost;
 *        - a distributor's share of its programme's limit;
 *        - an anchor's share of the book, the book being the sum of the
 *          limits of the institution's programmes.
 *
 * Shares are measured against limits, never against current utilisation, so
 * the first trade in an empty book is judged like any other. A share is a
 * whole number per ten thousand of a limit: a proportion of capacity, never a
 * return on anything.
 *
 * Exposure is the cost of every transaction holding a limit (from the hold
 * until it settles or is unwound), counted by the caller from the book.
 */

import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';

export interface ShareRule {
  readonly enabled: boolean;
  /** Whole number per ten thousand of the limit it is measured against (2500 = a quarter). */
  readonly maxSharePerTenThousand: number;
}

export interface ConcentrationPolicy {
  readonly policyRef: string;
  readonly singleTradeCap: { readonly enabled: boolean; readonly maxCostMinorUnits: bigint };
  readonly distributorShareOfProgramme: ShareRule;
  readonly anchorShareOfBook: ShareRule;
}

/** No rule chosen: facility and programme limits only. What an institution without a policy gets. */
export const NO_CONCENTRATION_RULES: ConcentrationPolicy = {
  policyRef: 'NONE',
  singleTradeCap: { enabled: false, maxCostMinorUnits: 0n },
  distributorShareOfProgramme: { enabled: false, maxSharePerTenThousand: 10_000 },
  anchorShareOfBook: { enabled: false, maxSharePerTenThousand: 10_000 },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function shareRule(v: unknown): ShareRule | undefined {
  if (!isRecord(v) || typeof v['enabled'] !== 'boolean') return undefined;
  const share = v['maxSharePerTenThousand'];
  if (typeof share !== 'number' || !Number.isInteger(share) || share < 1 || share > 10_000) return undefined;
  return { enabled: v['enabled'], maxSharePerTenThousand: share };
}

/** The institution's chosen rules. Every rule is stated, enabled or not; a policy half-read is not applied. */
export function parseConcentrationPolicy(input: unknown): Result<ConcentrationPolicy> {
  const bad = (reason: string) =>
    reject('OP-DETERMINACY', reason, 'The concentration policy does not load', { reason });
  if (!isRecord(input)) return bad('CONCENTRATION_POLICY_MALFORMED');
  const ref = input['policyRef'];
  if (typeof ref !== 'string' || ref.trim().length === 0) return bad('CONCENTRATION_POLICY_REF_REQUIRED');
  const cap = input['singleTradeCap'];
  if (
    !isRecord(cap) ||
    typeof cap['enabled'] !== 'boolean' ||
    typeof cap['maxCostMinorUnits'] !== 'string' ||
    !/^\d{1,15}$/.test(cap['maxCostMinorUnits']) ||
    (cap['enabled'] && BigInt(cap['maxCostMinorUnits']) === 0n)
  )
    return bad('CONCENTRATION_TRADE_CAP_INVALID');
  const distributor = shareRule(input['distributorShareOfProgramme']);
  if (distributor === undefined) return bad('CONCENTRATION_DISTRIBUTOR_SHARE_INVALID');
  const anchor = shareRule(input['anchorShareOfBook']);
  if (anchor === undefined) return bad('CONCENTRATION_ANCHOR_SHARE_INVALID');
  return ok({
    policyRef: ref.trim(),
    singleTradeCap: { enabled: cap['enabled'], maxCostMinorUnits: BigInt(cap['maxCostMinorUnits']) },
    distributorShareOfProgramme: distributor,
    anchorShareOfBook: anchor,
  });
}

/** The policy as configuration JSON: what a revision carries and the parser reads back. */
export function concentrationPolicyToJson(p: ConcentrationPolicy): Record<string, unknown> {
  return {
    policyRef: p.policyRef,
    singleTradeCap: {
      enabled: p.singleTradeCap.enabled,
      maxCostMinorUnits: p.singleTradeCap.maxCostMinorUnits.toString(),
    },
    distributorShareOfProgramme: { ...p.distributorShareOfProgramme },
    anchorShareOfBook: { ...p.anchorShareOfBook },
  };
}

export interface DrawdownExposure {
  /** The trade's cost: what would be held. */
  readonly cost: bigint;
  /** The distributor's approved limit in this programme, or undefined where none is approved. */
  readonly facilityLimit: bigint | undefined;
  /** What the distributor already holds in this programme. */
  readonly facilityHeld: bigint;
  readonly programmeLimit: bigint;
  readonly programmeHeld: bigint;
  /** What every programme of this programme's anchor already holds. */
  readonly anchorHeld: bigint;
  /** The sum of the limits of the institution's programmes. */
  readonly bookLimit: bigint;
}

/** `part` within `share` ten-thousandths of `whole`, in integers: part × 10 000 ≤ whole × share. */
const withinShare = (part: bigint, whole: bigint, share: number): boolean => part * 10_000n <= whole * BigInt(share);

/** Whether the trade's cost fits, in the order above. The refusal names the first limit it does not fit. */
export function checkDrawdown(e: DrawdownExposure, policy: ConcentrationPolicy): Result<true> {
  if (e.facilityLimit === undefined)
    return reject('OP-LIMIT', 'NO_FACILITY', 'The distributor has no approved facility in this programme');
  if (e.facilityHeld + e.cost > e.facilityLimit)
    return reject('OP-LIMIT', 'FACILITY_LIMIT_EXCEEDED', 'The distributor’s facility has no room for this cost');
  if (e.programmeHeld + e.cost > e.programmeLimit)
    return reject('OP-LIMIT', 'PROGRAMME_LIMIT_EXCEEDED', 'The programme has no room for this cost');
  if (policy.singleTradeCap.enabled && e.cost > policy.singleTradeCap.maxCostMinorUnits)
    return reject('OP-LIMIT', 'CONCENTRATION_SINGLE_TRADE_CAP', 'This trade’s cost is above the single-trade cap', {
      policyRef: policy.policyRef,
    });
  const d = policy.distributorShareOfProgramme;
  if (d.enabled && !withinShare(e.facilityHeld + e.cost, e.programmeLimit, d.maxSharePerTenThousand))
    return reject(
      'OP-LIMIT',
      'CONCENTRATION_DISTRIBUTOR_SHARE',
      'The distributor would hold more of the programme than the concentration policy allows',
      { policyRef: policy.policyRef },
    );
  const a = policy.anchorShareOfBook;
  if (a.enabled && !withinShare(e.anchorHeld + e.cost, e.bookLimit, a.maxSharePerTenThousand))
    return reject(
      'OP-LIMIT',
      'CONCENTRATION_ANCHOR_SHARE',
      'The anchor’s programmes would hold more of the book than the concentration policy allows',
      { policyRef: policy.policyRef },
    );
  return ok(true);
}
