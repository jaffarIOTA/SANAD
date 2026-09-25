/**
 * Eligibility pre-check (BRD §5, item 11 of the gap analysis).
 *
 * A partner wants to know, before raising a request, whether the institution
 * would trade. This answers with what the credit policy in force would decide
 * on the facts held today — and nothing more. It persists nothing, mints no
 * identifier, and creates no request; the result is advisory and says so.
 *
 * It is a thin wrapper over the engine, and pure like it. The one thing it
 * adds is a comparison of the requested amount against the limit the engine
 * assigned: an approval for less than what is asked is a referral from the
 * partner's point of view, and the reason code says so.
 *
 * Nothing rate-shaped goes in or comes out. Eligibility is whether, not price.
 */

import type { Money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';
import { evaluateCreditPolicy } from './engine.ts';
import { type CreditPolicy, type DecisionOutcome, resolveEffectivePolicy } from './policy.ts';
import type { ApplicantSnapshot } from './snapshot.ts';

export interface EligibilityQuery {
  readonly snapshot: ApplicantSnapshot;
  readonly requestedAmount: Money;
  readonly requestedTenorDays: number;
  /** The attested instant the check is made. Chooses the policy version. */
  readonly evaluatedAt: TsaInstant;
}

export interface EligibilityOutcome {
  readonly outcome: DecisionOutcome;
  readonly reasonCodes: readonly string[];
  readonly policyId: string;
  readonly policyVersion: string;
  readonly evaluatedAt: TsaInstant;
  /** Always false. The type says it so a caller cannot mistake this for a decision. */
  readonly persisted: false;
}

/** The pre-check's own reason: the engine approved, but for less than asked. */
export const REASON_BELOW_REQUESTED = 'R_ELIGIBLE_BELOW_REQUESTED_AMOUNT';

/** A decision identifier that no real decision can carry. */
const PRE_CHECK_DECISION_ID = 'pre-check';

export function preCheck(
  versions: readonly CreditPolicy[],
  query: EligibilityQuery,
): Result<EligibilityOutcome> {
  if (query.requestedAmount.minorUnits <= 0n) {
    return reject('OP-DETERMINACY', 'REQUESTED_AMOUNT_NOT_POSITIVE', 'The requested amount must be positive');
  }
  if (query.requestedAmount.currency !== query.snapshot.currency) {
    return reject('OP-DETERMINACY', 'CURRENCY_MISMATCH', 'The requested amount is not in the programme currency', {
      requested: query.requestedAmount.currency,
      programme: query.snapshot.currency,
    });
  }
  const applicable = versions.filter(
    (v) => v.programmeScope === 'ALL' || v.programmeScope.includes(query.snapshot.programmeId),
  );
  const policy = resolveEffectivePolicy(applicable, query.evaluatedAt.epochSeconds);
  if (!policy.ok) return policy;

  const record = evaluateCreditPolicy(policy.value, query.snapshot, PRE_CHECK_DECISION_ID);
  const reasonCodes = record.reasons.map((r) => r.code);

  const belowRequested =
    record.outcome === 'APPROVE' && record.assignedLimitMinorUnits < query.requestedAmount.minorUnits;

  return ok({
    outcome: belowRequested ? 'REFER' : record.outcome,
    reasonCodes: belowRequested ? [...reasonCodes, REASON_BELOW_REQUESTED] : reasonCodes,
    policyId: record.policyId,
    policyVersion: record.policyVersion,
    evaluatedAt: query.evaluatedAt,
    persisted: false,
  });
}
