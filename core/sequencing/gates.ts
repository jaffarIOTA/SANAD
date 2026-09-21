/**
 * Gate evaluation.
 *
 * A pure function of (definition, legs, evidence, observed instant). No I/O, no
 * clock read, no configuration lookup, no randomness. That is not a stylistic
 * preference: it is what makes the result replayable, so the Shariah audit
 * process can re-run any historic transaction against the parameters that were
 * in force at the time and get the same answer (SDD §6.5.2).
 *
 * Note that `observedAt` is an argument. Core never asks what time it is.
 */

import {
  type EvidenceRecord,
  type GateId,
  earliestCapturedAt,
  isLive,
  isThirdParty,
} from '../evidence/evidence.ts';
import type { ContractLeg } from '../legs/leg.ts';
import type { Rejection } from '../kernel/result.ts';
import {
  type ElapseGateDefinition,
  type EvidenceGateDefinition,
  type GateDefinition,
  type StructureDefinition,
} from '../structures/definition.ts';
import { type TsaInstant, elapsedSeconds, hasElapsed } from '../time/tsa.ts';

export type GateStatus =
  /** Its predecessor has not completed; the gate is not yet in play. */
  | 'NOT_STARTED'
  /** In play, not yet discharged. */
  | 'PENDING'
  | 'SATISFIED';

export interface GateOutcome {
  readonly gateId: GateId;
  readonly status: GateStatus;
  /** Evidence ids that discharged it. Empty for an elapse gate. */
  readonly dischargedBy: readonly string[];
  /** Why it is not satisfied. Present only when status is not SATISFIED. */
  readonly rejection?: Rejection;
}

export interface GateEvaluation {
  readonly gates: readonly GateOutcome[];
  readonly unsatisfied: readonly GateId[];
  readonly allSatisfied: boolean;
  /** Attested moment the risk-holding interval began, once possession holds. */
  readonly riskPeriodStartAt?: TsaInstant;
  /** Whole seconds held so far, for the Board's view. */
  readonly riskPeriodHeldSeconds?: bigint;
}

export interface GateEvaluationInput {
  readonly definition: StructureDefinition;
  readonly legs: readonly ContractLeg[];
  readonly evidence: readonly EvidenceRecord[];
  /**
   * The interval in force for THIS transaction, snapshotted at inception. Read
   * from the transaction, not from current configuration, so a later change to
   * the Board's parameter cannot retroactively validate or invalidate a
   * transaction that already executed.
   */
  readonly riskPeriodRequiredSeconds: number;
  /** Attested. Supplied by the caller from the timestamping authority. */
  readonly observedAt: TsaInstant;
}

export function evaluateGates(input: GateEvaluationInput): GateEvaluation {
  const { definition } = input;
  const outcomes: GateOutcome[] = [];
  const byId = new Map<GateId, GateOutcome>();
  let riskPeriodStartAt: TsaInstant | undefined;
  let riskPeriodHeldSeconds: bigint | undefined;

  for (const gate of definition.gates) {
    if (!predecessorComplete(gate, input, byId)) {
      const outcome: GateOutcome = {
        gateId: gate.id,
        status: 'NOT_STARTED',
        dischargedBy: [],
        rejection: {
          control: 'SH-05',
          reason: 'GATE_PREDECESSOR_INCOMPLETE',
          detail: 'A preceding step of the structure has not completed',
          context: { gateId: gate.id },
        },
      };
      outcomes.push(outcome);
      byId.set(gate.id, outcome);
      continue;
    }

    const outcome =
      gate.kind === 'EVIDENCE'
        ? evaluateEvidenceGate(gate, input)
        : evaluateElapseGate(gate, input, byId);

    if (gate.kind === 'ELAPSE') {
      const start = riskPeriodStart(gate, input, byId);
      if (start !== undefined) {
        riskPeriodStartAt = start;
        riskPeriodHeldSeconds = elapsedSeconds(start, input.observedAt);
      }
    }

    outcomes.push(outcome);
    byId.set(gate.id, outcome);
  }

  const unsatisfied = outcomes.filter((o) => o.status !== 'SATISFIED').map((o) => o.gateId);

  return {
    gates: outcomes,
    unsatisfied,
    allSatisfied: unsatisfied.length === 0,
    ...(riskPeriodStartAt !== undefined ? { riskPeriodStartAt } : {}),
    ...(riskPeriodHeldSeconds !== undefined ? { riskPeriodHeldSeconds } : {}),
  };
}

// -----------------------------------------------------------------------------

function predecessorComplete(
  gate: GateDefinition,
  input: GateEvaluationInput,
  byId: ReadonlyMap<GateId, GateOutcome>,
): boolean {
  if ('leg' in gate.after) {
    const legType = gate.after.leg;
    return input.legs.some((l) => l.legType === legType);
  }
  return byId.get(gate.after.gate)?.status === 'SATISFIED';
}

