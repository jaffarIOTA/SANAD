/**
 * The decision engine.
 *
 * Four properties are non-negotiable (SDD §6.6), and each is visible in the
 * signature or the body below:
 *
 *   1. Determinism. `evaluateCreditPolicy(policy, snapshot, decisionId)` reads
 *      nothing else. No clock, no database, no network, no randomness. Give it
 *      the same three arguments and it returns the same record, forever.
 *   2. Full trace. Every rule that ran, the values it actually used and what it
 *      concluded are recorded. This is the audit defence and the source of the
 *      customer-facing reason — the reason is not written separately from the
 *      decision, it is read out of it.
 *   3. Bilingual reasons, from the institution's own approved catalogue.
 *   4. Champion–challenger, where the challenger's result is recorded and never
 *      applied.
 *
 * The engine never throws and never returns a bare failure. A malformed policy
 * or an unreadable field produces a REFER with the fault in the trace, because
 * the failure mode of a credit engine must be "a human looks at it", never an
 * approval and never a silent decline the counterparty cannot be given a reason
 * for.
 */

import type { CurrencyCode } from '../kernel/money.ts';
import {
  type EvaluationContext,
  evaluateCondition,
  evaluateMoney,
  pathResolver,
} from './expression.ts';
import type {
  CreditPolicy,
  DecisionOutcome,
  GradeBand,
  LimitCap,
  ReasonText,
} from './policy.ts';
import {
  type ApplicantSnapshot,
  aggregateExposureMinorUnits,
  programmeHeadroomMinorUnits,
} from './snapshot.ts';

export type TraceStage =
  | 'DATA_SUFFICIENCY'
  | 'KNOCKOUT'
  | 'SCORECARD'
  | 'GRADE'
  | 'LIMIT_BASIS'
  | 'CAP'
  | 'FAULT';

export interface RuleTraceEntry {
  readonly sequence: number;
  readonly stage: TraceStage;
  readonly code: string;
  /** The values the rule actually consumed, stringified for durable storage. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly result: string;
  readonly pointsAwarded?: number;
  readonly reasonCode?: string;
}

export interface DecisionReason {
  readonly code: string;
  readonly ar: string;
  readonly en: string;
}

export interface DecisionRecord {
  readonly decisionId: string;
  readonly tenantId: string;
  readonly counterpartyId: string;
  readonly programmeId: string;
  readonly snapshotId: string;

  readonly policyId: string;
  readonly policyVersion: string;
  readonly creditApprovalRef: string;

  readonly outcome: DecisionOutcome;
  readonly grade?: string;
  readonly score: number;

  readonly assignedLimitMinorUnits: bigint;
  readonly currency: CurrencyCode;
  /** Which cap, if any, determined the limit. Useful to the anchor and to Credit. */
  readonly bindingCapCode?: string;

  readonly reasons: readonly DecisionReason[];
  readonly trace: readonly RuleTraceEntry[];

  /** Recorded, not read during evaluation. */
  readonly snapshotCapturedAtEpochSeconds: bigint;
}

/**
 * Evaluate. Pure.
 *
 * `decisionId` is an argument rather than something generated here, because an
 * engine that mints an identifier is an engine whose output differs between two
 * runs of the same input.
 */
