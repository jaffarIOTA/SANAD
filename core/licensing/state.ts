/**
 * The licence state (ADR 0006 §4), as one pure function.
 *
 * `licenceState(history, installation, now, highWaterMark)` reads the whole
 * installed history — every licence and revocation ever installed, each
 * re-verified here — and answers which state the installation is in, why,
 * and how long it has. It reads no clock (`now` is passed in) and decides
 * nothing: whether an act is permitted is `assertNewBusinessPermitted` in
 * gate.ts, and nowhere else.
 *
 * Rules, in the order they apply:
 *
 *   - **Development.** Outside production, an installation with no licence at
 *     all is `DEVELOPMENT_UNLICENSED`, which the gate permits. In production,
 *     no licence is `NEW_BUSINESS_BLOCKED` (`NO_LICENCE`).
 *   - **Clock rollback.** If `now` is more than one day behind the highest
 *     time this installation has seen, the clock has been wound back:
 *     `NEW_BUSINESS_BLOCKED` (`CLOCK_ROLLBACK`) until it is corrected.
 *   - **The effective licence** is the newest verified one that has started
 *     and has not been superseded by another that has started. A POC
 *     extension installed early therefore takes over on its own `notBefore`,
 *     which is its predecessor's `notAfter`.
 *   - **Coverage** runs from the effective licence through any verified
 *     licence that starts on or before the coverage end (an installed
 *     extension or renewal), so a chain of POC months, or a renewal installed
 *     ahead of time, does not show as expiring.
 *   - **Revocation** ends a licence's term on its `effectiveFrom`; the grace
 *     period starts there. Never an immediate stop.
 *   - Inside coverage: `VALID`, or `EXPIRING` within 60/30/7 days (ANNUAL) or
 *     7/3 days (POC) of the end. Up to `graceDays` after it: `GRACE`. After
 *     that: `NEW_BUSINESS_BLOCKED` (`GRACE_ENDED`).
 */

import { type Licence, type LicenceRefusal, type Revocation, type SignedDocument } from './licence.ts';
import { SECONDS_PER_DAY, ceilDays, parseDate, parseInstant, startOfDay } from './dates.ts';
import { type LicenceVerifier, verifyLicence, verifyRevocation } from './verify.ts';

export type LicenceStatus = 'VALID' | 'EXPIRING' | 'GRACE' | 'NEW_BUSINESS_BLOCKED' | 'DEVELOPMENT_UNLICENSED';

export type LicenceStateReason =
  | 'IN_TERM'
  | 'EXPIRING_SOON'
  | 'EXPIRED_IN_GRACE'
  | 'REVOKED_IN_GRACE'
  | 'GRACE_ENDED'
  | 'NO_LICENCE'
  | 'NO_VALID_LICENCE'
  | 'NOT_YET_VALID'
  | 'CLOCK_ROLLBACK'
  | 'DEVELOPMENT_NO_LICENCE';

/** The days before the end of coverage at which the institution's administrators are told, by kind. */
export const EXPIRING_THRESHOLDS: Readonly<Record<Licence['kind'], readonly number[]>> = {
  ANNUAL: [60, 30, 7],
  POC: [7, 3],
};

/** One day of tolerance for clock drift before a clock behind the high-water mark counts as rolled back. */
export const CLOCK_ROLLBACK_TOLERANCE_SECONDS = SECONDS_PER_DAY;

export interface Installation {
  readonly installationId: string;
  readonly verifier: LicenceVerifier;
}

export interface RefusedEntry {
  readonly kind: SignedDocument['kind'];
  readonly refusal: LicenceRefusal;
}

export interface LicenceState {
  readonly status: LicenceStatus;
  readonly reason: LicenceStateReason;
  /** The licence in force, or the one most recently in force. */
  readonly effective?: Licence;
  /** The last licence in the coverage chain: its kind sets the thresholds and its graceDays the grace. */
  readonly tail?: Licence;
  /** 00:00 UTC on which coverage ends (a notAfter, or a revocation's effectiveFrom). */
  readonly coverageEndsAtEpochSeconds?: bigint;
  /** From this instant new business is refused. Absent where there is no licence to measure from. */
  readonly graceEndsAtEpochSeconds?: bigint;
  /** Whole days, rounded up: to the end of coverage in VALID and EXPIRING, to the end of grace in GRACE. */
  readonly daysRemaining?: number;
  /** In EXPIRING: the threshold crossed (60, 30, 7 or 7, 3). */
  readonly expiringThreshold?: number;
  /** The revocation that ended coverage, if one did. */
  readonly revocationId?: string;
  /** The mark to store: the highest time this installation has now seen. */
  readonly highWaterMarkEpochSeconds: bigint;
  /** Every verified licence, newest first. */
  readonly licences: readonly Licence[];
  /** History entries that did not verify, kept visible rather than silently ignored. */
  readonly refused: readonly RefusedEntry[];
}

const start = (date: string): bigint => {
  const d = parseDate(date);
  // Verified licences carry parseable dates; this cannot be reached with one.
  if (d === undefined) throw new Error('a verified licence carries parseable dates');
  return startOfDay(d);
};

const issued = (l: Licence): bigint => parseInstant(l.issuedAt) ?? 0n;

