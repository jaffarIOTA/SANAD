/**
 * Shariah incidents (Wasl W6b-1; BR-F04): raised by the compliance checks or
 * by a Shariah reviewer, then triaged, planned, remediated and closed by the
 * institution's Shariah reviewers — closed by a different one from the
 * reviewer who remediated, with evidence. The lifecycle is
 * core/shariah/incidents.ts; this is where incidents are kept.
 *
 * The same finding on the same transaction is raised once, ever: a defect
 * that cannot be undone (a sale offered early) stays one incident, closed
 * with its remediation, rather than a new one every morning.
 *
 * Where they live: `core.shariah_incident` and `core.shariah_incident_event`
 * when a database is configured (migration 0034), read on every call; this
 * process's memory otherwise, for development and tests. Reads no clock but
 * the host-clock stand-in (SR-006).
 */
import { createHash, randomUUID } from 'node:crypto';

import type { TenantCode } from '@sanad/config/loader.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import {
  INCIDENT_SEVERITIES,
  type IncidentAction,
  type IncidentEvent,
  type IncidentRaise,
  type IncidentSeverity,
  type ShariahIncident,
  checkIncidentAction,
  incidentFrom,
  stopsTheSale,
} from '@sanad/core/shariah/incidents.ts';

import { tenantUuidByCode } from '../credentials.ts';
import { hostClockInstant } from '../host-clock.ts';
import { inTenant } from '../tenant-scope.ts';
import { waslPool } from '../wasl/book.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

/** What a check or a reviewer found; the store adds the reference, the fingerprint and the moment. */
export interface Discovery {
  readonly subjectRef: string;
  readonly productCode: string;
  readonly checkCode: string;
  readonly control: string;
  readonly reason: string;
  readonly context: Readonly<Record<string, string>>;
  readonly severity: IncidentSeverity;
  readonly observation?: string;
}

/** One finding on one subject, the same however often it is found. */
export function fingerprintOf(d: Discovery): string {
  const context = Object.keys(d.context)
    .sort()
    .map((k) => `${k}=${d.context[k] ?? ''}`)
    .join('&');
  const observation = d.checkCode === 'MANUAL' ? (d.observation ?? '') : '';
  return createHash('sha256')
    .update([d.subjectRef, d.checkCode, d.reason, context, observation].join('|'))
    .digest('hex');
}

// -- The store ------------------------------------------------------------------------

interface Stored {
  readonly raise: IncidentRaise;
  readonly events: IncidentEvent[];
}
const KEY = Symbol.for('sanad.shariah.incidents');
const memory = (): Map<string, Stored[]> => {
  const g = globalThis as { [KEY]?: Map<string, Stored[]> };
  g[KEY] ??= new Map();
  return g[KEY];
};

/** Tests only: forget every incident. */
export function resetShariahIncidents(): void {
  memory().clear();
}

const LOCKS = Symbol.for('sanad.shariah.incidentLocks');
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

const refOf = (n: number): string => `SI-${String(n).padStart(6, '0')}`;

function actionFrom(kind: string, d: Record<string, unknown>): IncidentAction {
  const s = (k: string) => String(d[k] ?? '');
  if (kind === 'TRIAGE')
    return { kind, severity: s('severity') as IncidentSeverity, owner: s('owner'), note: s('note') };
  if (kind === 'PLAN') return { kind, plan: s('plan') };
  if (kind === 'REMEDIATE') return { kind, note: s('note'), purificationRequired: d['purificationRequired'] === true };
  return { kind: 'CLOSE', closureEvidence: s('closureEvidence') };
}

const actionJson = (a: IncidentAction): Record<string, unknown> => {
  const { kind: _kind, ...rest } = a;
  return rest;
};

