/**
 * SME business applications on PostgreSQL (migration 0016).
 *
 *   core.business_application        one row per application, upserted on every transition
 *   core.business_financial_figure   append-only: a proposal is a row; its verification is a
 *                                    new row that supersedes it; a correction is a new
 *                                    proposal that supersedes the verified row
 *   core.business_assessment         append-only: one row per assessment run, full trace
 *   core.business_offer_letter       append-only: one row per letter version
 *   core.business_application_event  append-only: every transition, document, input and send
 *
 * The service (`business.ts`) keeps its in-process working set and marks what
 * changed; this module loads a tenant's book once and writes the marked
 * changes in one transaction, parents before children, before the response
 * that reports them is sent.
 *
 * Amounts and instants are bigint; jsonb columns go through the origination
 * codec, which tags a bigint and rebuilds an attested instant through the one
 * function allowed to make one. No identity number is written anywhere: the
 * domain refuses one at the hand-over, and owners appear by display name and
 * reference only.
 */

import type { Pool } from 'pg';

import type { FinancialFigure } from '@sanad/core/applicant/financials.ts';
import type { BusinessApplication } from '@sanad/core/origination/business-application.ts';
import type { OutboxEvent } from '@sanad/core/outbox/outbox.ts';
import { decodeJson, encodeJson } from '@sanad/origination/codec.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';

/** A figure as a row: the row id is what supersedes it. */
export interface FigureRow {
  readonly rowId: string;
  readonly supersedes?: string;
  readonly figure: FinancialFigure;
  readonly createdBy: string;
}

/** Anything the application's history records, transition or not. */
export interface ApplicationEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly fromStage: number | null;
  readonly toStage: number | null;
  readonly actor: string;
  readonly atEpochSeconds: bigint;
  /** Strings only. Never a personal datum beyond what the domain already holds masked. */
  readonly detail: Readonly<Record<string, string>>;
  /** Order within the application's history: several events can share one second. */
  readonly sequence: number;
}

export interface PersistedAssessment {
  readonly assessmentId: string;
  readonly applicationId: string;
  readonly outcome: string;
  readonly riskLevel?: string;
  readonly cumulativeScore?: number;
  readonly policyRef: string;
  readonly assessedAtEpochSeconds: bigint;
  readonly assessedBy: string;
  /** The whole run — assessment trace, facts and their derivations, ratios — as the service holds it. */
  readonly trace: unknown;
}

export interface PersistedOffer {
  readonly offerId: string;
  readonly applicationId: string;
  readonly letterVersion: string;
  readonly currency: string;
  readonly facilityMinorUnits: bigint;
  readonly createdBy: string;
  /** The letter and the quote summary, as the service holds them. */
  readonly letter: unknown;
  readonly schedule: unknown;
}

/**
 * The stored row's version as this process last saw it: its status and its
 * `updated_at` (set by the 0016 guard trigger on every update), as text at
 * full precision. 0016 carries no version column, so these two existing
 * columns are the optimistic-concurrency token; no migration is needed.
 */
export interface ApplicationVersion {
  readonly status: string;
  readonly updatedAt: string;
}

export interface BusinessBook {
  readonly applications: readonly BusinessApplication[];
  /** Per application id, the version loaded — what an update must still find. */
  readonly versions: ReadonlyMap<string, ApplicationVersion>;
  readonly figures: readonly (FigureRow & { readonly applicationId: string })[];
  readonly assessments: readonly PersistedAssessment[];
  readonly offers: readonly PersistedOffer[];
  readonly events: readonly (ApplicationEvent & { readonly applicationId: string })[];
}

export interface ApplicationChange {
  readonly application: BusinessApplication;
  /** The version this process loaded; absent for an application it created. */
  readonly expected?: ApplicationVersion;
}

export interface BusinessChanges {
  readonly applications: readonly ApplicationChange[];
  readonly figures: readonly (FigureRow & { readonly applicationId: string })[];
  readonly assessments: readonly PersistedAssessment[];
  readonly offers: readonly PersistedOffer[];
  readonly events: readonly (ApplicationEvent & { readonly applicationId: string })[];
  /** External side effects caused by these changes, written in the same transaction (the transactional outbox). */
  readonly outbox: readonly OutboxEvent[];
}

export type SaveOutcome =
  | { readonly kind: 'SAVED'; readonly versions: ReadonlyMap<string, ApplicationVersion> }
  /** Another process changed (or created) this application since it was loaded here: nothing was written. */
  | { readonly kind: 'STALE'; readonly applicationId: string };

