/**
 * A tenant's product catalogue: which product modules are enabled, under
 * which terms, on which programmes, priced by which rule. Data, effective-dated,
 * parsed strictly. An Islamic product without a board ruling reference does
 * not parse.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import type { RateBasis } from '../pricing/rate.ts';

export type PricingRule =
  | { readonly kind: 'FIXED_PROFIT_AMOUNT'; readonly profitMinorUnits: string }
  /** Profit amount = cost × rate × tenor, with the rate from the tenant's own catalogue. The rate lives here, not in the product. */
  | { readonly kind: 'CATALOGUE_RATE'; readonly bp: string; readonly basis: RateBasis; readonly catalogueRef: string }
  /** Rate = published benchmark + margin, bounded by the published market range where set. */
  | { readonly kind: 'BENCHMARK_PLUS_MARGIN'; readonly benchmarkCode: string; readonly marginBp: string; readonly basis: RateBasis; readonly boundByMarketRange?: boolean };

export interface CatalogueEntry {
  readonly productCode: string;
  readonly enabled: boolean;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly programmeIds: readonly string[] | 'ALL';
  readonly boardRulingRef?: string;
  readonly pricingRule: PricingRule;
  /** The module's own term sheet. Validated by the module, not here. */
  readonly terms: unknown;
  readonly effectiveFromEpochSeconds: bigint;
}

export interface ProductCatalogue {
  readonly version: string;
  readonly entries: readonly CatalogueEntry[];
}

const ENTRY_KEYS = new Set(['productCode', 'enabled', 'nameEn', 'nameAr', 'programmeIds', 'boardRulingRef', 'pricingRule', 'terms', 'effectiveFromEpochSeconds']);
const RULE_KEYS: Record<PricingRule['kind'], readonly string[]> = {
  FIXED_PROFIT_AMOUNT: ['kind', 'profitMinorUnits'],
  CATALOGUE_RATE: ['kind', 'bp', 'basis', 'catalogueRef'],
  BENCHMARK_PLUS_MARGIN: ['kind', 'benchmarkCode', 'marginBp', 'basis', 'boundByMarketRange'],
};
const BASES: readonly RateBasis[] = ['FLAT', 'REDUCING', 'APR'];

const bad = (reason: string, detail: string, context?: Record<string, string>): Result<never> => reject('OP-DETERMINACY', reason, detail, context);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntString = (v: unknown): v is string => typeof v === 'string' && /^-?\d+$/.test(v);

export function parseProductCatalogue(raw: unknown, islamicProductCodes: ReadonlySet<string>): Result<ProductCatalogue> {
  if (!isRecord(raw) || typeof raw['version'] !== 'string' || !Array.isArray(raw['entries'])) {
    return bad('CATALOGUE_MALFORMED', 'A catalogue has a version and an entries list');
  }
  const entries: CatalogueEntry[] = [];
  for (const e of raw['entries'] as unknown[]) {
    if (!isRecord(e)) return bad('CATALOGUE_ENTRY_MALFORMED', 'An entry is an object');
    const unknown = Object.keys(e).filter((k) => !ENTRY_KEYS.has(k));
    if (unknown.length > 0) return bad('CATALOGUE_UNKNOWN_KEY', 'Unknown key in a catalogue entry', { keys: unknown.join(',') });
    const code = e['productCode'];
    if (typeof code !== 'string' || !/^[a-z][a-z0-9-]+$/.test(code)) return bad('CATALOGUE_PRODUCT_CODE', 'productCode is a lower-case slug');
    if (typeof e['enabled'] !== 'boolean' || typeof e['nameEn'] !== 'string' || typeof e['nameAr'] !== 'string') return bad('CATALOGUE_ENTRY_MALFORMED', 'enabled, nameEn and nameAr are required', { productCode: code });
    const programmes = e['programmeIds'];
    if (programmes !== 'ALL' && !(Array.isArray(programmes) && programmes.every((p) => typeof p === 'string'))) return bad('CATALOGUE_PROGRAMMES', "programmeIds is a list or 'ALL'", { productCode: code });
    if (!isIntString(e['effectiveFromEpochSeconds'])) return bad('CATALOGUE_EFFECTIVE_FROM', 'effectiveFromEpochSeconds is an integer string', { productCode: code });
    const ruling = e['boardRulingRef'];
    if (ruling !== undefined && (typeof ruling !== 'string' || ruling.length === 0)) return bad('CATALOGUE_BOARD_RULING', 'boardRulingRef is a non-empty string when present', { productCode: code });
    if (islamicProductCodes.has(code) && e['enabled'] === true && ruling === undefined) {
      return reject('SH-18', 'BOARD_RULING_REQUIRED', 'An Islamic product cannot be enabled for a tenant without that tenant\'s Shariah board ruling reference', { productCode: code });
    }
    const rule = parseRule(e['pricingRule']);
    if (!rule.ok) return rule;
    entries.push({
      productCode: code,
      enabled: e['enabled'],
      nameEn: e['nameEn'],
      nameAr: e['nameAr'],
      programmeIds: programmes as readonly string[] | 'ALL',
      ...(ruling === undefined ? {} : { boardRulingRef: ruling }),
      pricingRule: rule.value,
      terms: e['terms'],
      effectiveFromEpochSeconds: BigInt(e['effectiveFromEpochSeconds']),
    });
  }
  const codes = entries.map((e) => e.productCode);
  if (new Set(codes).size !== codes.length) return bad('CATALOGUE_DUPLICATE_PRODUCT', 'A product appears once per catalogue');
  return ok({ version: raw['version'], entries });
}

