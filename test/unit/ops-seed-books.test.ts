/**
 * The development books: the UAE fund's and the two Saudi tenants'. Each Saudi
 * book is eight synthetic cases at every stage, in SAR, under Saudi rails
 * (Nafath, Yakeen, Wathq, SIMAH, GOSI), a Saudi CR, the tenant's own staff
 * and a published example Saudi IBAN — the same state machine the UAE book
 * walks, so the Saudi journey can be shown end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { listApplications, resetBusinessStore } from '../../apps/ops/src/server/business.ts';

const SAUDI = [
  { tenant: 'bank-a', prefix: 'BA-', cr: /^1010\d{6}$/, staff: /^stf-(maker|checker|committee|finance)-01$/ },
  { tenant: 'fintech-b', prefix: 'FB-', cr: /^4030\d{6}$/, staff: /^stf-fb-(officer|checker|committee|finance)-01$/ },
] as const;

beforeEach(() => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  resetBusinessStore();
});

describe('the Saudi development books', () => {
  it.each(SAUDI)(
    '$tenant: eight cases across every stage, in SAR, on Saudi rails and its own staff',
    async ({ tenant, prefix, cr, staff }) => {
      const views = await listApplications(tenant);
      expect(views).toHaveLength(8);
      for (const v of views) {
        const a = v.application;
        expect(a.applicationId.startsWith(prefix)).toBe(true);
        expect(a.applicant.registrationRef).toMatch(cr);
        expect(a.productCode).toBe('sme-term-conventional');
        expect(a.variantCode).toBe('SME_TERM');
        expect(a.applicant.upstreamVerificationRefs.map((r) => r.split(':')[0])).toEqual([
          'nafath',
          'yakeen',
          'wathq',
          'simah',
        ]);
        // Every person who acted is the tenant's own staff or a system principal — never the UAE fund's.
        for (const e of v.events) expect(e.actor).not.toMatch(/^stf-ae-/);
        for (const e of v.events.filter((x) => x.actor.startsWith('stf-'))) expect(e.actor).toMatch(staff);
      }
      const statuses = views.map((v) => v.application.status);
      expect(statuses).toEqual(
        expect.arrayContaining(['SPREADING', 'SUBMITTED', 'IN_COMMITTEE', 'OFFER_SENT', 'DISBURSED']),
      );
      const disbursed = views.filter((v) => v.application.status === 'DISBURSED');
      expect(disbursed).toHaveLength(2);
      for (const v of disbursed) {
        expect(v.latestOffer?.terms.facilityAmount.currency).toBe('SAR');
        expect(v.latestOffer?.terms.rateSourceRef).toBeDefined();
        expect(v.closing.payee?.iban).toBe('SA0380000000608010167519');
      }
      // One facility current, one in arrears.
      expect(disbursed.map((v) => (v.servicing?.position.daysPastDue ?? 0) > 0).sort()).toEqual([false, true]);
    },
  );

  it('leaves the UAE fund’s book as it was', async () => {
    const views = await listApplications('sme-fund-ae');
    expect(views.map((v) => v.application.applicationId).sort()).toEqual(
      ['01', '02', '03', '04', '05', '06', '07', '08'].map((n) => `FR-000051${n}`),
    );
    for (const v of views) expect(v.application.applicant.registrationRef).toMatch(/^TL-ILLUS-\d{4}$/);
  });

  it('is not seeded when a test asks for an empty store', async () => {
    resetBusinessStore({ seed: false });
    for (const t of ['sme-fund-ae', 'bank-a', 'fintech-b'] as const) expect(await listApplications(t)).toEqual([]);
  });
});