const decode = (v: unknown): unknown => decodeJson(typeof v === 'string' ? v : JSON.stringify(v));

/**
 * Whether this database may receive the illustrative seed: only when its
 * deployment profile (migration 0005) is readable and says it is not cleared
 * for production data. Unreadable, absent, or cleared for production — no.
 */
export async function illustrativeSeedPermitted(pool: Pool): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ production_data_permitted: boolean }>(
      'select production_data_permitted from config.deployment_profile limit 1',
    );
    const row = rows[0];
    return row !== undefined && row.production_data_permitted === false;
  } catch {
    return false;
  }
}

/** The tenant's whole business book. */
export async function loadBusinessBook(pool: Pool, tenantCode: string): Promise<BusinessBook> {
  const tenant = await tenantUuidByCode(pool, tenantCode);

  const apps = await pool.query<{ record: unknown; status: string; updated_at: string }>(
    'select record, status, updated_at::text as updated_at from core.business_application where tenant_id = $1::uuid order by sequence asc',
    [tenant],
  );

  const figures = await pool.query<{
    id: string;
    application_id: string;
    metric: string;
    period: string;
    currency: string;
    read_minor: string | null;
    verified_minor: string | null;
    source_kind: string;
    source_ref: string;
    verified_by: string | null;
    verified_at_epoch: string | null;
    supersedes: string | null;
    created_by: string;
    created_epoch: string;
  }>(
    `select id::text, application_id, metric, period, currency, read_minor::text, verified_minor::text, source_kind, source_ref,
            verified_by, verified_at_epoch::text, supersedes::text, created_by, floor(extract(epoch from created_at))::bigint::text as created_epoch
       from core.business_financial_figure
      where tenant_id = $1::uuid
      order by created_at asc`,
    [tenant],
  );

  const assessments = await pool.query<{
    id: string;
    application_id: string;
    outcome: string;
    risk_level: string | null;
    cumulative_score: number | null;
    trace: unknown;
    policy_ref: string;
    assessed_at_epoch: string;
    created_by: string;
  }>(
    `select id::text, application_id, outcome, risk_level, cumulative_score, trace, policy_ref, assessed_at_epoch::text, created_by
       from core.business_assessment where tenant_id = $1::uuid order by assessed_at_epoch asc`,
    [tenant],
  );

  const offers = await pool.query<{
    id: string;
    application_id: string;
    letter_version: string;
    letter: unknown;
    schedule: unknown;
    currency: string;
    facility_minor: string;
    created_by: string;
  }>(
    `select id::text, application_id, letter_version, letter, schedule, currency, facility_minor::text, created_by
       from core.business_offer_letter where tenant_id = $1::uuid order by created_at asc`,
    [tenant],
  );

  const events = await pool.query<{
    id: string;
    application_id: string;
    event_type: string;
    from_stage: number | null;
    to_stage: number | null;
    actor: string;
    detail: unknown;
    occurred_at_epoch: string;
  }>(
    `select id::text, application_id, event_type, from_stage, to_stage, actor, detail, occurred_at_epoch::text
       from core.business_application_event where tenant_id = $1::uuid order by occurred_at_epoch asc, created_at asc`,
    [tenant],
  );

  // A figure row's proposal instant is the FIGURE_PROPOSED event's; the row's own created_at is the fallback.
  const proposedAt = new Map<string, bigint>();
  const eventRows = events.rows.map((r) => {
    const raw = (decode(r.detail) ?? {}) as Record<string, unknown>;
    const detail: Record<string, string> = {};
    let sequence = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'seq') sequence = Number.parseInt(String(v), 10) || 0;
      else detail[k] = String(v);
    }
    if (r.event_type === 'FIGURE_PROPOSED' && detail['figureId'] !== undefined)
      proposedAt.set(detail['figureId'], BigInt(r.occurred_at_epoch));
    return {
      applicationId: r.application_id,
      eventId: r.id,
      eventType: r.event_type,
      fromStage: r.from_stage,
      toStage: r.to_stage,
      actor: r.actor,
      atEpochSeconds: BigInt(r.occurred_at_epoch),
      detail,
      sequence,
    };
  });
  eventRows.sort((a, b) =>
    a.atEpochSeconds === b.atEpochSeconds ? a.sequence - b.sequence : a.atEpochSeconds < b.atEpochSeconds ? -1 : 1,
  );

  const byId = new Map(figures.rows.map((r) => [r.id, r]));
  const figureRows = figures.rows.map((r) => {
    const currency = r.currency as FinancialFigure['proposedValue']['currency'];
    const proposal = r.supersedes === null ? undefined : byId.get(r.supersedes);
    // A verified row carries the proposal's reading; its entering officer and instant are the proposal's.
    const isVerification = r.verified_by !== null;
    const origin = isVerification && proposal !== undefined ? proposal : r;
    const enteredBy = r.source_kind === 'OFFICER_ENTRY' ? origin.created_by : undefined;
    const proposedEpoch = proposedAt.get(origin.id) ?? BigInt(origin.created_epoch);
    const base = {
      metric: r.metric as FinancialFigure['metric'],
      periodLabel: r.period,
      sourceKind: r.source_kind as FinancialFigure['sourceKind'],
      sourceRef: r.source_ref,
      proposedAtEpochSeconds: proposedEpoch,
      proposedValue: { minorUnits: BigInt(r.read_minor ?? r.verified_minor ?? '0'), currency },
      ...(enteredBy === undefined ? {} : { enteredBy }),
    };
    const figure: FinancialFigure = isVerification
      ? {
          ...base,
          status: 'VERIFIED',
          verification: {
            value: { minorUnits: BigInt(r.verified_minor ?? '0'), currency },
            verifiedBy: r.verified_by ?? '',
            verifiedAtEpochSeconds: BigInt(r.verified_at_epoch ?? '0'),
            correctedFromProposal: r.verified_minor !== r.read_minor,
          },
        }
      : { ...base, status: 'PROPOSED' };
    return {
      applicationId: r.application_id,
      rowId: r.id,
      ...(r.supersedes === null ? {} : { supersedes: r.supersedes }),
      figure,
      createdBy: r.created_by,
    };
  });

  const applications = apps.rows.map((r) => decode(r.record) as BusinessApplication);
  const versions = new Map<string, ApplicationVersion>();
  apps.rows.forEach((r, i) => {
    const a = applications[i];
    if (a !== undefined) versions.set(a.applicationId, { status: r.status, updatedAt: r.updated_at });
  });

  return {
    applications,
    versions,
    figures: figureRows,
    assessments: assessments.rows.map((r) => ({
      assessmentId: r.id,
      applicationId: r.application_id,
      outcome: r.outcome,
      ...(r.risk_level === null ? {} : { riskLevel: r.risk_level }),
      ...(r.cumulative_score === null ? {} : { cumulativeScore: r.cumulative_score }),
      policyRef: r.policy_ref,
      assessedAtEpochSeconds: BigInt(r.assessed_at_epoch),
      assessedBy: r.created_by,
      trace: decode(r.trace),
    })),
    offers: offers.rows.map((r) => ({
      offerId: r.id,
      applicationId: r.application_id,
      letterVersion: r.letter_version,
      currency: r.currency,
      facilityMinorUnits: BigInt(r.facility_minor),
      createdBy: r.created_by,
      letter: decode(r.letter),
      schedule: decode(r.schedule),
    })),
    events: eventRows,
  };
}

