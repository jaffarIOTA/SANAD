/**
 * Open Banking TPP — account information adapter (CLAUDE.md §5).
 *
 * Implements the AccountInformationPort, PaymentInitiationPort port. Vendor vocabulary stops here: the port sees
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
import type { AccountInformationPort } from '../../../core/ports/account-information.ts';
import type { PaymentInitiationPort } from '../../../core/ports/payment-initiation.ts';
import type { Money } from '../../../core/kernel/money.ts';

export const OPENBANKINGADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'OB-DEV-001',
    summary: 'Statement lines are available in full from the AIS.',
    containment: 'Only the affordability facts the decision needs are computed by the TPP call and mapped; no transaction line is stored.',
    verificationRef: 'KSA-RAIL-OB-01',
  },
];

export class OpenBankingAdapter extends RailAdapter implements AccountInformationPort, PaymentInitiationPort {
  readonly vendorName = 'Open Banking TPP';
  readonly capabilities = ['ACCOUNT_INFORMATION', 'PAYMENT_INITIATION'] as const;
  readonly deviations = OPENBANKINGADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async affordabilityFacts(p: { readonly tenantId: string; readonly applicantRef: string; readonly consentId: string; readonly months: number; readonly correlationId: string }) {
    const consent = this.requireConsent(p.consentId); if (!consent.ok) return consent;
    const r = await this.invoke('ais.affordability', { method: 'POST', path: '/v1/ais/affordability', body: { applicantRef: p.applicantRef, consentRef: p.consentId, months: p.months } }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const inflow = decimalToMinor(r.value['averageMonthlyInflow']); const low = decimalToMinor(r.value['lowestMonthEndBalance']);
    const returned = int(r.value['returnedPayments6m']); const salary = int(r.value['salaryCredits']); const at = epoch(r.value['asOf']); const referenceId = str(r.value['referenceId']);
    if (inflow === undefined || low === undefined || returned === undefined || salary === undefined || at === undefined || referenceId === undefined) return ok(malformed());
    return ok({ kind: 'ANSWERED' as const, value: { averageMonthlyInflow: money(inflow), lowestMonthEndBalance: money(low), returnedPaymentsLast6Months: returned, salaryCreditsObserved: salary, retrievedAtEpochSeconds: at, referenceId } });
  }

  async initiate(p: { readonly tenantId: string; readonly applicantRef: string; readonly consentId: string; readonly amount: Money; readonly direction: 'COLLECT' | 'DISBURSE'; readonly reference: string; readonly idempotencyKey: string; readonly correlationId: string }) {
    const consent = this.requireConsent(p.consentId); if (!consent.ok) return consent;
    const r = await this.invoke('pis.initiate', { method: 'POST', path: '/v1/pis/payments', body: { applicantRef: p.applicantRef, consentRef: p.consentId, amount: p.amount.minorUnits.toString(), currency: p.amount.currency, direction: p.direction, reference: p.reference, idempotencyKey: p.idempotencyKey } }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const ref = str(r.value['paymentId']); const at = epoch(r.value['initiatedAt']);
    const status = (['INITIATED', 'AUTHORISED', 'REJECTED'] as const).find((k) => k === r.value['status']);
    if (ref === undefined || at === undefined || status === undefined) return ok(malformed());
    return ok({ kind: 'ANSWERED' as const, value: { instructionRef: ref, status, initiatedAtEpochSeconds: at } });
  }

  async status(p: { readonly tenantId: string; readonly instructionRef: string; readonly correlationId: string }) {
    const r = await this.invoke('pis.status', { method: 'GET', path: `/v1/pis/payments/${encodeURIComponent(p.instructionRef)}` }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const status = str(r.value['status']);
    const known = ['INITIATED', 'AUTHORISED', 'SETTLED', 'REJECTED', 'RETURNED'] as const;
    const s = known.find((k) => k === status);
    return ok(s === undefined ? malformed() : { kind: 'ANSWERED' as const, value: { status: s } });
  }
}
