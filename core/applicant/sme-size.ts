/**
 * Enterprise size classification, from a cited regulatory definition held as
 * configuration (`config/regulatory/<jurisdiction>/sme-definition.json`).
 *
 * Two jurisdictions, two shapes (ADR 0005):
 *
 *   - Saudi Arabia (SAMA's adoption of the national definition): one set of
 *     bands; revenue decides, and full-time employees decide only where there
 *     is no revenue history — rule `REVENUE_THEN_EMPLOYEES`.
 *   - UAE (the unified federal definition): bands per sector — trading,
 *     manufacturing, services — on employees and revenue. Where the two
 *     criteria point to different classes the higher class is taken — rule
 *     `HIGHER_OF_BOTH` — so an enterprise is never under-classified; the
 *     interpretation is recorded in the definition file for confirmation.
 *
 * The figures are not in this file. They live in the configuration with the
 * instrument they come from, in the jurisdiction's currency.
 *
 * Pure. Money is minor-unit bigint; employees are a count.
 */

import { type CurrencyCode, type Money, CURRENCY_CODES } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

export type SmeSizeClass = 'MICRO' | 'SMALL' | 'MEDIUM' | 'LARGE';
export const SME_SIZE_CLASSES: readonly SmeSizeClass[] = ['MICRO', 'SMALL', 'MEDIUM', 'LARGE'];

export type ClassificationRule = 'REVENUE_THEN_EMPLOYEES' | 'HIGHER_OF_BOTH';

export interface SizeBand {
  readonly sizeClass: Exclude<SmeSizeClass, 'LARGE'>;
  /** Inclusive upper bound of annual revenue for this band. */
  readonly revenueUpToMinorUnits: bigint;
  /** Inclusive upper bound of full-time employees for this band. */
  readonly employeesUpTo: number;
}

export interface SmeDefinition {
  readonly currency: CurrencyCode;
  readonly rule: ClassificationRule;
  /** Bands per sector, ascending micro → small → medium. `ALL` where the definition has no sectors. */
  readonly sectors: Readonly<Record<string, readonly SizeBand[]>>;
  /** The instrument and article the bands come from. Required. */
  readonly citation: string;
  readonly effectiveFromEpochSeconds: bigint;
}

export interface SizeClassification {
  readonly sizeClass: SmeSizeClass;
  /** Which criterion decided it, recorded on the decision. */
  readonly basis: 'REVENUE' | 'EMPLOYEES';
  readonly sector: string;
  readonly citation: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntString = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const ORDER: readonly SizeBand['sizeClass'][] = ['MICRO', 'SMALL', 'MEDIUM'];
const RANK: Readonly<Record<SmeSizeClass, number>> = { MICRO: 0, SMALL: 1, MEDIUM: 2, LARGE: 3 };

function parseBands(raw: unknown): Result<readonly SizeBand[]> {
  const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);
  if (!Array.isArray(raw)) return bad('SME_DEFINITION_BANDS', 'Each sector lists its bands');
  const bands: SizeBand[] = [];
  for (const [i, b] of raw.entries()) {
    if (!isRecord(b) || b['sizeClass'] !== ORDER[i]) return bad('SME_DEFINITION_BAND_ORDER', 'Bands are MICRO, SMALL, MEDIUM in that order');
    if (!isIntString(b['revenueUpToMinorUnits'])) return bad('SME_DEFINITION_REVENUE', 'revenueUpToMinorUnits is an integer string');
    const employees = b['employeesUpTo'];
    if (typeof employees !== 'number' || !Number.isInteger(employees) || employees <= 0) return bad('SME_DEFINITION_EMPLOYEES', 'employeesUpTo is a positive whole number');
    const band: SizeBand = { sizeClass: ORDER[i] as SizeBand['sizeClass'], revenueUpToMinorUnits: BigInt(b['revenueUpToMinorUnits']), employeesUpTo: employees };
    const previous = bands[bands.length - 1];
    if (previous !== undefined && (band.revenueUpToMinorUnits <= previous.revenueUpToMinorUnits || band.employeesUpTo <= previous.employeesUpTo)) return bad('SME_DEFINITION_NOT_ASCENDING', 'Each band is strictly above the one before it');
    bands.push(band);
  }
  if (bands.length !== ORDER.length) return bad('SME_DEFINITION_BANDS', 'Exactly three bands per sector: micro, small, medium');
  return ok(bands);
}

