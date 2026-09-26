/**
 * The Tawarruq sequence, as a state machine whose transitions accept only
 * their predecessor. Ownership before sale; title before onward sale;
 * proceeds before disbursement; one disbursement.
 */

import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { Money } from '@sanad/core/kernel/money.ts';
import { type Outbox, emptyOutbox, enqueue } from '@sanad/core/outbox/outbox.ts';
import type { CommodityLot } from '@sanad/core/ports/commodity-broker.ts';
import { type TsaInstant, isStrictlyLater } from '@sanad/core/time/tsa.ts';

import type { TawarruqQuote } from './pricing.ts';

export interface TawarruqCore {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly applicantRef: string;
  readonly quote: TawarruqQuote;
  readonly brokerRef: string;
  readonly agency: { readonly permitted: boolean; readonly agencyRef?: string };
  /** The bureau enquiry the approval rested on. Required — see T-5. */
  readonly bureauEnquiryRef: string;
  readonly consentId: string;
  readonly correlationId: string;
  readonly openedAt: TsaInstant;
}

interface WithCore { readonly core: TawarruqCore }
export interface Draft extends WithCore { readonly state: 'DRAFT' }
export interface CommodityPurchased extends WithCore { readonly state: 'COMMODITY_PURCHASED'; readonly lot: CommodityLot; readonly purchasedAt: TsaInstant }
export interface SoldToCustomer extends WithCore { readonly state: 'SOLD_TO_CUSTOMER'; readonly lot: CommodityLot; readonly purchasedAt: TsaInstant; readonly soldAt: TsaInstant; readonly saleDocumentRef: string }
export interface TitleTransferred extends WithCore { readonly state: 'TITLE_TRANSFERRED'; readonly lot: CommodityLot; readonly soldAt: TsaInstant; readonly transferRef: string; readonly transferredAt: TsaInstant }
export interface ProceedsRealised extends WithCore { readonly state: 'PROCEEDS_REALISED'; readonly lot: CommodityLot; readonly saleRef: string; readonly proceeds: Money; readonly realisedAt: TsaInstant }
export interface Disbursed extends WithCore { readonly state: 'DISBURSED'; readonly proceeds: Money; readonly disbursedAt: TsaInstant; readonly outbox: Outbox }

export type TawarruqTransaction = Draft | CommodityPurchased | SoldToCustomer | TitleTransferred | ProceedsRealised | Disbursed;

// Belt and braces: the types already make a skipped step uncallable; at runtime a
// missing predecessor instant is refused rather than thrown.
const later = (a: TsaInstant, b: TsaInstant | undefined, what: string): Result<true> =>
  b === undefined
    ? reject('OP-CHAIN', 'PREDECESSOR_MISSING', `${what} has no attested predecessor step`)
    : isStrictlyLater(a, b) ? ok(true) : reject('OP-CHAIN', 'TIMESTAMPS_NOT_MONOTONIC', `${what} must be attested strictly after the step before it`);

export function open(core: TawarruqCore): Result<Draft> {
  if (core.bureauEnquiryRef.trim().length === 0) return reject('OP-DETERMINACY', 'BUREAU_ENQUIRY_REQUIRED', 'No approval without a bureau enquiry on record (T-5)');
  if (core.consentId.trim().length === 0) return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'No approval without the consent the bureau enquiry ran under');
  return ok({ state: 'DRAFT', core });
}

export function purchaseCommodity(t: Draft, lot: CommodityLot, at: TsaInstant): Result<CommodityPurchased> {
  const check = later(at, t.core.openedAt, 'The purchase'); if (!check.ok) return check;
  if (lot.price.minorUnits !== t.core.quote.commodityCost.minorUnits) {
    return reject('SH-03', 'COMMODITY_COST_MISMATCH', 'The lot bought is not the cost the customer was quoted', { lot: String(lot.price.minorUnits), quoted: String(t.core.quote.commodityCost.minorUnits) });
  }
  return ok({ state: 'COMMODITY_PURCHASED', core: t.core, lot, purchasedAt: at });
}

export function sellToCustomer(t: CommodityPurchased, saleDocumentRef: string, at: TsaInstant): Result<SoldToCustomer> {
  const check = later(at, t.purchasedAt, 'The sale'); if (!check.ok) return check;
  if (saleDocumentRef.length === 0) return reject('OP-DETERMINACY', 'SALE_DOCUMENT_REQUIRED', 'The deferred sale is a signed instrument');
  return ok({ state: 'SOLD_TO_CUSTOMER', core: t.core, lot: t.lot, purchasedAt: t.purchasedAt, soldAt: at, saleDocumentRef });
}

export function transferTitle(t: SoldToCustomer, transferRef: string, at: TsaInstant): Result<TitleTransferred> {
  const check = later(at, t.soldAt, 'Title transfer'); if (!check.ok) return check;
  return ok({ state: 'TITLE_TRANSFERRED', core: t.core, lot: t.lot, soldAt: t.soldAt, transferRef, transferredAt: at });
}

export function realiseProceeds(t: TitleTransferred, sale: { readonly saleRef: string; readonly proceeds: Money; readonly agencyRef?: string }, at: TsaInstant): Result<ProceedsRealised> {
  const check = later(at, t.transferredAt, 'The onward sale'); if (!check.ok) return check;
  if (sale.agencyRef !== undefined && !t.core.agency.permitted) {
    return reject('SH-18', 'AGENCY_NOT_PERMITTED', 'This tenant\'s board does not permit the institution to sell on as agent');
  }
  return ok({ state: 'PROCEEDS_REALISED', core: t.core, lot: t.lot, saleRef: sale.saleRef, proceeds: sale.proceeds, realisedAt: at });
}

/** Queues the disbursement and the bureau report. One each, keyed on the transaction. */
export function disburse(t: ProceedsRealised, at: TsaInstant): Result<Disbursed> {
  const check = later(at, t.realisedAt, 'Disbursement'); if (!check.ok) return check;
  const key = `txn:${t.core.transactionId}`;
  const base = { tenantId: t.core.tenantId, subjectRef: t.core.transactionId, correlationId: t.core.correlationId };
  const first = enqueue(emptyOutbox(), { ...base, eventId: `${key}:disburse`, kind: 'PAYMENT_DISBURSE', idempotencyKey: `${key}:disburse`, payload: { beneficiaryRef: t.core.applicantRef, minorUnits: String(t.proceeds.minorUnits), currency: t.proceeds.currency } });
  if (!first.ok) return first;
  const both = enqueue(first.value, { ...base, eventId: `${key}:bureau`, kind: 'BUREAU_REPORT', idempotencyKey: `${key}:bureau`, payload: { facilityRef: t.core.transactionId, event: 'OPENED', minorUnits: String(t.core.quote.deferredSalePrice.minorUnits) } });
  if (!both.ok) return both;
  return ok({ state: 'DISBURSED', core: t.core, proceeds: t.proceeds, disbursedAt: at, outbox: both.value });
}