export function evaluateCreditPolicy(
  policy: CreditPolicy,
  snapshot: ApplicantSnapshot,
  decisionId: string,
): DecisionRecord {
  const trace: RuleTraceEntry[] = [];
  const reasonCodes: string[] = [];
  const ctx: EvaluationContext = { resolve: pathResolver(snapshot) };
  let sequence = 0;
  const step = (entry: Omit<RuleTraceEntry, 'sequence'>): void => {
    trace.push({ sequence: sequence++, ...entry });
  };

  const base = {
    decisionId,
    tenantId: snapshot.tenantId,
    counterpartyId: snapshot.counterpartyId,
    programmeId: snapshot.programmeId,
    snapshotId: snapshot.snapshotId,
    policyId: policy.policyId,
    policyVersion: policy.version,
    creditApprovalRef: policy.approval.creditApprovalRef,
    currency: policy.currency,
    snapshotCapturedAtEpochSeconds: snapshot.capturedAtEpochSeconds,
  } as const;

  const finish = (
    outcome: DecisionOutcome,
    score: number,
    limit: bigint,
    grade?: string,
    bindingCapCode?: string,
  ): DecisionRecord => ({
    ...base,
    outcome,
    score,
    assignedLimitMinorUnits: limit,
    reasons: resolveReasons(policy, reasonCodes),
    trace,
    ...(grade !== undefined ? { grade } : {}),
    ...(bindingCapCode !== undefined ? { bindingCapCode } : {}),
  });

  // -- 1. Is the policy applicable at all? -----------------------------------

  if (policy.tenantId !== snapshot.tenantId) {
    step({
      stage: 'FAULT',
      code: 'POLICY_TENANT_MISMATCH',
      inputs: { policyTenant: policy.tenantId, snapshotTenant: snapshot.tenantId },
      result: 'REFER',
    });
    return finish('REFER', 0, 0n);
  }
  if (policy.currency !== snapshot.currency) {
    step({
      stage: 'FAULT',
      code: 'POLICY_CURRENCY_MISMATCH',
      inputs: { policy: policy.currency, snapshot: snapshot.currency },
      result: 'REFER',
    });
    return finish('REFER', 0, 0n);
  }

  // -- 2. Data sufficiency ---------------------------------------------------

  for (const consent of policy.dataRequirements.requiredConsents) {
    const given = snapshot.consent[consent];
    step({
      stage: 'DATA_SUFFICIENCY',
      code: `CONSENT_${String(consent)}`,
      inputs: { consent: String(consent) },
      result: given ? 'PRESENT' : 'ABSENT',
    });
    if (!given) {
      reasonCodes.push(policy.dataRequirements.missingConsentReasonCode);
      return finish('REFER', 0, 0n);
    }
  }

  for (const [path, maxAge] of Object.entries(policy.dataRequirements.maximumSourceAgeSeconds)) {
    const age = ctx.resolve(path);
    if (typeof age !== 'number') {
      step({
        stage: 'FAULT',
        code: 'FRESHNESS_FIELD_UNREADABLE',
        inputs: { path },
        result: 'REFER',
      });
      return finish('REFER', 0, 0n);
    }
    const fresh = age <= maxAge;
    step({
      stage: 'DATA_SUFFICIENCY',
      code: `FRESHNESS_${path}`,
      inputs: { path, ageSeconds: String(age), maximumSeconds: String(maxAge) },
      result: fresh ? 'FRESH' : 'STALE',
    });
    if (!fresh) {
      reasonCodes.push(policy.dataRequirements.staleDataReasonCode);
      return finish('REFER', 0, 0n);
    }
  }

  // -- 3. Knockouts ----------------------------------------------------------

  for (const knockout of policy.knockouts) {
    const fired = evaluateCondition(knockout.when, ctx);
    if (!fired.ok) {
      step({
        stage: 'FAULT',
        code: knockout.code,
        inputs: { reason: fired.error.reason },
        result: 'REFER',
      });
      return finish('REFER', 0, 0n);
    }
    step({
      stage: 'KNOCKOUT',
      code: knockout.code,
      inputs: {},
      result: fired.value ? 'FIRED' : 'PASSED',
      ...(fired.value ? { reasonCode: knockout.reasonCode } : {}),
    });
    if (fired.value) {
      reasonCodes.push(knockout.reasonCode);
      return finish(knockout.outcome, 0, 0n);
    }
  }

  // -- 4. Scorecard ----------------------------------------------------------

  let score = policy.scorecard.baseScore;
  /** Bands that scored below their characteristic's maximum, worst shortfall first. */
  const shortfalls: { readonly code: string; readonly shortfall: number; readonly reasonCode: string }[] = [];

  for (const characteristic of policy.scorecard.characteristics) {
    let awarded = characteristic.defaultPoints;
    let matchedBand = -1;
    let reasonCode = characteristic.defaultReasonCode;

    for (let i = 0; i < characteristic.bands.length; i++) {
      const band = characteristic.bands[i];
      if (band === undefined) continue;
      const matched = evaluateCondition(band.when, ctx);
      if (!matched.ok) {
        step({
          stage: 'FAULT',
          code: `${characteristic.code}#${i}`,
          inputs: { reason: matched.error.reason },
          result: 'REFER',
        });
        return finish('REFER', 0, 0n);
      }
      if (matched.value) {
        awarded = band.points;
        matchedBand = i;
        reasonCode = band.reasonCode ?? characteristic.defaultReasonCode;
        break;
      }
    }

    score += awarded;
    step({
      stage: 'SCORECARD',
      code: characteristic.code,
      inputs: { matchedBand: matchedBand === -1 ? 'DEFAULT' : String(matchedBand) },
      result: `${awarded}/${characteristic.maxPoints}`,
      pointsAwarded: awarded,
      ...(reasonCode !== undefined ? { reasonCode } : {}),
    });

    if (awarded < characteristic.maxPoints && reasonCode !== undefined) {
      shortfalls.push({
        code: characteristic.code,
        shortfall: characteristic.maxPoints - awarded,
        reasonCode,
      });
    }
  }

  // -- 5. Grade --------------------------------------------------------------

  const band = gradeFor(policy.grades, score);
  if (band === undefined) {
    step({
      stage: 'FAULT',
      code: 'NO_GRADE_BAND_FOR_SCORE',
      inputs: { score: String(score) },
      result: 'REFER',
    });
    return finish('REFER', score, 0n);
  }
  step({
    stage: 'GRADE',
    code: band.grade,
    inputs: { score: String(score), minScore: String(band.minScore) },
    result: band.outcome,
    ...(band.reasonCode !== undefined ? { reasonCode: band.reasonCode } : {}),
  });
  if (band.reasonCode !== undefined) reasonCodes.push(band.reasonCode);

  if (band.outcome !== 'APPROVE') {
    // The reason a case did not approve is the characteristics it scored worst
    // on, taken from the trace rather than authored at the point of refusal.
    for (const s of topShortfalls(shortfalls)) reasonCodes.push(s.reasonCode);
    return finish(band.outcome, score, 0n, band.grade);
  }

  // -- 6. Limit --------------------------------------------------------------

  const basisExpr = policy.limit.basisByGrade[band.grade];
  if (basisExpr === undefined) {
    step({
      stage: 'FAULT',
      code: 'NO_LIMIT_BASIS_FOR_GRADE',
      inputs: { grade: band.grade },
      result: 'REFER',
    });
    return finish('REFER', score, 0n, band.grade);
  }

  const basis = evaluateMoney(basisExpr, ctx);
  if (!basis.ok) {
    step({
      stage: 'FAULT',
      code: 'LIMIT_BASIS_UNEVALUABLE',
      inputs: { grade: band.grade, reason: basis.error.reason },
      result: 'REFER',
    });
    return finish('REFER', score, 0n, band.grade);
  }

  let limit = basis.value < 0n ? 0n : basis.value;
  step({
    stage: 'LIMIT_BASIS',
    code: band.grade,
    inputs: { grade: band.grade },
    result: String(limit),
  });

  let bindingCapCode: string | undefined;

  for (const cap of policy.limit.caps) {
    const capped = applyCap(cap, limit, snapshot, ctx);
    if (capped === undefined) {
      step({ stage: 'FAULT', code: cap.code, inputs: {}, result: 'REFER' });
      return finish('REFER', score, 0n, band.grade);
    }
    if (capped < limit) {
      bindingCapCode = cap.code;
      step({
        stage: 'CAP',
        code: cap.code,
        inputs: { before: String(limit) },
        result: String(capped),
      });
      limit = capped;
    } else {
      step({ stage: 'CAP', code: cap.code, inputs: { before: String(limit) }, result: 'NOT_BINDING' });
    }
  }

  // Round down to the configured granularity. A limit rounds down, never up.
  const granularity = toBigInt(policy.limit.roundDownToMultipleOfMinorUnits);
  if (granularity !== undefined && granularity > 0n) {
    const rounded = (limit / granularity) * granularity;
    if (rounded !== limit) {
      step({
        stage: 'CAP',
        code: 'ROUND_DOWN',
        inputs: { before: String(limit), granularity: String(granularity) },
        result: String(rounded),
      });
      limit = rounded;
    }
  }

  const minimum = toBigInt(policy.limit.minimumViableMinorUnits) ?? 0n;
  if (limit < minimum) {
    step({
      stage: 'CAP',
      code: 'BELOW_MINIMUM_VIABLE',
      inputs: { limit: String(limit), minimum: String(minimum) },
      result: 'REFER',
    });
    for (const s of topShortfalls(shortfalls)) reasonCodes.push(s.reasonCode);
    return finish('REFER', score, 0n, band.grade, bindingCapCode);
  }

  return finish('APPROVE', score, limit, band.grade, bindingCapCode);
}

