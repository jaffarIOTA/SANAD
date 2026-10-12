/**
 * Bayan — credit bureau adapter (CLAUDE.md §5).
 *
 * Implements the CreditBureauPort as the tenant's alternative (or primary) licensed bureau.
 * Vendor vocabulary stops here: the port sees capability-named outcomes and references,
 * never this rail's field names.
 *
 * Assumed contract (no published schema — see README.md): a commercial credit
 * report enquiry answered in the common credit-bureau layout of
 * `adapters/ksa/kernel/bureau-report.ts`. The score is an opaque integer; its
 * range is not public and none is assumed.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { Result } from '../../../core/kernel/result.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, minorToDecimal } from '../kernel/rail-adapter.ts';
import { acknowledgementOf, mapBureauReport } from '../kernel/bureau-report.ts';
import type {
  BureauOutcome,
  BureauRequest,
  CreditBureauPort,
  FacilityReport,
} from '../../../core/ports/credit-bureau.ts';
import type { TsaInstant } from '../../../core/time/tsa.ts';

export const BAYANADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'BAYAN-DEV-001',
    summary: 'Amounts arrive as decimal strings and the score as an opaque integer whose range is not public.',
    containment:
      'Decimals are converted to minor units by digit manipulation, never through a float; the score is carried as an opaque figure the decisioning DSL may compare but never do arithmetic on, and no range is assumed.',
    verificationRef: 'KSA-RAIL-BAYAN-01',
  },
  {
    id: 'BAYAN-DEV-002',
    summary: 'The report layout and the reporting format are not public.',
    containment:
      'The common credit-bureau layout is assumed; a facility, default or score block that does not read exactly makes the report UNAVAILABLE.',
    verificationRef: 'KSA-RAIL-BAYAN-01',
  },
];

export const BAYAN_COMMERCIAL_PRODUCT = 'COMMERCIAL_CREDIT_REPORT';

export class BayanAdapter extends RailAdapter implements CreditBureauPort {
  readonly vendorName = 'Bayan';
  readonly capabilities = ['CREDIT_BUREAU'] as const;
  readonly deviations = BAYANADAPTER_DEVIATIONS;

  readonly #attest: () => Promise<TsaInstant>;

  constructor(
    config: RailAdapterConfig,
    credentials: CredentialProvider,
    transport: RailTransport,
    attest: () => Promise<TsaInstant>,
  ) {
    super(config, credentials, transport);
    this.#attest = attest;
  }

  async request(req: BureauRequest): Promise<Result<BureauOutcome>> {
    const consent = await this.requireConsent(req.tenantId, req.consentId, 'CREDIT_BUREAU');
    if (!consent.ok) return consent;
    const r = await this.invoke(
      'bureau.enquiry',
      {
        method: 'POST',
        path: '/v1/credit-reports',
        body: {
          product: BAYAN_COMMERCIAL_PRODUCT,
          enquiryPurpose: 'NEW_CREDIT_APPLICATION',
          subject: { crNumber: req.commercialRegistration, memberReference: req.counterpartyId },
          consentReference: req.consentId,
        },
      },
      req.correlationId,
    );
    if (r.kind === 'UNAVAILABLE')
      return ok({
        kind: 'UNAVAILABLE',
        reason: r.reason,
        ...(r.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: r.retryAfterSeconds }),
      });
    if (r.kind === 'REFUSED') return ok({ kind: 'UNAVAILABLE', reason: `refused: ${r.code}` });
    return ok(await mapBureauReport(r.value, this.#attest));
  }

  async report(rep: FacilityReport) {
    const r = await this.invoke(
      'bureau.report',
      {
        method: 'POST',
        path: '/v1/facility-events',
        body: {
          facilityRef: rep.facilityRef,
          memberReference: rep.counterpartyId,
          eventType: rep.event,
          amount: minorToDecimal(rep.amount.minorUnits),
          currency: rep.amount.currency,
          asOf: rep.asOfEpochSeconds.toString(),
          idempotencyKey: rep.idempotencyKey,
        },
      },
      rep.correlationId,
    );
    if (r.kind !== 'ANSWERED')
      return ok({ kind: 'UNAVAILABLE' as const, reason: r.kind === 'REFUSED' ? `refused: ${r.code}` : r.reason });
    const ack = acknowledgementOf(r.value);
    return ok(
      ack === undefined
        ? { kind: 'UNAVAILABLE' as const, reason: 'response malformed' }
        : { kind: 'ACKNOWLEDGED' as const, acknowledgementRef: ack },
    );
  }
}
