/**
 * The licence repository on PostgreSQL (migration 0017).
 *
 * Every statement is a call to a SECURITY DEFINER function in `config`: the
 * tables themselves grant nothing to anyone, force row-level security and
 * refuse UPDATE and DELETE on the history. Four eyes and the one-pending rule
 * are enforced there as well as in the double, so a database refusal is
 * mapped back to the same typed reason.
 *
 * `pg` is the one vendor word in this file and it names a driver, not a
 * platform (ADR 0001).
 */

import type { Pool } from 'pg';

import { type Result, err, ok } from '../../../core/kernel/result.ts';
import type { SignedDocument } from '../../../core/licensing/licence.ts';
import type {
  InstalledEntry,
  LicenceProposal,
  LicenceRepository,
  LicenceStoreRefusal,
  LicenceStoreRefusalReason,
} from '../../../core/licensing/repository.ts';

const seconds = (d: Date): bigint => BigInt(Math.floor(d.getTime() / 1000));
const timestamp = (epochSeconds: bigint): string => new Date(Number(epochSeconds) * 1000).toISOString();

function refusalOf(error: unknown): Result<never, LicenceStoreRefusal> {
  const m = error instanceof Error ? error.message : '';
  const reason: LicenceStoreRefusalReason | undefined = /four eyes/.test(m)
    ? 'FOUR_EYES_SELF_DECISION'
    : /awaiting a decision/.test(m)
      ? 'PROPOSAL_PENDING'
      : /already installed/.test(m)
        ? 'ALREADY_INSTALLED'
        : /no licence proposal/.test(m)
          ? 'PROPOSAL_NOT_FOUND'
          : /is already (APPROVED|REJECTED)/.test(m)
            ? 'PROPOSAL_ALREADY_DECIDED'
            : /rejection_reason/.test(m)
              ? 'REJECTION_REASON_REQUIRED'
              : undefined;
  if (reason === undefined) throw error;
  return err({ reason, detail: 'The database refused the licence change' });
}

interface EntryRow {
  readonly id: string;
  readonly kind: SignedDocument['kind'];
  readonly subject_id: string;
  readonly document: string;
  readonly signature: string;
  readonly source: InstalledEntry['source'];
  readonly installed_by: string;
  readonly approved_by: string | null;
  readonly installed_at: Date;
}

interface ProposalRow {
  readonly id: string;
  readonly kind: SignedDocument['kind'];
  readonly subject_id: string;
  readonly document: string;
  readonly signature: string;
  readonly status: LicenceProposal['status'];
  readonly proposed_by: string;
  readonly proposed_at: Date;
  readonly decided_by: string | null;
  readonly rejection_reason: string | null;
}

export function postgresLicenceRepository(pool: Pool): LicenceRepository {
  return {
    async installation() {
      const r = await pool.query<{ installation_id: string; clock_high_water_mark: Date | null }>(
        'select installation_id, clock_high_water_mark from config.licence_installation()',
      );
      const row = r.rows[0];
      if (row === undefined) throw new Error('the deployment profile has no row');
      return {
        installationId: row.installation_id,
        highWaterMarkEpochSeconds: row.clock_high_water_mark === null ? undefined : seconds(row.clock_high_water_mark),
      };
    },

    async observeClock(now) {
      const r = await pool.query<{ before: Date | null }>(
        'select config.observe_licence_clock($1::timestamptz) as before',
        [timestamp(now)],
      );
      const before = r.rows[0]?.before ?? null;
      return before === null ? undefined : seconds(before);
    },

    async history() {
      const r = await pool.query<EntryRow>(
        'select id, kind, subject_id, document, signature, source, installed_by, approved_by, installed_at from config.list_licence_history()',
      );
      return r.rows.map((x) => ({
        entryId: x.id,
        kind: x.kind,
        subjectId: x.subject_id,
        document: x.document,
        signature: x.signature,
        source: x.source,
        installedBy: x.installed_by,
        approvedBy: x.approved_by,
        installedAtEpochSeconds: seconds(x.installed_at),
      }));
    },

    async proposals() {
      const r = await pool.query<ProposalRow>(
        'select id, kind, subject_id, document, signature, status, proposed_by, proposed_at, decided_by, rejection_reason from config.list_licence_proposals()',
      );
      return r.rows.map((x) => ({
        proposalId: x.id,
        kind: x.kind,
        subjectId: x.subject_id,
        document: x.document,
        signature: x.signature,
        status: x.status,
        proposedBy: x.proposed_by,
        proposedAtEpochSeconds: seconds(x.proposed_at),
        decidedBy: x.decided_by,
        rejectionReason: x.rejection_reason,
      }));
    },

    async propose({ signed, subjectId, proposedBy, correlationId }) {
      try {
        const r = await pool.query<{ id: string }>(
          'select config.propose_licence($1, $2::uuid, $3, $4, $5, $6::uuid) as id',
          [signed.kind, subjectId, signed.document, signed.signature, proposedBy, correlationId],
        );
        const id = r.rows[0]?.id;
        if (id === undefined) throw new Error('the proposal returned no id');
        return ok(id);
      } catch (error) {
        return refusalOf(error);
      }
    },

    async decide({ proposalId, approve, decidedBy, reason, correlationId }) {
      try {
        await pool.query('select config.decide_licence($1::uuid, $2, $3, $4, $5::uuid)', [
          proposalId,
          approve,
          decidedBy,
          reason ?? null,
          correlationId,
        ]);
        return ok(true);
      } catch (error) {
        return refusalOf(error);
      }
    },

    async recordFromCheckIn({ signed, subjectId, correlationId }) {
      await pool.query('select config.record_checked_in_licence($1, $2::uuid, $3, $4, $5::uuid)', [
        signed.kind,
        subjectId,
        signed.document,
        signed.signature,
        correlationId,
      ]);
      return ok(true);
    },
  };
}
