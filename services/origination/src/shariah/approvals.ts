/**
 * The Shariah approvals register (Wasl W6a, decided with the product owner on
 * 26 October 2026): recorded in the workbench by a Shariah reviewer and
 * confirmed by a different one. Suspension, reinstatement, withdrawal and
 * renewal go the same way. The register itself is core/shariah/approvals.ts,
 * folded from the confirmed changes; this is where the changes are kept and
 * where origination asks whether an approval is in force (SH-17, BR-F02).
 *
 * Where it lives: `core.shariah_approval_change` when a database is
 * configured, read on every call (the workbench, the portals and the cycle
 * are separate processes), with each confirmation projected onto
 * `core.shariah_approval` — the row transactions refer to (migration 0033);
 * this process's memory otherwise, for development and tests. Reads no clock
 * but the host-clock stand-in (SR-006).
 */
import { randomUUID } from 'node:crypto';

import type { TenantCode } from '@sanad/config/loader.ts';
import { type Rejection, type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { ISLAMIC_PRODUCT_CODES } from '@sanad/core/products/registry.ts';
import {
  type ApprovalChange,
  type ApprovalChangeEntry,
  type ApprovalChangeState,
  type ApprovalTerms,
  type ShariahApproval,
  approvalInForce,
  approvalRefOf,
  checkChange,
  registerAt,
} from '@sanad/core/shariah/approvals.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';

import { resolveProductCatalogue } from '../catalogue.ts';
import { civilDateOf } from '../civil-date.ts';
import { tenantUuidByCode } from '../credentials.ts';
import { hostClockInstant } from '../host-clock.ts';
import { inTenant } from '../tenant-scope.ts';
import { waslPool } from '../wasl/book.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

/** The moment a standing is judged at: an attested instant at origination, the effective moment in Admin. */
type Instant = Pick<TsaInstant, 'epochSeconds'>;

// -- The store ------------------------------------------------------------------------

const KEY = Symbol.for('sanad.shariah.approvalChanges');
const memory = (): Map<string, ApprovalChangeEntry[]> => {
  const g = globalThis as { [KEY]?: Map<string, ApprovalChangeEntry[]> };
  g[KEY] ??= new Map();
  return g[KEY];
};

/** Tests only: forget the register. */
export function resetShariahApprovals(): void {
  memory().clear();
}

const LOCKS = Symbol.for('sanad.shariah.approvalLocks');
function withLock<T>(tenant: TenantCode, work: () => Promise<T>): Promise<T> {
  const g = globalThis as { [LOCKS]?: Map<string, Promise<unknown>> };
  g[LOCKS] ??= new Map();
  const run = (g[LOCKS].get(tenant) ?? Promise.resolve()).then(work, work);
  g[LOCKS].set(
    tenant,
    run.catch(() => undefined),
  );
  return run;
}

/** The change as stored: plain JSON. */
function changeFrom(kind: string, json: Record<string, unknown>): ApprovalChange {
  const ref = String(json['approvalRef'] ?? '');
  if (kind === 'RECORD') {
    const t = json['terms'] as Record<string, unknown>;
    const strings = (v: unknown): readonly string[] => (Array.isArray(v) ? v.map(String) : []);
    return {
      kind,
      terms: {
        approvalRef: String(t['approvalRef']),
        approvingBody: String(t['approvingBody']),
        members: strings(t['members']),
        effectiveFrom: String(t['effectiveFrom']),
        ...(typeof t['reviewOrExpiry'] === 'string' ? { reviewOrExpiry: t['reviewOrExpiry'] } : {}),
        productCodes: strings(t['productCodes']),
        templateVersionIds: strings(t['templateVersionIds']),
      },
    };
  }
  if (kind === 'RENEW') return { kind, approvalRef: ref, reviewOrExpiry: String(json['reviewOrExpiry']) };
  return { kind: kind as 'SUSPEND' | 'REINSTATE' | 'WITHDRAW', approvalRef: ref };
}

/** Every change proposed to the tenant's register, oldest first. */
export async function approvalChanges(tenant: TenantCode): Promise<readonly ApprovalChangeEntry[]> {
  const pool = waslPool();
  if (pool === undefined) return memory().get(tenant) ?? [];
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  const rows = await inTenant(pool, tenantUuid, (db) =>
    db.query<{
      id: string;
      kind: string;
      change: Record<string, unknown>;
      reason: string;
      state: ApprovalChangeState;
      proposed_by: string;
      proposed_at: string;
      decided_by: string | null;
      decided_at: string | null;
      decision_note: string | null;
    }>(
      `select id::text, kind, change, reason, state, proposed_by,
              extract(epoch from proposed_at)::bigint::text proposed_at, decided_by,
              extract(epoch from decided_at)::bigint::text decided_at, decision_note
         from core.shariah_approval_change
        where tenant_id = $1
        order by proposed_at, created_at`,
      [tenantUuid],
    ),
  );
  return rows.rows.map((r) => ({
    changeId: r.id,
    change: changeFrom(r.kind, r.change),
    reason: r.reason,
    state: r.state,
    proposedBy: r.proposed_by,
    proposedAtEpochSeconds: BigInt(r.proposed_at),
    ...(r.decided_by === null ? {} : { decidedBy: r.decided_by }),
    ...(r.decided_at === null ? {} : { decidedAtEpochSeconds: BigInt(r.decided_at) }),
    ...(r.decision_note === null ? {} : { decisionNote: r.decision_note }),
  }));
}

/** The register as it stands at an instant (now, by default). */
export async function shariahRegister(
  tenant: TenantCode,
  asOfEpochSeconds: bigint = hostClockInstant().epochSeconds,
): Promise<readonly ShariahApproval[]> {
  return registerAt(await approvalChanges(tenant), asOfEpochSeconds);
}

/**
 * The approval a new origination of `productCode` rests on: in the register as
 * it stands, in force on the civil date of the attested instant where the
 * institution is, and covering the product — or the SH-17 refusal.
 */
export async function originationApproval(
  tenant: TenantCode,
  productCode: string,
  approvalRef: string | undefined,
  at: Instant,
): Promise<Result<ShariahApproval>> {
  return approvalInForce(await shariahRegister(tenant), approvalRef, productCode, civilDateOf(tenant, at));
}

/**
 * For a catalogue entry: an Islamic product originates only under the approval
 * its entry cites, in force (SH-17); any other product needs none, and gets
 * undefined.
 */
export async function catalogueApproval(
  tenant: TenantCode,
  entry: { readonly productCode: string; readonly boardRulingRef?: string },
  at: Instant,
): Promise<Result<ShariahApproval | undefined>> {
  if (!ISLAMIC_PRODUCT_CODES.has(entry.productCode)) return ok(undefined);
  return originationApproval(tenant, entry.productCode, entry.boardRulingRef, at);
}

/**
 * SH-17 beside the licence at every point new business starts (the same
 * points `newBusinessRefusal` guards, ADR 0006): undefined where the product
 * may originate now, the refusal otherwise. The approval is the one the
 * catalogue in force cites; a product the catalogue does not hold is left to
 * the catalogue's own refusal.
 */
export async function newBusinessShariahRefusal(
  tenant: TenantCode,
  productCode: string,
  at: Instant,
): Promise<Rejection | undefined> {
  if (!ISLAMIC_PRODUCT_CODES.has(productCode)) return undefined;
  const catalogue = (await resolveProductCatalogue(tenant, at.epochSeconds)).catalogue;
  const entry = catalogue.ok ? catalogue.value.entries.find((e) => e.productCode === productCode) : undefined;
  if (entry === undefined) return undefined;
  const r = await catalogueApproval(tenant, entry, at);
  return r.ok ? undefined : r.error;
}

// -- Proposing and deciding -----------------------------------------------------------

const termsJson = (t: ApprovalTerms): Record<string, unknown> => ({
  approvalRef: t.approvalRef.trim(),
  approvingBody: t.approvingBody.trim(),
  members: t.members.map((m) => m.trim()),
  effectiveFrom: t.effectiveFrom,
  ...(t.reviewOrExpiry === undefined ? {} : { reviewOrExpiry: t.reviewOrExpiry }),
  productCodes: [...t.productCodes],
  templateVersionIds: [...t.templateVersionIds],
});

const changeJson = (c: ApprovalChange): Record<string, unknown> =>
  c.kind === 'RECORD'
    ? { terms: termsJson(c.terms) }
    : c.kind === 'RENEW'
      ? { approvalRef: c.approvalRef, reviewOrExpiry: c.reviewOrExpiry }
      : { approvalRef: c.approvalRef };

/** A Shariah reviewer proposes a change to the register, with the board's reference for it. */
export function proposeApprovalChange(
  tenant: TenantCode,
  actor: string,
  input: { readonly change: ApprovalChange; readonly reason: string },
): Promise<Result<ApprovalChangeEntry>> {
  return withLock(tenant, async () => {
    const reason = input.reason.trim().slice(0, 1000);
    const change = changeFrom(input.change.kind, changeJson(input.change));
    const entries = await approvalChanges(tenant);
    const checked = checkChange(entries, change, reason);
    if (!checked.ok) return checked;
    const proposal: ApprovalChangeEntry = {
      changeId: randomUUID(),
      change,
      reason,
      state: 'PROPOSED',
      proposedBy: actor,
      proposedAtEpochSeconds: hostClockInstant().epochSeconds,
    };
    const pool = waslPool();
    if (pool === undefined) {
      memory().set(tenant, [...entries, proposal]);
      return ok(proposal);
    }
    const tenantUuid = await tenantUuidByCode(pool, tenant);
    try {
      await inTenant(pool, tenantUuid, (db) =>
        db.query(
          `insert into core.shariah_approval_change (id, tenant_id, approval_ref, kind, change, reason, proposed_by,
             proposed_at, correlation_id)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, to_timestamp($8), $9)`,
          [
            proposal.changeId,
            tenantUuid,
            approvalRefOf(change),
            change.kind,
            JSON.stringify(changeJson(change)),
            reason,
            actor,
            proposal.proposedAtEpochSeconds.toString(),
            randomUUID(),
          ],
        ),
      );
    } catch (error) {
      // The database's own lock: one open proposal per approval (0033).
      if ((error as { code?: string }).code === '23505')
        return fail('APPROVAL_CHANGE_OPEN', 'A change to this approval awaits a second person');
      return fail('PERSISTENCE_FAILED', 'The proposal was not written');
    }
    return ok(proposal);
  });
}

/**
 * A different Shariah reviewer confirms the change, which takes effect in the
 * register from that moment, or rejects it with a reason. The change is checked
 * again against the register as it now stands.
 */
export function decideApprovalChange(
  tenant: TenantCode,
  actor: string,
  input: { readonly changeId: string; readonly confirm: boolean; readonly note: string },
): Promise<Result<ApprovalChangeEntry>> {
  return withLock(tenant, async () => {
    const entries = await approvalChanges(tenant);
    const proposal = entries.find((e) => e.changeId === input.changeId);
    if (proposal === undefined) return fail('APPROVAL_CHANGE_NOT_FOUND', 'No such proposal');
    if (proposal.state !== 'PROPOSED')
      return fail('APPROVAL_CHANGE_ALREADY_DECIDED', 'This proposal is already decided', { state: proposal.state });
    if (proposal.proposedBy === actor)
      return fail('FOUR_EYES_SELF_APPROVAL', 'The person who proposed a change to the register may not decide it');
    const note = input.note.trim().slice(0, 1000);
    if (!input.confirm && note.length < 3) return fail('REJECTION_REASON_REQUIRED', 'A rejection says why');
    if (input.confirm) {
      const still = checkChange(entries, proposal.change, proposal.reason, proposal.changeId);
      if (!still.ok) return still;
    }
    const now = hostClockInstant().epochSeconds;
    const decided: ApprovalChangeEntry = {
      ...proposal,
      state: input.confirm ? 'CONFIRMED' : 'REJECTED',
      decidedBy: actor,
      decidedAtEpochSeconds: now > proposal.proposedAtEpochSeconds ? now : proposal.proposedAtEpochSeconds,
      ...(note.length === 0 ? {} : { decisionNote: note }),
    };
    const pool = waslPool();
    if (pool === undefined) {
      memory().set(
        tenant,
        entries.map((e) => (e.changeId === decided.changeId ? decided : e)),
      );
      return ok(decided);
    }
    const tenantUuid = await tenantUuidByCode(pool, tenant);
    try {
      return await inTenant(pool, tenantUuid, async (db) => {
        const updated = await db.query(
          `update core.shariah_approval_change set state = $3, decided_by = $4, decided_at = to_timestamp($5),
             decision_note = $6
           where tenant_id = $1 and id = $2::uuid and state = 'PROPOSED'`,
          [
            tenantUuid,
            decided.changeId,
            decided.state,
            actor,
            String(decided.decidedAtEpochSeconds),
            decided.decisionNote ?? null,
          ],
        );
        if (updated.rowCount !== 1) return fail('APPROVAL_CHANGE_ALREADY_DECIDED', 'This proposal is already decided');
        if (decided.state === 'CONFIRMED') await project(db, tenantUuid, decided);
        return ok(decided);
      });
    } catch {
      return fail('PERSISTENCE_FAILED', 'The decision was not written');
    }
  });
}

/** A confirmed change, onto the approval row transactions refer to. */
async function project(
  db: { query: (text: string, values?: readonly unknown[]) => Promise<unknown> },
  tenantUuid: string,
  e: ApprovalChangeEntry,
): Promise<void> {
  const c = e.change;
  if (c.kind === 'RECORD') {
    const t = c.terms;
    // A row implied by a reference before the register existed is filled in; a confirmed one is never rewritten.
    await db.query(
      `insert into core.shariah_approval (tenant_id, approval_ref, approving_body, effective_from, review_or_expiry,
         status, approving_members, product_codes, template_version_ids, recorded_by, confirmed_by, confirmed_at,
         correlation_id)
       values ($1, $2, $3, $4::date, $5::date, 'IN_FORCE', $6, $7, $8, $9, $10, to_timestamp($11), $12)
       on conflict (tenant_id, approval_ref) do update set
         approving_body = excluded.approving_body, effective_from = excluded.effective_from,
         review_or_expiry = excluded.review_or_expiry, status = 'IN_FORCE',
         approving_members = excluded.approving_members, product_codes = excluded.product_codes,
         template_version_ids = excluded.template_version_ids, recorded_by = excluded.recorded_by,
         confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at
       where core.shariah_approval.confirmed_by is null`,
      [
        tenantUuid,
        t.approvalRef,
        t.approvingBody,
        t.effectiveFrom,
        t.reviewOrExpiry ?? null,
        t.members,
        t.productCodes,
        t.templateVersionIds,
        e.proposedBy,
        e.decidedBy,
        String(e.decidedAtEpochSeconds),
        randomUUID(),
      ],
    );
    return;
  }
  if (c.kind === 'RENEW') {
    await db.query(
      'update core.shariah_approval set review_or_expiry = $3::date where tenant_id = $1 and approval_ref = $2',
      [tenantUuid, c.approvalRef, c.reviewOrExpiry],
    );
    return;
  }
  const status = c.kind === 'SUSPEND' ? 'SUSPENDED' : c.kind === 'REINSTATE' ? 'IN_FORCE' : 'WITHDRAWN';
  await db.query('update core.shariah_approval set status = $3 where tenant_id = $1 and approval_ref = $2', [
    tenantUuid,
    c.approvalRef,
    status,
  ]);
}
