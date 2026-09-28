/**
 * The product engine as the consumer journey uses it: which consumer products
 * this tenant offers, and a quote for one of them. The facts an affordability
 * rule needs come from the rails in production (employment verification, the
 * bureau); here they come from a development stand-in, labelled as such.
 */

import { type TenantCode, loadProductCatalogue } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type CatalogueEntry, entryFor } from '@sanad/core/products/catalogue.ts';
import type { AnyProductModule } from '@sanad/core/products/module.ts';
import { type Offer, buildOffer } from '@sanad/core/products/offer.ts';
import { ProductRegistry } from '@sanad/core/products/registry.ts';
import { resolvePricingInputs } from '@sanad/core/pricing/quotation.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';
import { bnpl } from '@sanad/products/bnpl/index.ts';
import { conventionalTerm } from '@sanad/products/conventional-term/index.ts';
import { tawarruqPersonal } from '@sanad/products/tawarruq-personal/index.ts';

export const TENANT: TenantCode = 'bank-a';
const REGISTRY = new ProductRegistry().register(tawarruqPersonal).register(bnpl).register(conventionalTerm);

/** Development stand-ins for the Rate Publisher and the affordability rails. */
const DEV_BENCHMARK = { code: 'SAIBOR-3M', rate: rate(560n, 'REDUCING'), asOfEpochSeconds: 0n, referenceId: 'dev-benchmark' };
const DEV_RANGE = { productClass: 'PERSONAL', lowBp: 600n, medianBp: 900n, highBp: 1_500n, asOfEpochSeconds: 0n, referenceId: 'dev-range' };
export const DEV_AFFORDABILITY = { monthlyIncome: money(1_500_000n), existingMonthlyObligations: money(0n), outstandingSameClass: money(0n), incomeSourceRef: 'dev-employment-verification' };

export function consumerProducts(): readonly { readonly entry: CatalogueEntry; readonly module: AnyProductModule }[] {
  const catalogue = loadProductCatalogue(TENANT);
  if (!catalogue.ok) return [];
  return catalogue.value.entries.flatMap((entry) => {
    const found = REGISTRY.find(entry.productCode);
    return entry.enabled && found.ok && found.value.descriptor.consumer ? [{ entry, module: found.value }] : [];
  });
}

export function quoteFor(productCode: string, amountMinorUnits: bigint, months: number, applicantRef: string, at: TsaInstant): Result<{ readonly offer: Offer; readonly programmeId: string }> {
  const catalogue = loadProductCatalogue(TENANT);
  if (!catalogue.ok) return catalogue;
  const entry = entryFor(catalogue.value, productCode, 'prg-0001', at.epochSeconds);
  if (!entry.ok) return entry;
  const found = REGISTRY.find(productCode);
  if (!found.ok) return found;
  if (!found.value.descriptor.consumer) return reject('OP-DETERMINACY', 'NOT_A_CONSUMER_PRODUCT', 'This product is not offered to individuals');
  const terms = found.value.validateTerms(entry.value.terms);
  if (!terms.ok) return terms;
  const principal = money(amountMinorUnits);
  const inputs = resolvePricingInputs(entry.value.pricingRule, { principal, tenorDays: months * 30, asOfEpochSeconds: at.epochSeconds, benchmark: DEV_BENCHMARK, marketRange: DEV_RANGE });
  if (!inputs.ok) return inputs;
  const quote = found.value.quote(terms.value, { tenantId: TENANT, programmeId: 'prg-0001', counterpartyId: applicantRef, requestedAmount: principal, requestedTenorDays: months * 30, asOf: at, pricing: inputs.value, affordability: DEV_AFFORDABILITY });
  if (!quote.ok) return quote;
  const offer = buildOffer(found.value, quote.value, at);
  if (!offer.ok) return offer;
  return ok({ offer: offer.value, programmeId: 'prg-0001' });
}

/** Both calendars from an attested instant plus a tenor — computed once, at quotation, and stored. */
export function maturityDates(at: TsaInstant, tenorDays: number): { readonly gregorian: string; readonly hijri: string } {
  const date = new Date((Number(at.epochSeconds) + tenorDays * 86_400) * 1000);
  const gregorian = date.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { gregorian, hijri: `${get('year').replace(/\D/g, '')}-${get('month')}-${get('day')}` };
}
