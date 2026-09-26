/**
 * SADAD — bill collection adapter (CLAUDE.md §5).
 *
 * Implements the BillCollectionPort port. Vendor vocabulary stops here: the port sees
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
import type { BillCollectionPort } from '../../../core/ports/bill-collection.ts';
import type { Money } from '../../../core/kernel/money.ts';

export const SADADADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'SADAD-DEV-001',
    summary: 'The biller relationship is the institution’s; the service addresses bills by the biller’s own bill number.',
    containment: 'Our obligation reference is the bill number we present; the mapping is one-to-one and stored with the presentment so reconciliation never needs the rail to remember us.',
    verificationRef: 'KSA-RAIL-SADAD-01',
  },
];

export class SadadAdapter extends RailAdapter implements BillCollectionPort {
  readonly vendorName = 'SADAD';
  readonly capabilities = ['BILL_COLLECTION'] as const;
  readonly deviations = SADADADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async present(p: { readonly tenantId: string; readonly obligationRef: string; readonly payerRef: string; readonly amount: Money; readonly dueDateGregorian: string; readonly idempotencyKey: string; readonly correlationId: string }) {
    const r = await this.invoke('bill.present', { method: 'POST', path: '/v1/bills', body: { billNumber: p.obligationRef, payerRef: p.payerRef, amount: p.amount.minorUnits.toString(), currency: p.amount.currency, dueDate: p.dueDateGregorian, idempotencyKey: p.idempotencyKey } }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const billRef = str(r.value['billId']); const at = epoch(r.value['presentedAt']);
    return ok(billRef === undefined || at === undefined ? malformed() : { kind: 'ANSWERED' as const, value: { billRef, presentedAtEpochSeconds: at } });
  }

  async paid(p: { readonly tenantId: string; readonly sinceEpochSeconds: bigint; readonly correlationId: string }) {
    const r = await this.invoke('bill.paid', { method: 'GET', path: `/v1/bills/paid?since=${p.sinceEpochSeconds.toString()}` }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    if (!Array.isArray(r.value['items'])) return ok(malformed());
    const items = (r.value['items'] as unknown[]).flatMap((x) => {
      const rec = x as Record<string, unknown>; const billRef = str(rec['billId']); const amount = decimalToMinor(rec['amount']); const at = epoch(rec['paidAt']); const settlementRef = str(rec['settlementId']);
      return billRef === undefined || amount === undefined || at === undefined || settlementRef === undefined ? [] : [{ billRef, amount: money(amount), paidAtEpochSeconds: at, settlementRef }];
    });
    return ok({ kind: 'ANSWERED' as const, value: items });
  }
}
