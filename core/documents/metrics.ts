/**
 * Document throughput (document intelligence D5): how the reading and the
 * checks are doing, measured against what the checkers decided.
 *
 * Measurement only. Nothing here accepts, refuses or ranks a document, and
 * nothing reads it back into a decision (product owner, 19 October 2026:
 * always four eyes). It is what would inform revisiting that decision: how
 * often the reader named the document right, how often the checker accepted
 * a document a check had failed, how many touches a pack takes and how long.
 *
 * Pure: the documents, their decisions and their findings in; counts and
 * durations out. Durations are whole seconds; nothing is a float.
 */
import type { CheckOutcome } from './understanding.ts';

/** One presented document as the measurement needs it. */
export interface MeasuredDocument {
  readonly documentType: string;
  readonly presentedAtEpochSeconds: bigint;
  readonly decision: 'VALID' | 'INVALID' | 'PENDING';
  readonly decidedAtEpochSeconds?: bigint;
  /** The checks on its latest reading; absent where it was not read (referenced, or no engine). */
  readonly checks?: readonly { readonly check: string; readonly outcome: CheckOutcome }[];
}

/** One application (or request) and its documents, in the order presented. */
export interface MeasuredSubject {
  readonly documents: readonly MeasuredDocument[];
  /** The document types its checklist requires: the pack is complete when each has an accepted document. */
  readonly requiredTypes: readonly string[];
  /** Requests to the applicant for documents (D4). */
  readonly requests: number;
}

export interface CheckTally {
  readonly pass: number;
  readonly fail: number;
  readonly unreadable: number;
}

export interface DocumentMetrics {
  readonly documents: number;
  /** Documents with a reading (uploaded and read). */
  readonly read: number;
  /**
   * The first document presented for each type, against the checker's decision:
   * named right (read as the type, accepted), named wrong (read as another type, accepted anyway),
   * flagged and refused (read as another type, refused), not named (not recognised, decided).
   */
  readonly firstAttempt: {
    readonly namedRight: number;
    readonly namedWrong: number;
    readonly flaggedAndRefused: number;
    readonly notNamed: number;
  };
  /** Every check, by code, over the latest reading of every document. */
  readonly checks: Readonly<Record<string, CheckTally>>;
  /** Decided documents with at least one check that could be made, against the checker. */
  readonly checker: {
    readonly decided: number;
    /** Accepted with nothing failing, or refused with something failing. */
    readonly agreed: number;
    /** Accepted although a check failed: the checker overrode the finding. By check. */
    readonly acceptedDespiteFailure: number;
    readonly acceptedDespiteFailureByCheck: Readonly<Record<string, number>>;
    /** Refused although nothing failed: the checker saw what the checks did not. */
    readonly refusedWithNothingFailing: number;
  };
  /** Presentations and requests per application that has any document. */
  readonly touchpoints: { readonly applications: number; readonly median: number; readonly max: number };
  /** From the first document to the last acceptance that completed the pack, for packs complete now. */
  readonly timeToComplete: {
    readonly complete: number;
    readonly medianSeconds?: bigint;
    readonly p90Seconds?: bigint;
  };
}

/** The value at a rank (0-based, of n) in an ascending list: the lower middle for a median. */
const at = <T>(sorted: readonly T[], rank: number): T | undefined =>
  sorted[Math.max(0, Math.min(sorted.length - 1, rank))];
const p90Rank = (n: number): number => Math.ceil((n * 9) / 10) - 1;
const medianRank = (n: number): number => Math.floor((n - 1) / 2);

export function documentMetrics(subjects: readonly MeasuredSubject[]): DocumentMetrics {
  let documents = 0;
  let read = 0;
  const first = { namedRight: 0, namedWrong: 0, flaggedAndRefused: 0, notNamed: 0 };
  const checks: Record<string, { pass: number; fail: number; unreadable: number }> = {};
  const checker = {
    decided: 0,
    agreed: 0,
    acceptedDespiteFailure: 0,
    acceptedDespiteFailureByCheck: {} as Record<string, number>,
    refusedWithNothingFailing: 0,
  };
  const touches: number[] = [];
  const durations: bigint[] = [];

  for (const s of subjects) {
    if (s.documents.length > 0) touches.push(s.documents.length + s.requests);
    const seenTypes = new Set<string>();
    for (const d of s.documents) {
      documents += 1;
      const firstOfType = !seenTypes.has(d.documentType);
      seenTypes.add(d.documentType);
      if (d.checks === undefined) continue;
      read += 1;
      for (const c of d.checks) {
        const t = (checks[c.check] ??= { pass: 0, fail: 0, unreadable: 0 });
        if (c.outcome === 'PASS') t.pass += 1;
        else if (c.outcome === 'FAIL') t.fail += 1;
        else t.unreadable += 1;
      }
      if (d.decision === 'PENDING') continue;
      const type = d.checks.find((c) => c.check === 'TYPE_MATCHES_DECLARED')?.outcome;
      if (firstOfType) {
        if (type === 'UNREADABLE' || type === undefined) first.notNamed += 1;
        else if (d.decision === 'VALID') first[type === 'PASS' ? 'namedRight' : 'namedWrong'] += 1;
        else if (type === 'FAIL') first.flaggedAndRefused += 1;
      }
      const made = d.checks.filter((c) => c.outcome !== 'UNREADABLE');
      if (made.length === 0) continue;
      const failed = made.filter((c) => c.outcome === 'FAIL').map((c) => c.check);
      checker.decided += 1;
      if ((d.decision === 'VALID') === (failed.length === 0)) checker.agreed += 1;
      if (d.decision === 'VALID' && failed.length > 0) {
        checker.acceptedDespiteFailure += 1;
        for (const c of failed)
          checker.acceptedDespiteFailureByCheck[c] = (checker.acceptedDespiteFailureByCheck[c] ?? 0) + 1;
      }
      if (d.decision === 'INVALID' && failed.length === 0) checker.refusedWithNothingFailing += 1;
    }

    // Complete now: every required type's latest document accepted. Completed at the last of those acceptances.
    const firstAt = s.documents.reduce<bigint | undefined>(
      (m, d) => (m === undefined || d.presentedAtEpochSeconds < m ? d.presentedAtEpochSeconds : m),
      undefined,
    );
    let completedAt: bigint | undefined = 0n;
    for (const type of s.requiredTypes) {
      const latest = [...s.documents].reverse().find((d) => d.documentType === type);
      if (latest?.decision !== 'VALID' || latest.decidedAtEpochSeconds === undefined) {
        completedAt = undefined;
        break;
      }
      if (completedAt !== undefined && latest.decidedAtEpochSeconds > completedAt)
        completedAt = latest.decidedAtEpochSeconds;
    }
    if (s.requiredTypes.length > 0 && completedAt !== undefined && firstAt !== undefined && completedAt >= firstAt)
      durations.push(completedAt - firstAt);
  }

  const sortedTouches = [...touches].sort((a, b) => a - b);
  const sortedDurations = [...durations].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = at(sortedDurations, medianRank(sortedDurations.length));
  const p90 = at(sortedDurations, p90Rank(sortedDurations.length));
  return {
    documents,
    read,
    firstAttempt: first,
    checks,
    checker,
    touchpoints: {
      applications: touches.length,
      median: at(sortedTouches, medianRank(sortedTouches.length)) ?? 0,
      max: sortedTouches.at(-1) ?? 0,
    },
    timeToComplete: {
      complete: durations.length,
      ...(median === undefined ? {} : { medianSeconds: median }),
      ...(p90 === undefined ? {} : { p90Seconds: p90 }),
    },
  };
}
