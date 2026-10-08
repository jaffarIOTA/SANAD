/**
 * AECB — Al Etihad Credit Bureau, credit bureau adapter (ADR 0005).
 *
 * Implements the CreditBureauPort. Commercial reports are keyed by trade
 * licence, individual reports by an applicant reference the adapter resolves
 * to the Emirates ID inside its own boundary. Consent-gated: no consent id,
 * no call. Amounts are AED and become minor units without a float.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. The module stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { BureauOutcome, BureauRequest, BureauSummary, CreditBureauPort, FacilityReport } from '../../../core/ports/credit-bureau.ts';
import { type Result, ok } from '../../../core/kernel/result.ts';
import type { TsaInstant } from '../../../core/time/tsa.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { type Body, RailAdapter, type RailAdapterConfig, int, str } from '../../kernel/rail-adapter.ts';
import { aed, requireAed } from '../kernel/dirham.ts';

export const AECB_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'AECB-DEV-001',
    summary: 'The bureau keys a commercial report on the trade licence number (and issuing authority); the port field is named commercialRegistration.',
    containment: 'The trade licence number travels in BureauRequest.commercialRegistration and is renamed only inside this adapter. The port is not renamed; the naming debt is recorded against ADR 0005.',
    verificationRef: 'UAE-RAIL-AECB-01',
  },
  {
    id: 'AECB-DEV-002',
    summary: 'The port has no subject type; the bureau sells commercial and individual reports.',
    containment: 'request() is the commercial report the SME journey needs; requestIndividual() is an adapter method for owner and guarantor reports, keyed by applicant reference. The Emirates ID never crosses the port.',
    verificationRef: 'UAE-RAIL-AECB-01',
  },
  {
    id: 'AECB-DEV-003',
    summary: 'Amounts arrive as AED decimals and the score as the bureau’s own integer.',
    containment: 'Decimals become AED minor units by digit manipulation; an answer in another currency is malformed. The score is an opaque figure, compared but never used arithmetically.',
    verificationRef: 'UAE-RAIL-AECB-01',
  },
];

const UNAVAILABLE = (reason: string): BureauOutcome => ({ kind: 'UNAVAILABLE', reason });

/** Recorded defaults in AED. One unreadable default is not dropped silently: the whole list is refused (`undefined`). */
function mapDefaults(list: unknown, currency: unknown): BureauSummary['defaults'] | undefined {
  if (!Array.isArray(list)) return [];
  const out: BureauSummary['defaults'][number][] = [];
  for (const d of list as unknown[]) {
    const rec = (typeof d === 'object' && d !== null ? d : {}) as Record<string, unknown>;
    const amount = aed(rec['amount'], currency);
    if (amount === undefined) return undefined;
    out.push({ amount, settled: rec['settled'] === true });
  }
  return out;
}

export class AecbAdapter extends RailAdapter implements CreditBureauPort {
  readonly vendorName = 'AECB';
  readonly capabilities = ['CREDIT_BUREAU'] as const;
  readonly deviations = AECB_DEVIATIONS;

  readonly #attest: () => Promise<TsaInstant>;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport, attest: () => Promise<TsaInstant>) {
    super(config, credentials, transport);
    this.#attest = attest;
  }

  /** The commercial report. `commercialRegistration` carries the trade licence number (AECB-DEV-001). */
  async request(req: BureauRequest): Promise<Result<BureauOutcome>> {
    const consent = this.requireConsent(req.consentId); if (!consent.ok) return consent;
    return this.#enquire('bureau.commercial', '/v1/reports/commercial', { tradeLicenceNumber: req.commercialRegistration, consentRef: req.consentId, purpose: 'NEW_CREDIT_APPLICATION' }, req.correlationId);
  }

  /** An owner's or guarantor's individual report (AECB-DEV-002). The adapter resolves the reference; no identifier is passed in. */
  async requestIndividual(req: { readonly tenantId: string; readonly applicantRef: string; readonly consentId: string; readonly correlationId: string }): Promise<Result<BureauOutcome>> {
    const consent = this.requireConsent(req.consentId); if (!consent.ok) return consent;
    return this.#enquire('bureau.individual', '/v1/reports/individual', { applicantRef: req.applicantRef, consentRef: req.consentId, purpose: 'NEW_CREDIT_APPLICATION' }, req.correlationId);
  }

  async report(rep: FacilityReport): ReturnType<CreditBureauPort['report']> {
    const currency = requireAed(rep.amount); if (!currency.ok) return currency;
    const r = await this.invoke('bureau.report', { method: 'POST', path: '/v1/facilities/events', body: { facilityRef: rep.facilityRef, event: rep.event, amount: rep.amount.minorUnits.toString(), currency: rep.amount.currency, asOf: rep.asOfEpochSeconds.toString(), idempotencyKey: rep.idempotencyKey } }, rep.correlationId);
    if (r.kind !== 'ANSWERED') return ok({ kind: 'UNAVAILABLE' as const, reason: r.kind === 'REFUSED' ? `refused: ${r.code}` : r.reason });
    const ack = str(r.value['submissionId']);
    return ok(ack === undefined ? { kind: 'UNAVAILABLE' as const, reason: 'response malformed' } : { kind: 'ACKNOWLEDGED' as const, acknowledgementRef: ack });
  }

  async #enquire(operation: string, path: string, body: Body, correlationId: string): Promise<Result<BureauOutcome>> {
    const r = await this.invoke(operation, { method: 'POST', path, body }, correlationId);
    if (r.kind === 'UNAVAILABLE') return ok({ kind: 'UNAVAILABLE', reason: r.reason, ...(r.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: r.retryAfterSeconds }) });
    // A refusal is not a clean file: it routes to the bureau-unavailable exception, never to a decline or a pass.
    if (r.kind === 'REFUSED') return ok(UNAVAILABLE(`refused: ${r.code}`));
    const v = r.value;
    const reference = str(v['reportId']);
    if (reference === undefined) return ok(UNAVAILABLE('response malformed'));
    if (v['subjectFound'] === false) return ok({ kind: 'NO_RECORD', bureauReference: reference });
    const currency = v['currency'];
    const totalExposure = aed(v['totalOutstanding'], currency); const overdue = aed(v['totalOverdue'], currency);
    const worst = int(v['maxDaysPastDue']); const active = int(v['activeContracts']);
    if (totalExposure === undefined || overdue === undefined || worst === undefined || active === undefined) return ok(UNAVAILABLE('response malformed'));
    const defaults = mapDefaults(v['defaults'], currency);
    if (defaults === undefined) return ok(UNAVAILABLE('response malformed'));
    const score = int(v['score']);
    return ok({ kind: 'REPORT', summary: { bureauReference: reference, retrievedAt: await this.#attest(), totalExposure, overdueAmount: overdue, worstDelinquencyDays: worst, activeFacilities: active, ...(score === undefined ? {} : { bureauScore: score }), defaults } });
  }
}
