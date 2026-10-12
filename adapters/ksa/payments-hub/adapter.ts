/**
 * Payments hub — payments adapter (CLAUDE.md §5).
 *
 * Implements the PaymentsPort. Vendor vocabulary stops here: the port sees
 * capability-named outcomes and references, never this rail's field names.
 *
 * Assumed contract (each institution's hub is its own; see README.md): the
 * public analogue is ISO 20022, which SARIE and the Saudi instant payment
 * system use — a credit transfer or direct debit instruction answered by a
 * payment status report (pacs.002): `TxSts` ACSC (settled), ACSP / ACCP / ACTC
 * (accepted), PDNG (pending), RJCT (rejected) with `StsRsnInf.Rsn.Cd` (e.g.
 * AC04 closed account, AM04 insufficient funds); a collection later returned
 * carries the return reason of a pacs.004.
 *
 * Every instruction is in SAR, for a positive amount, and carries the outbox
 * event's idempotency key, so a retried event cannot pay twice.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { Money } from '../../../core/kernel/money.ts';
import { ok } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import {
  type Body,
  RailAdapter,
  type RailAdapterConfig,
  idStr,
  isoToEpoch,
  malformed,
  minorToDecimal,
  obj,
  own,
} from '../kernel/rail-adapter.ts';
import { instructableSar } from '../kernel/riyal.ts';
import type { PaymentsPort } from '../../../core/ports/payments.ts';

export const PAYMENTSHUBADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'PAYHUB-DEV-001',
    summary: 'The hub chooses the rail (instant transfer, SARIE, card scheme, internal) from the beneficiary.',
    containment:
      'The port never names a rail; the adapter passes the beneficiary reference and the hub decides. The idempotency key is the outbox event key, so a retried event cannot pay twice.',
    verificationRef: 'KSA-RAIL-PAYHUB-01',
  },
  {
    id: 'PAYHUB-DEV-002',
    summary: 'The hub’s answer is modelled on ISO 20022 pacs.002; its JSON rendering is the institution’s own.',
    containment:
      'Only the published status codes are mapped; an unknown TxSts is UNAVAILABLE. The rejection reason code is not carried by the port (a recommended port extension).',
    verificationRef: 'KSA-RAIL-PAYHUB-01',
  },
];

type HubStatus = 'ACCEPTED' | 'SETTLED' | 'REJECTED';

/** pacs.002 `TxSts` to the port. */
export const TX_STATUS: Readonly<Record<string, HubStatus>> = {
  ACSC: 'SETTLED',
  ACSP: 'ACCEPTED',
  ACCP: 'ACCEPTED',
  ACTC: 'ACCEPTED',
  ACWC: 'ACCEPTED',
  PDNG: 'ACCEPTED',
  RJCT: 'REJECTED',
};

export class PaymentsHubAdapter extends RailAdapter implements PaymentsPort {
  readonly vendorName = 'Payments hub';
  readonly capabilities = ['PAYMENTS'] as const;
  readonly deviations = PAYMENTSHUBADAPTER_DEVIATIONS;

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
    const instructable = instructableSar(p.amount);
    if (!instructable.ok) return instructable;
    const r = await this.#instruct(
      'payments.disburse',
      '/v1/credit-transfers',
      {
        EndToEndId: p.reference,
        InstrId: p.idempotencyKey,
        idempotencyKey: p.idempotencyKey,
        IntrBkSttlmAmt: { Amount: minorToDecimal(p.amount.minorUnits), Ccy: p.amount.currency },
        Purp: { Cd: p.purposeCode },
        creditorRef: p.beneficiaryRef,
      },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    // A disbursement has no return in this port's vocabulary; a pacs.004 on one is not understood.
    return ok(r.value.returned ? malformed() : { kind: 'ANSWERED' as const, value: r.value.instruction });
  }

  async collect(p: {
    readonly tenantId: string;
    readonly payerRef: string;
    readonly amount: Money;
    readonly reference: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }) {
    const instructable = instructableSar(p.amount);
    if (!instructable.ok) return instructable;
    const r = await this.#instruct(
      'payments.collect',
      '/v1/direct-debits',
      {
        EndToEndId: p.reference,
        InstrId: p.idempotencyKey,
        idempotencyKey: p.idempotencyKey,
        IntrBkSttlmAmt: { Amount: minorToDecimal(p.amount.minorUnits), Ccy: p.amount.currency },
        debtorRef: p.payerRef,
      },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const { instruction, returned } = r.value;
    return ok({
      kind: 'ANSWERED' as const,
      value: returned ? { ...instruction, status: 'RETURNED' as const } : instruction,
    });
  }

  async #instruct(operation: string, path: string, body: Body, correlationId: string) {
    const r = await this.invoke(operation, { method: 'POST', path, body }, correlationId);
    if (r.kind !== 'ANSWERED') return r;
    const v = r.value;
    const status = own(TX_STATUS, v['TxSts']);
    // The hub's own transaction id; the end-to-end id is ours and must come back unchanged.
    const ref = idStr(v['TxId']);
    const at = isoToEpoch(v['AccptncDtTm']);
    if (status === undefined || ref === undefined || at === undefined || v['OrgnlEndToEndId'] !== body['EndToEndId'])
      return malformed();
    // pacs.004: a settled collection the payer's bank later sent back.
    const returned = obj(v['RtrInf']) !== undefined;
    return {
      kind: 'ANSWERED' as const,
      value: { instruction: { instructionRef: ref, status, acceptedAtEpochSeconds: at }, returned },
    };
  }
}
