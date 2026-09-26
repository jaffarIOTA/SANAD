/**
 * The product module interface (CLAUDE.md §3).
 *
 * The engine talks to a product through this and nothing else. It knows that
 * a product has a journey shape, can validate its own term sheet, can turn a
 * request into a quote, can say what the customer must be shown, and can
 * execute an approval. It does not know whether the product is a Murabaha, a
 * Tawarruq or a term loan; the module does.
 *
 * If a module needs something this interface does not offer, extend the
 * interface for every module — never with a special case for one.
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';
import type { Approved } from '../origination/request.ts';
import type { TradeReference } from '../origination/trade-reference.ts';
import type { CashFlow } from '../pricing/apr.ts';
import type { RateSnapshot } from '../pricing/rate.ts';

export type JourneyShape = 'AMOUNT_FIRST' | 'TRADE_FIRST';
export type ProductFamily = 'ISLAMIC' | 'CONVENTIONAL';

export interface ProductDescriptor {
  /** Stable identifier; the directory name under products/. */
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly journeyShape: JourneyShape;
  readonly family: ProductFamily;
  /** A consumer product must disclose the full SAMA set, APR included, before acceptance. */
  readonly consumer: boolean;
  /** An Islamic product cannot be enabled for a tenant without that tenant's board ruling. */
  readonly requiresBoardRuling: boolean;
}

/**
 * What the engine resolved about price before asking the module to quote.
 * A Murabaha takes a profit amount; a rate-priced product takes a rate
 * snapshot. Both come from the tenant's catalogue rule (core/pricing/quotation.ts),
 * never from the request body.
 */
export interface PricingInputs {
  readonly profitAmount?: Money;
  readonly rate?: RateSnapshot;
}

/**
 * Facts an affordability rule needs, where the product has one. Snapshots
 * from the rails (registered salary, bureau obligations, platform exposure),
 * never typed in by the applicant.
 */
export interface AffordabilityFacts {
  readonly monthlyIncome?: Money;
  readonly existingMonthlyObligations?: Money;
  /** Outstanding under products of the same class on this platform, for consumer limits. */
  readonly outstandingSameClass?: Money;
  readonly incomeSourceRef?: string;
}

export interface QuoteRequest {
  readonly tenantId: string;
  readonly programmeId: string;
  readonly counterpartyId: string;
  /** Present for an amount-first product; the invoice amount for a trade-first one. */
  readonly requestedAmount: Money;
  /** Present for a trade-first product. */
  readonly tradeReference?: TradeReference;
  readonly requestedTenorDays: number;
  readonly asOf: TsaInstant;
  readonly pricing: PricingInputs;
  readonly affordability?: AffordabilityFacts;
  /** The partner that raised the request, from the credential — set by the engine for partner channels. */
  readonly partnerRef?: string;
  /** Product-specific choices the applicant or partner made (a collection mode, a delivery option). The module validates them. */
  readonly preferences?: Readonly<Record<string, string>>;
}

export interface Fee {
  readonly code: string;
  readonly labelEn: string;
  readonly labelAr: string;
  readonly amount: Money;
  readonly when: 'UPFRONT' | 'PERIODIC' | 'ON_EVENT';
}

/** The part of a quote every product shares. A module extends it with its own pricing facts. */
export interface Quote {
  readonly productCode: string;
  readonly financingAmount: Money;
  readonly tenorDays: number;
  /** Every cash flow, drawdowns and repayments, fees included. The APR is computed from exactly this. */
  readonly schedule: readonly CashFlow[];
  readonly fees: readonly Fee[];
  readonly totalPayable: Money;
  readonly totalCostOfCredit: Money;
}

export interface DisclosureLine {
  readonly code: string;
  readonly labelEn: string;
  readonly labelAr: string;
  readonly amount: Money;
}

/**
 * The figures the customer is shown before accepting. The platform adds APR
 * beside these (core/products/offer.ts); a module never computes it.
 */
export interface Disclosure {
  readonly financingAmount: Money;
  readonly tenorDays: number;
  readonly instalmentCount: number;
  /** Absent when instalments are unequal; then every instalment is listed. */
  readonly instalmentAmount?: Money;
  readonly totalCostOfCredit: Money;
  readonly totalPayable: Money;
  readonly fees: readonly Fee[];
  /** Product-specific figures, labelled in both languages: cost and profit for a Murabaha, commodity price for a Tawarruq. */
  readonly lines: readonly DisclosureLine[];
}

export interface ProductModule<TTerms, TQuote extends Quote, TExecutionContext, TExecution> {
  readonly descriptor: ProductDescriptor;
  /** The tenant's term sheet for this product, from the catalogue. Strict. */
  validateTerms(raw: unknown): Result<TTerms>;
  quote(terms: TTerms, request: QuoteRequest): Result<TQuote>;
  disclose(quote: TQuote): Disclosure;
  /** What an approval buys. For a sequenced product, the first state and nothing later. */
  execute(terms: TTerms, approved: Approved, quote: TQuote, context: TExecutionContext): Result<TExecution>;
}

/** A module as the registry holds it: the type parameters erased. */
export type AnyProductModule = ProductModule<unknown, Quote, unknown, unknown>;