// -----------------------------------------------------------------------------

export interface ChampionChallengerResult {
  /** The decision that is applied and returned to the counterparty. */
  readonly applied: DecisionRecord;
  /**
   * The challenger's decision on the same snapshot. Recorded for measurement,
   * never applied — that is the whole point of running it.
   */
  readonly challenger?: DecisionRecord;
}

export function evaluateWithChallenger(
  champion: CreditPolicy,
  challenger: CreditPolicy | undefined,
  snapshot: ApplicantSnapshot,
  decisionId: string,
  challengerDecisionId: string,
): ChampionChallengerResult {
  const applied = evaluateCreditPolicy(champion, snapshot, decisionId);
  if (challenger === undefined) return { applied };
  return {
    applied,
    challenger: evaluateCreditPolicy(challenger, snapshot, challengerDecisionId),
  };
}

/** Highest band whose floor the score reaches. */
export function gradeFor(grades: readonly GradeBand[], score: number): GradeBand | undefined {
  return [...grades]
    .sort((a, b) => b.minScore - a.minScore)
    .find((g) => score >= g.minScore);
}

function applyCap(
  cap: LimitCap,
  current: bigint,
  snapshot: ApplicantSnapshot,
  ctx: EvaluationContext,
): bigint | undefined {
  switch (cap.kind) {
    case 'ABSOLUTE': {
      const max = toBigInt(cap.maxMoneyMinorUnits);
      return max === undefined ? undefined : min(current, max);
    }
    case 'EXPRESSION': {
      if (cap.when !== undefined) {
        const applies = evaluateCondition(cap.when, ctx);
        if (!applies.ok) return undefined;
        if (!applies.value) return current;
      }
      const max = evaluateMoney(cap.max, ctx);
      return max.ok ? min(current, max.value) : undefined;
    }
    case 'PROGRAMME_HEADROOM':
      return min(current, programmeHeadroomMinorUnits(snapshot));
    case 'SHARE_OF_PROGRAMME_LIMIT': {
      if (!Number.isInteger(cap.shareBasisPoints) || cap.shareBasisPoints < 0) return undefined;
      const share =
        (snapshot.programme.programmeLimitMinorUnits * BigInt(cap.shareBasisPoints)) / 10000n;
      return min(current, share);
    }
    case 'NET_OF_EXISTING_EXPOSURE': {
      const net = current - aggregateExposureMinorUnits(snapshot);
      return net > 0n ? net : 0n;
    }
  }
}

/** At most three reasons, worst shortfall first. A wall of text is not an explanation. */
function topShortfalls(
  shortfalls: readonly { code: string; shortfall: number; reasonCode: string }[],
): readonly { code: string; shortfall: number; reasonCode: string }[] {
  return [...shortfalls].sort((a, b) => b.shortfall - a.shortfall).slice(0, 3);
}

function resolveReasons(policy: CreditPolicy, codes: readonly string[]): readonly DecisionReason[] {
  const seen = new Set<string>();
  const out: DecisionReason[] = [];
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    const text: ReasonText | undefined = policy.reasons[code];
    // parseCreditPolicy guarantees wording exists; this is the belt to that brace.
    out.push({
      code,
      ar: text?.ar ?? '',
      en: text?.en ?? '',
    });
  }
  return out;
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function toBigInt(v: string): bigint | undefined {
  try {
    return BigInt(v);
  } catch {
    return undefined;
  }
}
