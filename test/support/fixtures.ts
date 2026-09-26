/**
 * Test fixtures.
 *
 * Builders, not mocks. Everything here constructs a real domain object through
 * the real constructors, so a test that passes is evidence about the system
 * rather than about the test double.
 *
 * Attested instants are built from a `VerifiedTimestamp` literal, which is what
 * the TSA adapter returns. A test can fabricate one; production code cannot,
 * because the only other way to obtain one is to verify a token. That is the
 * seam, and it is deliberate.
 */

import type { EvidenceRecord, EvidenceSource, EvidenceType, GateId } from '../../core/evidence/evidence.ts';
import type { ContractLeg, CounterpartyRole, LegType } from '../../products/murabaha-scf/legs/leg.ts';
import { type TsaInstant, tsaInstant } from '../../core/time/tsa.ts';
import { money } from '../../core/kernel/money.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { priceMurabaha } from '../../products/murabaha-scf/pricing/murabaha.ts';
import type { TransactionCore } from '../../products/murabaha-scf/sequencing/state.ts';
import type { ApplicantSnapshot } from '../../core/decisioning/snapshot.ts';
import type { StructureDefinition } from '../../products/murabaha-scf/structures/definition.ts';
import { type TenantCode, loadStructureDefinition } from '../../config/loader.ts';

/** An attested instant. Seconds since the epoch; the value itself is arbitrary. */
export function at(epochSeconds: number | bigint): TsaInstant {
  return tsaInstant({
    verified: true,
    genTimeEpochSeconds: BigInt(epochSeconds),
    tokenDigest: `d-${String(epochSeconds)}`,
    authorityId: 'tsa-test',
  });
}

export const INSTITUTION_CR = '7001000001';
export const ANCHOR_CR = '1010000002';
export const DISTRIBUTOR_CR = '4030000003';

export const TENANT = 'bank-a';
export const PROGRAMME_ID = 'prg-0001';
export const COUNTERPARTY_ID = 'cpt-0001';
export const TRANSACTION_ID = 'txn-0001';

export function structureFor(tenant: TenantCode): StructureDefinition {
  return expectOk(loadStructureDefinition(tenant, 'MURABAHA_DISTRIBUTOR'));
}

/** The Board-set interval this tenant's definition declares. */
export function riskPeriodSecondsFor(tenant: TenantCode): number {
  const definition = structureFor(tenant);
  const gate = definition.gates.find((g) => g.id === 'GATE_3_RISK_PERIOD');
  if (gate === undefined || gate.kind !== 'ELAPSE') {
    throw new Error(`tenant ${tenant} declares no risk period gate`);
  }
  return gate.minimumSeconds;
}

export interface LegSpec {
  readonly legType: LegType;
  readonly sequenceNo: number;
  readonly executedAt: TsaInstant;
  readonly counterpartyRole: CounterpartyRole;
  readonly counterpartyCr: string;
  readonly documentId?: string;
  readonly contentHash?: string;
}

/** Build a correctly chained run of legs. */
export function chain(specs: readonly LegSpec[], tenant: string = TENANT): ContractLeg[] {
  const legs: ContractLeg[] = [];
  let previousHash: string | undefined;

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
      ...(previousHash === undefined ? {} : { prevLegHash: previousHash }),
      executedAt: spec.executedAt,
      tsaTokenDigest: `d-${spec.sequenceNo}`,
      templateVersionId: 'tpl-v3',
      counterpartyRole: spec.counterpartyRole,
      counterpartyCr: spec.counterpartyCr,
      immutable: true,
    });
    previousHash = contentHash;
  }

  return legs;
}

/** The two legs that exist by the time gate 1 is in play. */
export function legsThroughPurchase(tenant: string = TENANT): ContractLeg[] {
  return chain(
    [
      {
        legType: 'WAAD',
        sequenceNo: 1,
        executedAt: at(1_000_000),
        counterpartyRole: 'BUYER',
        counterpartyCr: DISTRIBUTOR_CR,
      },
      {
        legType: 'PURCHASE',
        sequenceNo: 2,
        executedAt: at(1_000_100),
        counterpartyRole: 'SELLER',
        counterpartyCr: ANCHOR_CR,
      },
    ],
    tenant,
  );
}

