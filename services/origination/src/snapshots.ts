/**
 * Development applicant snapshots.
 *
 * Until the registry, screening, bureau and e-invoicing adapters are wired,
 * the snapshot port answers from a small set of counterparties whose facts
 * are chosen to exercise each outcome. The values are invented; none of them
 * describes a real business.
 *
 * Which counterparty gets which facts is decided by the last hex digit of the
 * identifier, so a partner can try all three outcomes without knowing a list:
 *   …ends in 'd' — registration not active   → DECLINE
 *   …ends in 'e' — screening inconclusive    → REFER
 *   anything else — a strong applicant       → APPROVE
 */

import type { ApplicantSnapshot } from '@sanad/core/decisioning/snapshot.ts';
import { ok } from '@sanad/core/kernel/result.ts';
import type { ApplicantSnapshotPort, SnapshotRequest } from '@sanad/core/ports/applicant-snapshot.ts';

export function developmentSnapshots(): ApplicantSnapshotPort {
  return {
    assemble(request: SnapshotRequest) {
      return Promise.resolve(ok(developmentSnapshot(request)));
    },
  };
}

export function developmentSnapshot(request: SnapshotRequest): ApplicantSnapshot {
  const last = request.counterpartyId.at(-1)?.toLowerCase();
  return {
    snapshotId: `snp-dev-${request.at.epochSeconds.toString()}`,
    tenantId: request.tenantId,
    counterpartyId: request.counterpartyId,
    programmeId: request.programmeId,
    currency: 'SAR',
    capturedAtEpochSeconds: request.at.epochSeconds,
    registration: {
      crNumber: '4030000003',
      status: last === 'd' ? 'EXPIRED' : 'ACTIVE',
      ageMonths: 60,
      legalForm: 'LLC',
      activityCodes: ['46900'],
      paidCapitalMinorUnits: 50_000_000n,
      retrievedSecondsAgo: 3600,
    },
    signatory: { authorityVerified: true, method: 'NATIONAL_IDENTITY_PROVIDER', assertionId: 'asr-dev', retrievedSecondsAgo: 600 },
    screening: {
      sanctions: last === 'e' ? 'POTENTIAL_MATCH' : 'CLEAR',
      politicallyExposed: 'CLEAR',
      adverseMedia: 'CLEAR',
      activityPermissibility: 'PERMITTED',
      retrievedSecondsAgo: 7200,
    },
    tradeHistory: {
      availability: 'AVAILABLE',
      monthsObserved: 48,
      clearedInvoiceCount: 420,
      totalClearedValueMinorUnits: 3_600_000_000n,
      distinctBuyerCount: 9,
      largestBuyerSharePerTenThousand: 4200,
      retrievedSecondsAgo: 1800,
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
    },
    openBanking: { availability: 'AVAILABLE', averageMonthlyInflowMinorUnits: 80_000_000n, lowestMonthEndBalanceMinorUnits: 9_000_000n, returnedPaymentsLast6Months: 0, retrievedSecondsAgo: 43_200 },
    workforce: { availability: 'AVAILABLE', employeeCount: 24, socialInsuranceRegistered: true, retrievedSecondsAgo: 86_400 },
    programme: { anchorRecourse: 'PARTIAL', programmeLimitMinorUnits: 10_000_000_000n, programmeUtilisedMinorUnits: 1_000_000_000n, sectorCode: 'BUILDING_MATERIALS', goodsCategoryCode: 'CEMENT' },
    exposure: { platformExposureMinorUnits: 0n, coreBankingExposureMinorUnits: 0n, groupExposureMinorUnits: 0n },
    consent: { eInvoicing: true, creditBureau: true, openBanking: true, workforce: true },
  };
}
