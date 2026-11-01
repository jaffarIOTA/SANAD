/**
 * A party's contact details on PostgreSQL (migration 0037, journey gap B1).
 *
 * Opened through the intake service with the database configured: the details
 * are written with the intake in one transaction, read back by the delivery
 * directory under the tenant only, never changed in place, and absent from
 * both the stored intake and the audit chain, which record the masked forms
 * and the channels.
 *
 * Runs with SANAD_TEST_DATABASE_URL, through the runtime role under the tenant.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { contactRefOf } from '@sanad/core/origination/business-intake.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { inTenant } from '@sanad/origination/tenant-scope.ts';

import { resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import {
  openIntakeFor,
  partyContactDirectory,
  recordIntakeContact,
  resetIntakeStore,
} from '../../apps/ops/src/server/intake.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const TENANT = 'sme-fund-ae';
const EMAIL = 'db.signatory@example.com';

describe.skipIf(url === undefined)('party contacts on PostgreSQL (0037)', () => {
  let pool: Pool;
  let intakeId: string;
  let tenant: string;

  beforeAll(async () => {
    vi.stubEnv('SANAD_DATABASE_URL', url as string);
    resetIntakeStore();
    resetBusinessStore({ seed: false });
    pool = new Pool({ connectionString: url, max: 2 });
    tenant = await tenantUuidByCode(pool, TENANT);
    const opened = expectOk(
      await openIntakeFor(
        TENANT,
        {
          tradeLicence: 'CN-5550037',
          issuingAuthority: 'DET',
          businessNameEn: 'Contact Persisted LLC',
          sector: 'SERVICES',
          yearsInOperation: 3,
          productCode: 'sme-term-conventional',
          variantCode: 'WORKING_CAPITAL',
          purpose: 'WORKING_CAPITAL',
          requestedMinorUnits: 40_000_000n,
          tenorMonths: 24,
          graceMonths: 0,
          contributionPerTenThousand: 1000,
          parties: [
            {
              partyRef: 'party-p',
              displayName: 'Owner P',
              role: 'OWNER_SIGNATORY',
              ownershipPerTenThousand: 10_000,
              contact: { email: EMAIL },
            },
          ],
        },
        'officer-1',
      ),
    );
    intakeId = opened.intakeId;
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await pool.end();
  });

  it('the directory reads the latest details back, in this tenant only', async () => {
    const ref = contactRefOf(intakeId, 'party-p');
    expect((await partyContactDirectory(TENANT).resolve(ref))?.email).toBe(EMAIL);
    expectOk(await recordIntakeContact(TENANT, intakeId, 'party-p', { mobile: '+971501234567' }, 'officer-2'));
    expect(await partyContactDirectory(TENANT).resolve(ref)).toMatchObject({
      mobile: '+971501234567',
      recordedBy: 'officer-2',
    });
    expect(await partyContactDirectory('bank-a').resolve(ref)).toBeUndefined();
  });

  it('a recorded contact is never changed or deleted in place', async () => {
    for (const sql of ['update core.party_contact set email = null', 'delete from core.party_contact']) {
      await expect(inTenant(pool, tenant, (db) => db.query(sql))).rejects.toThrow();
    }
  });

  it('a row without a channel, or with an unnormalised number, is refused by the table itself', async () => {
    for (const [email, mobile] of [
      [null, null],
      [null, '050 123 4567'],
    ] as const) {
      await expect(
        inTenant(pool, tenant, (db) =>
          db.query(
            `insert into core.party_contact (tenant_id, contact_ref, email, mobile, context_ref, correlation_id, created_by)
             values ($1::uuid, 'INT-000000/x', $2, $3, 'test', 'test', 'test')`,
            [tenant, email, mobile],
          ),
        ),
      ).rejects.toThrow();
    }
  });

  it('neither the stored intake nor the audit chain holds the address', async () => {
    const stored = await inTenant(pool, tenant, (db) =>
      db.query<{ record: string }>('select record::text as record from core.business_intake where intake_id = $1', [
        intakeId,
      ]),
    );
    expect(stored.rows[0]?.record).toContain('d***@example.com');
    expect(stored.rows[0]?.record).not.toContain('db.signatory');

    const audited = await inTenant(pool, tenant, (db) =>
      db.query<{ after: string }>(
        `select after_state::text as after from audit.audit_event
          where subject_type = 'core.party_contact' and after_state->>'contactRef' = $1`,
        [contactRefOf(intakeId, 'party-p')],
      ),
    );
    expect(audited.rows.length).toBeGreaterThanOrEqual(1);
    for (const r of audited.rows) {
      expect(r.after).not.toContain('example.com');
      expect(r.after).not.toContain('501234567');
    }
  });
});
