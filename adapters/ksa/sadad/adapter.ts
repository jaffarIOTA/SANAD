/**
 * SADAD — bill collection adapter (CLAUDE.md §5).
 *
 * Implements the BillCollectionPort. Vendor vocabulary stops here: the port sees
 * capability-named outcomes and references, never this rail's field names.
 *
 * Assumed contract (SADAD biller interfaces are released at biller onboarding;
 * see README.md): a bill is addressed as the SAMA Open Banking
 * `BillDetails{BillerID, BillNumber}` — the institution's biller id and its own
 * bill number — and follows the published SADAD lifecycle: presented
 * (uploaded to SADAD), paid (by the customer through any bank channel), settled
 * (funds credited to the biller), with end-of-day reconciliation of paid and
 * settled bills. Sanad never becomes the biller.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { Money } from '../../../core/kernel/money.ts';
import { ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import {
  RailAdapter,
  type RailAdapterConfig,
  arr,
  idStr,
  isoToEpoch,
  malformed,
  minorToDecimal,
  obj,
  own,
} from '../kernel/rail-adapter.ts';
import { instructableSar, sar } from '../kernel/riyal.ts';
import type { BillCollectionPort } from '../../../core/ports/bill-collection.ts';

export const SADADADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'SADAD-DEV-001',
    summary:
      'The biller relationship is the institution’s; the service addresses bills by the biller id and the biller’s own bill number.',
    containment:
      'Our obligation reference is the bill number we present under the tenant’s configured biller id; the bill reference is "BillerID-BillNumber", so reconciliation never needs the rail to remember us.',
    verificationRef: 'KSA-RAIL-SADAD-01',
  },
  {
    id: 'SADAD-DEV-002',
    summary: 'The bill status vocabulary beyond the public lifecycle (presented, paid, settled) is not published.',
    containment:
      'Only PAID and SETTLED bills are reconciled; one reconciliation line that does not read refuses the whole batch rather than dropping a payment.',
    verificationRef: 'KSA-RAIL-SADAD-01',
  },
];

/** Lifecycle statuses on the reconciliation file that mean the customer has paid. */
const PAID: Readonly<Record<string, boolean>> = { PAID: true, SETTLED: true, PRESENTED: false, EXPIRED: false };

export class SadadAdapter extends RailAdapter implements BillCollectionPort {
  readonly vendorName = 'SADAD';
  readonly capabilities = ['BILL_COLLECTION'] as const;
  readonly deviations = SADADADAPTER_DEVIATIONS;

  /** The institution's own SADAD biller id: configuration, never a request field. */
  readonly #billerId: string;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport, billerId: string) {
    super(config, credentials, transport);
    this.#billerId = billerId;
  }

  async present(p: {
    readonly tenantId: string;
    readonly obligationRef: string;
    readonly payerRef: string;
    readonly amount: Money;
    readonly dueDateGregorian: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }) {
    const amount = instructableSar(p.amount);
    if (!amount.ok) return amount;
    if (!/^\d{1,6}$/.test(this.#billerId))
      return reject('OP-DETERMINACY', 'BILLER_NOT_CONFIGURED', 'No SADAD biller id is configured for this tenant');
    const r = await this.invoke(
      'bill.present',
      {
        method: 'POST',
        path: '/v1/bills',
        body: {
          BillDetails: { BillerID: this.#billerId, BillNumber: p.obligationRef },
          payerRef: p.payerRef,
          Amount: { Amount: minorToDecimal(p.amount.minorUnits), Currency: p.amount.currency },
          DueDate: p.dueDateGregorian,
          idempotencyKey: p.idempotencyKey,
        },
      },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const bill = obj(r.value['BillDetails']);
    const billNumber = idStr(bill?.['BillNumber']);
    const at = isoToEpoch(r.value['PresentedDateTime']);
    if (billNumber !== p.obligationRef || idStr(bill?.['BillerID']) !== this.#billerId || at === undefined)
      return ok(malformed());
    if (r.value['Status'] !== 'PRESENTED') return ok({ kind: 'REFUSED' as const, code: 'NOT_PRESENTED' });
    return ok({
      kind: 'ANSWERED' as const,
      value: { billRef: `${this.#billerId}-${billNumber}`, presentedAtEpochSeconds: at },
    });
  }

  async paid(p: { readonly tenantId: string; readonly sinceEpochSeconds: bigint; readonly correlationId: string }) {
    const since = new Date(Number(p.sinceEpochSeconds) * 1000).toISOString();
    const r = await this.invoke(
      'bill.paid',
      { method: 'GET', path: `/v1/bills/reconciliation?fromDateTime=${encodeURIComponent(since)}` },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const list = arr(obj(r.value['Data'])?.['Bill']);
    if (list === undefined) return ok(malformed());
    const items: { billRef: string; amount: Money; paidAtEpochSeconds: bigint; settlementRef: string }[] = [];
    for (const raw of list) {
      const b = obj(raw);
      const paid = own(PAID, b?.['Status']);
      if (b === undefined || paid === undefined) return ok(malformed());
      if (!paid) continue;
      const details = obj(b['BillDetails']);
      const billerId = idStr(details?.['BillerID']);
      const billNumber = idStr(details?.['BillNumber']);
      const amount = sar(obj(b['PaidAmount'])?.['Amount'], obj(b['PaidAmount'])?.['Currency']);
      const at = isoToEpoch(b['PaymentDateTime']);
      // SADAD's payment id identifies the payment; the settlement reference arrives once it is settled.
      const settlementRef = idStr(b['SettlementReference']) ?? idStr(b['SadadPaymentId']);
      if (
        billerId !== this.#billerId ||
        billNumber === undefined ||
        amount === undefined ||
        at === undefined ||
        settlementRef === undefined
      )
        return ok(malformed());
      items.push({ billRef: `${billerId}-${billNumber}`, amount, paidAtEpochSeconds: at, settlementRef });
    }
    return ok({ kind: 'ANSWERED' as const, value: items });
  }
}
