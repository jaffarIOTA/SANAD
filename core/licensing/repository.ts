/**
 * Where an installation keeps its licences (ADR 0006 §5), as a port.
 *
 * Three things, all deployment-wide rather than per tenant:
 *   - the installation's identity (`installationId`, generated once) and the
 *     highest server time it has seen (the clock high-water mark);
 *   - the append-only history of installed licences and revocations, each
 *     as the signed document and its signature, with who installed it and
 *     who approved it;
 *   - proposals: installing a licence is an administrator's act under four
 *     eyes — one proposes, a different one approves — like the jurisdiction.
 *
 * The PostgreSQL implementation is migration 0017 behind
 * `services/origination/src/licence-postgres.ts`. The in-memory double below
 * is for tests and for development without a database; it enforces the same
 * four-eyes and append-only rules so a test against it means something.
 *
 * Nothing here verifies a signature: the caller verifies before it proposes
 * and again before it approves. The store only keeps what it is given.
 */

import { randomUUID } from 'node:crypto';

import { type Result, err, ok } from '../kernel/result.ts';
import type { SignedDocument } from './licence.ts';

export type LicenceEntrySource = 'ADMIN_INSTALL' | 'CHECK_IN';

export interface InstalledEntry extends SignedDocument {
  readonly entryId: string;
  /** The licenceId of a licence, the revocationId of a revocation. */
  readonly subjectId: string;
  readonly source: LicenceEntrySource;
  /** The administrator who proposed it, or the check-in job. */
  readonly installedBy: string;
  /** The second administrator who approved it; null only for a check-in. */
  readonly approvedBy: string | null;
  readonly installedAtEpochSeconds: bigint;
}

export interface LicenceProposal extends SignedDocument {
  readonly proposalId: string;
  readonly subjectId: string;
  readonly status: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  readonly proposedBy: string;
  readonly proposedAtEpochSeconds: bigint;
  readonly decidedBy: string | null;
  readonly rejectionReason: string | null;
}

export interface InstallationRecord {
  readonly installationId: string;
  readonly highWaterMarkEpochSeconds: bigint | undefined;
}

export type LicenceStoreRefusalReason =
  | 'FOUR_EYES_SELF_DECISION'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_ALREADY_DECIDED'
  | 'PROPOSAL_PENDING'
  | 'ALREADY_INSTALLED'
  | 'REJECTION_REASON_REQUIRED';

export interface LicenceStoreRefusal {
  readonly reason: LicenceStoreRefusalReason;
  readonly detail: string;
}

export interface LicenceRepository {
  installation(): Promise<InstallationRecord>;
  /** Raise the high-water mark to `now` if it is higher. Returns the mark as it stood before. */
  observeClock(nowEpochSeconds: bigint): Promise<bigint | undefined>;
  /** Every installed licence and revocation, oldest first. */
  history(): Promise<readonly InstalledEntry[]>;
  /** Recent proposals, newest first. */
  proposals(): Promise<readonly LicenceProposal[]>;
  propose(p: {
    readonly signed: SignedDocument;
    readonly subjectId: string;
    readonly proposedBy: string;
    readonly correlationId: string;
  }): Promise<Result<string, LicenceStoreRefusal>>;
  /** Approve (which installs) or reject. The decider is never the proposer. */
  decide(d: {
    readonly proposalId: string;
    readonly approve: boolean;
    readonly decidedBy: string;
    readonly reason?: string;
    readonly correlationId: string;
  }): Promise<Result<true, LicenceStoreRefusal>>;
  /** A newer licence or a revocation the check-in server returned, verified by the caller. No second person: it is the issuer's signed act. */
  recordFromCheckIn(p: {
    readonly signed: SignedDocument;
    readonly subjectId: string;
    readonly correlationId: string;
  }): Promise<Result<true, LicenceStoreRefusal>>;
}

const refuse = (reason: LicenceStoreRefusalReason, detail: string): Result<never, LicenceStoreRefusal> =>
  err({ reason, detail });

/**
 * The in-memory double. `clock` stamps the installed-at time; tests pass a
 * fixed one, development passes the wall clock from outside core.
 */
export function inMemoryLicenceRepository(
  options: { readonly installationId?: string; readonly clock?: () => bigint } = {},
): LicenceRepository {
  const installationId = options.installationId ?? randomUUID();
  const clock = options.clock ?? ((): bigint => 0n);
  let highWaterMark: bigint | undefined;
  const entries: InstalledEntry[] = [];
  const proposals: LicenceProposal[] = [];

  const installed = (subjectId: string): boolean => entries.some((e) => e.subjectId === subjectId);

  return {
    installation: () => Promise.resolve({ installationId, highWaterMarkEpochSeconds: highWaterMark }),

    observeClock(now) {
      const before = highWaterMark;
      if (highWaterMark === undefined || now > highWaterMark) highWaterMark = now;
      return Promise.resolve(before);
    },

    history: () => Promise.resolve([...entries]),

    proposals: () => Promise.resolve([...proposals].reverse()),

    propose({ signed, subjectId, proposedBy }) {
      if (installed(subjectId))
        return Promise.resolve(refuse('ALREADY_INSTALLED', 'That licence is already installed'));
      if (proposals.some((p) => p.status === 'PROPOSED'))
        return Promise.resolve(refuse('PROPOSAL_PENDING', 'Another licence is awaiting a decision'));
      const proposalId = randomUUID();
      proposals.push({
        ...signed,
        proposalId,
        subjectId,
        status: 'PROPOSED',
        proposedBy,
        proposedAtEpochSeconds: clock(),
        decidedBy: null,
        rejectionReason: null,
      });
      return Promise.resolve(ok(proposalId));
    },

    decide({ proposalId, approve, decidedBy, reason }) {
      const i = proposals.findIndex((p) => p.proposalId === proposalId);
      const p = proposals[i];
      if (p === undefined) return Promise.resolve(refuse('PROPOSAL_NOT_FOUND', 'No such proposal'));
      if (p.status !== 'PROPOSED')
        return Promise.resolve(refuse('PROPOSAL_ALREADY_DECIDED', 'That proposal is already decided'));
      if (p.proposedBy === decidedBy)
        return Promise.resolve(refuse('FOUR_EYES_SELF_DECISION', 'The proposer may not decide their own proposal'));
      if (!approve && (reason ?? '').trim().length < 3)
        return Promise.resolve(refuse('REJECTION_REASON_REQUIRED', 'A rejection says why'));
      if (approve && installed(p.subjectId))
        return Promise.resolve(refuse('ALREADY_INSTALLED', 'That licence is already installed'));
      proposals[i] = {
        ...p,
        status: approve ? 'APPROVED' : 'REJECTED',
        decidedBy,
        rejectionReason: approve ? null : (reason ?? null),
      };
      if (approve)
        entries.push({
          kind: p.kind,
          document: p.document,
          signature: p.signature,
          entryId: randomUUID(),
          subjectId: p.subjectId,
          source: 'ADMIN_INSTALL',
          installedBy: p.proposedBy,
          approvedBy: decidedBy,
          installedAtEpochSeconds: clock(),
        });
      return Promise.resolve(ok(true));
    },

    recordFromCheckIn({ signed, subjectId }) {
      if (installed(subjectId)) return Promise.resolve(ok(true));
      entries.push({
        ...signed,
        entryId: randomUUID(),
        subjectId,
        source: 'CHECK_IN',
        installedBy: 'licence-check-in',
        approvedBy: null,
        installedAtEpochSeconds: clock(),
      });
      return Promise.resolve(ok(true));
    },
  };
}