export interface EvidenceSpec {
  readonly evidenceId?: string;
  readonly evidenceType: EvidenceType;
  readonly gate: GateId;
  readonly source?: EvidenceSource;
  readonly capturedAt: TsaInstant;
  readonly validationStatus?: EvidenceRecord['validationStatus'];
  readonly validationDetail?: EvidenceRecord['validationDetail'];
  readonly extractionConfidencePerTenThousand?: number;
  readonly supersededBy?: string;
}

export function evidenceRecord(spec: EvidenceSpec, tenant: string = TENANT): EvidenceRecord {
  return {
    evidenceId: spec.evidenceId ?? `evd-${spec.gate}-${String(spec.capturedAt.epochSeconds)}`,
    tenantId: tenant,
    transactionId: TRANSACTION_ID,
    evidenceType: spec.evidenceType,
    gateSatisfied: spec.gate,
    source: spec.source ?? 'E_INVOICING_AUTHORITY',
    artefactUri: 's3://evidence/test',
    artefactHash: 'artefact-hash',
    capturedAt: spec.capturedAt,
    validationStatus: spec.validationStatus ?? 'VALID',
    ...(spec.validationDetail === undefined ? {} : { validationDetail: spec.validationDetail }),
    ...(spec.extractionConfidencePerTenThousand === undefined
      ? {}
      : { extractionConfidencePerTenThousand: spec.extractionConfidencePerTenThousand }),
    ...(spec.supersededBy === undefined ? {} : { supersededBy: spec.supersededBy }),
  };
}

/** Ownership evidence that satisfies the validation both tenants declare. */
export function ownershipEvidence(capturedAt: TsaInstant, tenant: string = TENANT): EvidenceRecord {
  return evidenceRecord(
    {
      evidenceType: 'OWNERSHIP_INVOICE',
      gate: 'GATE_1_OWNERSHIP',
      source: 'E_INVOICING_AUTHORITY',
      capturedAt,
      validationDetail: { recipientIsInstitution: true, clearanceStatus: 'CLEARED' },
    },
    tenant,
  );
}

export function deliveryEvidence(capturedAt: TsaInstant, tenant: string = TENANT): EvidenceRecord {
  return evidenceRecord(
    {
      evidenceType: 'DELIVERY_NOTE',
      gate: 'GATE_2_POSSESSION',
      source: 'ANCHOR_SYSTEM',
      capturedAt,
      extractionConfidencePerTenThousand: 9800,
    },
    tenant,
  );
}

export function constructivePossessionEvidence(
  capturedAt: TsaInstant,
  tenant: string = TENANT,
): EvidenceRecord {
  return evidenceRecord(
    {
      evidenceType: 'CONSTRUCTIVE_POSSESSION',
      gate: 'GATE_2_POSSESSION',
      source: 'ANCHOR_SYSTEM',
      capturedAt,
    },
    tenant,
  );
}

export function transactionCore(
  tenant: TenantCode,
  overrides: Partial<TransactionCore> = {},
): TransactionCore {
  const pricing = expectOk(priceMurabaha(money(18_500_000n), money(462_500n)));
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
    maturityDateGregorian: '2027-01-04',
    maturityDateHijri: '1448-07-25',
    tradeReference: {
      type: 'CLEARED_INVOICE',
      invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000001',
      invoiceHash: 'invoice-hash',
      issuerCr: ANCHOR_CR,
      recipientCr: INSTITUTION_CR,
    },
    decisionId: 'dec-0001',
    creditPolicyVersion: '1.0.0',
    correlationId: 'cor-0001',
    ...overrides,
  };
}

// -- Decisioning ---------------------------------------------------------------

export interface SnapshotOverrides {
  readonly registration?: Partial<ApplicantSnapshot['registration']>;
  readonly signatory?: Partial<ApplicantSnapshot['signatory']>;
  readonly screening?: Partial<ApplicantSnapshot['screening']>;
  readonly tradeHistory?: Partial<Omit<ApplicantSnapshot['tradeHistory'], 'withAnchor'>> & {
    readonly withAnchor?: Partial<ApplicantSnapshot['tradeHistory']['withAnchor']>;
  };
  readonly bureau?: Partial<ApplicantSnapshot['bureau']>;
  readonly openBanking?: Partial<ApplicantSnapshot['openBanking']>;
  readonly workforce?: Partial<ApplicantSnapshot['workforce']>;
  readonly programme?: Partial<ApplicantSnapshot['programme']>;
  readonly exposure?: Partial<ApplicantSnapshot['exposure']>;
  readonly consent?: Partial<ApplicantSnapshot['consent']>;
}

