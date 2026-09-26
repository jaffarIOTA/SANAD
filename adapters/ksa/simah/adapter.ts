/**
 * SIMAH — credit bureau adapter (CLAUDE.md §5).
 *
 * Implements the CreditBureauPort port. Vendor vocabulary stops here: the port sees
 * capability-named outcomes and references, never this rail's field names.
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { Result } from '../../../core/kernel/result.ts';
import { ok } from '../../../core/kernel/result.ts';
import { money } from '../../../core/kernel/money.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { RailAdapter, type RailAdapterConfig, bool, decimalToMinor, epoch, int, malformed, str } from '../kernel/rail-adapter.ts';
import type { BureauOutcome, BureauRequest, CreditBureauPort, FacilityReport } from '../../../core/ports/credit-bureau.ts';
import type { TsaInstant } from '../../../core/time/tsa.ts';

export const SIMAHADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'SIMAH-DEV-001',
    summary: 'Amounts arrive as decimal strings and the score as an opaque integer.',
    containment: 'Decimals are converted to minor units by digit manipulation, never through a float; the score is carried as an opaque figure the decisioning DSL may compare but never do arithmetic on.',
    verificationRef: 'KSA-RAIL-SIMAH-01',
  },
];

export class SimahAdapter extends RailAdapter implements CreditBureauPort {
  readonly vendorName = 'SIMAH';
  readonly capabilities = ['CREDIT_BUREAU'] as const;
  readonly deviations = SIMAHADAPTER_DEVIATIONS;

  readonly #attest: () => Promise<TsaInstant>;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport, attest: () => Promise<TsaInstant>) {
    super(config, credentials, transport);
    this.#attest = attest;
  }

  async request(req: BureauRequest): Promise<Result<BureauOutcome>> {
    const consent = this.requireConsent(req.consentId); if (!consent.ok) return consent;
    const r = await this.invoke('bureau.enquiry', { method: 'POST', path: '/v1/enquiries', body: { subjectCr: req.commercialRegistration, consentRef: req.consentId, purpose: 'CREDIT_APPLICATION' } }, req.correlationId);
    if (r.kind === 'UNAVAILABLE') return ok({ kind: 'UNAVAILABLE', reason: r.reason, ...(r.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: r.retryAfterSeconds }) });
    if (r.kind === 'REFUSED') return ok({ kind: 'UNAVAILABLE', reason: `refused: ${r.code}` });
    const reference = str(r.value['enquiryId']);
    if (reference === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'response malformed' });
    if (r.value['found'] === false) return ok({ kind: 'NO_RECORD', bureauReference: reference });
    const totalExposure = decimalToMinor(r.value['totalExposure']); const overdue = decimalToMinor(r.value['overdueAmount']);
    const worst = int(r.value['worstDelinquencyDays']); const active = int(r.value['activeFacilities']);
    if (totalExposure === undefined || overdue === undefined || worst === undefined || active === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'response malformed' });
    const score = int(r.value['score']);
    const defaults = Array.isArray(r.value['defaults']) ? (r.value['defaults'] as unknown[]).flatMap((d) => { const rec = d as Record<string, unknown>; const amount = decimalToMinor(rec['amount']); return amount === undefined ? [] : [{ amount: money(amount), settled: rec['settled'] === true }]; }) : [];
    return ok({ kind: 'REPORT', summary: { bureauReference: reference, retrievedAt: await this.#attest(), totalExposure: money(totalExposure), overdueAmount: money(overdue), worstDelinquencyDays: worst, activeFacilities: active, ...(score === undefined ? {} : { bureauScore: score }), defaults } });
  }

  async report(rep: FacilityReport) {
    const r = await this.invoke('bureau.report', { method: 'POST', path: '/v1/facilities/events', body: { facilityRef: rep.facilityRef, event: rep.event, amount: rep.amount.minorUnits.toString(), asOf: rep.asOfEpochSeconds.toString(), idempotencyKey: rep.idempotencyKey } }, rep.correlationId);
    if (r.kind !== 'ANSWERED') return ok({ kind: 'UNAVAILABLE' as const, reason: r.kind === 'REFUSED' ? `refused: ${r.code}` : r.reason });
    const ack = str(r.value['acknowledgementId']);
    return ok(ack === undefined ? { kind: 'UNAVAILABLE' as const, reason: 'response malformed' } : { kind: 'ACKNOWLEDGED' as const, acknowledgementRef: ack });
  }
}
