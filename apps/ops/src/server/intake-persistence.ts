/**
 * SME business intakes and the consent ledger on PostgreSQL (migration 0025).
 *
 *   core.business_intake        one row per intake, upserted on every change
 *   core.business_intake_event  append-only: every consent, check, clearance and hand-over
 *   core.consent_record         append-only: one row per grant (or withdrawal)
 *
 * The service (`intake.ts`) keeps its working set in process and marks what
 * changed; this module loads a tenant's intakes once and writes the marked
 * changes in one transaction under the tenant's row-level security, parents
 * before children, before the response that reports them is sent.
 *
 * Optimistic concurrency as for applications (business-persistence.ts): an
 * intake is updated only while its stored status and `updated_at` are the ones
 * this process loaded, so two officers cannot overwrite each other's work.
 */
import type { Pool } from 'pg';

import type { ConsentRecord } from '@sanad/core/consent/consent.ts';
import type { BusinessIntake, IntakeEvent } from '@sanad/core/origination/business-intake.ts';
import { decodeJson, encodeJson } from '@sanad/origination/codec.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { Rollback, inTenant } from '@sanad/origination/tenant-scope.ts';

export interface IntakeVersion {
  readonly status: string;
  readonly updatedAt: string;
}

export interface StoredIntake {
  readonly intake: BusinessIntake;
  readonly version: IntakeVersion;
}

export interface IntakeChanges {
  readonly intakes: readonly { readonly intake: BusinessIntake; readonly expected?: IntakeVersion }[];
  readonly events: readonly (IntakeEvent & { readonly intakeId: string })[];
  readonly consents: readonly (ConsentRecord & { readonly contextRef: string; readonly createdBy: string })[];
}

export type IntakeSaveOutcome =
  | { readonly kind: 'SAVED'; readonly versions: ReadonlyMap<string, IntakeVersion> }
  | { readonly kind: 'STALE'; readonly intakeId: string };

const decode = (v: unknown): unknown => decodeJson(typeof v === 'string' ? v : JSON.stringify(v));

export async function loadIntakeBook(
  pool: Pool,
  tenantCode: string,
): Promise<{ readonly intakes: readonly StoredIntake[]; readonly consents: readonly ConsentRecord[] }> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  return inTenant(pool, tenant, async (client) => {
    const intakes = await client.query<{ record: unknown; status: string; updated_at: string }>(
      `select record, status, updated_at::text as updated_at from core.business_intake order by sequence`,
    );
    // The stored record, so each attested instant is rebuilt by the codec from its evidence.
    const consents = await client.query<{ record: unknown }>(
      `select record from core.consent_record order by created_at`,
    );
    return {
      intakes: intakes.rows.map((r) => ({
        intake: decode(r.record) as BusinessIntake,
        version: { status: r.status, updatedAt: r.updated_at },
      })),
      consents: consents.rows.map((r) => decode(r.record) as ConsentRecord),
    };
  });
}

export async function saveIntakeChanges(
  pool: Pool,
  tenantCode: string,
  changes: IntakeChanges,
): Promise<IntakeSaveOutcome> {
  const versions = new Map<string, IntakeVersion>();
  if (changes.intakes.length + changes.events.length + changes.consents.length === 0)
    return { kind: 'SAVED', versions };
  const tenant = await tenantUuidByCode(pool, tenantCode);
  return inTenant(pool, tenant, async (client): Promise<IntakeSaveOutcome> => {
    for (const { intake: i, expected } of changes.intakes) {
      const written = await client.query<{ status: string; updated_at: string }>(
        `insert into core.business_intake
           (tenant_id, intake_id, status, trade_licence, currency, requested_minor, application_id, record, correlation_id, created_by)
         values ($1::uuid, $2, $3, $4, $5, $6::bigint, $7, $8::jsonb, $9, $10)
         on conflict (tenant_id, intake_id) do update
           set status = excluded.status,
               application_id = excluded.application_id,
               record = excluded.record
           where core.business_intake.status = $11::text
             and core.business_intake.updated_at = $12::timestamptz
         returning status, updated_at::text as updated_at`,
        [
          tenant,
          i.intakeId,
          i.status,
          i.entity.tradeLicence,
          i.request.requested.currency,
          i.request.requested.minorUnits.toString(),
          i.handedOver?.applicationId ?? null,
          encodeJson(i),
          i.intakeId,
          i.openedBy,
          expected?.status ?? null,
          expected?.updatedAt ?? null,
        ],
      );
      const row = written.rows[0];
      // Another officer or process changed it first: abandon the whole transaction and report it.
      if (row === undefined) throw new Rollback<IntakeSaveOutcome>({ kind: 'STALE', intakeId: i.intakeId });
      versions.set(i.intakeId, { status: row.status, updatedAt: row.updated_at });
    }
    for (const c of changes.consents) {
      await client.query(
        `insert into core.consent_record
           (tenant_id, consent_id, subject_ref, consent_type, purpose, channel, evidence_ref, context_ref,
            granted_at_epoch, expires_at_epoch, withdraws_consent_id, record, correlation_id, created_by)
         values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10::bigint, $11, $14::jsonb, $12, $13)`,
        [
          tenant,
          c.consentId,
          c.counterpartyId,
          c.type,
          c.purpose,
          c.channel,
          c.evidenceRef,
          c.contextRef,
          c.grantedAt.epochSeconds.toString(),
          c.expiresAt?.epochSeconds.toString() ?? null,
          c.withdraws ?? null,
          c.contextRef,
          c.createdBy,
          encodeJson({
            consentId: c.consentId,
            tenantId: c.tenantId,
            counterpartyId: c.counterpartyId,
            type: c.type,
            version: c.version,
            purpose: c.purpose,
            channel: c.channel,
            evidenceRef: c.evidenceRef,
            grantedAt: c.grantedAt,
            ...(c.expiresAt === undefined ? {} : { expiresAt: c.expiresAt }),
            ...(c.withdraws === undefined ? {} : { withdraws: c.withdraws }),
            ...(c.withdrawnAt === undefined ? {} : { withdrawnAt: c.withdrawnAt }),
          }),
        ],
      );
    }
    for (const e of changes.events) {
      await client.query(
        `insert into core.business_intake_event (tenant_id, intake_id, event_type, actor, detail, occurred_at_epoch, correlation_id)
         values ($1::uuid, $2, $3, $4, $5::jsonb, $6::bigint, $7)`,
        [tenant, e.intakeId, e.eventType, e.actor, JSON.stringify(e.detail), e.atEpochSeconds.toString(), e.intakeId],
      );
    }
    return { kind: 'SAVED', versions };
  });
}
