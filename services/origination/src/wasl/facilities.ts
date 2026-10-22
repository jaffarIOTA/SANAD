/**
 * Distributor facilities (Wasl W5a, decided with the product owner on
 * 22 October 2026): the limit a distributor may draw in a programme,
 * proposed by a credit officer and approved by a different person. No
 * approved facility, no trade: trade validation holds a cost against the
 * facility before the programme (steps.ts).
 *
 *   - One open proposal per distributor and programme at a time.
 *   - A facility is never more than its programme's limit.
 *   - An approval never sets a limit below what the distributor already holds
 *     (and the database refuses it too, at commit: core.facility's own
 *     capacity trigger, migration 0031).
 *   - A later approval supersedes an earlier one; nothing is edited.
 *
 * Where it lives: `core.facility_approval` and `core.facility` when a database
 * is configured, reloaded on every read (the workbench and the cycle are
 * separate processes); this process's memory otherwise, for development and
 * tests. Reads no clock but the host-clock stand-in (SR-006).
 */
import { randomUUID } from 'node:crypto';

import { type TenantCode, type WaslParties, loadWaslParties } from '@sanad/config/loader.ts';
import { type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';

import { tenantUuidByCode } from '../credentials.ts';
import { hostClockInstant } from '../host-clock.ts';
import { inTenant } from '../tenant-scope.ts';
import { hydrate, structureOf, waslPool, withLock } from './book.ts';
import { resolveWaslParties } from './configuration.ts';
import { exposureOf } from './exposure.ts';
import { referenceRows } from './persistence.ts';

export type FacilityApprovalState = 'PROPOSED' | 'APPROVED' | 'REJECTED';

export interface FacilityApproval {
  readonly approvalId: string;
  /** The distributor, by the counterparty id its requests carry. */
  readonly counterpartyId: string;
  readonly programmeId: string;
  readonly limit: Money;
  readonly rationale: string;
  readonly state: FacilityApprovalState;
  readonly proposedBy: string;
  readonly proposedAtEpochSeconds: bigint;
  readonly decidedBy?: string;
  readonly decidedAtEpochSeconds?: bigint;
  readonly decisionNote?: string;
}

export interface Facility {
  readonly counterpartyId: string;
  readonly programmeId: string;
  readonly limit: Money;
  /** The approval that set this limit. */
  readonly approvalId: string;
  readonly approvedBy: string;
  readonly approvedAtEpochSeconds: bigint;
}

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

// -- The store ------------------------------------------------------------------------

const KEY = Symbol.for('sanad.wasl.facilityApprovals');
const memory = (): Map<string, FacilityApproval[]> => {
  const g = globalThis as { [KEY]?: Map<string, FacilityApproval[]> };
  g[KEY] ??= new Map();
  return g[KEY];
};

/** Tests only: forget every facility. */
export function resetFacilities(): void {
  memory().clear();
}

/** Every proposal and decision for the tenant, oldest first. */
export async function facilityApprovals(tenant: TenantCode): Promise<readonly FacilityApproval[]> {
  const pool = waslPool();
  if (pool === undefined) return memory().get(tenant) ?? [];
  const parties = loadWaslParties(tenant);
  if (!parties.ok) return [];
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  const rows = await inTenant(pool, tenantUuid, (db) =>
    db.query<{
      id: string;
      registration_no: string;
      code: string;
      currency: string;
      limit_minor: string;
      rationale: string;
      state: FacilityApprovalState;
      proposed_by: string;
      proposed_at: string;
      decided_by: string | null;
      decided_at: string | null;
      decision_note: string | null;
    }>(
      `select a.id::text, c.registration_no, p.code, a.currency, a.limit_minor::text, a.rationale, a.state,
              a.proposed_by, extract(epoch from a.proposed_at)::bigint::text proposed_at, a.decided_by,
              extract(epoch from a.decided_at)::bigint::text decided_at, a.decision_note
         from core.facility_approval a
         join core.counterparty c on c.id = a.counterparty_id
         join core.programme p on p.id = a.programme_id
        where a.tenant_id = $1
        order by a.proposed_at, a.created_at`,
      [tenantUuid],
    ),
  );
  return rows.rows.flatMap((r) => {
    const d = parties.value.distributors.find((x) => x.registrationNo === r.registration_no);
    if (d === undefined) return [];
    return [
      {
        approvalId: r.id,
        counterpartyId: d.counterpartyId,
        programmeId: r.code,
        limit: money(BigInt(r.limit_minor), r.currency as Money['currency']),
        rationale: r.rationale,
        state: r.state,
        proposedBy: r.proposed_by,
        proposedAtEpochSeconds: BigInt(r.proposed_at),
        ...(r.decided_by === null ? {} : { decidedBy: r.decided_by }),
        ...(r.decided_at === null ? {} : { decidedAtEpochSeconds: BigInt(r.decided_at) }),
        ...(r.decision_note === null ? {} : { decisionNote: r.decision_note }),
      },
    ];
  });
}

/** The facility in force for each distributor and programme: the latest approval. */
export function facilitiesFrom(approvals: readonly FacilityApproval[]): readonly Facility[] {
  const latest = new Map<string, Facility>();
  for (const a of approvals) {
    if (a.state !== 'APPROVED' || a.decidedBy === undefined || a.decidedAtEpochSeconds === undefined) continue;
    const k = `${a.counterpartyId}|${a.programmeId}`;
    const before = latest.get(k);
    if (before !== undefined && before.approvedAtEpochSeconds > a.decidedAtEpochSeconds) continue;
    latest.set(k, {
      counterpartyId: a.counterpartyId,
      programmeId: a.programmeId,
      limit: a.limit,
      approvalId: a.approvalId,
      approvedBy: a.decidedBy,
      approvedAtEpochSeconds: a.decidedAtEpochSeconds,
    });
  }
  return [...latest.values()];
}

/** The distributor's facility in the programme, or undefined where none is approved. */
export async function facilityFor(
  tenant: TenantCode,
  counterpartyId: string,
  programmeId: string,
): Promise<Facility | undefined> {
  return facilitiesFrom(await facilityApprovals(tenant)).find(
    (f) => f.counterpartyId === counterpartyId && f.programmeId === programmeId,
  );
}

// -- Proposing and deciding -----------------------------------------------------------

function partiesOf(
  parties: WaslParties,
  counterpartyId: string,
  programmeId: string,
): Result<{
  readonly programme: WaslParties['programmes'][number];
  readonly distributor: WaslParties['distributors'][number];
}> {
  const programme = parties.programmes.find((p) => p.programmeId === programmeId);
  if (programme === undefined) return fail('PROGRAMME_NOT_CONFIGURED', 'No such programme');
  const distributor = parties.distributors.find((d) => d.counterpartyId === counterpartyId);
  if (distributor === undefined) return fail('COUNTERPARTY_NOT_CONFIGURED', 'The distributor is not onboarded');
  return ok({ programme, distributor });
}

/** A credit officer proposes a distributor's limit in a programme, with what it rests on. */
export function proposeFacility(
  tenant: TenantCode,
  actor: string,
  input: {
    readonly counterpartyId: string;
    readonly programmeId: string;
    readonly limitMinorUnits: bigint;
    readonly rationale: string;
  },
): Promise<Result<FacilityApproval>> {
  return withLock(tenant, async () => {
    // The programme as it stands now: its limit may have been revised in Admin (W5b).
    const parties = await resolveWaslParties(tenant);
    if (!parties.ok) return parties;
    const found = partiesOf(parties.value, input.counterpartyId, input.programmeId);
    if (!found.ok) return found;
    const { programme } = found.value;
    if (input.limitMinorUnits <= 0n) return fail('FACILITY_LIMIT_NOT_POSITIVE', 'A facility is a positive amount');
    if (input.limitMinorUnits > programme.programmeLimitMinorUnits)
      return reject('OP-LIMIT', 'FACILITY_ABOVE_PROGRAMME', 'A facility is never more than its programme’s limit');
    const rationale = input.rationale.trim().slice(0, 1000);
    if (rationale.length < 3) return fail('FACILITY_RATIONALE_REQUIRED', 'Say what the limit rests on');
    const approvals = await facilityApprovals(tenant);
    if (
      approvals.some(
        (a) =>
          a.state === 'PROPOSED' && a.counterpartyId === input.counterpartyId && a.programmeId === input.programmeId,
      )
    )
      return fail('FACILITY_PROPOSAL_OPEN', 'A proposal for this distributor and programme awaits a decision');
    const proposal: FacilityApproval = {
      approvalId: randomUUID(),
      counterpartyId: input.counterpartyId,
      programmeId: input.programmeId,
      limit: money(input.limitMinorUnits, 'SAR'),
      rationale,
      state: 'PROPOSED',
      proposedBy: actor,
      proposedAtEpochSeconds: hostClockInstant().epochSeconds,
    };
    const pool = waslPool();
    if (pool === undefined) {
      memory().set(tenant, [...(memory().get(tenant) ?? []), proposal]);
      return ok(proposal);
    }
    const structure = structureOf(tenant);
    if (!structure.ok) return structure;
    const tenantUuid = await tenantUuidByCode(pool, tenant);
    return inTenant(pool, tenantUuid, async (db) => {
      const refs = await referenceRows(
        db,
        tenantUuid,
        tenant,
        {
          programmeId: input.programmeId,
          counterpartyId: input.counterpartyId,
          shariahApprovalId: structure.value.shariahApprovalRef,
          structureDefinitionId: structure.value.definitionId,
          currency: proposal.limit.currency,
        },
        parties.value,
      );
      if (!refs.ok) return refs;
      await db.query(
        `insert into core.facility_approval (id, tenant_id, counterparty_id, programme_id, currency, limit_minor,
           rationale, proposed_by, proposed_at, correlation_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9), $10)`,
        [
          proposal.approvalId,
          tenantUuid,
          refs.value.counterpartyId,
          refs.value.programmeId,
          proposal.limit.currency,
          proposal.limit.minorUnits.toString(),
          rationale,
          actor,
          proposal.proposedAtEpochSeconds.toString(),
          randomUUID(),
        ],
      );
      return ok(proposal);
    });
  });
}

/**
 * A different person approves the proposal, which becomes the facility in
 * force, or rejects it with a reason. An approval below what the distributor
 * already holds is refused.
 */
export function decideFacility(
  tenant: TenantCode,
  actor: string,
  input: { readonly approvalId: string; readonly approve: boolean; readonly note: string },
): Promise<Result<FacilityApproval>> {
  return withLock(tenant, async () => {
    const proposal = (await facilityApprovals(tenant)).find((a) => a.approvalId === input.approvalId);
    if (proposal === undefined) return fail('FACILITY_PROPOSAL_NOT_FOUND', 'No such proposal');
    if (proposal.state !== 'PROPOSED')
      return fail('FACILITY_ALREADY_DECIDED', 'This proposal is already decided', { state: proposal.state });
    if (proposal.proposedBy === actor)
      return fail('FOUR_EYES_SELF_APPROVAL', 'The person who proposed a facility may not decide it');
    const note = input.note.trim().slice(0, 1000);
    if (!input.approve && note.length < 3) return fail('REJECTION_REASON_REQUIRED', 'A rejection says why');
    if (input.approve) {
      const parties = await resolveWaslParties(tenant);
      if (!parties.ok) return parties;
      const programme = parties.value.programmes.find((p) => p.programmeId === proposal.programmeId);
      // The programme may have been revised since the proposal: a facility is never larger than it is now.
      if (programme === undefined || proposal.limit.minorUnits > programme.programmeLimitMinorUnits)
        return reject('OP-LIMIT', 'FACILITY_ABOVE_PROGRAMME', 'A facility is never more than its programme’s limit');
      const book = await hydrate(tenant);
      const held = exposureOf(
        [...book.records.values()],
        parties.value,
        proposal.counterpartyId,
        proposal.programmeId,
      ).facilityHeld;
      if (proposal.limit.minorUnits < held)
        return reject('OP-LIMIT', 'FACILITY_BELOW_EXPOSURE', 'The distributor already holds more than this limit');
    }
    const decidedAt = hostClockInstant().epochSeconds;
    const decided: FacilityApproval = {
      ...proposal,
      state: input.approve ? 'APPROVED' : 'REJECTED',
      decidedBy: actor,
      decidedAtEpochSeconds: decidedAt > proposal.proposedAtEpochSeconds ? decidedAt : proposal.proposedAtEpochSeconds,
      ...(note.length === 0 ? {} : { decisionNote: note }),
    };
    const pool = waslPool();
    if (pool === undefined) {
      memory().set(
        tenant,
        (memory().get(tenant) ?? []).map((a) => (a.approvalId === decided.approvalId ? decided : a)),
      );
      return ok(decided);
    }
    const tenantUuid = await tenantUuidByCode(pool, tenant);
    try {
      return await inTenant(pool, tenantUuid, async (db) => {
        const updated = await db.query(
          `update core.facility_approval set state = $3, decided_by = $4, decided_at = to_timestamp($5),
             decision_note = $6
           where tenant_id = $1 and id = $2::uuid and state = 'PROPOSED'`,
          [
            tenantUuid,
            decided.approvalId,
            decided.state,
            actor,
            String(decided.decidedAtEpochSeconds),
            decided.decisionNote ?? null,
          ],
        );
        if (updated.rowCount !== 1) return fail('FACILITY_ALREADY_DECIDED', 'This proposal is already decided');
        if (decided.state === 'APPROVED')
          // The facility in force: authorised by this approval; a later approval moves its limit.
          await db.query(
            `insert into core.facility (tenant_id, counterparty_id, programme_id, approval_id, currency, limit_minor,
               correlation_id)
             select a.tenant_id, a.counterparty_id, a.programme_id, a.id, a.currency, a.limit_minor, a.correlation_id
               from core.facility_approval a where a.tenant_id = $1 and a.id = $2::uuid
             on conflict (tenant_id, counterparty_id, programme_id)
             do update set limit_minor = excluded.limit_minor, approval_id = excluded.approval_id, updated_at = now()`,
            [tenantUuid, decided.approvalId],
          );
        return ok(decided);
      });
    } catch (error) {
      const e = error as { code?: string };
      // The database's own lock: the limit no longer covers what is utilised and held (0031).
      if (e.code === '23001')
        return reject('OP-LIMIT', 'FACILITY_BELOW_EXPOSURE', 'The database refused a limit below what is held');
      return fail('PERSISTENCE_FAILED', 'The decision was not written');
    }
  });
}
