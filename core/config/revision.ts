/**
 * Configuration revisions under maker-checker.
 *
 * Every institution-specific ruling is configuration, and a change to it is a
 * revision: proposed by one person, decided by a different one, effective
 * from a stated moment, never edited afterwards. This module is the rule set
 * the database functions (migration 0009) enforce, stated once more in pure
 * code so the compliance suite can attempt the prohibited outcomes without a
 * database and so a reader finds the rules in one place.
 *
 * A payload is validated by the area's own parser before it may be proposed:
 * the same parser that reads the configuration in production, so nothing can
 * be approved that could not be loaded.
 */

import { type Result, ok, reject } from '../kernel/result.ts';

export type RevisionArea =
  | 'PRODUCTS'
  | 'RAILS'
  | 'STAFF_IDENTITY'
  | 'PARTNERS'
  | 'CREDIT_POLICY'
  | 'ORIGINATION_POLICY'
  // Shariah parameters, under the same four eyes (SR-025).
  | 'STRUCTURES'
  | 'BOARD_POSITIONS';
export type RevisionStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED';

export interface Revision<T = unknown> {
  readonly id: string;
  readonly tenantId: string;
  readonly area: RevisionArea;
  readonly payload: T;
  readonly summary: string;
  readonly effectiveFromEpochSeconds: bigint;
  readonly status: RevisionStatus;
  readonly proposedBy: string;
  readonly proposedAtEpochSeconds: bigint;
  readonly decidedBy?: string;
  readonly decidedAtEpochSeconds?: bigint;
  readonly rejectionReason?: string;
}

export interface ProposeParams<T> {
  readonly id: string;
  readonly tenantId: string;
  readonly area: RevisionArea;
  readonly rawPayload: unknown;
  readonly summary: string;
  readonly effectiveFromEpochSeconds: bigint;
  readonly proposedBy: string;
  readonly proposedAtEpochSeconds: bigint;
  /** The area's production parser. A payload it refuses is not proposable. */
  readonly parse: (raw: unknown) => Result<T>;
}

const named = (s: string): boolean => s.trim().length > 0;

export function proposeRevision<T>(p: ProposeParams<T>): Result<Revision<T>> {
  if (!named(p.proposedBy))
    return reject('OP-DETERMINACY', 'REVISION_PROPOSER_REQUIRED', 'A revision names its proposer');
  if (p.summary.trim().length < 3 || p.summary.length > 400)
    return reject('OP-DETERMINACY', 'REVISION_SUMMARY_REQUIRED', 'A revision says in a sentence what it changes');
  const parsed = p.parse(p.rawPayload);
  if (!parsed.ok)
    return reject(
      parsed.error.control,
      'REVISION_PAYLOAD_INVALID',
      `The proposed configuration does not load: ${parsed.error.reason}`,
      { reason: parsed.error.reason, ...(parsed.error.context ?? {}) },
    );
  return ok({
    id: p.id,
    tenantId: p.tenantId,
    area: p.area,
    payload: parsed.value,
    summary: p.summary.trim(),
    effectiveFromEpochSeconds: p.effectiveFromEpochSeconds,
    status: 'PROPOSED',
    proposedBy: p.proposedBy,
    proposedAtEpochSeconds: p.proposedAtEpochSeconds,
  });
}

export interface DecideParams {
  readonly decidedBy: string;
  readonly decidedAtEpochSeconds: bigint;
  readonly approve: boolean;
  readonly reason?: string;
}

export function decideRevision<T>(r: Revision<T>, d: DecideParams): Result<Revision<T>> {
  if (r.status !== 'PROPOSED')
    return reject('OP-DETERMINACY', 'REVISION_ALREADY_DECIDED', `Revision is already ${r.status}; propose a new one`, {
      status: r.status,
    });
  if (!named(d.decidedBy)) return reject('OP-DETERMINACY', 'REVISION_DECIDER_REQUIRED', 'A decision names who took it');
  if (d.decidedBy === r.proposedBy)
    return reject('OP-DETERMINACY', 'FOUR_EYES_SELF_DECISION', 'The person who proposed a revision may not decide it', {
      proposedBy: r.proposedBy,
    });
  if (!d.approve && (d.reason === undefined || d.reason.trim().length < 3))
    return reject('OP-DETERMINACY', 'REJECTION_REASON_REQUIRED', 'A rejection says why');
  if (d.decidedAtEpochSeconds < r.proposedAtEpochSeconds)
    return reject('OP-CHAIN', 'TIMESTAMPS_NOT_MONOTONIC', 'A decision is attested after the proposal');
  const decided: Revision<T> = {
    ...r,
    status: d.approve ? 'APPROVED' : 'REJECTED',
    decidedBy: d.decidedBy,
    decidedAtEpochSeconds: d.decidedAtEpochSeconds,
  };
  return ok(d.approve || d.reason === undefined ? decided : { ...decided, rejectionReason: d.reason.trim() });
}

/** The revision in force at a moment: latest effective among the approved; ties go to the later decision. None → undefined. */
export function effectiveRevision<T>(
  revisions: readonly Revision<T>[],
  asOfEpochSeconds: bigint,
): Revision<T> | undefined {
  let best: Revision<T> | undefined;
  for (const r of revisions) {
    if (r.status !== 'APPROVED' || r.effectiveFromEpochSeconds > asOfEpochSeconds) continue;
    if (
      best === undefined ||
      r.effectiveFromEpochSeconds > best.effectiveFromEpochSeconds ||
      (r.effectiveFromEpochSeconds === best.effectiveFromEpochSeconds &&
        (r.decidedAtEpochSeconds ?? 0n) > (best.decidedAtEpochSeconds ?? 0n))
    )
      best = r;
  }
  return best;
}
