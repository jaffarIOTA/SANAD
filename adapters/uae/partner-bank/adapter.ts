/**
 * Partner bank — payments adapter (ADR 0005).
 *
 * Implements the PaymentsPort through the bank the institution contracts for
 * money movement: a development fund that holds no settlement account of its
 * own disburses to the borrower, and collects instalments, through its
 * partner bank. The bank chooses the domestic rail (instant payment, the
 * federal transfer system, internal book transfer); the port never names one.
 *
 * Every instruction is in AED and carries the outbox event's idempotency key,
 * so a retried event cannot pay twice.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. The module stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { PaymentsPort } from '../../../core/ports/payments.ts';
import type { Money } from '../../../core/kernel/money.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { type Body, RailAdapter, type RailAdapterConfig, epoch, malformed, str } from '../../kernel/rail-adapter.ts';
import { requireAed } from '../kernel/dirham.ts';

export const PARTNER_BANK_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'PARTNER-BANK-DEV-001',
    summary:
      'Each partner bank exposes its own corporate payments API; there is no national payments hub contract to code against.',
    containment:
      'The adapter speaks one instruction shape (beneficiary reference, AED amount in minor units, purpose code, idempotency key). A bank whose API differs gets its own route table here, never a branch in the engine.',
    verificationRef: 'UAE-RAIL-PARTNER-BANK-01',
  },
  {
    id: 'PARTNER-BANK-DEV-002',
    summary: 'Domestic transfers require a payment purpose code from the central bank’s list.',
    containment:
      'The purpose code is passed through as the engine supplied it; which codes the bank accepts for a loan disbursement and an instalment collection is the verification item.',
    verificationRef: 'UAE-RAIL-PARTNER-BANK-01',
  },
];

export class PartnerBankAdapter extends RailAdapter implements PaymentsPort {
  readonly vendorName = 'Partner bank';
  readonly capabilities = ['PAYMENTS'] as const;
  readonly deviations = PARTNER_BANK_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async disburse(p: {
    readonly tenantId: string;
    readonly beneficiaryRef: string;
    readonly amount: Money;
    readonly purposeCode: string;
    readonly reference: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }) {
    const currency = this.#instructable(p.amount);
    if (!currency.ok) return currency;
    return this.#instruct(
      'payments.disburse',
      '/v1/payments/outward',
      {
        beneficiaryRef: p.beneficiaryRef,
        amount: p.amount.minorUnits.toString(),
        currency: p.amount.currency,
        purposeCode: p.purposeCode,
        reference: p.reference,
        idempotencyKey: p.idempotencyKey,
      },
      p.correlationId,
      ['ACCEPTED', 'SETTLED', 'REJECTED'] as const,
    );
  }

  async collect(p: {
    readonly tenantId: string;
    readonly payerRef: string;
    readonly amount: Money;
    readonly reference: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }) {
    const currency = this.#instructable(p.amount);
    if (!currency.ok) return currency;
    return this.#instruct(
      'payments.collect',
      '/v1/payments/direct-debits',
      {
        payerRef: p.payerRef,
        amount: p.amount.minorUnits.toString(),
        currency: p.amount.currency,
        reference: p.reference,
        idempotencyKey: p.idempotencyKey,
      },
      p.correlationId,
      ['ACCEPTED', 'SETTLED', 'REJECTED', 'RETURNED'] as const,
    );
  }

  /** AED, and strictly positive: a zero or negative instruction is a fault upstream, not a payment. */
  #instructable(amount: Money): Result<true> {
    const currency = requireAed(amount);
    if (!currency.ok) return currency;
    return amount.minorUnits > 0n
      ? currency
      : reject('OP-DETERMINACY', 'AMOUNT_NOT_POSITIVE', 'A payment instruction is for a positive amount');
  }

  async #instruct<S extends string>(
    operation: string,
    path: string,
    body: Body,
    correlationId: string,
    statuses: readonly S[],
  ) {
    const r = await this.invoke(operation, { method: 'POST', path, body }, correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const ref = str(r.value['paymentId']);
    const at = epoch(r.value['acceptedAt']);
    const status = statuses.find((s) => s === r.value['status']);
    return ok(
      ref === undefined || at === undefined || status === undefined
        ? malformed()
        : { kind: 'ANSWERED' as const, value: { instructionRef: ref, status, acceptedAtEpochSeconds: at } },
    );
  }
}
