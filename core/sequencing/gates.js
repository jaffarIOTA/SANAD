import {
  earliestCapturedAt,
  isLive,
  isThirdParty
} from "../evidence/evidence.js";
import { elapsedSeconds, hasElapsed } from "../time/tsa.js";
function evaluateGates(input) {
  const { definition } = input;
  const outcomes = [];
  const byId = /* @__PURE__ */ new Map();
  let riskPeriodStartAt;
  let riskPeriodHeldSeconds;
  for (const gate of definition.gates) {
    if (!predecessorComplete(gate, input, byId)) {
      const outcome2 = {
        gateId: gate.id,
        status: "NOT_STARTED",
        dischargedBy: [],
        rejection: {
          control: "SH-05",
          reason: "GATE_PREDECESSOR_INCOMPLETE",
          detail: "A preceding step of the structure has not completed",
          context: { gateId: gate.id }
        }
      };
      outcomes.push(outcome2);
      byId.set(gate.id, outcome2);
      continue;
    }
    const outcome = gate.kind === "EVIDENCE" ? evaluateEvidenceGate(gate, input) : evaluateElapseGate(gate, input, byId);
    if (gate.kind === "ELAPSE") {
      const start = riskPeriodStart(gate, input, byId);
      if (start !== void 0) {
        riskPeriodStartAt = start;
        riskPeriodHeldSeconds = elapsedSeconds(start, input.observedAt);
      }
    }
    outcomes.push(outcome);
    byId.set(gate.id, outcome);
  }
  const unsatisfied = outcomes.filter((o) => o.status !== "SATISFIED").map((o) => o.gateId);
  return {
    gates: outcomes,
    unsatisfied,
    allSatisfied: unsatisfied.length === 0,
    ...riskPeriodStartAt !== void 0 ? { riskPeriodStartAt } : {},
    ...riskPeriodHeldSeconds !== void 0 ? { riskPeriodHeldSeconds } : {}
  };
}
function predecessorComplete(gate, input, byId) {
  if ("leg" in gate.after) {
    const legType = gate.after.leg;
    return input.legs.some((l) => l.legType === legType);
  }
  return byId.get(gate.after.gate)?.status === "SATISFIED";
}
function evaluateEvidenceGate(gate, input) {
  const admissible = new Set(gate.requires.anyOf);
  const candidates = input.evidence.filter(
    (e) => isLive(e) && e.gateSatisfied === gate.id && admissible.has(e.evidenceType)
  );
  if (candidates.length === 0) {
    return {
      gateId: gate.id,
      status: "PENDING",
      dischargedBy: [],
      rejection: {
        control: "SH-05",
        reason: "NO_ADMISSIBLE_EVIDENCE",
        detail: "No valid evidence of an admissible type has been recorded for this gate",
        context: { gateId: gate.id, admissibleTypes: gate.requires.anyOf.join(",") }
      }
    };
  }
  const qualifying = candidates.filter((e) => meetsQuality(gate, e) && meetsValidation(gate, e));
  if (qualifying.length === 0) {
    return {
      gateId: gate.id,
      status: "PENDING",
      dischargedBy: [],
      rejection: {
        control: "SH-05",
        reason: "EVIDENCE_DID_NOT_QUALIFY",
        detail: "Evidence of an admissible type exists but does not satisfy the declared source, confidence or validation requirements",
        context: { gateId: gate.id, candidateCount: candidates.length }
      }
    };
  }
  return {
    gateId: gate.id,
    status: "SATISFIED",
    dischargedBy: qualifying.map((e) => e.evidenceId)
  };
}
function meetsQuality(gate, e) {
  if (gate.requireThirdPartySource === true && !isThirdParty(e.source)) return false;
  const floor = gate.minimumExtractionConfidencePerTenThousand;
  if (floor !== void 0) {
    const confidence = e.extractionConfidencePerTenThousand;
    if (confidence !== void 0 && confidence < floor) return false;
  }
  return true;
}
function meetsValidation(gate, e) {
  if (gate.validation === void 0) return true;
  const detail = e.validationDetail;
  if (detail === void 0) return false;
  for (const [key, expected] of Object.entries(gate.validation)) {
    if (detail[key] !== expected) return false;
  }
  return true;
}
function evaluateElapseGate(gate, input, byId) {
  const start = riskPeriodStart(gate, input, byId);
  if (start === void 0) {
    return {
      gateId: gate.id,
      status: "PENDING",
      dischargedBy: [],
      rejection: {
        control: "SH-06",
        reason: "RISK_PERIOD_NOT_STARTED",
        detail: "The interval cannot begin until the preceding gate is discharged by attested evidence",
        context: { gateId: gate.id }
      }
    };
  }
  const required = Math.max(input.riskPeriodRequiredSeconds, 0);
  if (!hasElapsed(start, required, input.observedAt)) {
    return {
      gateId: gate.id,
      status: "PENDING",
      dischargedBy: [],
      rejection: {
        control: "SH-06",
        reason: "RISK_PERIOD_NOT_ELAPSED",
        detail: "The institution has not yet held the goods at its own risk for the required interval",
        context: {
          gateId: gate.id,
          requiredSeconds: required,
          heldSeconds: Number(elapsedSeconds(start, input.observedAt))
        }
      }
    };
  }
  return { gateId: gate.id, status: "SATISFIED", dischargedBy: [] };
}
function riskPeriodStart(gate, input, byId) {
  if (!("gate" in gate.after)) return void 0;
  const predecessor = byId.get(gate.after.gate);
  if (predecessor?.status !== "SATISFIED") return void 0;
  const discharging = input.evidence.filter((e) => predecessor.dischargedBy.includes(e.evidenceId));
  if (discharging.length === 0) return void 0;
  const basis = gate.startBasis ?? "LATEST_DISCHARGING_EVIDENCE";
  if (basis === "EARLIEST_DISCHARGING_EVIDENCE") {
    return earliestCapturedAt(discharging);
  }
  let latest;
  for (const e of discharging) {
    if (latest === void 0 || e.capturedAt.epochSeconds > latest.epochSeconds) {
      latest = e.capturedAt;
    }
  }
  return latest;
}
export {
  evaluateGates
};
