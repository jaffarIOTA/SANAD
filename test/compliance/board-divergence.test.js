import { describe, expect, it } from "vitest";
import { TENANT_CODES, loadAllForTenant, loadStructureDefinition } from "../../config/loader.js";
import { expectOk } from "../../core/kernel/result.js";
import { evaluateGates } from "../../core/sequencing/gates.js";
import { parseStructureDefinition } from "../../core/structures/definition.js";
import { emittableReasonCodes } from "../../core/decisioning/policy.js";
import {
  at,
  constructivePossessionEvidence,
  deliveryEvidence,
  ownershipEvidence,
  riskPeriodSecondsFor,
  structureFor
} from "../support/fixtures.js";
import { chain, ANCHOR_CR, DISTRIBUTOR_CR } from "../support/fixtures.js";
const legs = (tenant) => chain(
  [
    {
      legType: "WAAD",
      sequenceNo: 1,
      executedAt: at(1e6),
      counterpartyRole: "BUYER",
      counterpartyCr: DISTRIBUTOR_CR
    },
    {
      legType: "PURCHASE",
      sequenceNo: 2,
      executedAt: at(1000100),
      counterpartyRole: "SELLER",
      counterpartyCr: ANCHOR_CR
    }
  ],
  tenant
);
describe("the two Boards genuinely differ", () => {
  it("sets different risk-holding intervals", () => {
    expect(riskPeriodSecondsFor("bank-a")).not.toBe(riskPeriodSecondsFor("fintech-b"));
  });
  it("admits different possession evidence", () => {
    const bankGate = structureFor("bank-a").gates.find((g) => g.id === "GATE_2_POSSESSION");
    const fintechGate = structureFor("fintech-b").gates.find((g) => g.id === "GATE_2_POSSESSION");
    if (bankGate?.kind !== "EVIDENCE" || fintechGate?.kind !== "EVIDENCE") {
      throw new Error("both tenants must declare an evidence gate at GATE_2_POSSESSION");
    }
    expect(bankGate.requires.anyOf).toContain("CONSTRUCTIVE_POSSESSION");
    expect(fintechGate.requires.anyOf).not.toContain("CONSTRUCTIVE_POSSESSION");
  });
  it("measures the interval from a different instant where evidence overlaps", () => {
    const bankGate = structureFor("bank-a").gates.find((g) => g.id === "GATE_3_RISK_PERIOD");
    const fintechGate = structureFor("fintech-b").gates.find((g) => g.id === "GATE_3_RISK_PERIOD");
    if (bankGate?.kind !== "ELAPSE" || fintechGate?.kind !== "ELAPSE") {
      throw new Error("both tenants must declare an elapse gate at GATE_3_RISK_PERIOD");
    }
    expect(bankGate.startBasis).not.toBe(fintechGate.startBasis);
  });
});
describe("the divergence is absorbed by configuration", () => {
  it("accepts constructive possession for the Board that permits it and not for the other", () => {
    const capturedAt = at(1000200);
    const observedAt = at(1000200 + 2e5);
    const evaluateFor = (tenant) => evaluateGates({
      definition: structureFor(tenant),
      legs: legs(tenant),
      evidence: [
        ownershipEvidence(at(1000150), tenant),
        constructivePossessionEvidence(capturedAt, tenant)
      ],
      riskPeriodRequiredSeconds: riskPeriodSecondsFor(tenant),
      observedAt
    });
    expect(evaluateFor("bank-a").allSatisfied).toBe(true);
    const fintech = evaluateFor("fintech-b");
    expect(fintech.allSatisfied).toBe(false);
    expect(fintech.unsatisfied).toContain("GATE_2_POSSESSION");
  });
  it("accepts a physical delivery note for both", () => {
    for (const tenant of TENANT_CODES) {
      const capturedAt = at(1000200);
      const evaluation = evaluateGates({
        definition: structureFor(tenant),
        legs: legs(tenant),
        evidence: [ownershipEvidence(at(1000150), tenant), deliveryEvidence(capturedAt, tenant)],
        riskPeriodRequiredSeconds: riskPeriodSecondsFor(tenant),
        observedAt: at(1000200 + riskPeriodSecondsFor(tenant))
      });
      expect(evaluation.allSatisfied, `${tenant} should accept a delivery note`).toBe(true);
    }
  });
  it("holds the goods for each Board\u2019s own interval, not a shared one", () => {
    for (const tenant of TENANT_CODES) {
      const required = riskPeriodSecondsFor(tenant);
      const evidence = [
        ownershipEvidence(at(1000150), tenant),
        deliveryEvidence(at(1000200), tenant)
      ];
      const shared = {
        definition: structureFor(tenant),
        legs: legs(tenant),
        evidence,
        riskPeriodRequiredSeconds: required
      };
      expect(
        evaluateGates({ ...shared, observedAt: at(1000200 + required - 1) }).allSatisfied,
        `${tenant} must not clear the gate one second early`
      ).toBe(false);
      expect(
        evaluateGates({ ...shared, observedAt: at(1000200 + required) }).allSatisfied,
        `${tenant} must clear the gate once its own interval has run`
      ).toBe(true);
    }
  });
});
describe("configuration may tighten the platform floor but never loosen it", () => {
  it("refuses a definition that declares a sale leg and omits the risk-period gate", () => {
    const tightened = structureFor("bank-a");
    const withoutGate3 = {
      ...tightened,
      gates: tightened.gates.filter((g) => g.id !== "GATE_3_RISK_PERIOD")
    };
    const result = parseStructureDefinition(withoutGate3);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-05");
    expect(result.error.reason).toBe("MANDATORY_GATE_MISSING");
  });
  it("refuses a risk-holding interval of zero", () => {
    const definition = structureFor("bank-a");
    const zeroed = {
      ...definition,
      gates: definition.gates.map(
        (g) => g.id === "GATE_3_RISK_PERIOD" ? { ...g, minimumSeconds: 0 } : g
      )
    };
    const result = parseStructureDefinition(zeroed);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-06");
  });
  it("refuses an interval measured against anything but the timestamping authority", () => {
    const definition = structureFor("bank-a");
    const localClock = {
      ...definition,
      gates: definition.gates.map(
        (g) => g.id === "GATE_3_RISK_PERIOD" ? { ...g, clock: "SERVER" } : g
      )
    };
    const result = parseStructureDefinition(localClock);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-06");
    expect(result.error.reason).toBe("UNTRUSTED_CLOCK");
  });
  it("refuses a definition with no approval reference", () => {
    const definition = structureFor("bank-a");
    const result = parseStructureDefinition({ ...definition, shariahApprovalRef: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-17");
  });
  it("refuses a definition that turns off one-document-per-leg", () => {
    const definition = structureFor("bank-a");
    const result = parseStructureDefinition({
      ...definition,
      constraints: { ...definition.constraints, oneDocumentPerLeg: false }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-07");
  });
});
describe.each(TENANT_CODES)("every tenant\u2019s configuration loads and is coherent [%s]", (tenant) => {
  it("parses", () => {
    const loaded = expectOk(loadAllForTenant(tenant));
    expect(loaded.structures.length).toBeGreaterThan(0);
    expect(loaded.creditPolicies.length).toBeGreaterThan(0);
  });
  it("binds its structure to an approval record", () => {
    const definition = expectOk(loadStructureDefinition(tenant, "MURABAHA_DISTRIBUTOR"));
    expect(definition.shariahApprovalRef).toMatch(/^SSB-/);
  });
  it("can explain, in both languages, every reason its policy can emit", () => {
    const { creditPolicies } = expectOk(loadAllForTenant(tenant));
    for (const policy of creditPolicies) {
      for (const code of emittableReasonCodes(policy)) {
        const text = policy.reasons[code];
        expect(text, `${tenant} policy can emit ${code} with no wording`).toBeDefined();
        expect(text?.ar.trim().length).toBeGreaterThan(0);
        expect(text?.en.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
