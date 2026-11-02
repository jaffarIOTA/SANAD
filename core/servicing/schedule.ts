/**
 * The servicing day (Servicing S4): what the daily cycle does for each
 * disbursed facility, and what each answer means. Pure.
 *
 * Each day, in order: late charges are assessed (an instalment overdue beyond
 * the grace days is charged once), then instalments due within the lead
 * window — and any overdue — are presented for collection, then, from the
 * tenant's reporting day of the month, the month's status goes to the credit
 * bureau. Every one of these is already idempotent in the application
 * service: an instalment is charged once, presented once until returned, and
 * each month is reported once. So the cycle may run twice in a day, or be
 * re-run after a failure, and change nothing the second time.
 *
 * The date is the servicing date in the tenant's time zone from an attested
 * instant. The scheduler's own clock only wakes the cycle; it never decides
 * what day it is.
 */
import { type Result, ok, reject } from '../kernel/result.ts';
import { civilDay } from './instalment-position.ts';

export type ServicingTask = 'LATE_CHARGES' | 'COLLECTIONS' | 'BUREAU_REPORT';

/**
 * A task run once for the whole tenant, before any facility (Wasl W4b):
 * reading the collection rail's paid-bills file. First, so the day's receipts
 * are applied before anything is charged late or presented again.
 */
export type TenantTask = 'RECONCILE_COLLECTIONS';

/** The tenant-wide tasks the cycle runs on a servicing date, in order. A malformed date runs nothing. */
export function tenantTasksForDay(date: string): readonly TenantTask[] {
  return civilDay(date) === undefined ? [] : ['RECONCILE_COLLECTIONS'];
}

export interface ServicingSchedule {
  /** When the cycle runs each day, in the tenant's time zone: HH:MM, 24-hour. */
  readonly runAtLocal: string;
  /** From this day of the month (1–28) the month's status is reported to the bureau. */
  readonly bureauReportingDay: number;
}

export function parseServicingSchedule(raw: unknown): Result<ServicingSchedule> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const at = r['runAtLocal'];
  const day = r['bureauReportingDay'];
  if (typeof at !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at))
    return reject('OP-DETERMINACY', 'SERVICING_POLICY_INVALID', 'The servicing cycle runs at a local time, HH:MM');
  if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 28)
    return reject(
      'OP-DETERMINACY',
      'SERVICING_POLICY_INVALID',
      'The bureau reporting day is a day of the month from 1 to 28, so every month has it',
    );
  return ok({ runAtLocal: at, bureauReportingDay: day });
}

/** The tasks the cycle runs on a servicing date, in order. A malformed date runs nothing. */
export function tasksForDay(date: string, schedule: ServicingSchedule): readonly ServicingTask[] {
  if (civilDay(date) === undefined) return [];
  const dayOfMonth = Number(date.slice(8, 10));
  return [
    'LATE_CHARGES',
    'COLLECTIONS',
    ...(dayOfMonth >= schedule.bureauReportingDay ? (['BUREAU_REPORT'] as const) : []),
  ];
}

export type TaskOutcome =
  | { readonly kind: 'DONE' }
  /** Nothing was due: no instalment to charge or present, or the month already reported. */
  | { readonly kind: 'NOTHING_DUE' }
  /** Deliberately not acted on: the customer is in hardship. */
  | { readonly kind: 'HELD' }
  /** Something stopped it that a person must look at; the code says what. */
  | { readonly kind: 'FAILED'; readonly code: string };

const NOTHING_DUE: ReadonlySet<string> = new Set([
  'NOTHING_TO_COLLECT',
  'NO_LATE_CHARGE_DUE',
  'BUREAU_ALREADY_REPORTED',
  'NOTHING_TO_RECONCILE',
  // A task the facility's product does not have (a Wasl transaction is not reported by this task): nothing to do.
  'NOT_FOR_THIS_FACILITY',
]);

/** What a task's refusal means to the cycle. Anything not known to be harmless is a failure to look at. */
export function outcomeOfRefusal(reason: string): TaskOutcome {
  if (NOTHING_DUE.has(reason)) return { kind: 'NOTHING_DUE' };
  if (reason === 'HARDSHIP_HOLD') return { kind: 'HELD' };
  return { kind: 'FAILED', code: reason };
}

export interface ServicingDayReport {
  readonly tenantId: string;
  readonly servicingDate: string;
  readonly facilities: number;
  readonly done: number;
  readonly nothingDue: number;
  readonly held: number;
  /** References and codes only: never a name, an amount or an identifier of a person. */
  readonly failed: readonly {
    /** The facility, or `TENANT` for a tenant-wide task. */
    readonly applicationId: string;
    readonly task: ServicingTask | TenantTask;
    readonly code: string;
  }[];
}
