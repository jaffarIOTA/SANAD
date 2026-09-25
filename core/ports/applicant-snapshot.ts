/**
 * Where the facts about an applicant come from.
 *
 * The decision engine is pure: it reads a snapshot and nothing else. Something
 * has to assemble that snapshot from the registry, the screening provider, the
 * bureau, the e-invoicing history and the institution's own exposure — and
 * that something does I/O, so it is a port. The engine never sees it.
 *
 * Consent is checked by the sources themselves (see credit-bureau.ts and
 * screening.ts): a source without consent reports `NOT_CONSENTED` in the
 * snapshot rather than refusing to assemble, so the engine can say *why* it
 * referred instead of the caller getting an opaque failure.
 */

import type { Result } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';
import type { ApplicantSnapshot } from '../decisioning/snapshot.ts';

export interface SnapshotRequest {
  readonly tenantId: string;
  readonly counterpartyId: string;
  readonly programmeId: string;
  /** Attested. Recorded on the snapshot as its capture time. */
  readonly at: TsaInstant;
}

export interface ApplicantSnapshotPort {
  /**
   * A snapshot as of `at`, or a rejection saying which source could not be
   * reached. Never throws for an unreachable source — that is a typed outcome.
   */
  assemble(request: SnapshotRequest): Promise<Result<ApplicantSnapshot>>;
}
