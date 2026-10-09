/**
 * Ops surfaces that compile with the design package (JSX), so they are
 * type-checked under tsconfig.web-test.json with the other UI tests.
 *
 *  #15 the pipeline CSV neutralises formula-injection cells (OWASP)
 *  #7 #12 the module map is truthful about what is manual and what is a fixture
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The export is for a signed-in member of staff, of their own institution: the session cookie stands in here.
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
}));

import { handOver, resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import { MODULE_GROUPS } from '../../apps/ops/src/server/modules.ts';
import { STAFF_SESSION_COOKIE, epochNow, issueStaffSession } from '../../apps/ops/src/server/staff-session.ts';

const DATABASE = process.env['SANAD_DATABASE_URL'];

describe.skipIf(DATABASE !== undefined)('#15 the pipeline CSV export', () => {
  beforeAll(() => {
    // Wholly in memory. The business store reads only SANAD_DATABASE_URL, but the deployment's
    // jurisdiction falls back to SANAD_TEST_DATABASE_URL; with a test database configured it came from
    // there (SA), the fund tenant was inactive, and the export was empty.
    vi.stubEnv('SANAD_TEST_DATABASE_URL', '');
    process.env['SANAD_JURISDICTION'] = 'AE';
    resetBusinessStore({ seed: false });
  });

  it('neutralises cells a spreadsheet would execute (= + - @ tab CR)', async () => {
    const names = ['=HYPERLINK("http://x.test","y")', '+SUM(A1)', '-2+3', '@cmd', '\tTabbed LLC', '\rReturn LLC'];
    for (const [i, name] of names.entries()) {
      const n = String(7100 + i);
      const r = await handOver(
        'sme-fund-ae',
        {
          applicationId: `FR-0000${n}`,
          upstreamRef: `upstream-csv-${n}`,
          applicant: {
            businessNameEn: name,
            registrationRef: `TL-CSV-${n}`,
            sector: 'TRADING',
            yearsInOperation: 4,
            owners: [{ displayName: 'Csv Owner Example', ref: `owner-csv-${n}` }],
            upstreamVerificationRefs: ['uaepass:assert-csv'],
          },
          productCode: 'sme-term-conventional',
          variantCode: 'SMALL_LOAN',
          purpose: 'INVENTORY',
          requestedMinorUnits: 25_000_000n,
          tenorMonths: 24,
          graceMonths: 0,
          contributionPerTenThousand: 2_000,
        },
        'upstream',
      );
      expect(r.ok).toBe(true);
    }
    const { GET } = await import('../../apps/ops/src/app/[locale]/business/export/route.ts');
    // Signed out: no export.
    jar.clear();
    expect((await GET()).status).toBe(401);
    jar.set(
      STAFF_SESSION_COOKIE,
      issueStaffSession(
        { principalId: 'stf-ae-officer-01', tenantId: 'sme-fund-ae', authorities: ['MAKER'] },
        600n,
        epochNow(),
      ).token,
    );
    const csv = await (await GET()).text();
    const businessCells = csv
      .split('\r\n')
      .slice(1)
      .map((line) => line.split(',')[1] ?? '');
    expect(businessCells).toHaveLength(names.length);
    for (const cellText of businessCells) {
      // After optional RFC 4180 quoting, no cell starts with a formula trigger.
      expect(cellText.replace(/^"/, '')).not.toMatch(/^[=+\-@\t\r]/);
    }
    expect(csv).toContain(`"'=HYPERLINK(""http://x.test""`);
    expect(csv).toContain("'+SUM(A1)");
    expect(csv).toContain("'-2+3");
    expect(csv).toContain("'@cmd");
    expect(csv).toContain("'\tTabbed LLC");
    expect(csv).toContain(`"'\rReturn LLC"`);
  });
});

describe('#7 #12 the module map', () => {
  it('marks signing and disbursement as fixtures, and the bureau score as manual', () => {
    const items = MODULE_GROUPS.flatMap((g) => g.items);
    const signing = items.find((i) => i.id === 'business-sign-disburse');
    expect(signing?.readiness.kind).toBe('BLOCKED');
    if (signing?.readiness.kind === 'BLOCKED') expect(signing.readiness.on).toMatch(/fixture signing and payment/);
    expect(items.find((i) => i.id === 'business-assessment')?.reference).toMatch(/MANUAL: the bureau score/);
  });
});
