/**
 * The Products & modules area: the catalogue in force, and a proposed change
 * to one entry, validated by the same parsers production uses before it may
 * be proposed. A change is the whole catalogue with one entry replaced, so a
 * revision is self-contained and reproducible.
 */

import { randomUUID } from 'node:crypto';

import type { TenantCode } from '@sanad/config/loader.ts';
import { proposeRevision as proposePure } from '@sanad/core/config/revision.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type CatalogueEntry, type ProductCatalogue, parseProductCatalogue } from '@sanad/core/products/catalogue.ts';
import { ISLAMIC_PRODUCT_CODES, ProductRegistry } from '@sanad/core/products/registry.ts';
import { resolveProductCatalogue } from '@sanad/origination/catalogue.ts';
import { bnpl } from '@sanad/products/bnpl/index.ts';
import { conventionalTerm } from '@sanad/products/conventional-term/index.ts';
import { smeTermConventional } from '@sanad/products/sme-term-conventional/index.ts';
import { smeTermIslamic } from '@sanad/products/sme-term-islamic/index.ts';
import { embeddedLending } from '@sanad/products/embedded-lending/index.ts';
import { murabahaScf } from '@sanad/products/murabaha-scf/index.ts';
import { tawarruqPersonal } from '@sanad/products/tawarruq-personal/index.ts';

export const REGISTRY = new ProductRegistry().register(murabahaScf).register(tawarruqPersonal).register(bnpl).register(embeddedLending).register(conventionalTerm).register(smeTermConventional).register(smeTermIslamic);

export { resolveProductCatalogue };

/** The catalogue as JSON again: bigint fields back to the strings the file format uses. */
export function catalogueToJson(c: ProductCatalogue): unknown {
  return {
    version: c.version,
    entries: c.entries.map((e) => ({
      productCode: e.productCode, enabled: e.enabled, nameEn: e.nameEn, nameAr: e.nameAr, programmeIds: e.programmeIds,
      ...(e.boardRulingRef === undefined ? {} : { boardRulingRef: e.boardRulingRef }),
      ...(e.coreBankingProductCode === undefined ? {} : { coreBankingProductCode: e.coreBankingProductCode }),
      pricingRule: e.pricingRule, terms: e.terms, effectiveFromEpochSeconds: e.effectiveFromEpochSeconds.toString(),
    })),
  };
}

export interface EntryChange {
  readonly productCode: string;
  readonly enabled: boolean;
  /** The term sheet as JSON text, validated by the module's own parser. */
  readonly termsJson: string;
  readonly boardRulingRef?: string;
  /** The core banking product type this product books under; empty clears it. */
  readonly coreBankingProductCode?: string;
}

/** The whole catalogue with one entry changed, parsed as production would parse it. Refuses before anything is proposed. */
export function catalogueWithChange(current: ProductCatalogue, change: EntryChange): Result<{ readonly payload: unknown; readonly parsed: ProductCatalogue }> {
  const found = REGISTRY.find(change.productCode);
  if (!found.ok) return found;
  let terms: unknown;
  try { terms = JSON.parse(change.termsJson); } catch { return reject('OP-DETERMINACY', 'TERMS_NOT_JSON', 'The term sheet is not valid JSON'); }
  const validTerms = found.value.validateTerms(terms);
  if (!validTerms.ok) return validTerms;
  const existing = current.entries.find((e) => e.productCode === change.productCode);
  if (existing === undefined) return reject('OP-DETERMINACY', 'PRODUCT_NOT_IN_CATALOGUE', 'Adding a product to the catalogue is a separate change', { productCode: change.productCode });
  const { coreBankingProductCode: _previousCore, ...rest } = existing;
  const next: CatalogueEntry = {
    ...rest, enabled: change.enabled, terms,
    ...(change.boardRulingRef === undefined ? {} : { boardRulingRef: change.boardRulingRef }),
    ...(change.coreBankingProductCode === undefined || change.coreBankingProductCode.trim().length === 0 ? {} : { coreBankingProductCode: change.coreBankingProductCode.trim() }),
  };
  const payload = catalogueToJson({ version: current.version, entries: current.entries.map((e) => (e.productCode === change.productCode ? next : e)) });
  const parsed = parseProductCatalogue(payload, ISLAMIC_PRODUCT_CODES);
  if (!parsed.ok) return parsed;
  return ok({ payload, parsed: parsed.value });
}

/**
 * Modules the platform ships that are not in the catalogue in force, each with
 * the checked-in term sheet for this tenant as its starting point. Adding one is
 * a proposal like any other change: a second administrator approves it.
 */
export function productsNotInCatalogue(current: ProductCatalogue, template: ProductCatalogue): readonly CatalogueEntry[] {
  const have = new Set(current.entries.map((e) => e.productCode));
  return template.entries.filter((e) => !have.has(e.productCode) && REGISTRY.find(e.productCode).ok);
}

/** The whole catalogue with one entry added from the checked-in template, parsed as production would parse it. */
export function catalogueWithAddition(current: ProductCatalogue, template: ProductCatalogue, productCode: string): Result<{ readonly payload: unknown; readonly parsed: ProductCatalogue }> {
  if (current.entries.some((e) => e.productCode === productCode)) return reject('OP-DETERMINACY', 'PRODUCT_ALREADY_IN_CATALOGUE', 'The product is already in the catalogue; propose a change to it instead', { productCode });
  const entry = template.entries.find((e) => e.productCode === productCode);
  if (entry === undefined) return reject('OP-DETERMINACY', 'PRODUCT_HAS_NO_TEMPLATE', 'This tenant has no checked-in term sheet for the product', { productCode });
  const module = REGISTRY.find(productCode);
  if (!module.ok) return module;
  const terms = module.value.validateTerms(entry.terms);
  if (!terms.ok) return terms;
  const payload = catalogueToJson({ version: current.version, entries: [...current.entries, entry] });
  const parsed = parseProductCatalogue(payload, ISLAMIC_PRODUCT_CODES);
  if (!parsed.ok) return parsed;
  return ok({ payload, parsed: parsed.value });
}

/** The pure rule set's view of a proposal, so the screen refuses exactly what the database would. */
export function checkProposal(p: { readonly tenant: TenantCode; readonly payload: unknown; readonly summary: string; readonly effectiveFromEpochSeconds: bigint; readonly proposedBy: string; readonly nowEpochSeconds: bigint }): Result<unknown> {
  return proposePure({ id: randomUUID(), tenantId: p.tenant, area: 'PRODUCTS', rawPayload: p.payload, summary: p.summary, effectiveFromEpochSeconds: p.effectiveFromEpochSeconds, proposedBy: p.proposedBy, proposedAtEpochSeconds: p.nowEpochSeconds, parse: (raw) => parseProductCatalogue(raw, ISLAMIC_PRODUCT_CODES) });
}