function evaluateEvidenceGate(
  gate: EvidenceGateDefinition,
  input: GateEvaluationInput,
): GateOutcome {
  const admissible = new Set(gate.requires.anyOf);
  const candidates = input.evidence.filter(
    (e) => isLive(e) && e.gateSatisfied === gate.id && admissible.has(e.evidenceType),
  );

  if (candidates.length === 0) {
    return {
      gateId: gate.id,
      status: 'PENDING',
      dischargedBy: [],
      rejection: {
        control: 'SH-05',
        reason: 'NO_ADMISSIBLE_EVIDENCE',
        detail: 'No valid evidence of an admissible type has been recorded for this gate',
        context: { gateId: gate.id, admissibleTypes: gate.requires.anyOf.join(',') },
      },
    };
  }

  const qualifying = candidates.filter((e) => meetsQuality(gate, e) && meetsValidation(gate, e));

  if (qualifying.length === 0) {
    return {
      gateId: gate.id,
      status: 'PENDING',
      dischargedBy: [],
      rejection: {
        control: 'SH-05',
        reason: 'EVIDENCE_DID_NOT_QUALIFY',
        detail:
          'Evidence of an admissible type exists but does not satisfy the declared source, confidence or validation requirements',
        context: { gateId: gate.id, candidateCount: candidates.length },
      },
    };
  }

  return {
    gateId: gate.id,
    status: 'SATISFIED',
    dischargedBy: qualifying.map((e) => e.evidenceId),
  };
}

function meetsQuality(gate: EvidenceGateDefinition, e: EvidenceRecord): boolean {
  if (gate.requireThirdPartySource === true && !isThirdParty(e.source)) return false;
  const floor = gate.minimumExtractionConfidencePerTenThousand;
  if (floor !== undefined) {
    // An artefact with no confidence score was not machine-extracted, so the
    // floor does not apply to it. One that was, and scored below, does not
    // discharge the gate.
    const confidence = e.extractionConfidencePerTenThousand;
    if (confidence !== undefined && confidence < floor) return false;
  }
  return true;
}

/**
 * Declared assertions on the evidence payload, e.g. that the cleared invoice
 * names the institution as recipient. Comparison is exact and the validation
 * detail must carry the key — an absent key does not pass by default.
 */
function meetsValidation(gate: EvidenceGateDefinition, e: EvidenceRecord): boolean {
  if (gate.validation === undefined) return true;
  const detail = e.validationDetail;
  if (detail === undefined) return false;
  for (const [key, expected] of Object.entries(gate.validation)) {
    if (detail[key] !== expected) return false;
  }
  return true;
}

function evaluateElapseGate(
  gate: ElapseGateDefinition,
  input: GateEvaluationInput,
  byId: ReadonlyMap<GateId, GateOutcome>,
): GateOutcome {
  const start = riskPeriodStart(gate, input, byId);

  if (start === undefined) {
    return {
      gateId: gate.id,
      status: 'PENDING',
      dischargedBy: [],
      rejection: {
        control: 'SH-06',
        reason: 'RISK_PERIOD_NOT_STARTED',
        detail: 'The interval cannot begin until the preceding gate is discharged by attested evidence',
        context: { gateId: gate.id },
      },
    };
  }

  // The transaction's own snapshotted interval governs, never the definition's
  // current value — but a definition may only ever be the stricter of the two.
  const required = Math.max(input.riskPeriodRequiredSeconds, 0);

  if (!hasElapsed(start, required, input.observedAt)) {
    return {
      gateId: gate.id,
      status: 'PENDING',
      dischargedBy: [],
      rejection: {
        control: 'SH-06',
        reason: 'RISK_PERIOD_NOT_ELAPSED',
        detail: 'The institution has not yet held the goods at its own risk for the required interval',
        context: {
          gateId: gate.id,
          requiredSeconds: required,
          heldSeconds: Number(elapsedSeconds(start, input.observedAt)),
        },
      },
    };
  }

  return { gateId: gate.id, status: 'SATISFIED', dischargedBy: [] };
}

/** The attested instant the interval began, per the Board's declared basis. */
function riskPeriodStart(
  gate: ElapseGateDefinition,
  input: GateEvaluationInput,
  byId: ReadonlyMap<GateId, GateOutcome>,
): TsaInstant | undefined {
  if (!('gate' in gate.after)) return undefined;
  const predecessor = byId.get(gate.after.gate);
  if (predecessor?.status !== 'SATISFIED') return undefined;

  const discharging = input.evidence.filter((e) => predecessor.dischargedBy.includes(e.evidenceId));
  if (discharging.length === 0) return undefined;

  const basis = gate.startBasis ?? 'LATEST_DISCHARGING_EVIDENCE';
  if (basis === 'EARLIEST_DISCHARGING_EVIDENCE') {
    return earliestCapturedAt(discharging);
  }

  let latest: TsaInstant | undefined;
  for (const e of discharging) {
    if (latest === undefined || e.capturedAt.epochSeconds > latest.epochSeconds) {
      latest = e.capturedAt;
    }
  }
  return latest;
}