export function parseSmeDefinition(raw: unknown): Result<SmeDefinition> {
  const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);
  if (!isRecord(raw) || !isRecord(raw['sectors'])) return bad('SME_DEFINITION_MALFORMED', 'An SME definition has a currency, a rule, sectors of bands, a citation and an effective date');
  if (typeof raw['citation'] !== 'string' || raw['citation'].trim().length < 10) return bad('SME_DEFINITION_CITATION_REQUIRED', 'A regulatory definition carries the instrument it comes from');
  if (!CURRENCY_CODES.includes(raw['currency'] as CurrencyCode)) return bad('SME_DEFINITION_CURRENCY', 'currency is the jurisdiction’s ISO 4217 code');
  if (raw['rule'] !== 'REVENUE_THEN_EMPLOYEES' && raw['rule'] !== 'HIGHER_OF_BOTH') return bad('SME_DEFINITION_RULE', 'rule is REVENUE_THEN_EMPLOYEES or HIGHER_OF_BOTH');
  if (!isIntString(raw['effectiveFromEpochSeconds'])) return bad('SME_DEFINITION_EFFECTIVE_FROM', 'effectiveFromEpochSeconds is an integer string');
  const sectors: Record<string, readonly SizeBand[]> = {};
  for (const [name, bands] of Object.entries(raw['sectors'])) {
    if (!/^[A-Z_]{3,20}$/.test(name)) return bad('SME_DEFINITION_SECTOR', 'Sector names are upper-case codes');
    const parsed = parseBands(bands);
    if (!parsed.ok) return parsed;
    sectors[name] = parsed.value;
  }
  if (Object.keys(sectors).length === 0) return bad('SME_DEFINITION_SECTORS', 'At least one sector');
  return ok({ currency: raw['currency'] as CurrencyCode, rule: raw['rule'], sectors, citation: raw['citation'], effectiveFromEpochSeconds: BigInt(raw['effectiveFromEpochSeconds']) });
}

const byRevenue = (bands: readonly SizeBand[], revenue: bigint): SmeSizeClass => bands.find((b) => revenue <= b.revenueUpToMinorUnits)?.sizeClass ?? 'LARGE';
const byEmployees = (bands: readonly SizeBand[], employees: number): SmeSizeClass => bands.find((b) => employees <= b.employeesUpTo)?.sizeClass ?? 'LARGE';

/**
 * Classify under the definition's own rule. A definition with sectors needs
 * the enterprise's sector; one with a single `ALL` sector ignores it. An
 * enterprise that cannot be classified is refused rather than guessed.
 */
export function classifySme(def: SmeDefinition, facts: { readonly annualRevenue?: Money; readonly fullTimeEmployees: number; readonly sector?: string }): Result<SizeClassification> {
  const sector = def.sectors['ALL'] !== undefined ? 'ALL' : facts.sector;
  const bands = sector === undefined ? undefined : def.sectors[sector];
  if (sector === undefined || bands === undefined) return reject('OP-DETERMINACY', 'SECTOR_REQUIRED', 'This jurisdiction’s SME definition differs by sector, and the enterprise’s sector is not one it lists', { sectors: Object.keys(def.sectors).join(',') });
  if (facts.annualRevenue !== undefined) {
    if (facts.annualRevenue.currency !== def.currency) return reject('OP-DETERMINACY', 'REVENUE_CURRENCY_MISMATCH', 'Revenue is classified in the definition’s own currency', { expected: def.currency, given: facts.annualRevenue.currency });
    if (facts.annualRevenue.minorUnits < 0n) return reject('OP-DETERMINACY', 'REVENUE_NEGATIVE', 'Annual revenue cannot be negative');
  }
  const hasStaff = Number.isInteger(facts.fullTimeEmployees) && facts.fullTimeEmployees >= 1;
  const revenueClass = facts.annualRevenue === undefined ? undefined : byRevenue(bands, facts.annualRevenue.minorUnits);
  const staffClass = hasStaff ? byEmployees(bands, facts.fullTimeEmployees) : undefined;
  const base = { sector, citation: def.citation };

  if (def.rule === 'REVENUE_THEN_EMPLOYEES') {
    if (revenueClass !== undefined) return ok({ ...base, sizeClass: revenueClass, basis: 'REVENUE' });
    if (staffClass !== undefined) return ok({ ...base, sizeClass: staffClass, basis: 'EMPLOYEES' });
  } else {
    if (revenueClass !== undefined && staffClass !== undefined) {
      return ok(RANK[revenueClass] >= RANK[staffClass] ? { ...base, sizeClass: revenueClass, basis: 'REVENUE' } : { ...base, sizeClass: staffClass, basis: 'EMPLOYEES' });
    }
    if (revenueClass !== undefined) return ok({ ...base, sizeClass: revenueClass, basis: 'REVENUE' });
    if (staffClass !== undefined) return ok({ ...base, sizeClass: staffClass, basis: 'EMPLOYEES' });
  }
  return reject('OP-DETERMINACY', 'SIZE_UNCLASSIFIABLE', 'Neither a revenue history nor a count of full-time employees was given');
}
