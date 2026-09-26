/**
 * Payments hub — payments adapter (CLAUDE.md §5).
 *
 * Implements the PaymentsPort port. Vendor vocabulary stops here: the port sees
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
import type { PaymentsPort } from '../../../core/ports/payments.ts';
import type { Money } from '../../../core/kernel/money.ts';

export const PAYMENTSHUBADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'PAYHUB-DEV-001',
    summary: 'The hub chooses the rail (instant transfer, card scheme, internal) from the beneficiary.',
    containment: 'The port never names a rail; the adapter passes the beneficiary reference and the hub decides. The idempotency key is the outbox event key, so a retried event cannot pay twice.',
    verificationRef: 'KSA-RAIL-PAYHUB-01',
  },
];

export class PaymentsHubAdapter extends RailAdapter implements PaymentsPort {
  readonly vendorName = 'Payments hub';
  readonly capabilities = ['PAYMENTS'] as const;
  readonly deviations = PAYMENTSHUBADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async disburse(p: { readonly tenantId: string; readonly beneficiaryRef: string; readonly amount: Money; readonly purposeCode: string; readonly reference: string; readonly idempotencyKey: string; readonly correlationId: string }) {
    return this.#instruct('payments.disburse', '/v1/disbursements', { beneficiaryRef: p.beneficiaryRef, amount: p.amount.minorUnits.toString(), currency: p.amount.currency, purposeCode: p.purposeCode, reference: p.reference, idempotencyKey: p.idempotencyKey }, p.correlationId, ['ACCEPTED', 'SETTLED', 'REJECTED'] as const);
  }

  async collect(p: { readonly tenantId: string; readonly payerRef: string; readonly amount: Money; readonly reference: string; readonly idempotencyKey: string; readonly correlationId: string }) {
    return this.#instruct('payments.collect', '/v1/collections', { payerRef: p.payerRef, amount: p.amount.minorUnits.toString(), currency: p.amount.currency, reference: p.reference, idempotencyKey: p.idempotencyKey }, p.correlationId, ['ACCEPTED', 'SETTLED', 'REJECTED', 'RETURNED'] as const);
  }

  async #instruct<S extends string>(operation: string, path: string, body: Readonly<Record<string, unknown>>, correlationId: string, statuses: readonly S[]) {
    const r = await this.invoke(operation, { method: 'POST', path, body }, correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const ref = str(r.value['instructionId']); const at = epoch(r.value['acceptedAt']); const status = statuses.find((s) => s === r.value['status']);
    return ok(ref === undefined || at === undefined || status === undefined ? malformed() : { kind: 'ANSWERED' as const, value: { instructionRef: ref, status, acceptedAtEpochSeconds: at } });
  }
}