/** Every incident for the tenant, oldest first. */
export async function shariahIncidents(tenant: TenantCode): Promise<readonly ShariahIncident[]> {
  const pool = waslPool();
  if (pool === undefined) return (memory().get(tenant) ?? []).map((s) => incidentFrom(s.raise, s.events));
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  return inTenant(pool, tenantUuid, async (db) => {
    const raised = await db.query<{
      id: string;
      incident_ref: string;
      subject_ref: string;
      product_code: string;
      check_code: string;
      control: string;
      reason: string;
      context: Record<string, string>;
      observation: string | null;
      severity: IncidentSeverity;
      fingerprint: string;
      raised_by: string;
      raised_at: string;
    }>(
      `select id::text, incident_ref, subject_ref, product_code, check_code, control, reason, context, observation,
              severity, fingerprint, raised_by, extract(epoch from raised_at)::bigint::text raised_at
         from core.shariah_incident where tenant_id = $1 order by raised_at, incident_ref`,
      [tenantUuid],
    );
    const events = await db.query<{
      incident_id: string;
      kind: string;
      detail: Record<string, unknown>;
      actor: string;
      occurred_at: string;
    }>(
      `select incident_id::text, kind, detail, actor, extract(epoch from occurred_at)::bigint::text occurred_at
         from core.shariah_incident_event where tenant_id = $1 order by incident_id, seq`,
      [tenantUuid],
    );
    return raised.rows.map((r) =>
      incidentFrom(
        {
          incidentId: r.id,
          incidentRef: r.incident_ref,
          subjectRef: r.subject_ref,
          productCode: r.product_code,
          checkCode: r.check_code,
          control: r.control,
          reason: r.reason,
          context: r.context,
          ...(r.observation === null ? {} : { observation: r.observation }),
          severity: r.severity,
          fingerprint: r.fingerprint,
          raisedBy: r.raised_by,
          raisedAtEpochSeconds: BigInt(r.raised_at),
        },
        events.rows
          .filter((e) => e.incident_id === r.id)
          .map((e) => ({
            action: actionFrom(e.kind, e.detail),
            actor: e.actor,
            atEpochSeconds: BigInt(e.occurred_at),
          })),
      ),
    );
  });
}

/** The open MATERIAL incidents on a subject: each one stops its commitment to a sale. */
export async function incidentsStoppingTheSale(
  tenant: TenantCode,
  subjectRef: string,
): Promise<readonly ShariahIncident[]> {
  return (await shariahIncidents(tenant)).filter((i) => i.subjectRef === subjectRef && stopsTheSale(i));
}

/**
 * Raise what was found, once: a discovery already raised on the subject, open
 * or closed, raises nothing and answers undefined.
 */
export function raiseIncident(
  tenant: TenantCode,
  raisedBy: string,
  d: Discovery,
): Promise<Result<ShariahIncident | undefined>> {
  return withLock(tenant, async () => {
    if (!INCIDENT_SEVERITIES.includes(d.severity)) return fail('INCIDENT_SEVERITY_UNKNOWN', 'No such severity');
    const fingerprint = fingerprintOf(d);
    const existing = await shariahIncidents(tenant);
    if (existing.some((i) => i.fingerprint === fingerprint)) return ok(undefined);
    const raise: IncidentRaise = {
      incidentId: randomUUID(),
      incidentRef: refOf(existing.length + 1),
      subjectRef: d.subjectRef,
      productCode: d.productCode,
      checkCode: d.checkCode,
      control: d.control,
      reason: d.reason,
      context: d.context,
      ...(d.observation === undefined ? {} : { observation: d.observation }),
      severity: d.severity,
      fingerprint,
      raisedBy,
      raisedAtEpochSeconds: hostClockInstant().epochSeconds,
    };
    const pool = waslPool();
    if (pool === undefined) {
      memory().set(tenant, [...(memory().get(tenant) ?? []), { raise, events: [] }]);
      return ok(incidentFrom(raise, []));
    }
    const tenantUuid = await tenantUuidByCode(pool, tenant);
    // Another process may have raised the next reference a moment ago: take the one after.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const n = existing.length + 1 + attempt;
      try {
        const inserted = await inTenant(pool, tenantUuid, (db) =>
          db.query(
            `insert into core.shariah_incident (id, tenant_id, incident_ref, subject_ref, product_code, check_code,
               control, reason, context, observation, severity, fingerprint, raised_by, raised_at, correlation_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, to_timestamp($14), $15)
             on conflict (tenant_id, fingerprint) do nothing`,
            [
              raise.incidentId,
              tenantUuid,
              refOf(n),
              raise.subjectRef,
              raise.productCode,
              raise.checkCode,
              raise.control,
              raise.reason,
              JSON.stringify(raise.context),
              raise.observation ?? null,
              raise.severity,
              fingerprint,
              raisedBy,
              raise.raisedAtEpochSeconds.toString(),
              randomUUID(),
            ],
          ),
        );
        return ok(inserted.rowCount === 1 ? incidentFrom({ ...raise, incidentRef: refOf(n) }, []) : undefined);
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') return fail('PERSISTENCE_FAILED', 'Nothing was raised');
      }
    }
    return fail('PERSISTENCE_FAILED', 'Nothing was raised');
  });
}

