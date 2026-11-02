/**
 * Servicing S1 — repayments and the position of a disbursed facility. Each
 * case attempts something servicing forbids and passes only when it is
 * refused: a manual receipt counting before a second person confirms it, the
 * recorder confirming their own, the same receipt twice, a receipt dated in
 * the future or against a facility not yet disbursed. Clearing the arrears
 * brings the facility back to current, and a loan-system report that then
 * disagrees is flagged, not obeyed.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  SEED_PRINCIPALS,
  type BusinessApplicationView,
  confirmRepayment,
  getApplication,
  listApplications,
  recordPortfolioStatus,
  recordRepayment,
  resetBusinessStore,
} from '../../apps/ops/src/server/business.ts';

const TENANT = 'sme-fund-ae' as const;
const { finance, checker, officer } = SEED_PRINCIPALS;
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);
const today = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

let views: readonly BusinessApplicationView[] = [];
beforeEach(async () => {
  resetBusinessStore();
  views = await listApplications(TENANT);
});

const disbursed = () => {
  const v = views.find((x) => x.application.status === 'DISBURSED' && x.servicing !== undefined);
  if (v === undefined) throw new Error('no disbursed seed with a schedule');
  return v;
};

describe('repayments', () => {
  it('a manual receipt counts only once a different person confirms it', async () => {
    const v = disbursed();
    const id = v.application.applicationId;
    const before = v.servicing?.position.totalPaid.minorUnits ?? 0n;
    const recorded = expectOk(
      await recordRepayment(TENANT, id, { amountMinorUnits: 1_000_00n, receivedOn: today(), reference: 'bank-ref-0001', channel: 'MANUAL', source: 'LIVE' }, finance),
    );
    expect(recorded.servicing?.position.totalPaid.minorUnits).toBe(before);
    const rp = recorded.servicing?.repayments.at(-1)?.repaymentId ?? '';
    expect(reason(await confirmRepayment(TENANT, id, rp, finance))).toBe('FOUR_EYES_SELF_CONFIRMATION');
    const confirmed = expectOk(await confirmRepayment(TENANT, id, rp, checker));
    expect(confirmed.servicing?.position.totalPaid.minorUnits).toBe(before + 1_000_00n);
  });

  it('refuses the same receipt twice, a future value date and a facility not yet disbursed', async () => {
    const id = disbursed().application.applicationId;
    const entry = { amountMinorUnits: 500_00n, receivedOn: today(), reference: 'bank-ref-0002', channel: 'MANUAL' as const, source: 'LIVE' as const };
    expectOk(await recordRepayment(TENANT, id, entry, finance));
    expect(reason(await recordRepayment(TENANT, id, entry, finance))).toBe('REPAYMENT_DUPLICATE');
    expect(reason(await recordRepayment(TENANT, id, { ...entry, reference: 'bank-ref-0003', receivedOn: '2999-01-01' }, finance))).toBe(
      'REPAYMENT_DATE_INVALID',
    );
    const open = views.find((x) => x.application.status === 'OFFER_SENT')?.application.applicationId ?? '';
    expect(reason(await recordRepayment(TENANT, open, { ...entry, reference: 'bank-ref-0004' }, finance))).toBe('TRANSITION_NOT_ALLOWED');
  });

  it('clearing the arrears brings the facility current; a loan-system report that disagrees is flagged, not obeyed', async () => {
    const late = views.find((x) => (x.servicing?.position.daysPastDue ?? 0) > 0);
    // The seed's arrears case (FR-00005108) is past due by Sanad's own count.
    expect(late).toBeDefined();
    if (late === undefined) return;
    const id = late.application.applicationId;
    const arrears = late.servicing?.position.arrears.minorUnits ?? 0n;
    const r = expectOk(await recordRepayment(TENANT, id, { amountMinorUnits: arrears, receivedOn: today(), reference: 'bank-ref-arrears', channel: 'MANUAL', source: 'LIVE' }, finance));
    expectOk(await confirmRepayment(TENANT, id, r.servicing?.repayments.at(-1)?.repaymentId ?? '', checker));
    const cleared = await getApplication(TENANT, id);
    expect(cleared?.servicing?.position.daysPastDue).toBe(0);
    expect(cleared?.servicing?.position.arrears.minorUnits).toBe(0n);
    // The loan system still says 5 days past due: Sanad keeps its own figure and flags the difference.
    expectOk(await recordPortfolioStatus(TENANT, id, { daysPastDue: 5, arrearsMinorUnits: 100n }, officer));
    const flagged = await getApplication(TENANT, id);
    expect(flagged?.servicing?.reconciliation).toMatchObject({ loanSystemDaysPastDue: 5, sanadDaysPastDue: 0, matches: false });
  });
});
