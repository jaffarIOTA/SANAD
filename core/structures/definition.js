import { ok, reject } from "../kernel/result.js";
const MANDATORY_GATES_BEFORE_SALE = {
  MURABAHA: ["GATE_1_OWNERSHIP", "GATE_2_POSSESSION", "GATE_3_RISK_PERIOD"],
  SALAM: [],
  ISTISNA: [],
  IJARAH: ["GATE_1_OWNERSHIP", "GATE_2_POSSESSION"],
  MUSHARAKA: []
};
const MINIMUM_RISK_PERIOD_SECONDS = 1;
function parseStructureDefinition(input) {
  const d = input;
  if (typeof d !== "object" || d === null) {
    return reject("OP-DETERMINACY", "DEFINITION_NOT_AN_OBJECT", "Structure definition is not an object");
  }
  if (typeof d.shariahApprovalRef !== "string" || d.shariahApprovalRef.length === 0) {
    return reject(
      "SH-17",
      "NO_SHARIAH_APPROVAL_REFERENCE",
      "A structure definition must name the approval it executes under",
      { definitionId: String(d.definitionId) }
    );
  }
  if (!Array.isArray(d.legs) || d.legs.length === 0) {
    return reject("OP-DETERMINACY", "NO_LEGS", "A structure must declare at least one leg");
  }
  const seen = /* @__PURE__ */ new Set();
  let previousSeq = 0;
  for (const leg of d.legs) {
    if (seen.has(leg.seq)) {
      return reject("OP-DETERMINACY", "DUPLICATE_LEG_SEQUENCE", "Leg sequence numbers must be unique", {
        seq: leg.seq
      });
    }
    if (leg.seq <= previousSeq) {
      return reject("OP-DETERMINACY", "LEG_SEQUENCE_UNORDERED", "Legs must be declared in sequence order", {
        seq: leg.seq
      });
    }
    seen.add(leg.seq);
    previousSeq = leg.seq;
  }
  const gateIds = new Set(d.gates.map((g) => g.id));
  const required = MANDATORY_GATES_BEFORE_SALE[d.structureCode] ?? [];
  const hasSaleLeg = d.legs.some((l) => l.type === "SALE_OFFER");
  if (hasSaleLeg) {
    for (const gateId of required) {
      if (!gateIds.has(gateId)) {
        return reject(
          "SH-05",
          "MANDATORY_GATE_MISSING",
          `Structure declares a sale leg but omits ${gateId}; the platform floor cannot be loosened by configuration`,
          { definitionId: d.definitionId, gateId }
        );
      }
    }
  }
  for (const gate of d.gates) {
    if (gate.kind === "ELAPSE") {
      if (gate.clock !== "TRUSTED_TIMESTAMP_AUTHORITY") {
        return reject(
          "SH-06",
          "UNTRUSTED_CLOCK",
          "An elapse gate may only be measured against the timestamping authority",
          { gateId: gate.id }
        );
      }
      if (!Number.isInteger(gate.minimumSeconds) || gate.minimumSeconds < MINIMUM_RISK_PERIOD_SECONDS) {
        return reject(
          "SH-06",
          "RISK_PERIOD_NOT_POSITIVE",
          "The risk-holding interval must be a positive whole number of seconds",
          { gateId: gate.id, minimumSeconds: gate.minimumSeconds }
        );
      }
    } else if (gate.requires.anyOf.length === 0) {
      return reject(
        "SH-05",
        "GATE_ACCEPTS_NO_EVIDENCE",
        "An evidence gate must declare at least one admissible evidence type",
        { gateId: gate.id }
      );
    }
    if ("gate" in gate.after && !gateIds.has(gate.after.gate)) {
      return reject("OP-DETERMINACY", "GATE_PREDECESSOR_UNDECLARED", "Gate depends on an undeclared gate", {
        gateId: gate.id,
        after: gate.after.gate
      });
    }
  }
  if (d.constraints?.oneDocumentPerLeg !== true || d.constraints?.monotonicTimestamps !== true) {
    return reject(
      "SH-07",
      "STRUCTURAL_CONSTRAINT_DISABLED",
      "oneDocumentPerLeg and monotonicTimestamps are not optional",
      { definitionId: d.definitionId }
    );
  }
  return ok(d);
}
function findGate(definition, gateId) {
  return definition.gates.find((g) => g.id === gateId);
}
function gatesBeforeSale(definition) {
  const required = new Set(MANDATORY_GATES_BEFORE_SALE[definition.structureCode] ?? []);
  return definition.gates.filter((g) => required.has(g.id));
}
export {
  MANDATORY_GATES_BEFORE_SALE,
  MINIMUM_RISK_PERIOD_SECONDS,
  findGate,
  gatesBeforeSale,
  parseStructureDefinition
};
