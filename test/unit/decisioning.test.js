import { describe, expect, it } from "vitest";
import { loadCreditPolicyVersions } from "../../config/loader.js";
import { expectOk } from "../../core/kernel/result.js";
import {
  evaluateCreditPolicy,
  evaluateWithChallenger,
  gradeFor
} from "../../core/decisioning/engine.js";
import {
  parseCreditPolicy,
  resolveEffectivePolicy
} from "../../core/decisioning/policy.js";
import { pathResolver } from "../../core/decisioning/expression.js";
import { strongApplicant } from "../support/fixtures.js";
function policyFor(tenant) {
  const versions = expectOk(loadCreditPolicyVersions(tenant, "wasl-distributor"));
  return expectOk(resolveEffectivePolicy(versions, 1791000000n));
}
function decide(tenant, overrides = {}) {
  return evaluateCreditPolicy(policyFor(tenant), strongApplicant(tenant, overrides), "dec-0001");
}
describe("determinism (BR-C02)", () => {
  it("returns an identical record for an identical snapshot and policy version", () => {
    const policy = policyFor("bank-a");
    const snapshot = strongApplicant("bank-a");
    const first = evaluateCreditPolicy(policy, snapshot, "dec-0001");
    const second = evaluateCreditPolicy(policy, snapshot, "dec-0001");
    expect(first).toStrictEqual(second);
  });
  it("takes its decision identifier as an argument rather than minting one", () => {
    const policy = policyFor("bank-a");
    const snapshot = strongApplicant("bank-a");
    expect(evaluateCreditPolicy(policy, snapshot, "a").decisionId).toBe("a");
    expect(evaluateCreditPolicy(policy, snapshot, "b").decisionId).toBe("b");
  });
  it("records the snapshot capture time rather than reading a clock", () => {
    const decision = decide("bank-a");
    expect(decision.snapshotCapturedAtEpochSeconds).toBe(1791000000n);
  });
});
describe("a strong applicant is approved, and the two institutions size it differently", () => {
  it("approves at the bank, sized on trade with the anchor and capped by invoice size", () => {
    const decision = decide("bank-a");
    expect(decision.outcome).toBe("APPROVE");
    expect(decision.grade).toBe("A");
    expect(decision.score).toBe(110);
    expect(decision.assignedLimitMinorUnits).toBe(160000000n);
    expect(decision.bindingCapCode).toBe("CAP_SINGLE_LARGEST_INVOICE");
  });
  it("approves at the fintech, sized on the lower of trade and bank inflow", () => {
    const decision = decide("fintech-b");
    expect(decision.outcome).toBe("APPROVE");
    expect(decision.grade).toBe("A");
    expect(decision.assignedLimitMinorUnits).toBe(120000000n);
  });
  it("gives the same applicant a different limit at each institution", () => {
    expect(decide("bank-a").assignedLimitMinorUnits).not.toBe(
      decide("fintech-b").assignedLimitMinorUnits
    );
  });
});
describe("knockouts", () => {
  it("declines an inactive registration at both institutions", () => {
    for (const tenant of ["bank-a", "fintech-b"]) {
      const decision = decide(tenant, { registration: { status: "EXPIRED" } });
      expect(decision.outcome).toBe("DECLINE");
      expect(decision.reasons.map((r) => r.code)).toContain("R_REGISTRATION_NOT_ACTIVE");
      expect(decision.assignedLimitMinorUnits).toBe(0n);
    }
  });
  it("declines an excluded business activity \u2014 a Shariah gate, not a credit one", () => {
    const decision = decide("bank-a", { screening: { activityPermissibility: "EXCLUDED" } });
    expect(decision.outcome).toBe("DECLINE");
    expect(decision.reasons[0]?.code).toBe("R_ACTIVITY_EXCLUDED");
  });
  it("stops at the first knockout and runs nothing after it", () => {
    const decision = decide("bank-a", { registration: { status: "CANCELLED" } });
    const stages = decision.trace.map((t) => t.stage);
    expect(stages).not.toContain("SCORECARD");
    expect(stages).not.toContain("LIMIT_BASIS");
  });
  it("treats an inconclusive screening result differently at the two institutions", () => {
    expect(decide("bank-a", { screening: { sanctions: "POTENTIAL_MATCH" } }).outcome).toBe("REFER");
    expect(decide("fintech-b", { screening: { sanctions: "POTENTIAL_MATCH" } }).outcome).toBe(
      "DECLINE"
    );
  });
  it("declines a recent default at the bank, which asks the bureau, and not at the fintech, which does not", () => {
    expect(decide("bank-a", { bureau: { defaultsLast24Months: 1 } }).outcome).toBe("DECLINE");
    expect(decide("fintech-b", { bureau: { defaultsLast24Months: 1 } }).outcome).toBe("APPROVE");
  });
});
describe("data sufficiency", () => {
  it("refers rather than deciding when a required consent is absent", () => {
    const decision = decide("bank-a", { consent: { creditBureau: false } });
    expect(decision.outcome).toBe("REFER");
    expect(decision.reasons[0]?.code).toBe("R_MISSING_CONSENT");
  });
  it("does not require a consent the institution does not use", () => {
    expect(decide("fintech-b", { consent: { creditBureau: false } }).outcome).toBe("APPROVE");
  });
  it("refers on stale data rather than deciding on figures nobody stands behind", () => {
    const decision = decide("bank-a", { tradeHistory: { retrievedSecondsAgo: 999999 } });
    expect(decision.outcome).toBe("REFER");
    expect(decision.reasons[0]?.code).toBe("R_STALE_DATA");
  });
});
describe("the score, the grade and the reasons", () => {
  it("refers a middling applicant with the characteristics it fell short on", () => {
    const decision = decide("bank-a", {
      tradeHistory: {
        largestBuyerSharePerTenThousand: 9e3,
        withAnchor: {
          medianMonthlyValueMinorUnits: 20000000n,
          latePaymentPerTenThousand: 2800,
          disputeCount: 2
        }
      },
      bureau: { worstArrearsDaysLast12Months: 45 },
      workforce: { employeeCount: 2 }
    });
    expect(decision.outcome).toBe("REFER");
    expect(decision.score).toBe(61);
    const codes = decision.reasons.map((r) => r.code);
    expect(codes).toContain("R_GRADE_REFER");
    expect(codes).toContain("R_PAYMENT_BEHAVIOUR");
    expect(codes).toContain("R_BUREAU_ARREARS");
    expect(decision.reasons).toHaveLength(4);
  });
  it("carries approved Arabic and English wording on every reason it gives", () => {
    const decision = decide("bank-a", { registration: { status: "SUSPENDED" } });
    expect(decision.reasons.length).toBeGreaterThan(0);
    for (const reason of decision.reasons) {
      expect(reason.ar.trim().length).toBeGreaterThan(0);
      expect(reason.en.trim().length).toBeGreaterThan(0);
      expect(/[؀-ۿ]/.test(reason.ar)).toBe(true);
    }
  });
  it("traces every rule that ran, in order, with what it concluded", () => {
    const decision = decide("bank-a");
    expect(decision.trace.map((t) => t.sequence)).toEqual(
      decision.trace.map((_, i) => i)
    );
    const stages = new Set(decision.trace.map((t) => t.stage));
    expect(stages).toContain("DATA_SUFFICIENCY");
    expect(stages).toContain("KNOCKOUT");
    expect(stages).toContain("SCORECARD");
    expect(stages).toContain("GRADE");
    expect(stages).toContain("LIMIT_BASIS");
    expect(stages).toContain("CAP");
    expect(stages).not.toContain("FAULT");
  });
  it("picks the highest grade band the score reaches", () => {
    const grades = [
      { grade: "A", minScore: 85, outcome: "APPROVE" },
      { grade: "B", minScore: 70, outcome: "APPROVE" },
      { grade: "D", minScore: 0, outcome: "DECLINE" }
    ];
    expect(gradeFor(grades, 92)?.grade).toBe("A");
    expect(gradeFor(grades, 85)?.grade).toBe("A");
    expect(gradeFor(grades, 84)?.grade).toBe("B");
    expect(gradeFor(grades, 0)?.grade).toBe("D");
  });
});
describe("limit sizing and caps", () => {
  it("nets the limit down by exposure the institution already carries", () => {
    const decision = decide("bank-a", {
      exposure: { coreBankingExposureMinorUnits: 60000000n }
    });
    expect(decision.assignedLimitMinorUnits).toBe(100000000n);
    expect(decision.bindingCapCode).toBe("CAP_NET_OF_EXPOSURE");
  });
  it("never exceeds the programme\u2019s remaining headroom", () => {
    const decision = decide("bank-a", {
      programme: {
        programmeLimitMinorUnits: 1000000000n,
        programmeUtilisedMinorUnits: 990000000n
      }
    });
    expect(decision.assignedLimitMinorUnits).toBeLessThanOrEqual(10000000n);
  });
  it("caps a single counterparty\u2019s share of the programme", () => {
    const decision = decide("bank-a", {
      programme: {
        programmeLimitMinorUnits: 200000000n,
        programmeUtilisedMinorUnits: 0n
      }
    });
    expect(decision.assignedLimitMinorUnits).toBe(30000000n);
    expect(decision.bindingCapCode).toBe("CAP_CONCENTRATION_SHARE");
  });
  it("tightens the limit where confirmatory bank data is unavailable", () => {
    const decision = decide("bank-a", { openBanking: { availability: "UNAVAILABLE" } });
    expect(decision.assignedLimitMinorUnits).toBe(100000000n);
    expect(decision.bindingCapCode).toBe("CAP_NO_OPEN_BANKING");
  });
  it("rounds the limit down, never up", () => {
    const decision = decide("bank-a", {
      tradeHistory: {
        withAnchor: {
          medianMonthlyValueMinorUnits: 50033333n,
          largestSingleInvoiceMinorUnits: 900000000n
        }
      }
    });
    expect(decision.assignedLimitMinorUnits).toBe(150000000n);
  });
  it("refers rather than approving a limit too small to be worth issuing", () => {
    const decision = decide("bank-a", {
      exposure: { coreBankingExposureMinorUnits: 159000000n }
    });
    expect(decision.outcome).toBe("REFER");
    expect(decision.assignedLimitMinorUnits).toBe(0n);
  });
  it("uses integer arithmetic throughout", () => {
    expect(typeof decide("bank-a").assignedLimitMinorUnits).toBe("bigint");
  });
});
describe("champion and challenger", () => {
  it("records the challenger\u2019s decision and applies the champion\u2019s", () => {
    const champion = policyFor("bank-a");
    const challenger = {
      ...champion,
      version: "1.1.0-challenger",
      limit: {
        ...champion.limit,
        caps: champion.limit.caps.filter((c) => c.code !== "CAP_SINGLE_LARGEST_INVOICE")
      }
    };
    const result = evaluateWithChallenger(
      champion,
      challenger,
      strongApplicant("bank-a"),
      "dec-0001",
      "dec-0001-c"
    );
    expect(result.applied.assignedLimitMinorUnits).toBe(160000000n);
    expect(result.challenger?.assignedLimitMinorUnits).toBe(180000000n);
    expect(result.applied.policyVersion).toBe(champion.version);
  });
  it("runs without a challenger", () => {
    const result = evaluateWithChallenger(
      policyFor("bank-a"),
      void 0,
      strongApplicant("bank-a"),
      "dec-0001",
      "dec-0001-c"
    );
    expect(result.challenger).toBeUndefined();
  });
});
describe("policy loading refuses what it cannot stand behind", () => {
  it("refuses a policy section the engine does not recognise", () => {
    const policy = policyFor("bank-a");
    const result = parseCreditPolicy({ ...policy, pricing: { markupTable: [] } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("UNKNOWN_POLICY_SECTION");
  });
  it("refuses a policy that can decline without being able to say why", () => {
    const policy = policyFor("bank-a");
    const result = parseCreditPolicy({
      ...policy,
      reasons: { ...policy.reasons, R_REGISTRATION_NOT_ACTIVE: { ar: "", en: "Not valid" } }
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("REASON_WORDING_MISSING");
  });
  it("refuses a policy with no credit approval reference", () => {
    const policy = policyFor("bank-a");
    const result = parseCreditPolicy({
      ...policy,
      approval: { ...policy.approval, creditApprovalRef: "" }
    });
    expect(result.ok).toBe(false);
  });
  it("refuses an approving grade with no way to size a limit", () => {
    const policy = policyFor("bank-a");
    const result = parseCreditPolicy({
      ...policy,
      grades: [...policy.grades, { grade: "AA", minScore: 200, outcome: "APPROVE" }]
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("APPROVING_GRADE_HAS_NO_LIMIT_BASIS");
  });
});
describe("effective dating", () => {
  const base = policyFor("bank-a");
  const v2 = { ...base, version: "2.0.0", effectiveFromEpochSeconds: "1800000000" };
  it("resolves the version in force at the moment being evaluated, not the newest", () => {
    const before = expectOk(resolveEffectivePolicy([base, v2], 1791000000n));
    expect(before.version).toBe("1.0.0");
    const after = expectOk(resolveEffectivePolicy([base, v2], 1800000001n));
    expect(after.version).toBe("2.0.0");
  });
  it("refuses when no version is in force", () => {
    const result = resolveEffectivePolicy([base, v2], 1n);
    expect(result.ok).toBe(false);
  });
  it("refuses when two versions share an effective date", () => {
    const clash = { ...base, version: "1.0.1" };
    const result = resolveEffectivePolicy([base, clash], 1791000000n);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("AMBIGUOUS_POLICY_VERSIONS");
  });
});
describe("the expression language cannot reach beyond the snapshot", () => {
  const resolve = pathResolver(strongApplicant("bank-a"));
  it("resolves declared fields", () => {
    expect(resolve("registration.status")).toBe("ACTIVE");
    expect(resolve("tradeHistory.withAnchor.monthsTrading")).toBe(42);
  });
  it("does not walk the prototype chain", () => {
    expect(resolve("constructor")).toBeUndefined();
    expect(resolve("__proto__.constructor")).toBeUndefined();
    expect(resolve("registration.toString")).toBeUndefined();
  });
  it("returns undefined for anything undeclared", () => {
    expect(resolve("registration.nationalId")).toBeUndefined();
    expect(resolve("nothing.here")).toBeUndefined();
  });
});
