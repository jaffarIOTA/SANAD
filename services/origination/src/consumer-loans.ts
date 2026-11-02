/**
 * Consumer loans on PostgreSQL (migration 0038): the loan as accepted and the
 * channel it is collected through, and what has happened to it since.
 *
 * Append-only both: a loan is written once; each event once for its
 * idempotency key (a second write of the same key is a no-op, never an
 * update), so a retried servicing run records nothing twice.
 */
import type { Pool } from 'pg';

import type { CollectionChannel } from '../../../core/jurisdiction/profile.ts';
import type { CurrencyCode } from '../../../core/kernel/money.ts';
import type { CoreHeldLoanEvent, CoreHeldLoanEventKind } from '../../../core/servicing/core-held-loan.ts';
import { tenantUuidByCode } from './credentials.ts';
import { inTenant } from './tenant-scope.ts';

export interface ConsumerLoanRecord {
  readonly loanRef: string;
  readonly productCode: string;
  readonly applicantRef: string;
  readonly originRef: string;
  readonly merchantRef?: string;
  readonly principalMinorUnits: bigint;
  readonly currency: CurrencyCode;
  /** As disclosed and accepted, basis points. */
  readonly rateBp: bigint;
  /** From core/pricing/apr.ts, as disclosed. */
  readonly aprBp: bigint;
  readonly numberOfInstalments: number;
  readonly intervalDays: number;
  /** yyyy-mm-dd. */
  readonly firstDueDate: string;
  readonly collectionChannel: CollectionChannel;
  readonly collectionMandateRef: string;
  readonly correlationId: string;
  readonly createdBy: string;
  readonly createdAt?: string;
}

export interface StoredLoanEvent extends CoreHeldLoanEvent {
  readonly sequence: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ConsumerLoanView {
  readonly loan: ConsumerLoanRecord;
  readonly events: readonly StoredLoanEvent[];
}

export async function recordConsumerLoan(pool: Pool, tenantCode: string, loan: ConsumerLoanRecord): Promise<void> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  await inTenant(pool, tenant, async (db) => {
    await db.query(
      `insert into core.consumer_loan
         (tenant_id, loan_ref, product_code, applicant_ref, origin_ref, merchant_ref, principal_minor_units, currency,
          rate_bp, apr_bp, number_of_instalments, interval_days, first_due_date, collection_channel, collection_mandate_ref,
          correlation_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       on conflict (tenant_id, loan_ref) do nothing`,
      [
        tenant,
        loan.loanRef,
        loan.productCode,
        loan.applicantRef,
        loan.originRef,
        loan.merchantRef ?? null,
        loan.principalMinorUnits.toString(),
        loan.currency,
        loan.rateBp.toString(),
        loan.aprBp.toString(),
        loan.numberOfInstalments,
        loan.intervalDays,
        loan.firstDueDate,
        loan.collectionChannel,
        loan.collectionMandateRef,
        loan.correlationId,
        loan.createdBy,
      ],
    );
  });
}

/** Record events; one already recorded for its idempotency key is left as it is. */
export async function recordLoanEvents(
  pool: Pool,
  tenantCode: string,
  loanRef: string,
  events: readonly CoreHeldLoanEvent[],
  actor: string,
  correlationId: string,
): Promise<void> {
  if (events.length === 0) return;
  const tenant = await tenantUuidByCode(pool, tenantCode);
  await inTenant(pool, tenant, async (db) => {
    for (const e of events)
      await db.query(
        `insert into core.consumer_loan_event
           (tenant_id, loan_ref, kind, schedule_number, detail, idempotency_key, correlation_id, created_by)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         on conflict (tenant_id, idempotency_key) do nothing`,
        [
          tenant,
          loanRef,
          e.kind,
          e.scheduleNumber ?? null,
          JSON.stringify(e.detail),
          e.idempotencyKey,
          correlationId,
          actor,
        ],
      );
  });
}

interface LoanRow {
  loan_ref: string;
  product_code: string;
  applicant_ref: string;
  origin_ref: string;
  merchant_ref: string | null;
  principal_minor_units: string;
  currency: string;
  rate_bp: string;
  apr_bp: string;
  number_of_instalments: number;
  interval_days: number;
  first_due_date: string;
  collection_channel: string;
  collection_mandate_ref: string;
  correlation_id: string;
  created_by: string;
  created_at: Date;
}
interface EventRow {
  loan_ref: string;
  kind: string;
  schedule_number: number | null;
  detail: Record<string, string>;
  idempotency_key: string;
  sequence: string;
  created_at: Date;
  created_by: string;
}

/** The tenant's consumer loans with their events in order; newest loan first. One loan when `loanRef` is given. */
export async function listConsumerLoans(pool: Pool, tenantCode: string, loanRef?: string): Promise<ConsumerLoanView[]> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  return inTenant(pool, tenant, async (db) => {
    const loans = await db.query<LoanRow>(
      `select loan_ref, product_code, applicant_ref, origin_ref, merchant_ref,
              principal_minor_units::text as principal_minor_units, currency, rate_bp::text as rate_bp,
              apr_bp::text as apr_bp, number_of_instalments, interval_days,
              to_char(first_due_date, 'YYYY-MM-DD') as first_due_date, collection_channel, collection_mandate_ref,
              correlation_id, created_by, created_at
         from core.consumer_loan
        where ($1::text is null or loan_ref = $1)
        order by created_at desc, loan_ref desc
        limit 200`,
      [loanRef ?? null],
    );
    if (loans.rows.length === 0) return [];
    const events = await db.query<EventRow>(
      `select loan_ref, kind, schedule_number, detail, idempotency_key, sequence::text as sequence, created_at, created_by
         from core.consumer_loan_event
        where loan_ref = any($1::text[])
        order by sequence`,
      [loans.rows.map((r) => r.loan_ref)],
    );
    return loans.rows.map((r) => ({
      loan: {
        loanRef: r.loan_ref,
        productCode: r.product_code,
        applicantRef: r.applicant_ref,
        originRef: r.origin_ref,
        ...(r.merchant_ref === null ? {} : { merchantRef: r.merchant_ref }),
        principalMinorUnits: BigInt(r.principal_minor_units),
        currency: r.currency as CurrencyCode,
        rateBp: BigInt(r.rate_bp),
        aprBp: BigInt(r.apr_bp),
        numberOfInstalments: r.number_of_instalments,
        intervalDays: r.interval_days,
        firstDueDate: r.first_due_date,
        collectionChannel: r.collection_channel as CollectionChannel,
        collectionMandateRef: r.collection_mandate_ref,
        correlationId: r.correlation_id,
        createdBy: r.created_by,
        createdAt: r.created_at.toISOString(),
      },
      events: events.rows
        .filter((e) => e.loan_ref === r.loan_ref)
        .map((e) => ({
          kind: e.kind as CoreHeldLoanEventKind,
          ...(e.schedule_number === null ? {} : { scheduleNumber: e.schedule_number }),
          idempotencyKey: e.idempotency_key,
          detail: e.detail,
          sequence: e.sequence,
          createdAt: e.created_at.toISOString(),
          createdBy: e.created_by,
        })),
    }));
  });
}
