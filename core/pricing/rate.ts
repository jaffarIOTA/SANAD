/**
 * Rates, as first-class typed values (ADR 0002, CLAUDE.md §4.1).
 *
 * A rate is integer basis points as `bigint` — never a `number`, never a
 * percentage string in the domain. 1 bp = 0.01%. It carries its basis and its
 * period so that two rates cannot be compared or added without both being
 * stated, and it is converted for display only, in the `<Rate>` component.
 *
 * Every rate that reaches an offer is effective-dated and carries its source.
 * A manual override is a discriminated case that cannot be constructed without
 * an approval reference: there is no anonymous rate.
 *
 * Nothing in this file applies to the Murabaha module, which prices by amount.
 */

import { type Money, money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

export type RateBasis = 'FLAT' | 'REDUCING' | 'APR';
export type RatePeriod = 'ANNUAL' | 'MONTHLY';

export interface Rate {
  readonly bp: bigint;
  readonly basis: RateBasis;
  readonly period: RatePeriod;
}

export const BP_PER_UNIT = 10_000n;
export const DAYS_PER_YEAR = 365n;

export function rate(bp: bigint, basis: RateBasis, period: RatePeriod = 'ANNUAL'): Rate {
  return { bp, basis, period };
}

export const isNonNegative = (r: Rate): boolean => r.bp >= 0n;

/** Add basis points to a rate of the same basis and period — a margin over a benchmark. */
export function addBp(r: Rate, bp: bigint): Rate {
  return { ...r, bp: r.bp + bp };
}

export function sameShape(a: Rate, b: Rate): boolean {
  return a.basis === b.basis && a.period === b.period;
}

/**
 * The amount an annual rate yields on a principal over a number of days.
 * Integer arithmetic, rounded half up at the last step: amount × bp × days /
 * (10 000 × 365). Used for flat and simple-reducing schedules; a product
 * module that needs another convention writes it in its own pricing.ts.
 */
export function accrue(principal: Money, r: Rate, days: bigint): Result<Money> {
  if (r.period !== 'ANNUAL') {
    return reject('PLAT-02', 'RATE_PERIOD_NOT_ANNUAL', 'accrue() takes an annual rate', { period: r.period });
  }
  if (days < 0n) return reject('PLAT-02', 'NEGATIVE_DAYS', 'A period cannot be negative');
  const numerator = principal.minorUnits * r.bp * days;
  const denominator = BP_PER_UNIT * DAYS_PER_YEAR;
  return ok(money(roundDiv(numerator, denominator), principal.currency));
}

/** Integer division rounded half away from zero. */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  const negative = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return negative ? -q : q;
}

// -- Sourced, effective-dated rates -------------------------------------------

export type RateSource = 'TENANT_CATALOGUE' | 'RATE_PUBLISHER' | 'MANUAL_OVERRIDE';

interface RateRecordBase {
  readonly rate: Rate;
  readonly effectiveFromEpochSeconds: bigint;
  readonly effectiveToEpochSeconds?: bigint;
}

export type RateRecord =
  | (RateRecordBase & { readonly source: 'TENANT_CATALOGUE'; readonly catalogueRef: string })
  | (RateRecordBase & { readonly source: 'RATE_PUBLISHER'; readonly publisherReferenceId: string })
  | (RateRecordBase & {
      readonly source: 'MANUAL_OVERRIDE';
      /** Who, under what approval, and why. Without these the case cannot be built. */
      readonly overriddenBy: string;
      readonly approvalRef: string;
      readonly justification: string;
    });

/** The record in force at an instant, or a rejection. Never a stale rate silently. */
export function rateInForce(records: readonly RateRecord[], atEpochSeconds: bigint): Result<RateRecord> {
  const inForce = records
    .filter((r) => r.effectiveFromEpochSeconds <= atEpochSeconds && (r.effectiveToEpochSeconds === undefined || r.effectiveToEpochSeconds > atEpochSeconds))
    .sort((a, b) => (a.effectiveFromEpochSeconds === b.effectiveFromEpochSeconds ? 0 : a.effectiveFromEpochSeconds < b.effectiveFromEpochSeconds ? 1 : -1));
  const latest = inForce[0];
  if (latest === undefined) {
    return reject('PLAT-03', 'NO_RATE_IN_FORCE', 'No rate is in force at the moment being priced', { atEpochSeconds: String(atEpochSeconds) });
  }
  return ok(latest);
}

/** A snapshot for an executed offer: the rate and where it came from, frozen. */
export interface RateSnapshot {
  readonly rate: Rate;
  readonly source: RateSource;
  readonly sourceRef: string;
  readonly snapshottedAtEpochSeconds: bigint;
}

export function snapshot(record: RateRecord, atEpochSeconds: bigint): RateSnapshot {
  const sourceRef =
    record.source === 'TENANT_CATALOGUE' ? record.catalogueRef : record.source === 'RATE_PUBLISHER' ? record.publisherReferenceId : record.approvalRef;
  return { rate: record.rate, source: record.source, sourceRef, snapshottedAtEpochSeconds: atEpochSeconds };
}