function parseRule(raw: unknown): Result<PricingRule> {
  if (!isRecord(raw) || typeof raw['kind'] !== 'string' || !(raw['kind'] in RULE_KEYS)) return bad('PRICING_RULE_KIND', 'pricingRule.kind is FIXED_PROFIT_AMOUNT, CATALOGUE_RATE or BENCHMARK_PLUS_MARGIN');
  const kind = raw['kind'] as PricingRule['kind'];
  const unknown = Object.keys(raw).filter((k) => !RULE_KEYS[kind].includes(k));
  if (unknown.length > 0) return bad('PRICING_RULE_UNKNOWN_KEY', 'Unknown key in pricingRule', { keys: unknown.join(',') });
  switch (kind) {
    case 'FIXED_PROFIT_AMOUNT':
      return isIntString(raw['profitMinorUnits']) ? ok({ kind, profitMinorUnits: raw['profitMinorUnits'] }) : bad('PRICING_RULE_AMOUNT', 'profitMinorUnits is an integer string');
    case 'CATALOGUE_RATE':
      if (!isIntString(raw['bp']) || !BASES.includes(raw['basis'] as RateBasis) || typeof raw['catalogueRef'] !== 'string') return bad('PRICING_RULE_RATE', 'bp (integer string), basis and catalogueRef are required');
      return ok({ kind, bp: raw['bp'], basis: raw['basis'] as RateBasis, catalogueRef: raw['catalogueRef'] });
    case 'BENCHMARK_PLUS_MARGIN':
      if (typeof raw['benchmarkCode'] !== 'string' || !isIntString(raw['marginBp']) || !BASES.includes(raw['basis'] as RateBasis)) return bad('PRICING_RULE_BENCHMARK', 'benchmarkCode, marginBp (integer string) and basis are required');
      if (raw['boundByMarketRange'] !== undefined && typeof raw['boundByMarketRange'] !== 'boolean') return bad('PRICING_RULE_BOUND', 'boundByMarketRange is a boolean');
      return ok({ kind, benchmarkCode: raw['benchmarkCode'], marginBp: raw['marginBp'], basis: raw['basis'] as RateBasis, ...(raw['boundByMarketRange'] === undefined ? {} : { boundByMarketRange: raw['boundByMarketRange'] }) });
  }
}

export function entryFor(catalogue: ProductCatalogue, productCode: string, programmeId: string, atEpochSeconds: bigint): Result<CatalogueEntry> {
  const entry = catalogue.entries.find((e) => e.productCode === productCode);
  if (entry === undefined || !entry.enabled) return reject('OP-DETERMINACY', 'PRODUCT_NOT_ENABLED', 'This product is not enabled for the tenant', { productCode });
  if (entry.programmeIds !== 'ALL' && !entry.programmeIds.includes(programmeId)) return reject('OP-DETERMINACY', 'PRODUCT_NOT_ON_PROGRAMME', 'This product is not offered on that programme', { productCode, programmeId });
  if (entry.effectiveFromEpochSeconds > atEpochSeconds) return reject('OP-DETERMINACY', 'PRODUCT_NOT_YET_EFFECTIVE', 'This catalogue entry is not yet in force', { productCode });
  return ok(entry);
}
