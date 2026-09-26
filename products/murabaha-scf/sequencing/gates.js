 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }/**
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


  earliestCapturedAt,
  isLive,
  isThirdParty,
} from '../../../core/evidence/evidence.js';








import { elapsedSeconds, hasElapsed } from '../../../core/time/tsa.js';

 








































export function evaluateGates(input) {
  const { definition } = input;
  const outcomes = [];
  const byId = new Map();
  let riskPeriodStartAt;
  let riskPeriodHeldSeconds;

  for (const gate of definition.gates) {
    if (!predecessorComplete(gate, input, byId)) {
      const outcome = {
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
  gate,
  input,
  byId,
) {
  if ('leg' in gate.after) {
    const legType = gate.after.leg;
    return input.legs.some((l) => l.legType === legType);
  }
  return _optionalChain([byId, 'access', _ => _.get, 'call', _2 => _2(gate.after.gate), 'optionalAccess', _3 => _3.status]) === 'SATISFIED';
}

function evaluateEvidenceGate(
  gate,
  input,
) {
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

function meetsQuality(gate, e) {
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
function meetsValidation(gate, e) {
  if (gate.validation === undefined) return true;
  const detail = e.validationDetail;
  if (detail === undefined) return false;
  for (const [key, expected] of Object.entries(gate.validation)) {
    if (detail[key] !== expected) return false;
  }
  return true;
}

function evaluateElapseGate(
  gate,
  input,
  byId,
) {
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
  gate,
  input,
  byId,
) {
  if (!('gate' in gate.after)) return undefined;
  const predecessor = byId.get(gate.after.gate);
  if (_optionalChain([predecessor, 'optionalAccess', _4 => _4.status]) !== 'SATISFIED') return undefined;

  const discharging = input.evidence.filter((e) => predecessor.dischargedBy.includes(e.evidenceId));
  if (discharging.length === 0) return undefined;

  const basis = _nullishCoalesce(gate.startBasis, () => ( 'LATEST_DISCHARGING_EVIDENCE'));
  if (basis === 'EARLIEST_DISCHARGING_EVIDENCE') {
    return earliestCapturedAt(discharging);
  }

  let latest;
  for (const e of discharging) {
    if (latest === undefined || e.capturedAt.epochSeconds > latest.epochSeconds) {
      latest = e.capturedAt;
    }
  }
  return latest;
}
