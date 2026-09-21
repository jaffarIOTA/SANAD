import { tsaInstant } from "../../core/time/tsa.js";
import { money } from "../../core/kernel/money.js";
import { expectOk } from "../../core/kernel/result.js";
import { priceMurabaha } from "../../core/pricing/murabaha.js";
import { loadStructureDefinition } from "../../config/loader.js";
function at(epochSeconds) {
  return tsaInstant({
    verified: true,
    genTimeEpochSeconds: BigInt(epochSeconds),
    tokenDigest: `d-${String(epochSeconds)}`,
    authorityId: "tsa-test"
  });
}
const INSTITUTION_CR = "7001000001";
const ANCHOR_CR = "1010000002";
const DISTRIBUTOR_CR = "4030000003";
const TENANT = "bank-a";
const PROGRAMME_ID = "prg-0001";
const COUNTERPARTY_ID = "cpt-0001";
const TRANSACTION_ID = "txn-0001";
function structureFor(tenant) {
  return expectOk(loadStructureDefinition(tenant, "MURABAHA_DISTRIBUTOR"));
}
function riskPeriodSecondsFor(tenant) {
  const definition = structureFor(tenant);
  const gate = definition.gates.find((g) => g.id === "GATE_3_RISK_PERIOD");
  if (gate === void 0 || gate.kind !== "ELAPSE") {
    throw new Error(`tenant ${tenant} declares no risk period gate`);
  }
  return gate.minimumSeconds;
}
function chain(specs, tenant = TENANT) {
  const legs = [];
  let previousHash;
  for (const spec of specs) {
    const contentHash = spec.contentHash ?? `hash-${spec.sequenceNo}`;
    legs.push({
      legId: `leg-${spec.sequenceNo}`,
      tenantId: tenant,
      transactionId: TRANSACTION_ID,
      legType: spec.legType,
      sequenceNo: spec.sequenceNo,
      documentId: spec.documentId ?? `doc-${spec.sequenceNo}`,
      contentHash,
      ...previousHash === void 0 ? {} : { prevLegHash: previousHash },
      executedAt: spec.executedAt,
      tsaTokenDigest: `d-${spec.sequenceNo}`,
      templateVersionId: "tpl-v3",
      counterpartyRole: spec.counterpartyRole,
      counterpartyCr: spec.counterpartyCr,
      immutable: true
    });
    previousHash = contentHash;
  }
  return legs;
}
function legsThroughPurchase(tenant = TENANT) {
  return chain(
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
}
function evidenceRecord(spec, tenant = TENANT) {
  return {
    evidenceId: spec.evidenceId ?? `evd-${spec.gate}-${String(spec.capturedAt.epochSeconds)}`,
    tenantId: tenant,
    transactionId: TRANSACTION_ID,
    evidenceType: spec.evidenceType,
    gateSatisfied: spec.gate,
    source: spec.source ?? "E_INVOICING_AUTHORITY",
    artefactUri: "s3://evidence/test",
    artefactHash: "artefact-hash",
    capturedAt: spec.capturedAt,
    validationStatus: spec.validationStatus ?? "VALID",
    ...spec.validationDetail === void 0 ? {} : { validationDetail: spec.validationDetail },
    ...spec.extractionConfidencePerTenThousand === void 0 ? {} : { extractionConfidencePerTenThousand: spec.extractionConfidencePerTenThousand },
    ...spec.supersededBy === void 0 ? {} : { supersededBy: spec.supersededBy }
  };
}
function ownershipEvidence(capturedAt, tenant = TENANT) {
  return evidenceRecord(
    {
      evidenceType: "OWNERSHIP_INVOICE",
      gate: "GATE_1_OWNERSHIP",
      source: "E_INVOICING_AUTHORITY",
      capturedAt,
      validationDetail: { recipientIsInstitution: true, clearanceStatus: "CLEARED" }
    },
    tenant
  );
}
function deliveryEvidence(capturedAt, tenant = TENANT) {
  return evidenceRecord(
    {
      evidenceType: "DELIVERY_NOTE",
      gate: "GATE_2_POSSESSION",
      source: "ANCHOR_SYSTEM",
      capturedAt,
      extractionConfidencePerTenThousand: 9800
    },
    tenant
  );
}
function constructivePossessionEvidence(capturedAt, tenant = TENANT) {
  return evidenceRecord(
    {
      evidenceType: "CONSTRUCTIVE_POSSESSION",
      gate: "GATE_2_POSSESSION",
      source: "ANCHOR_SYSTEM",
      capturedAt
    },
    tenant
  );
}
function transactionCore(tenant, overrides = {}) {
  const pricing = expectOk(priceMurabaha(money(18500000n), money(462500n)));
  const definition = structureFor(tenant);
  return {
    transactionId: TRANSACTION_ID,
    tenantId: tenant,
    programmeId: PROGRAMME_ID,
    counterpartyId: COUNTERPARTY_ID,
    structureCode: definition.structureCode,
    structureDefinitionId: definition.definitionId,
    structureVersion: definition.version,
    shariahApprovalId: definition.shariahApprovalRef,
    riskPeriodRequiredSeconds: riskPeriodSecondsFor(tenant),
    pricing,
    tenorDays: 90,
    maturityDateGregorian: "2027-01-04",
    maturityDateHijri: "1448-07-25",
    tradeReference: {
      type: "CLEARED_INVOICE",
      invoiceUuid: "3cf5d9a2-0000-4000-8000-000000000001",
      invoiceHash: "invoice-hash",
      issuerCr: ANCHOR_CR,
      recipientCr: INSTITUTION_CR
    },
    decisionId: "dec-0001",
    creditPolicyVersion: "1.0.0",
    correlationId: "cor-0001",
    ...overrides
  };
}
function strongApplicant(tenant, overrides = {}) {
  const { withAnchor: anchorOverrides, ...tradeOverrides } = overrides.tradeHistory ?? {};
  return {
    snapshotId: "snp-0001",
    tenantId: tenant,
    counterpartyId: COUNTERPARTY_ID,
    programmeId: PROGRAMME_ID,
    currency: "SAR",
    capturedAtEpochSeconds: 1791000000n,
    registration: {
      crNumber: DISTRIBUTOR_CR,
      status: "ACTIVE",
      ageMonths: 60,
      legalForm: "LLC",
      activityCodes: ["46900"],
      paidCapitalMinorUnits: 50000000n,
      retrievedSecondsAgo: 3600,
      ...overrides.registration
    },
    signatory: {
      authorityVerified: true,
      method: "NATIONAL_IDENTITY_PROVIDER",
      assertionId: "asr-0001",
      retrievedSecondsAgo: 600,
      ...overrides.signatory
    },
    screening: {
      sanctions: "CLEAR",
      politicallyExposed: "CLEAR",
      adverseMedia: "CLEAR",
      activityPermissibility: "PERMITTED",
      retrievedSecondsAgo: 7200,
      ...overrides.screening
    },
    tradeHistory: {
      availability: "AVAILABLE",
      monthsObserved: 48,
      clearedInvoiceCount: 420,
      totalClearedValueMinorUnits: 3600000000n,
      distinctBuyerCount: 9,
      largestBuyerSharePerTenThousand: 4200,
      retrievedSecondsAgo: 1800,
      ...tradeOverrides,
      withAnchor: {
        monthsTrading: 42,
        clearedInvoiceCount: 260,
        totalValueMinorUnits: 2400000000n,
        medianMonthlyValueMinorUnits: 60000000n,
        largestSingleInvoiceMinorUnits: 40000000n,
        medianDaysToPayment: 34,
        latePaymentPerTenThousand: 300,
        disputeCount: 0,
        creditNotePerTenThousand: 80,
        ...anchorOverrides
      }
    },
    bureau: {
      availability: "AVAILABLE",
      obligationsTotalMinorUnits: 120000000n,
      activeFacilityCount: 2,
      defaultsLast24Months: 0,
      worstArrearsDaysLast12Months: 0,
      enquiriesLast6Months: 1,
      judgmentCount: 0,
      retrievedSecondsAgo: 86400,
      ...overrides.bureau
    },
    openBanking: {
      availability: "AVAILABLE",
      averageMonthlyInflowMinorUnits: 80000000n,
      lowestMonthEndBalanceMinorUnits: 9000000n,
      returnedPaymentsLast6Months: 0,
      retrievedSecondsAgo: 43200,
      ...overrides.openBanking
    },
    workforce: {
      availability: "AVAILABLE",
      employeeCount: 24,
      socialInsuranceRegistered: true,
      retrievedSecondsAgo: 86400,
      ...overrides.workforce
    },
    programme: {
      anchorRecourse: "PARTIAL",
      programmeLimitMinorUnits: 10000000000n,
      programmeUtilisedMinorUnits: 1000000000n,
      sectorCode: "BUILDING_MATERIALS",
      goodsCategoryCode: "CEMENT",
      ...overrides.programme
    },
    exposure: {
      platformExposureMinorUnits: 0n,
      coreBankingExposureMinorUnits: 0n,
      groupExposureMinorUnits: 0n,
      ...overrides.exposure
    },
    consent: {
      eInvoicing: true,
      creditBureau: true,
      openBanking: true,
      workforce: true,
      ...overrides.consent
    }
  };
}
export {
  ANCHOR_CR,
  COUNTERPARTY_ID,
  DISTRIBUTOR_CR,
  INSTITUTION_CR,
  PROGRAMME_ID,
  TENANT,
  TRANSACTION_ID,
  at,
  chain,
  constructivePossessionEvidence,
  deliveryEvidence,
  evidenceRecord,
  legsThroughPurchase,
  ownershipEvidence,
  riskPeriodSecondsFor,
  strongApplicant,
  structureFor,
  transactionCore
};
