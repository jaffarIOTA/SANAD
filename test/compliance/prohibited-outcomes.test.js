import { describe, expect, it } from "vitest";
import { TENANT_CODES } from "../../config/loader.js";
import { expectOk } from "../../core/kernel/result.js";
import { money } from "../../core/kernel/money.js";
import { priceMurabaha } from "../../core/pricing/murabaha.js";
import {
  applyEarlySettlementRelief,
  applyPayment,
  createObligation,
  reschedule
} from "../../core/obligation/obligation.js";
import { disburse, postLateAmount } from "../../core/ledger/charity.js";
import { buildLegRenderRequest } from "../../core/documents/render.js";
import { appendLeg } from "../../core/legs/leg.js";
import { verifyDistinctParties, verifyNoBuyBack } from "../../core/parties/distinctness.js";
import {
  ENTITLEMENT_ACTIONS,
  FORBIDDEN_ENTITLEMENT_PATTERNS,
  SEQUENCING_TRANSITIONS,
  defineEntitlement
} from "../../core/authz/entitlements.js";
import {
  assertNotPreviouslyFinanced
} from "../../core/trade/financed-invoice-registry.js";
import { ANCHOR_CR, DISTRIBUTOR_CR, at, chain, structureFor } from "../support/fixtures.js";
class InMemoryRegistry {
  #rows = /* @__PURE__ */ new Map();
  async register(record) {
    const key = `${record.tenantId}/${record.invoiceUuid}`;
    const existing = this.#rows.get(key);
    if (existing !== void 0 && existing !== record.transactionId) {
      return {
        ok: false,
        error: {
          control: "SH-10",
          reason: "DUPLICATE_FINANCING",
          detail: "This invoice has already been financed and cannot be financed again",
          context: { existingReference: existing }
        }
      };
    }
    this.#rows.set(key, record.transactionId);
    return { ok: true, value: { registryId: key } };
  }
  async lookup(tenantId, invoiceUuid) {
    const existing = this.#rows.get(`${tenantId}/${invoiceUuid}`);
    return existing === void 0 ? void 0 : { transactionId: existing };
  }
}
describe("adversarial: duplicate financing (SH-10)", () => {
  const invoiceUuid = "3cf5d9a2-0000-4000-8000-000000000001";
  const record = (transactionId) => ({
    tenantId: "bank-a",
    invoiceUuid,
    invoiceHash: "invoice-hash",
    issuerCr: ANCHOR_CR,
    recipientCr: DISTRIBUTOR_CR,
    financedAmount: money(18500000n),
    transactionId,
    financedAtEpochSeconds: 1000000n
  });
  it("refuses a second drawdown against an invoice already financed", async () => {
    const registry = new InMemoryRegistry();
    expectOk(await registry.register(record("txn-0001")));
    const preflight = await assertNotPreviouslyFinanced(registry, "bank-a", invoiceUuid);
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.error.control).toBe("SH-10");
    expect(preflight.error.context?.["existingReference"]).toBe("txn-0001");
    const secondWrite = await registry.register(record("txn-0002"));
    expect(secondWrite.ok).toBe(false);
  });
  it("still allows an idempotent replay of the same drawdown", async () => {
    const registry = new InMemoryRegistry();
    expectOk(await registry.register(record("txn-0001")));
    expectOk(await registry.register(record("txn-0001")));
  });
  it("keeps the record after settlement", async () => {
    const registry = new InMemoryRegistry();
    expectOk(await registry.register(record("txn-0001")));
    expect(Object.keys(registry)).not.toContain("delete");
    expect(await registry.lookup("bank-a", invoiceUuid)).toEqual({ transactionId: "txn-0001" });
  });
});
describe("adversarial: the total never increases (SH-02)", () => {
  const pricing = expectOk(priceMurabaha(money(18500000n), money(462500n)));
  const total = pricing.salePriceAmount.minorUnits;
  const split = (amounts) => amounts.map((amount, i) => ({
    instalmentNo: i + 1,
    dueDateGregorian: `2026-1${i}-01`,
    dueDateHijri: `1448-0${i + 1}-01`,
    amount: money(amount)
  }));
  const obligation = expectOk(
    createObligation({
      obligationId: "obl-0001",
      tenantId: "bank-a",
      transactionId: "txn-0001",
      pricing,
      instalments: split([9481250n, 9481250n])
    })
  );
  it("refuses a schedule that sums to more than the original total", () => {
    const result = reschedule(obligation, split([9481250n, 9481251n]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-02");
    expect(result.error.reason).toBe("SCHEDULE_INCREASES_TOTAL");
  });
  it("refuses a schedule that does not sum to the total at all", () => {
    const result = reschedule(obligation, split([1000000n]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-02");
  });
  it("accepts new dates and a new split at the same total", () => {
    const rescheduled = expectOk(
      reschedule(obligation, split([6320834n, 6320833n, 6320833n]))
    );
    expect(rescheduled.totalAmount.minorUnits).toBe(total);
    expect(rescheduled.instalments).toHaveLength(3);
  });
  it("refuses an obligation whose schedule did not sum to the total at creation", () => {
    const result = createObligation({
      obligationId: "obl-0002",
      tenantId: "bank-a",
      transactionId: "txn-0002",
      pricing,
      instalments: split([total + 1n])
    });
    expect(result.ok).toBe(false);
  });
  it("refuses a waiver that would increase what is owed", () => {
    const result = applyEarlySettlementRelief(obligation, money(-1n), split([total + 1n]), {
      configKey: "ibra.basis",
      shariahApprovalId: "SSB-A-2026-014"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-02");
  });
  it("permits a waiver, which moves the amount owed downward", () => {
    const waived = expectOk(
      applyEarlySettlementRelief(obligation, money(462500n), split([18500000n]), {
        configKey: "ibra.basis",
        shariahApprovalId: "SSB-A-2026-014"
      })
    );
    expect(waived.totalAmount.minorUnits).toBe(total);
    expect(waived.waivedAmount.minorUnits).toBe(462500n);
  });
  it("refuses to absorb an overpayment silently", () => {
    const result = applyPayment(obligation, money(total + 1n));
    expect(result.ok).toBe(false);
  });
});
describe("adversarial: late charges are never income (SH-13)", () => {
  const base = {
    entryId: "chg-0001",
    tenantId: "bank-a",
    transactionId: "txn-0001",
    amount: money(50000n),
    computationBasisConfigKey: "late.basis.actual_cost",
    shariahApprovalId: "SSB-A-2026-014",
    recordedAt: at(2e6)
  };
  it("posts only to the segregated charity liability", () => {
    const entry = expectOk(postLateAmount({ ...base, assessment: "ABLE_BUT_UNWILLING" }));
    expect(entry.accountClass).toBe("CHARITY_LIABILITY");
    expect(entry.reason).toBe("LATE_PAYMENT");
  });
  it("suspends the charge where the counterparty is unable to pay", () => {
    const result = postLateAmount({ ...base, assessment: "UNABLE" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-14");
    expect(result.error.reason).toBe("HARDSHIP_SUSPENDS_LATE_AMOUNTS");
  });
  it("refuses a charge with no Board-approved computation basis", () => {
    const result = postLateAmount({
      ...base,
      assessment: "ABLE_BUT_UNWILLING",
      computationBasisConfigKey: ""
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-13");
  });
  it("refuses disbursement to a recipient not on the Board-approved register", () => {
    const entry = expectOk(postLateAmount({ ...base, assessment: "ABLE_BUT_UNWILLING" }));
    const result = disburse(entry, "not-on-the-register", ["approved-charity-1"], "dsb-0001");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-13");
  });
  it("refuses to disburse the same entry twice", () => {
    const entry = expectOk(postLateAmount({ ...base, assessment: "ABLE_BUT_UNWILLING" }));
    const once = expectOk(disburse(entry, "approved-charity-1", ["approved-charity-1"], "dsb-0001"));
    const twice = disburse(once, "approved-charity-1", ["approved-charity-1"], "dsb-0002");
    expect(twice.ok).toBe(false);
  });
});
describe("adversarial: separation of contracts (SH-07)", () => {
  const legs = chain([
    {
      legType: "SALE_OFFER",
      sequenceNo: 1,
      executedAt: at(1e6),
      counterpartyRole: "INSTITUTION",
      counterpartyCr: "7001000001"
    },
    {
      legType: "ACCEPTANCE",
      sequenceNo: 2,
      executedAt: at(1000060),
      counterpartyRole: "BUYER",
      counterpartyCr: DISTRIBUTOR_CR
    }
  ]);
  const renderParams = {
    requestId: "req-0001",
    tenantId: "bank-a",
    templateVersionId: "tpl-v3",
    translationLocale: "en-SA",
    mergeFields: {},
    shariahApprovalId: "SSB-A-2026-014",
    correlationId: "cor-0001"
  };
  it("refuses to render two legs into one instrument", () => {
    const result = buildLegRenderRequest(legs, renderParams);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-07");
    expect(result.error.reason).toBe("COMBINED_LEG_RENDERING_REFUSED");
  });
  it("renders one leg into one instrument", () => {
    const request = expectOk(buildLegRenderRequest([legs[0]], renderParams));
    expect(request.leg.legId).toBe(legs[0].legId);
    expect(request.governingLocale).toBe("ar-SA");
  });
  it("refuses to bind one document to a second leg", () => {
    const duplicate = { ...legs[1], documentId: legs[0].documentId };
    const result = appendLeg([legs[0]], duplicate);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-07");
    expect(result.error.reason).toBe("DOCUMENT_ALREADY_BOUND_TO_A_LEG");
  });
  it("refuses a leg that does not chain to its predecessor", () => {
    const orphan = { ...legs[1], prevLegHash: "not-the-predecessor" };
    const result = appendLeg([legs[0]], orphan);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("HASH_CHAIN_BROKEN");
  });
  it("refuses a leg back-dated behind its predecessor", () => {
    const backdated = { ...legs[1], executedAt: at(999999) };
    const result = appendLeg([legs[0]], backdated);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("TIMESTAMPS_NOT_MONOTONIC");
  });
});
describe.each(TENANT_CODES)("adversarial: counterparty distinctness [%s]", (tenant) => {
  const definition = structureFor(tenant);
  it("refuses a chain that sells back to the entity it bought from", () => {
    const legs = chain([
      {
        legType: "PURCHASE",
        sequenceNo: 1,
        executedAt: at(1e6),
        counterpartyRole: "SELLER",
        counterpartyCr: ANCHOR_CR
      },
      {
        legType: "ACCEPTANCE",
        sequenceNo: 2,
        executedAt: at(1000100),
        counterpartyRole: "BUYER",
        counterpartyCr: ANCHOR_CR
      }
    ]);
    const declared = verifyDistinctParties(definition, legs);
    expect(declared.ok).toBe(false);
    if (declared.ok) return;
    expect(declared.error.control).toBe("SH-08");
    expect(verifyNoBuyBack(legs).ok).toBe(false);
  });
  it("matches on registration number rather than on presentation", () => {
    const legs = chain([
      {
        legType: "PURCHASE",
        sequenceNo: 1,
        executedAt: at(1e6),
        counterpartyRole: "SELLER",
        counterpartyCr: " 1010-000002 "
      },
      {
        legType: "ACCEPTANCE",
        sequenceNo: 2,
        executedAt: at(1000100),
        counterpartyRole: "BUYER",
        counterpartyCr: "1010000002"
      }
    ]);
    expect(verifyDistinctParties(definition, legs).ok).toBe(false);
  });
  it("permits genuinely distinct parties", () => {
    const legs = chain([
      {
        legType: "PURCHASE",
        sequenceNo: 1,
        executedAt: at(1e6),
        counterpartyRole: "SELLER",
        counterpartyCr: ANCHOR_CR
      },
      {
        legType: "ACCEPTANCE",
        sequenceNo: 2,
        executedAt: at(1000100),
        counterpartyRole: "BUYER",
        counterpartyCr: DISTRIBUTOR_CR
      }
    ]);
    expectOk(verifyDistinctParties(definition, legs));
    expectOk(verifyNoBuyBack(legs));
  });
});
describe("adversarial: no gate-bypass entitlement can be defined (SH-05, BR-D10)", () => {
  const spec = {
    entitlementId: "ent-0001",
    tenantId: "bank-a",
    roleCode: "OPERATIONS_SUPERVISOR",
    scope: { kind: "TENANT" }
  };
  it.each([
    "transaction.override_gate",
    "gate.advance",
    "sequencing.bypass",
    "transaction.force_execute",
    "risk_period.waive",
    "admin.superuser"
  ])("refuses the entitlement %s", (action) => {
    const result = defineEntitlement({ ...spec, actions: [action] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.control).toBe("SH-05");
  });
  it("refuses an entitlement naming a sequencing transition", () => {
    for (const transition of SEQUENCING_TRANSITIONS) {
      const result = defineEntitlement({ ...spec, actions: [transition] });
      expect(result.ok).toBe(false);
    }
  });
  it("refuses any action outside the closed catalogue", () => {
    const result = defineEntitlement({ ...spec, actions: ["something.invented"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("UNKNOWN_ENTITLEMENT_ACTION");
  });
  it("has no catalogue entry that could advance a gate", () => {
    const transitions = new Set(SEQUENCING_TRANSITIONS);
    for (const action of ENTITLEMENT_ACTIONS) {
      expect(transitions.has(action)).toBe(false);
      for (const pattern of FORBIDDEN_ENTITLEMENT_PATTERNS) {
        expect(pattern.test(action), `catalogue entry ${action} matches ${String(pattern)}`).toBe(
          false
        );
      }
    }
  });
  it("still grants the ordinary work operations actually does", () => {
    const entitlement = expectOk(
      defineEntitlement({
        ...spec,
        actions: ["evidence.upload", "evidence.resolve_extraction_exception", "transaction.read"]
      })
    );
    expect(entitlement.actions).toHaveLength(3);
  });
});
