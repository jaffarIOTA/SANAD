/**
 * Commodity broker — commodity broker adapter (CLAUDE.md §5).
 *
 * Implements the CommodityBrokerPort port. Vendor vocabulary stops here: the port sees
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
import type { CommodityBrokerPort } from '../../../core/ports/commodity-broker.ts';
import type { Money } from '../../../core/kernel/money.ts';

export const COMMODITYBROKERADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'BROKER-DEV-001',
    summary: 'The broker confirms ownership on its own clock.',
    containment: 'The broker’s confirmation time is carried as evidence; the platform attests each step separately through the timestamping authority and sequences on that.',
    verificationRef: 'KSA-RAIL-BROKER-01',
  },
];

export class CommodityBrokerAdapter extends RailAdapter implements CommodityBrokerPort {
  readonly vendorName = 'Commodity broker';
  readonly capabilities = ['COMMODITY_BROKER'] as const;
  readonly deviations = COMMODITYBROKERADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async purchase(p: { readonly tenantId: string; readonly brokerRef: string; readonly commodityCode: string; readonly amount: Money; readonly idempotencyKey: string; readonly correlationId: string }) {
    const r = await this.invoke('commodity.purchase', { method: 'POST', path: '/v1/purchases', body: { broker: p.brokerRef, commodity: p.commodityCode, amount: p.amount.minorUnits.toString(), currency: p.amount.currency, idempotencyKey: p.idempotencyKey } }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const lotRef = str(r.value['lotId']); const quantity = str(r.value['quantity']); const unit = str(r.value['unit']); const price = decimalToMinor(r.value['price']); const at = epoch(r.value['confirmedAt']);
    if (lotRef === undefined || quantity === undefined || unit === undefined || price === undefined || at === undefined) return ok(malformed());
    return ok({ kind: 'ANSWERED' as const, value: { lotRef, commodityCode: p.commodityCode, quantity, unit, price: money(price, p.amount.currency), confirmedAtEpochSeconds: at } });
  }

  async transferTitle(p: { readonly tenantId: string; readonly lotRef: string; readonly toPartyRef: string; readonly correlationId: string }) {
    const r = await this.invoke('commodity.transfer', { method: 'POST', path: `/v1/lots/${encodeURIComponent(p.lotRef)}/transfers`, body: { to: p.toPartyRef } }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const transferRef = str(r.value['transferId']); const at = epoch(r.value['confirmedAt']);
    return ok(transferRef === undefined || at === undefined ? malformed() : { kind: 'ANSWERED' as const, value: { transferRef, confirmedAtEpochSeconds: at } });
  }

  async sellOnBehalf(p: { readonly tenantId: string; readonly lotRef: string; readonly onBehalfOfPartyRef: string; readonly agencyRef?: string; readonly idempotencyKey: string; readonly correlationId: string }) {
    const r = await this.invoke('commodity.sell', { method: 'POST', path: `/v1/lots/${encodeURIComponent(p.lotRef)}/sales`, body: { onBehalfOf: p.onBehalfOfPartyRef, ...(p.agencyRef === undefined ? {} : { agency: p.agencyRef }), idempotencyKey: p.idempotencyKey } }, p.correlationId);
    if (r.kind !== 'ANSWERED') return ok(r);
    const saleRef = str(r.value['saleId']); const proceeds = decimalToMinor(r.value['proceeds']); const at = epoch(r.value['confirmedAt']);
    return ok(saleRef === undefined || proceeds === undefined || at === undefined ? malformed() : { kind: 'ANSWERED' as const, value: { saleRef, proceeds: money(proceeds), confirmedAtEpochSeconds: at } });
  }
}
