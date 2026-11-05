/**
 * Consumer loans on PostgreSQL (migration 0038): a BNPL loan booked in the
 * loan system (demonstration transport) and serviced there.
 *
 * - The loan is visible under its tenant only, and never changed in place.
 * - A loan in another currency than its tenant's base is refused by the table.
 * - Servicing a day collects the due instalment once on the outbox, posts the
 *   settled collection into the loan once, and a second run of the same day
 *   records nothing new.
 *
 * Runs with SANAD_TEST_DATABASE_URL, through the runtime role under the tenant.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { runConsumerLoanServicing } from '@sanad/origination/consumer-loan-servicing.ts';
import { listConsumerLoans, recordConsumerLoan } from '@sanad/origination/consumer-loans.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { inTenant } from '@sanad/origination/tenant-scope.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const TENANT = 'bank-a';
const LOAN = `txn_db_${String(Date.now())}`;

describe.skipIf(url === undefined)('consumer loans on PostgreSQL (0038)', () => {
  let pool: Pool;
  let tenant: string;

  beforeAll(async () => {
    vi.stubEnv('SANAD_DATABASE_URL', url as string);
    pool = new Pool({ connectionString: url, max: 2 });
    tenant = await tenantUuidByCode(pool, TENANT);
    await recordConsumerLoan(pool, TENANT, {
      loanRef: LOAN,
      productCode: 'bnpl',
      applicantRef: 'db-shopper-1',
      originRef: 'session-db-1',
      merchantRef: 'mer-demo-01',
      principalMinorUnits: 120_000n,
      currency: 'SAR',
      rateBp: 0n,
      aprBp: 0n,
      numberOfInstalments: 4,
      intervalDays: 30,
      firstDueDate: '2026-12-02',
      collectionChannel: 'BILL_PRESENTMENT',
      collectionMandateRef: 'demo-bill-acct-db-shopper-1',
      correlationId: '00000000-0000-4000-8000-000000000038',
      createdBy: 'db-shopper-1',
    });
  });

  afterAll(async () => {
    await pool.end();
    vi.unstubAllEnvs();
  });

  it('is visible under its own tenant only', async () => {
    const own = await listConsumerLoans(pool, TENANT, LOAN);
    expect(own.map((v) => v.loan.loanRef)).toEqual([LOAN]);
    const other = await tenantUuidByCode(pool, 'sme-fund-ae');
    const seen = await inTenant(pool, other, async (db) =>
      db.query<{ n: number }>('select count(*)::int as n from core.consumer_loan where loan_ref = $1', [LOAN]),
    );
    expect(seen.rows[0]?.n).toBe(0);
  });

  it('is never changed in place', async () => {
    await expect(
      inTenant(pool, tenant, (db) =>
        db.query('update core.consumer_loan set collection_channel = $2 where loan_ref = $1', [LOAN, 'CARD']),
      ),
    ).rejects.toThrow();
  });

  it('refuses a loan in another currency than the tenant’s base', async () => {
    await expect(
      recordConsumerLoan(pool, TENANT, {
        loanRef: `${LOAN}-aed`,
        productCode: 'bnpl',
        applicantRef: 'db-shopper-2',
        originRef: 'session-db-2',
        principalMinorUnits: 120_000n,
        currency: 'AED',
        rateBp: 0n,
        aprBp: 0n,
        numberOfInstalments: 4,
        intervalDays: 30,
        firstDueDate: '2026-12-02',
        collectionChannel: 'CARD',
        collectionMandateRef: 'demo-card-token-db-shopper-2',
        correlationId: '00000000-0000-4000-8000-000000000039',
        createdBy: 'db-shopper-2',
      }),
    ).rejects.toThrow(/base currency/);
  });

  it('keeps a monthly plan as monthly (0039), and books it in the loan system on its payment day', async () => {
    const monthly = `${LOAN}-m`;
    await recordConsumerLoan(pool, TENANT, {
      loanRef: monthly,
      productCode: 'bnpl',
      applicantRef: 'db-shopper-3',
      originRef: 'session-db-3',
      principalMinorUnits: 400_000n,
      currency: 'SAR',
      rateBp: 0n,
      aprBp: 0n,
      numberOfInstalments: 4,
      intervalMonths: 1,
      firstDueDate: '2026-12-03',
      collectionChannel: 'BILL_PRESENTMENT',
      collectionMandateRef: 'demo-bill-acct-db-shopper-3',
      correlationId: '00000000-0000-4000-8000-000000000040',
      createdBy: 'db-shopper-3',
    });
    const [read] = await listConsumerLoans(pool, TENANT, monthly);
    expect(read?.loan.intervalMonths).toBe(1);
    expect(read?.loan.intervalDays).toBeUndefined();
    const run = expectOk(
      await runConsumerLoanServicing(pool, TENANT, monthly, '2027-01-03', 'stf-checker-01', {
        simulateRailResults: true,
      }),
    );
    expect(run.position.instalments.map((i) => i.dueDate)).toEqual([
      '2026-12-03',
      '2027-01-03',
      '2027-02-03',
      '2027-03-03',
    ]);
  });

  it('refuses a loan whose plan is set both in days and in months', async () => {
    await expect(
      inTenant(pool, tenant, (db) =>
        db.query(
          `insert into core.consumer_loan
             (tenant_id, loan_ref, product_code, applicant_ref, origin_ref, principal_minor_units, currency, rate_bp,
              apr_bp, number_of_instalments, interval_days, interval_months, first_due_date, collection_channel,
              collection_mandate_ref, correlation_id, created_by)
           values ($1, $2, 'bnpl', 'db-shopper-4', 'session-db-4', 100000, 'SAR', 0, 0, 4, 30, 1, '2026-12-03',
                   'CARD', 'demo-card-token-db-shopper-4', 'c', 'db-shopper-4')`,
          [tenant, `${LOAN}-both`],
        ),
      ),
    ).rejects.toThrow(/consumer_loan_one_interval/);
  });

  it('services a day once: books, collects the due instalment, posts what settled; a rerun adds nothing', async () => {
    const first = expectOk(
      await runConsumerLoanServicing(pool, TENANT, LOAN, '2026-12-02', 'stf-checker-01', { simulateRailResults: true }),
    );
    expect(first.source).toBe('FIXTURE');
    expect(first.queued).toBe(1);
    expect(first.settled).toBe(1);
    expect(first.posted).toBe(1);
    expect(first.position.instalments[0]?.standing).toBe('PAID');

    const events = (await listConsumerLoans(pool, TENANT, LOAN))[0]?.events ?? [];
    expect(events.map((e) => e.kind)).toEqual([
      'BOOKED_IN_LOAN_SYSTEM',
      'COLLECTION_QUEUED',
      'COLLECTION_SETTLED',
      'REPAYMENT_POSTED',
    ]);
    const outbox = await inTenant(pool, tenant, (db) =>
      db.query<{ kind: string; payload: Record<string, string> }>(
        'select kind, payload from core.outbox_event where subject_ref = $1 order by created_at',
        [LOAN],
      ),
    );
    expect(outbox.rows.map((r) => r.kind)).toEqual(['BILL_PRESENT']);
    expect(outbox.rows[0]?.payload['currency']).toBe('SAR');

    const again = expectOk(
      await runConsumerLoanServicing(pool, TENANT, LOAN, '2026-12-02', 'stf-checker-01', { simulateRailResults: true }),
    );
    expect(again.queued + again.posted + again.settled).toBe(0);
    expect(((await listConsumerLoans(pool, TENANT, LOAN))[0]?.events ?? []).length).toBe(events.length);
  });
});
