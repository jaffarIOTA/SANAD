import { describe, expect, it } from "vitest";
import { TENANT_CODES } from "../../config/loader.js";
import { expectOk } from "../../core/kernel/result.js";
import { evaluateGates } from "../../core/sequencing/gates.js";
import {
  acceptOffer,
  acquireOwnership,
  confirmPossession,
  executePurchase,
  executeWaad,
  offerSale,
  reserveLimit,
  submit
} from "../../core/sequencing/transitions.js";
import {
  ANCHOR_CR,
  DISTRIBUTOR_CR,
  at,
  chain,
  constructivePossessionEvidence,
  deliveryEvidence,
  evidenceRecord,
  ownershipEvidence,
  riskPeriodSecondsFor,
  structureFor,
  transactionCore
} from "../support/fixtures.js";
const WAAD_AT = 1e6;
const PURCHASE_AT = 1000100;
const OWNERSHIP_AT = 1000150;
const POSSESSION_AT = 1000200;
function legsFor(tenant, saleAt, acceptAt) {
  return chain(
    [
      {
        legType: "WAAD",
        sequenceNo: 1,
        executedAt: at(WAAD_AT),
        counterpartyRole: "BUYER",
        counterpartyCr: DISTRIBUTOR_CR
      },
      {
        legType: "PURCHASE",
        sequenceNo: 2,
        executedAt: at(PURCHASE_AT),
        counterpartyRole: "SELLER",
        counterpartyCr: ANCHOR_CR
      },
      {
        legType: "SALE_OFFER",
        sequenceNo: 3,
        executedAt: at(saleAt),
        counterpartyRole: "INSTITUTION",
        counterpartyCr: "7001000001"
      },
      {
        legType: "ACCEPTANCE",
        sequenceNo: 4,
        executedAt: at(acceptAt),
        counterpartyRole: "BUYER",
        counterpartyCr: DISTRIBUTOR_CR
      }
    ],
    tenant
  );
}
function context(tenant, evidence, observedAtSeconds) {
  return { definition: structureFor(tenant), evidence, observedAt: at(observedAtSeconds) };
}
function purchaseExecuted(tenant, legs) {
  const core = transactionCore(tenant);
  const ctx = context(tenant, [], PURCHASE_AT);
  const reserved = reserveLimit(submit({ state: "DRAFT", core }), "res-0001");
  const waad = expectOk(executeWaad(reserved, legs[0], ctx));
  return expectOk(executePurchase(waad, legs[1], ctx));
}
describe.each(TENANT_CODES)("adversarial: sequencing gates [%s]", (tenant) => {
  const requiredSeconds = riskPeriodSecondsFor(tenant);
  const saleAt = POSSESSION_AT + requiredSeconds + 100;
  const acceptAt = saleAt + 60;
  const legs = legsFor(tenant, saleAt, acceptAt);
  const validOwnership = ownershipEvidence(at(OWNERSHIP_AT), tenant);
  const acceptedPossession = tenant === "bank-a" ? constructivePossessionEvidence(at(POSSESSION_AT), tenant) : deliveryEvidence(at(POSSESSION_AT), tenant);
  it("refuses to acquire ownership with no evidence at all", () => {
    const purchase = purchaseExecuted(tenant, legs);
    const result = acquireOwnership(purchase, context(tenant, [], PURCHASE_AT + 10));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-05");
    expect(result.error.reason).toBe("NO_ADMISSIBLE_EVIDENCE");
  });
  it("refuses ownership evidence from a self-attested source", () => {
    const purchase = purchaseExecuted(tenant, legs);
    const selfAttested = evidenceRecord(
      {
        evidenceType: "OWNERSHIP_INVOICE",
        gate: "GATE_1_OWNERSHIP",
        source: "UPLOAD",
        capturedAt: at(OWNERSHIP_AT),
        validationDetail: { recipientIsInstitution: true, clearanceStatus: "CLEARED" }
      },
      tenant
    );
    const result = acquireOwnership(purchase, context(tenant, [selfAttested], OWNERSHIP_AT));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-05");
    expect(result.error.reason).toBe("EVIDENCE_DID_NOT_QUALIFY");
  });
  it("refuses ownership evidence that fails the declared validation", () => {
    const purchase = purchaseExecuted(tenant, legs);
    const notCleared = evidenceRecord(
      {
        evidenceType: "OWNERSHIP_INVOICE",
        gate: "GATE_1_OWNERSHIP",
        source: "E_INVOICING_AUTHORITY",
        capturedAt: at(OWNERSHIP_AT),
        // Named as recipient, but the invoice was never cleared with the authority.
        validationDetail: { recipientIsInstitution: true, clearanceStatus: "REPORTED" }
      },
      tenant
    );
    const result = acquireOwnership(purchase, context(tenant, [notCleared], OWNERSHIP_AT));
    expect(result.ok).toBe(false);
  });
  it("refuses superseded evidence", () => {
    const purchase = purchaseExecuted(tenant, legs);
    const superseded = { ...validOwnership, supersededBy: "evd-correction" };
    const result = acquireOwnership(purchase, context(tenant, [superseded], OWNERSHIP_AT));
    expect(result.ok).toBe(false);
  });
  it("refuses to confirm possession before ownership is evidenced", () => {
    const purchase = purchaseExecuted(tenant, legs);
    const result = acquireOwnership(purchase, context(tenant, [acceptedPossession], POSSESSION_AT));
    expect(result.ok).toBe(false);
  });
  it("refuses to offer the sale before the risk-holding interval has run", () => {
    const purchase = purchaseExecuted(tenant, legs);
    const evidence = [validOwnership, acceptedPossession];
    const owned = expectOk(acquireOwnership(purchase, context(tenant, evidence, OWNERSHIP_AT)));
    const held = expectOk(confirmPossession(owned, context(tenant, evidence, POSSESSION_AT)));
    const tooEarly = POSSESSION_AT + requiredSeconds - 1;
    const result = offerSale(
      held,
      legs[2],
      BigInt(tooEarly + 3600),
      context(tenant, evidence, tooEarly)
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-06");
    expect(result.error.reason).toBe("RISK_PERIOD_NOT_ELAPSED");
    expect(result.error.context?.["requiredSeconds"]).toBe(requiredSeconds);
  });
  it("refuses to offer the sale when possession evidence is later withdrawn", () => {
    const purchase = purchaseExecuted(tenant, legs);
    const evidence = [validOwnership, acceptedPossession];
    const owned = expectOk(acquireOwnership(purchase, context(tenant, evidence, OWNERSHIP_AT)));
    const held = expectOk(confirmPossession(owned, context(tenant, evidence, POSSESSION_AT)));
    const withdrawn = [validOwnership, { ...acceptedPossession, supersededBy: "evd-correction" }];
    const result = offerSale(held, legs[2], BigInt(saleAt + 3600), context(tenant, withdrawn, saleAt));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-05");
  });
  it("measures the interval from the attested instant, not from when evidence was filed", () => {
    const evidence = [validOwnership, acceptedPossession];
    const evaluation = evaluateGates({
      definition: structureFor(tenant),
      legs,
      evidence,
      riskPeriodRequiredSeconds: requiredSeconds,
      observedAt: at(POSSESSION_AT + requiredSeconds)
    });
    expect(evaluation.riskPeriodStartAt?.epochSeconds).toBe(BigInt(POSSESSION_AT));
    expect(evaluation.allSatisfied).toBe(true);
  });
  it("is a pure function of its inputs", () => {
    const input = {
      definition: structureFor(tenant),
      legs,
      evidence: [validOwnership, acceptedPossession],
      riskPeriodRequiredSeconds: requiredSeconds,
      observedAt: at(saleAt)
    };
    expect(evaluateGates(input)).toStrictEqual(evaluateGates(input));
  });
  it("completes a real drawdown when every condition is genuinely met", () => {
    const purchase = purchaseExecuted(tenant, legs);
    const evidence = [validOwnership, acceptedPossession];
    const owned = expectOk(acquireOwnership(purchase, context(tenant, evidence, OWNERSHIP_AT)));
    expect(owned.state).toBe("OWNERSHIP_ACQUIRED");
    const held = expectOk(confirmPossession(owned, context(tenant, evidence, POSSESSION_AT)));
    expect(held.state).toBe("POSSESSION_CONFIRMED");
    expect(held.riskPeriodStartAt.epochSeconds).toBe(BigInt(POSSESSION_AT));
    const offered = expectOk(
      offerSale(held, legs[2], BigInt(acceptAt + 3600), context(tenant, evidence, saleAt))
    );
    expect(offered.state).toBe("SALE_OFFERED");
    const executed = expectOk(acceptOffer(offered, legs[3], context(tenant, evidence, acceptAt)));
    expect(executed.state).toBe("EXECUTED");
    expect(executed.legs).toHaveLength(4);
    const { pricing } = executed.core;
    expect(pricing.salePriceAmount.minorUnits).toBe(
      pricing.costAmount.minorUnits + pricing.profitAmount.minorUnits
    );
  });
  it("refuses an acceptance attested at the same instant as the offer", () => {
    const purchase = purchaseExecuted(tenant, legs);
    const evidence = [validOwnership, acceptedPossession];
    const owned = expectOk(acquireOwnership(purchase, context(tenant, evidence, OWNERSHIP_AT)));
    const held = expectOk(confirmPossession(owned, context(tenant, evidence, POSSESSION_AT)));
    const offered = expectOk(
      offerSale(held, legs[2], BigInt(acceptAt + 3600), context(tenant, evidence, saleAt))
    );
    const sameInstantLeg = { ...legs[3], executedAt: at(saleAt) };
    const result = acceptOffer(offered, sameInstantLeg, context(tenant, evidence, saleAt));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-07");
    expect(result.error.reason).toBe("ACCEPTANCE_NOT_AFTER_OFFER");
  });
});
