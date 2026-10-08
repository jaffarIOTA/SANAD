/**
 * Core banking product catalogue port — read only.
 *
 * The core banking platform has its own notion of a product: a type code with
 * a group, a currency, a country, and a configuration that says how the
 * platform would schedule and price a facility booked under it. Sanad's own
 * catalogue (`core/products/catalogue.ts`) is the one that governs origination;
 * this port exists so an administrator can see what the core offers, map a
 * Sanad product to a core product code, and read, before anything is booked,
 * whether the core would price that product by a rate.
 *
 * Nothing here books, prices or quotes. The two operations are reads, and both
 * return the rail outcome shape so that an unreachable core is a value the
 * screen can show, never an approval or a silent empty list.
 *
 * Vendor vocabulary stays in the adapter. A figure the core publishes about a
 * product (an amount limit, a component value) is carried as text for display:
 * it is the core's figure, not Sanad's, and it enters no arithmetic here.
 */

import type { RailOutcome } from './rail.ts';

export interface CoreBankingProductType {
  readonly code: string;
  readonly description: string;
  readonly group: string;
  readonly groupDescription: string;
  readonly currency: string;
  readonly country: string;
  readonly status: string;
  /** The organisational unit the core files the product under. */
  readonly unit: string;
}

export interface CoreBankingPricingComponent {
  readonly component: string;
  readonly kind: 'RATE' | 'FEE' | 'OTHER';
  /** The core's published value, verbatim, for display only. */
  readonly valueText: string;
}

export interface CoreBankingProductDetail {
  readonly summary: CoreBankingProductType;
  /** The core's schedule shape code, e.g. an annuity or a bullet. */
  readonly scheduleShape: string;
  /** The core's amount limits, as published, for display only. */
  readonly amountLimits?: { readonly lowText: string; readonly highText: string };
  /** The core's period limits in its period unit (months for every product seen so far). */
  readonly periodLimits?: { readonly low: number; readonly high: number };
  /**
   * Whether the core would derive the cost of credit from a rate under this
   * product. `RATE_DRIVEN` is what every lending-module product seen so far
   * answers; a Murabaha deferred price cannot be booked under such a product
   * as a fixed amount (adapter README, Finding 1).
   */
  readonly pricingMethod: 'RATE_DRIVEN' | 'NOT_RATE_DRIVEN' | 'UNKNOWN';
  /** How the rate is applied, if rate driven: type and day-count, in the core's codes. */
  readonly rateBasis?: string;
  readonly components: readonly CoreBankingPricingComponent[];
  readonly repaymentCycle?: {
    readonly frequency?: number;
    readonly unit?: string;
    readonly invoiceTermDays?: number;
    readonly minBillingPeriodDays?: number;
  };
  readonly reviewRequiredBeforeOffer: boolean;
}

export interface CoreBankingProductCatalogue {
  listProductTypes(correlationId: string): Promise<RailOutcome<readonly CoreBankingProductType[]>>;
  describeProductType(code: string, correlationId: string): Promise<RailOutcome<CoreBankingProductDetail>>;
}