/** Newest first: latest start, then latest issue, then licence id, so the order never depends on input order. */
function newestFirst(a: Licence, b: Licence): number {
  const s = start(b.notBefore) - start(a.notBefore);
  if (s !== 0n) return s > 0n ? 1 : -1;
  const i = issued(b) - issued(a);
  if (i !== 0n) return i > 0n ? 1 : -1;
  if (a.licenceId === b.licenceId) return 0;
  return a.licenceId < b.licenceId ? 1 : -1;
}

export function licenceState(
  history: readonly SignedDocument[],
  installation: Installation,
  nowEpochSeconds: bigint,
  highWaterMarkEpochSeconds: bigint | undefined,
): LicenceState {
  const mark =
    highWaterMarkEpochSeconds === undefined || nowEpochSeconds > highWaterMarkEpochSeconds
      ? nowEpochSeconds
      : highWaterMarkEpochSeconds;

  const licences: Licence[] = [];
  const revocations: Revocation[] = [];
  const refused: RefusedEntry[] = [];
  for (const entry of history) {
    if (entry.kind === 'LICENCE') {
      const v = verifyLicence(entry, installation.verifier, installation.installationId);
      if (v.ok) licences.push(v.value);
      else refused.push({ kind: entry.kind, refusal: v.error });
    } else {
      const v = verifyRevocation(entry, installation.verifier, installation.installationId);
      if (v.ok) revocations.push(v.value);
      else refused.push({ kind: entry.kind, refusal: v.error });
    }
  }
  licences.sort(newestFirst);
  const base = { highWaterMarkEpochSeconds: mark, licences, refused };

  const anyLicenceInstalled = history.some((e) => e.kind === 'LICENCE');
  if (!anyLicenceInstalled) {
    return installation.verifier.mode === 'PRODUCTION'
      ? { ...base, status: 'NEW_BUSINESS_BLOCKED', reason: 'NO_LICENCE' }
      : { ...base, status: 'DEVELOPMENT_UNLICENSED', reason: 'DEVELOPMENT_NO_LICENCE' };
  }

  if (
    highWaterMarkEpochSeconds !== undefined &&
    nowEpochSeconds + CLOCK_ROLLBACK_TOLERANCE_SECONDS < highWaterMarkEpochSeconds
  ) {
    return { ...base, status: 'NEW_BUSINESS_BLOCKED', reason: 'CLOCK_ROLLBACK' };
  }

  if (licences.length === 0) return { ...base, status: 'NEW_BUSINESS_BLOCKED', reason: 'NO_VALID_LICENCE' };

  // A licence's own end: its notAfter, or the earliest verified revocation of it.
  const endOf = (l: Licence): { readonly end: bigint; readonly revocationId?: string } => {
    let end = start(l.notAfter);
    let revocationId: string | undefined;
    for (const r of revocations) {
      if (r.licenceId !== l.licenceId) continue;
      const at = start(r.effectiveFrom);
      if (at < end) {
        end = at;
        revocationId = r.revocationId;
      }
    }
    return revocationId === undefined ? { end } : { end, revocationId };
  };

  const started = licences.filter((l) => start(l.notBefore) <= nowEpochSeconds);
  const supersededNow = new Set(started.flatMap((l) => (l.supersedes === null ? [] : [l.supersedes])));
  const candidates = started.filter((l) => !supersededNow.has(l.licenceId));
  const effective = candidates[0];
  if (effective === undefined) return { ...base, status: 'NEW_BUSINESS_BLOCKED', reason: 'NOT_YET_VALID' };

  // Follow the coverage chain: any verified licence that starts by the current end and runs past it.
  let tail = effective;
  let { end, revocationId } = endOf(effective);
  for (;;) {
    const next = licences
      .filter((l) => l !== tail && start(l.notBefore) <= end && endOf(l).end > end)
      .sort((a, b) => {
        const d = endOf(b).end - endOf(a).end;
        if (d !== 0n) return d > 0n ? 1 : -1;
        return newestFirst(a, b);
      })[0];
    if (next === undefined) break;
    tail = next;
    ({ end, revocationId } = endOf(next));
  }

  const graceEnd = end + BigInt(tail.graceDays) * SECONDS_PER_DAY;
  const measured = {
    ...base,
    effective,
    tail,
    coverageEndsAtEpochSeconds: end,
    graceEndsAtEpochSeconds: graceEnd,
    ...(revocationId === undefined ? {} : { revocationId }),
  };

  if (nowEpochSeconds < end) {
    const daysRemaining = ceilDays(end - nowEpochSeconds);
    const thresholds = EXPIRING_THRESHOLDS[tail.kind];
    const crossed = thresholds.filter((t) => daysRemaining <= t);
    const threshold = crossed[crossed.length - 1];
    return threshold === undefined
      ? { ...measured, status: 'VALID', reason: 'IN_TERM', daysRemaining }
      : { ...measured, status: 'EXPIRING', reason: 'EXPIRING_SOON', daysRemaining, expiringThreshold: threshold };
  }
  if (nowEpochSeconds < graceEnd) {
    return {
      ...measured,
      status: 'GRACE',
      reason: revocationId === undefined ? 'EXPIRED_IN_GRACE' : 'REVOKED_IN_GRACE',
      daysRemaining: ceilDays(graceEnd - nowEpochSeconds),
    };
  }
  return { ...measured, status: 'NEW_BUSINESS_BLOCKED', reason: 'GRACE_ENDED', daysRemaining: 0 };
}
