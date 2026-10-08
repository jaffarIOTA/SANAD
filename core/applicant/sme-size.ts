/**
 * Enterprise size classification, from a cited regulatory definition held as
 * configuration (`config/regulatory/sme-definition.json`).
 *
 * The definition in force for SAMA-regulated finance is SAMA's own adoption
 * of the national SME definition: the class is decided by annual revenue, and
 * by the count of full-time employees only where there is no revenue history
 * (a new enterprise). The figures are not in this file. They live in the
 * configuration with the circular they come from, so a change of definition
 * is a configuration change with a citation, never a code edit.
 *
 * Pure. Money is minor-unit bigint; employees are a count.
 */

import { type Money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

export type SmeSizeClass = 'MICRO' | 'SMALL' | 'MEDIUM' | 'LARGE';
export const SME_SIZE_CLASSES: readonly SmeSizeClass[] = ['MICRO', 'SMALL', 'MEDIUM', 'LARGE'];

export interface SizeBand {
  readonly sizeClass: Exclude<SmeSizeClass, 'LARGE'>;
  /** Inclusive upper bound of annual revenue for this band. */
  readonly revenueUpToMinorUnits: bigint;
  /** Inclusive upper bound of full-time employees for this band. */
  readonly employeesUpTo: number;
}

export interface SmeDefinition {
  /** Ascending: micro, small, medium. Anything above the last band is large. */
  readonly bands: readonly SizeBand[];
  /** The regulation and article the bands come from. Required. */
  readonly citation: string;
  readonly effectiveFromEpochSeconds: bigint;
}

export interface SizeClassification {
  readonly sizeClass: SmeSizeClass;
  /** Which criterion decided it, recorded on the decision. */
  readonly basis: 'REVENUE' | 'EMPLOYEES';
  readonly citation: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntString = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const ORDER: readonly SizeBand['sizeClass'][] = ['MICRO', 'SMALL', 'MEDIUM'];

export function parseSmeDefinition(raw: unknown): Result<SmeDefinition> {
  const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);
  if (!isRecord(raw) || !Array.isArray(raw['bands'])) return bad('SME_DEFINITION_MALFORMED', 'An SME definition has bands, a citation and an effective date');
  if (typeof raw['citation'] !== 'string' || raw['citation'].trim().length < 10) return bad('SME_DEFINITION_CITATION_REQUIRED', 'A regulatory definition carries the circular it comes from');
  if (!isIntString(raw['effectiveFromEpochSeconds'])) return bad('SME_DEFINITION_EFFECTIVE_FROM', 'effectiveFromEpochSeconds is an integer string');
  const bands: SizeBand[] = [];
  for (const [i, b] of (raw['bands'] as unknown[]).entries()) {
    if (!isRecord(b) || b['sizeClass'] !== ORDER[i]) return bad('SME_DEFINITION_BAND_ORDER', 'Bands are MICRO, SMALL, MEDIUM in that order');
    if (!isIntString(b['revenueUpToMinorUnits'])) return bad('SME_DEFINITION_REVENUE', 'revenueUpToMinorUnits is an integer string');
    const employees = b['employeesUpTo'];
    if (typeof employees !== 'number' || !Number.isInteger(employees) || employees <= 0) return bad('SME_DEFINITION_EMPLOYEES', 'employeesUpTo is a positive whole number');
    const band: SizeBand = { sizeClass: ORDER[i] as SizeBand['sizeClass'], revenueUpToMinorUnits: BigInt(b['revenueUpToMinorUnits']), employeesUpTo: employees };
    const previous = bands[bands.length - 1];
    if (previous !== undefined && (band.revenueUpToMinorUnits <= previous.revenueUpToMinorUnits || band.employeesUpTo <= previous.employeesUpTo)) return bad('SME_DEFINITION_NOT_ASCENDING', 'Each band is strictly above the one before it');
    bands.push(band);
  }
  if (bands.length !== ORDER.length) return bad('SME_DEFINITION_BANDS', 'Exactly three bands: micro, small, medium');
  return ok({ bands, citation: raw['citation'], effectiveFromEpochSeconds: BigInt(raw['effectiveFromEpochSeconds']) });
}

/**
 * Revenue decides; employees decide only when there is no revenue history.
 * A business with neither a revenue figure nor at least one employee cannot be
 * classified and is refused rather than guessed.
 */
export function classifySme(def: SmeDefinition, facts: { readonly annualRevenue?: Money; readonly fullTimeEmployees: number }): Result<SizeClassification> {
  if (facts.annualRevenue !== undefined) {
    if (facts.annualRevenue.minorUnits < 0n) return reject('OP-DETERMINACY', 'REVENUE_NEGATIVE', 'Annual revenue cannot be negative');
    const band = def.bands.find((b) => facts.annualRevenue !== undefined && facts.annualRevenue.minorUnits <= b.revenueUpToMinorUnits);
    return ok({ sizeClass: band?.sizeClass ?? 'LARGE', basis: 'REVENUE', citation: def.citation });
  }
  if (!Number.isInteger(facts.fullTimeEmployees) || facts.fullTimeEmployees < 1) {
    return reject('OP-DETERMINACY', 'SIZE_UNCLASSIFIABLE', 'With no revenue history the enterprise is classified by its full-time employees, and none were given');
  }
  const band = def.bands.find((b) => facts.fullTimeEmployees <= b.employeesUpTo);
  return ok({ sizeClass: band?.sizeClass ?? 'LARGE', basis: 'EMPLOYEES', citation: def.citation });
}
