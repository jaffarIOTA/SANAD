/**
 * The intake and the consent ledger survive the process (migration 0025).
 *
 * An intake is opened, consents are captured and the registry is checked with
 * the database configured; the working set is then dropped and reloaded from
 * PostgreSQL. The intake comes back whole, and a consent read back from the
 * ledger still authorises a rail call — which it can only do if its attested
 * instant was rebuilt from its evidence, not from a bare epoch.
 *
 * Runs with SANAD_TEST_DATABASE_URL, through the runtime role under the tenant.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import { resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import {
  getIntake,
  openIntakeFor,
  recordIntakeConsent,
  resetIntakeStore,
  runIdentityCheck,
  runRegistryCheck,
} from '../../apps/ops/src/server/intake.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const TENANT = 'sme-fund-ae';

describe.skipIf(url === undefined)('the intake on PostgreSQL', () => {
  beforeAll(() => {
    vi.stubEnv('SANAD_DATABASE_URL', url as string);
    resetIntakeStore();
    resetBusinessStore({ seed: false });
  });
  afterAll(() => vi.unstubAllEnvs());

  it('reloads the intake and its consents, and a reloaded consent still authorises a rail call', async () => {
    const opened = expectOk(
      await openIntakeFor(
        TENANT,
        {
          tradeLicence: 'CN-5550001',
          issuingAuthority: 'DET',
          businessNameEn: 'Persisted Intake LLC',
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
            { partyRef: 'party-p', displayName: 'Owner P', role: 'OWNER_SIGNATORY', ownershipPerTenThousand: 10_000 },
          ],
        },
        'officer-db',
      ),
    );
    expectOk(
      await recordIntakeConsent(
        TENANT,
        opened.intakeId,
        { type: 'IDENTITY_VERIFICATION', subject: 'party-p', evidenceRef: 'form-db' },
        'officer-db',
      ),
    );
    expectOk(await runRegistryCheck(TENANT, opened.intakeId, 'officer-db'));

    // A fresh process: nothing in memory, everything from the database.
    resetIntakeStore();
    const reloaded = await getIntake(TENANT, opened.intakeId);
    expect(reloaded?.intake.registry?.status).toBe('ACTIVE');
    expect(reloaded?.intake.consents.map((c) => c.type)).toEqual(['IDENTITY_VERIFICATION']);
    expect(reloaded?.intake.request.requested.minorUnits).toBe(40_000_000n);

    // The adapter checks the reloaded consent in the ledger before calling out.
    const checked = expectOk(await runIdentityCheck(TENANT, opened.intakeId, 'party-p', 'officer-db'));
    expect(checked.parties[0]?.identity?.verified).toBe(true);
  });
});
