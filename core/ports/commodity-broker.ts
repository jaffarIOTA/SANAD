/**
 * The commodity broker an organised Tawarruq runs through (CLAUDE.md §3,
 * `tawarruq-personal`; AAOIFI SS 30).
 *
 * The institution buys a commodity, sells it to the customer on deferred
 * terms, and the customer — or an agent the customer appoints — sells it on
 * for cash. Each step is a separate, attested act, in that order; the
 * broker's confirmations are what the sequence is evidenced by. The tenant's
 * board decides which brokers, which commodities and whether agency is
 * permitted; that is configuration.
 *
 * Nothing here is a rate. The commodity has a price; the sale to the customer
 * has a price; the difference is the profit amount the product discloses.
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface CommodityLot {
  readonly lotRef: string;
  readonly commodityCode: string;
  readonly quantity: string;
  readonly unit: string;
  readonly price: Money;
  /** The broker's own attestation of the moment; the platform attests separately. */
  readonly confirmedAtEpochSeconds: bigint;
}

export interface CommodityBrokerPort {
  /** The institution buys. Ownership passes on confirmation; the lot is identified, not fungible. */
  purchase(params: {
    readonly tenantId: string;
    readonly brokerRef: string;
    readonly commodityCode: string;
    readonly amount: Money;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<CommodityLot>>>;

  /** Title transfer to the customer after the deferred sale is executed. */
  transferTitle(params: {
    readonly tenantId: string;
    readonly lotRef: string;
    readonly toPartyRef: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<{ readonly transferRef: string; readonly confirmedAtEpochSeconds: bigint }>>>;

  /** The customer (or the appointed agent) sells the lot for cash. Only after title has passed. */
  sellOnBehalf(params: {
    readonly tenantId: string;
    readonly lotRef: string;
    readonly onBehalfOfPartyRef: string;
    readonly agencyRef?: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<{ readonly saleRef: string; readonly proceeds: Money; readonly confirmedAtEpochSeconds: bigint }>>>;
}
