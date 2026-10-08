/**
 * Assembling an applicant snapshot from the rails.
 *
 * The decision engine reads a snapshot and nothing else; this is the one
 * place the rails are consulted to build it. Each source answers, is
 * unavailable, or was never asked because there is no consent — and each of
 * those is a fact recorded in the snapshot, not an exception. The engine
 * then decides what a gap means (it refers; it never approves on one).
 *
 * Nothing personal lands in the snapshot: the registry's signatory
 * references, the bureau's reference, the screening reference. The decision
 * record can be retained and replayed without retaining a person.
 */

import { type ConsentRecord, validConsent } from '../consent/consent.ts';
import type { Money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { AccountInformationPort } from '../ports/account-information.ts';
import type { BusinessRegistryPort } from '../ports/business-registry.ts';
import type { CounterpartyMasterPort } from '../ports/counterparty-master.ts';
import type { CreditBureauPort } from '../ports/credit-bureau.ts';
import type { EInvoicingProvider } from '../ports/e-invoicing.ts';
import type { EmploymentVerificationPort } from '../ports/employment-verification.ts';
import type { ScreeningPort } from '../ports/screening.ts';
import type { TsaInstant } from '../time/tsa.ts';
import type {
  ApplicantSnapshot,
  Availability,
  BureauFacts,
  OpenBankingFacts,
  ProgrammeFacts,
  ScreeningFacts,
  TradeHistoryFacts,
  WorkforceFacts,
} from './snapshot.ts';

/** What the tenant's own configuration and books contribute. Ports too, but the platform's own. */
export interface ProgrammeSource {
  facts(tenantId: string, programmeId: string): Promise<Result<ProgrammeFacts & { readonly anchorCr: string }>>;
}
export interface ExposureSource {
  exposure(
    tenantId: string,
    counterpartyId: string,
  ): Promise<Result<{ readonly platform: Money; readonly coreBanking: Money; readonly group: Money }>>;
}
export interface ConsentSource {
  records(tenantId: string, counterpartyId: string): Promise<readonly ConsentRecord[]>;
}
/** The board's permissibility register, applied to activity codes. Configuration, not a rail. */
export interface PermissibilitySource {
  assess(tenantId: string, activityCodes: readonly string[]): 'PERMITTED' | 'EXCLUDED' | 'REVIEW';
}

export interface SnapshotSources {
  readonly master: CounterpartyMasterPort;
  readonly registry: BusinessRegistryPort;
  readonly screening: ScreeningPort;
  readonly bureau: CreditBureauPort;
  readonly eInvoicing: EInvoicingProvider;
  readonly employment?: EmploymentVerificationPort;
  readonly accounts?: AccountInformationPort;
  readonly programmes: ProgrammeSource;
  readonly exposure: ExposureSource;
  readonly consents: ConsentSource;
  readonly permissibility: PermissibilitySource;
}

export interface AssembleRequest {
  readonly tenantId: string;
  readonly counterpartyId: string;
  readonly programmeId: string;
  readonly snapshotId: string;
  readonly at: TsaInstant;
  readonly correlationId: string;
  /** Months of trade history to ask for. */
  readonly historyMonths?: number;
}

const age = (retrievedEpochSeconds: bigint, at: TsaInstant): number =>
  Number(at.epochSeconds - retrievedEpochSeconds < 0n ? 0n : at.epochSeconds - retrievedEpochSeconds);

const unavailableTrade = (retrievedSecondsAgo: number): TradeHistoryFacts => ({
  availability: 'UNAVAILABLE',
  monthsObserved: 0,
  clearedInvoiceCount: 0,
  totalClearedValueMinorUnits: 0n,
  distinctBuyerCount: 0,
  largestBuyerSharePerTenThousand: 0,
  retrievedSecondsAgo,
  withAnchor: {
    monthsTrading: 0,
    clearedInvoiceCount: 0,
    totalValueMinorUnits: 0n,
    medianMonthlyValueMinorUnits: 0n,
    largestSingleInvoiceMinorUnits: 0n,
    medianDaysToPayment: 0,
    latePaymentPerTenThousand: 0,
    disputeCount: 0,
    creditNotePerTenThousand: 0,
  },
});
const bureauWith = (availability: Availability, retrievedSecondsAgo: number): BureauFacts => ({
  availability,
  obligationsTotalMinorUnits: 0n,
  activeFacilityCount: 0,
  defaultsLast24Months: 0,
  worstArrearsDaysLast12Months: 0,
  enquiriesLast6Months: 0,
  judgmentCount: 0,
  retrievedSecondsAgo,
});
const openBankingWith = (availability: Availability): OpenBankingFacts => ({
  availability,
  averageMonthlyInflowMinorUnits: 0n,
  lowestMonthEndBalanceMinorUnits: 0n,
  returnedPaymentsLast6Months: 0,
  retrievedSecondsAgo: 0,
});
const workforceWith = (availability: Availability): WorkforceFacts => ({
  availability,
  employeeCount: 0,
  socialInsuranceRegistered: false,
  retrievedSecondsAgo: 0,
});

export async function assembleSnapshot(
  sources: SnapshotSources,
  request: AssembleRequest,
): Promise<Result<ApplicantSnapshot>> {
  const { tenantId, counterpartyId, programmeId, at, correlationId } = request;

  const profile = await sources.master.get(tenantId, counterpartyId);
  if (!profile.ok) return profile;
  const programme = await sources.programmes.facts(tenantId, programmeId);
  if (!programme.ok) return programme;
  const consents = await sources.consents.records(tenantId, counterpartyId);
  const has = (type: ConsentRecord['type']): boolean => validConsent(consents, counterpartyId, type, at) !== undefined;
  const consentIdFor = (type: ConsentRecord['type']): string =>
    validConsent(consents, counterpartyId, type, at)?.consentId ?? '';

  // Registration — the state's register, never our copy of it.
  const reg = await sources.registry.lookup({
    tenantId,
    commercialRegistration: profile.value.commercialRegistration,
    correlationId,
  });
  if (!reg.ok) return reg;
  const registration =
    reg.value.kind === 'ANSWERED'
      ? {
          crNumber: reg.value.value.commercialRegistration,
          status: reg.value.value.status as ApplicantSnapshot['registration']['status'],
          ageMonths: monthsSince(reg.value.value.registeredAtGregorian, at),
          legalForm: reg.value.value.legalForm,
          activityCodes: reg.value.value.activityCodes,
          paidCapitalMinorUnits: reg.value.value.paidCapitalMinorUnits ?? 0n,
          retrievedSecondsAgo: age(reg.value.value.retrievedAtEpochSeconds, at),
        }
      : {
          crNumber: profile.value.commercialRegistration,
          status: 'UNKNOWN' as const,
          ageMonths: 0,
          legalForm: profile.value.legalForm,
          activityCodes: [],
          paidCapitalMinorUnits: 0n,
          retrievedSecondsAgo: 0,
        };

  // Screening — consent-gated; not consented is a fact, not a call.
  let screening: ScreeningFacts;
  if (!has('SCREENING')) {
    screening = {
      sanctions: 'UNAVAILABLE',
      politicallyExposed: 'UNAVAILABLE',
      adverseMedia: 'UNAVAILABLE',
      activityPermissibility: sources.permissibility.assess(tenantId, registration.activityCodes),
      retrievedSecondsAgo: 0,
    };
  } else {
    const screened = await sources.screening.screen({
      tenantId,
      counterpartyId,
      commercialRegistration: profile.value.commercialRegistration,
      signatoryRefs: profile.value.signatoryRefs,
      checks: ['SANCTIONS', 'PEP', 'ADVERSE_MEDIA'],
      consentId: consentIdFor('SCREENING'),
      correlationId,
    });
    if (!screened.ok) return screened;
    const outcome = (check: 'SANCTIONS' | 'PEP' | 'ADVERSE_MEDIA'): ScreeningFacts['sanctions'] => {
      if ('kind' in screened.value) return 'UNAVAILABLE';
      const o = screened.value.perCheck.find((c) => c.check === check)?.outcome ?? screened.value.overall;
      return o === 'CLEAR' ? 'CLEAR' : o === 'REJECT' ? 'HIT' : 'POTENTIAL_MATCH';
    };
    screening = {
      sanctions: outcome('SANCTIONS'),
      politicallyExposed: outcome('PEP'),
      adverseMedia: outcome('ADVERSE_MEDIA'),
      activityPermissibility: sources.permissibility.assess(tenantId, registration.activityCodes),
      retrievedSecondsAgo: 'kind' in screened.value ? 0 : age(screened.value.screenedAt.epochSeconds, at),
    };
  }

  // Bureau — consent-gated.
  let bureau: BureauFacts;
  if (!has('CREDIT_BUREAU')) bureau = bureauWith('NOT_CONSENTED', 0);
  else {
    const pulled = await sources.bureau.request({
      tenantId,
      counterpartyId,
      commercialRegistration: profile.value.commercialRegistration,
      consentId: consentIdFor('CREDIT_BUREAU'),
      correlationId,
    });
    if (!pulled.ok) return pulled;
    const o = pulled.value;
    bureau =
      o.kind === 'REPORT'
        ? {
            availability: 'AVAILABLE',
            obligationsTotalMinorUnits: o.summary.totalExposure.minorUnits,
            activeFacilityCount: o.summary.activeFacilities,
            defaultsLast24Months: o.summary.defaults.filter((d) => !d.settled).length,
            worstArrearsDaysLast12Months: o.summary.worstDelinquencyDays,
            enquiriesLast6Months: 0,
            judgmentCount: 0,
            retrievedSecondsAgo: age(o.summary.retrievedAt.epochSeconds, at),
          }
        : o.kind === 'NO_RECORD'
          ? bureauWith('AVAILABLE', 0)
          : bureauWith('UNAVAILABLE', 0);
  }

  // Trade history — the e-invoicing authority; anchor trade is the strongest signal.
  const months = request.historyMonths ?? 12;
  const history = await sources.eInvoicing.fetchTradeHistory(
    tenantId,
    profile.value.commercialRegistration,
    { fromDateGregorian: isoDaysBefore(at, months * 30), toDateGregorian: isoDaysBefore(at, 0) },
    correlationId,
  );
  let tradeHistory: TradeHistoryFacts;
  if (!history.ok) tradeHistory = unavailableTrade(0);
  else {
    const h = history.value;
    const anchor = h.perBuyer.find((b) => b.buyerCr === programme.value.anchorCr);
    const largest = h.perBuyer.reduce((m, b) => (b.totalValue.minorUnits > m ? b.totalValue.minorUnits : m), 0n);
    tradeHistory = {
      availability: 'AVAILABLE',
      monthsObserved: months,
      clearedInvoiceCount: h.clearedInvoiceCount,
      totalClearedValueMinorUnits: h.totalClearedValue.minorUnits,
      distinctBuyerCount: h.distinctBuyerCount,
      largestBuyerSharePerTenThousand:
        h.totalClearedValue.minorUnits === 0n ? 0 : Number((largest * 10_000n) / h.totalClearedValue.minorUnits),
      retrievedSecondsAgo: 0,
      withAnchor:
        anchor === undefined
          ? unavailableTrade(0).withAnchor
          : {
              monthsTrading: months,
              clearedInvoiceCount: anchor.invoiceCount,
              totalValueMinorUnits: anchor.totalValue.minorUnits,
              medianMonthlyValueMinorUnits: anchor.totalValue.minorUnits / BigInt(Math.max(1, months)),
              largestSingleInvoiceMinorUnits: anchor.totalValue.minorUnits / BigInt(Math.max(1, anchor.invoiceCount)),
              medianDaysToPayment: anchor.medianDaysToPayment,
              latePaymentPerTenThousand: 0,
              disputeCount: 0,
              creditNotePerTenThousand:
                anchor.invoiceCount === 0 ? 0 : Math.round((anchor.creditNoteCount * 10_000) / anchor.invoiceCount),
            },
    };
  }

  // Optional consumer rails: asked only where a port is wired and consent (DATA_SHARING) exists.
  let openBanking = openBankingWith(
    sources.accounts === undefined ? 'UNAVAILABLE' : has('DATA_SHARING_WITH_PARTNER') ? 'UNAVAILABLE' : 'NOT_CONSENTED',
  );
  if (sources.accounts !== undefined && has('DATA_SHARING_WITH_PARTNER')) {
    const a = await sources.accounts.affordabilityFacts({
      tenantId,
      applicantRef: counterpartyId,
      consentId: consentIdFor('DATA_SHARING_WITH_PARTNER'),
      months: 6,
      correlationId,
    });
    if (a.ok && a.value.kind === 'ANSWERED')
      openBanking = {
        availability: 'AVAILABLE',
        averageMonthlyInflowMinorUnits: a.value.value.averageMonthlyInflow.minorUnits,
        lowestMonthEndBalanceMinorUnits: a.value.value.lowestMonthEndBalance.minorUnits,
        returnedPaymentsLast6Months: a.value.value.returnedPaymentsLast6Months,
        retrievedSecondsAgo: age(a.value.value.retrievedAtEpochSeconds, at),
      };
  }
  let workforce = workforceWith(
    sources.employment === undefined
      ? 'UNAVAILABLE'
      : has('DATA_SHARING_WITH_PARTNER')
        ? 'UNAVAILABLE'
        : 'NOT_CONSENTED',
  );
  if (sources.employment !== undefined && has('DATA_SHARING_WITH_PARTNER')) {
    const e = await sources.employment.employment({
      tenantId,
      applicantRef: counterpartyId,
      consentId: consentIdFor('DATA_SHARING_WITH_PARTNER'),
      correlationId,
    });
    if (e.ok && e.value.kind === 'ANSWERED')
      workforce = {
        availability: 'AVAILABLE',
        employeeCount: e.value.value.employed ? 1 : 0,
        socialInsuranceRegistered: e.value.value.employed,
        retrievedSecondsAgo: age(e.value.value.retrievedAtEpochSeconds, at),
      };
  }

  const exposure = await sources.exposure.exposure(tenantId, counterpartyId);
  if (!exposure.ok) return exposure;
  const { anchorCr: _anchor, ...programmeFacts } = programme.value;

  return ok({
    snapshotId: request.snapshotId,
    tenantId,
    counterpartyId,
    programmeId,
    currency: 'SAR',
    capturedAtEpochSeconds: at.epochSeconds,
    registration,
    signatory: {
      authorityVerified: profile.value.kycStatus === 'VERIFIED',
      method: 'NATIONAL_IDENTITY_PROVIDER',
      assertionId: profile.value.signatoryRefs[0] ?? '',
      retrievedSecondsAgo: 0,
    },
    screening,
    tradeHistory,
    bureau,
    openBanking,
    workforce,
    programme: programmeFacts,
    exposure: {
      platformExposureMinorUnits: exposure.value.platform.minorUnits,
      coreBankingExposureMinorUnits: exposure.value.coreBanking.minorUnits,
      groupExposureMinorUnits: exposure.value.group.minorUnits,
    },
    consent: {
      eInvoicing: true,
      creditBureau: has('CREDIT_BUREAU'),
      openBanking: has('DATA_SHARING_WITH_PARTNER'),
      workforce: has('DATA_SHARING_WITH_PARTNER'),
    },
  });
}

function monthsSince(isoDate: string | undefined, at: TsaInstant): number {
  if (isoDate === undefined) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (m === null) return 0;
  const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  return Math.max(0, Math.floor((Number(at.epochSeconds) - then) / (30 * 86_400)));
}

/** Calendar date of an attested instant less some days — integer arithmetic, no Date object in the engine. */
function isoDaysBefore(at: TsaInstant, days: number): string {
  const z = Math.floor(Number(at.epochSeconds) / 86_400) - days + 719_468;
  const era = Math.floor((z >= 0 ? z : z - 146_096) / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function unavailable(reason: string): Result<never> {
  return reject('OP-DETERMINACY', 'SNAPSHOT_SOURCE_UNAVAILABLE', reason);
}