/** A Shariah reviewer raises what they observed on a transaction. */
export function raiseObservation(
  tenant: TenantCode,
  actor: string,
  input: {
    readonly subjectRef: string;
    readonly productCode: string;
    readonly severity: IncidentSeverity;
    readonly observation: string;
  },
): Promise<Result<ShariahIncident | undefined>> {
  const observation = input.observation.trim().slice(0, 2000);
  if (observation.length < 3) return Promise.resolve(fail('OBSERVATION_REQUIRED', 'Say what was observed'));
  return raiseIncident(tenant, actor, {
    subjectRef: input.subjectRef,
    productCode: input.productCode,
    checkCode: 'MANUAL',
    control: 'SH-18',
    reason: 'REVIEWER_OBSERVATION',
    context: {},
    severity: input.severity,
    observation,
  });
}

/** Triage, plan, remediate or close an incident: the next step, by a Shariah reviewer. */
export function actOnIncident(
  tenant: TenantCode,
  actor: string,
  incidentRef: string,
  action: IncidentAction,
): Promise<Result<ShariahIncident>> {
  return withLock(tenant, async () => {
    const incident = (await shariahIncidents(tenant)).find((i) => i.incidentRef === incidentRef);
    if (incident === undefined) return fail('INCIDENT_NOT_FOUND', 'No such incident');
    const checked = checkIncidentAction(incident, action, actor);
    if (!checked.ok) return checked;
    const now = hostClockInstant().epochSeconds;
    const last = incident.history.at(-1)?.atEpochSeconds ?? incident.raisedAtEpochSeconds;
    const event: IncidentEvent = { action, actor, atEpochSeconds: now > last ? now : last };
    const pool = waslPool();
    if (pool === undefined) {
      const stored = (memory().get(tenant) ?? []).find((s) => s.raise.incidentRef === incidentRef);
      stored?.events.push(event);
      return ok(incidentFrom(incident, [...incident.history, event]));
    }
    const tenantUuid = await tenantUuidByCode(pool, tenant);
    try {
      await inTenant(pool, tenantUuid, (db) =>
        db.query(
          `insert into core.shariah_incident_event (tenant_id, incident_id, seq, kind, detail, actor, occurred_at,
             correlation_id)
           values ($1, $2::uuid, $3, $4, $5::jsonb, $6, to_timestamp($7), $8)`,
          [
            tenantUuid,
            incident.incidentId,
            incident.history.length + 1,
            action.kind,
            JSON.stringify(actionJson(action)),
            actor,
            String(event.atEpochSeconds),
            randomUUID(),
          ],
        ),
      );
    } catch (error) {
      // The table's own locks: one step at a time, in order, and four eyes at closing (0034).
      const code = (error as { code?: string }).code;
      if (code === '23505') return fail('INCIDENT_STEP_OUT_OF_ORDER', 'Someone else took this step meanwhile');
      if (code === '23001') return fail('FOUR_EYES_SELF_APPROVAL', 'The database refused the step');
      return fail('PERSISTENCE_FAILED', 'The step was not written');
    }
    return ok(incidentFrom(incident, [...incident.history, event]));
  });
}