/**
 * Writes one batch of changes in a single transaction: applications first
 * (every other table refers to them), then figures in the order they were
 * made (a verification refers to its proposal), then assessments, letters
 * and events, then the outbox rows those changes caused — in the same
 * transaction, so a notification, payment instruction or bureau report is
 * durable exactly when the state change that caused it is. Either all of it
 * is durable or none of it is.
 *
 * Optimistic concurrency: an existing application is updated only while its
 * stored status and `updated_at` are still the ones this process loaded; a
 * new one is inserted only if no other process inserted it first. Otherwise
 * the whole transaction is rolled back and the outcome is STALE.
 */
export async function saveBusinessChanges(
  pool: Pool,
  tenantCode: string,
  changes: BusinessChanges,
): Promise<SaveOutcome> {
  const total =
    changes.applications.length +
    changes.figures.length +
    changes.assessments.length +
    changes.offers.length +
    changes.events.length +
    changes.outbox.length;
  const versions = new Map<string, ApplicationVersion>();
  if (total === 0) return { kind: 'SAVED', versions };
  const tenant = await tenantUuidByCode(pool, tenantCode);
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const { application: a, expected } of changes.applications) {
      const written = await client.query<{ status: string; updated_at: string }>(
        `insert into core.business_application
           (tenant_id, application_id, upstream_ref, stage, status, product_code, variant_code, currency, requested_minor, tenor_months, grace_months, record, correlation_id, created_by)
         values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10, $11, $12::jsonb, $13, $14)
         on conflict (tenant_id, application_id) do update
           set stage = excluded.stage,
               status = excluded.status,
               record = excluded.record
           where core.business_application.status = $15::text
             and core.business_application.updated_at = $16::timestamptz
         returning status, updated_at::text as updated_at`,
        [
          tenant,
          a.applicationId,
          a.upstreamRef,
          a.stage,
          a.status,
          a.productCode,
          a.variantCode,
          a.requested.currency,
          a.requested.minorUnits.toString(),
          a.tenorMonths,
          a.graceMonths,
          encodeJson(a),
          a.applicationId,
          a.submittedBy ?? 'upstream-handover',
          expected?.status ?? null,
          expected?.updatedAt ?? null,
        ],
      );
      const row = written.rows[0];
      if (row === undefined) {
        await client.query('rollback');
        return { kind: 'STALE', applicationId: a.applicationId };
      }
      versions.set(a.applicationId, { status: row.status, updatedAt: row.updated_at });
    }
    for (const f of changes.figures) {
      const v = f.figure.verification;
      await client.query(
        `insert into core.business_financial_figure
           (id, tenant_id, application_id, metric, period, currency, read_minor, verified_minor, source_kind, source_ref, verified_by, verified_at_epoch, supersedes, correlation_id, created_by)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::bigint, $8::bigint, $9, $10, $11, $12::bigint, $13::uuid, $14, $15)
         on conflict (id) do nothing`,
        [
          f.rowId,
          tenant,
          f.applicationId,
          f.figure.metric,
          f.figure.periodLabel,
          f.figure.proposedValue.currency,
          f.figure.proposedValue.minorUnits.toString(),
          v === undefined ? null : v.value.minorUnits.toString(),
          f.figure.sourceKind,
          f.figure.sourceRef,
          v?.verifiedBy ?? null,
          v === undefined ? null : v.verifiedAtEpochSeconds.toString(),
          f.supersedes ?? null,
          f.applicationId,
          f.createdBy,
        ],
      );
    }
    for (const s of changes.assessments) {
      await client.query(
        `insert into core.business_assessment
           (id, tenant_id, application_id, outcome, risk_level, cumulative_score, trace, policy_ref, assessed_at_epoch, correlation_id, created_by)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9::bigint, $10, $11)
         on conflict (id) do nothing`,
        [
          s.assessmentId,
          tenant,
          s.applicationId,
          s.outcome,
          s.riskLevel ?? null,
          s.cumulativeScore ?? null,
          encodeJson(s.trace),
          s.policyRef,
          s.assessedAtEpochSeconds.toString(),
          s.applicationId,
          s.assessedBy,
        ],
      );
    }
    for (const o of changes.offers) {
      await client.query(
        `insert into core.business_offer_letter
           (id, tenant_id, application_id, letter_version, letter, schedule, currency, facility_minor, correlation_id, created_by)
         values ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7, $8::bigint, $9, $10)
         on conflict (tenant_id, application_id, letter_version) do nothing`,
        [
          o.offerId,
          tenant,
          o.applicationId,
          o.letterVersion,
          encodeJson(o.letter),
          encodeJson(o.schedule),
          o.currency,
          o.facilityMinorUnits.toString(),
          o.applicationId,
          o.createdBy,
        ],
      );
    }
    for (const e of changes.events) {
      await client.query(
        `insert into core.business_application_event
           (id, tenant_id, application_id, event_type, from_stage, to_stage, actor, detail, occurred_at_epoch, correlation_id)
         values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::bigint, $10)
         on conflict (id) do nothing`,
        [
          e.eventId,
          tenant,
          e.applicationId,
          e.eventType,
          e.fromStage,
          e.toStage,
          e.actor,
          JSON.stringify({ ...e.detail, seq: String(e.sequence) }),
          e.atEpochSeconds.toString(),
          e.applicationId,
        ],
      );
    }
    // The outbox table keys on the tenant's uuid; the events carry its code. Idempotent on (tenant, kind, key), as the outbox store is.
    for (const o of changes.outbox) {
      await client.query(
        `insert into core.outbox_event (tenant_id, event_id, kind, subject_ref, idempotency_key, payload, correlation_id)
         values ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)
         on conflict (tenant_id, kind, idempotency_key) do nothing`,
        [tenant, o.eventId, o.kind, o.subjectRef, o.idempotencyKey, JSON.stringify(o.payload), o.correlationId],
      );
    }
    await client.query('commit');
    return { kind: 'SAVED', versions };
  } catch (error) {
    // A rollback on a broken connection fails too; the original error is the one that matters, and the
    // transaction is abandoned with the connection either way.
    try {
      await client.query('rollback');
    } catch {
      /* the connection is gone; nothing was committed */
    }
    throw error;
  } finally {
    client.release();
  }
}