/**
 * A strong applicant: long anchor tenure, good volume, clean conduct. Both
 * tenants' policies approve it, which makes it a useful baseline to degrade.
 */
export function strongApplicant(
  tenant: TenantCode,
  overrides: SnapshotOverrides = {},
): ApplicantSnapshot {
  const { withAnchor: anchorOverrides, ...tradeOverrides } = overrides.tradeHistory ?? {};

  return {
    snapshotId: 'snp-0001',
    tenantId: tenant,
    counterpartyId: COUNTERPARTY_ID,
    programmeId: PROGRAMME_ID,
    currency: 'SAR',
    capturedAtEpochSeconds: 1_791_000_000n,

    registration: {
      crNumber: DISTRIBUTOR_CR,
      status: 'ACTIVE',
      ageMonths: 60,
      legalForm: 'LLC',
      activityCodes: ['46900'],
      paidCapitalMinorUnits: 50_000_000n,
      retrievedSecondsAgo: 3600,
      ...overrides.registration,
    },
    signatory: {
      authorityVerified: true,
      method: 'NATIONAL_IDENTITY_PROVIDER',
      assertionId: 'asr-0001',
      retrievedSecondsAgo: 600,
      ...overrides.signatory,
    },
    screening: {
      sanctions: 'CLEAR',
      politicallyExposed: 'CLEAR',
      adverseMedia: 'CLEAR',
      activityPermissibility: 'PERMITTED',
      retrievedSecondsAgo: 7200,
      ...overrides.screening,
    },
    tradeHistory: {
      availability: 'AVAILABLE',
      monthsObserved: 48,
      clearedInvoiceCount: 420,
      totalClearedValueMinorUnits: 3_600_000_000n,
      distinctBuyerCount: 9,
      largestBuyerSharePerTenThousand: 4200,
      retrievedSecondsAgo: 1800,
      ...tradeOverrides,
      withAnchor: {
        monthsTrading: 42,
        clearedInvoiceCount: 260,
        totalValueMinorUnits: 2_400_000_000n,
        medianMonthlyValueMinorUnits: 60_000_000n,
        largestSingleInvoiceMinorUnits: 40_000_000n,
        medianDaysToPayment: 34,
        latePaymentPerTenThousand: 300,
        disputeCount: 0,
        creditNotePerTenThousand: 80,
        ...anchorOverrides,
      },
    },
    bureau: {
      availability: 'AVAILABLE',
      obligationsTotalMinorUnits: 120_000_000n,
      activeFacilityCount: 2,
      defaultsLast24Months: 0,
      worstArrearsDaysLast12Months: 0,
      enquiriesLast6Months: 1,
      judgmentCount: 0,
      retrievedSecondsAgo: 86_400,
      ...overrides.bureau,
    },
    openBanking: {
      availability: 'AVAILABLE',
      averageMonthlyInflowMinorUnits: 80_000_000n,
      lowestMonthEndBalanceMinorUnits: 9_000_000n,
      returnedPaymentsLast6Months: 0,
      retrievedSecondsAgo: 43_200,
      ...overrides.openBanking,
    },
    workforce: {
      availability: 'AVAILABLE',
      employeeCount: 24,
      socialInsuranceRegistered: true,
      retrievedSecondsAgo: 86_400,
      ...overrides.workforce,
    },
    programme: {
      anchorRecourse: 'PARTIAL',
      programmeLimitMinorUnits: 10_000_000_000n,
      programmeUtilisedMinorUnits: 1_000_000_000n,
      sectorCode: 'BUILDING_MATERIALS',
      goodsCategoryCode: 'CEMENT',
      ...overrides.programme,
    },
    exposure: {
      platformExposureMinorUnits: 0n,
      coreBankingExposureMinorUnits: 0n,
      groupExposureMinorUnits: 0n,
      ...overrides.exposure,
    },
    consent: {
      eInvoicing: true,
      creditBureau: true,
      openBanking: true,
      workforce: true,
      ...overrides.consent,
    },
  };
}
