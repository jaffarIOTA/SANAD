/**
 * Servicing S3 on a facility in arrears (the seed's FR-00005108, a term
 * loan). Each case attempts something servicing forbids and passes only when
 * it is refused: charging an instalment twice, waiving one's own charge,
 * collecting or charging during hardship, lifting one's own hold, approving
 * one's own restructuring. An approved restructuring folds the arrears into
 * the new schedule and the facility is current again.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  SEED_PRINCIPALS,
  approveRestructure,
  assessLateCharges,
  getApplication,
  liftHardship,
  presentCollections,
  proposeRestructure,
  resetBusinessStore,
  setHardship,
  waiveLateCharge,
} from '../../apps/ops/src/server/business.ts';

const TENANT = 'sme-fund-ae' as const;
const ID = 'FR-00005108';
const { finance, checker, officer } = SEED_PRINCIPALS;
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);
const monthAhead = () => new Date(Date.now() + 4 * 3_600_000 + 32 * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => resetBusinessStore());

describe('late charges', () => {
  it('charges each instalment overdue beyond the grace days once, as a fee on a term loan; the assessor does not waive it', async () => {
    const v = expectOk(await assessLateCharges(TENANT, ID, finance));
    expect(v.servicing?.lateCharges.length).toBeGreaterThan(0);
    expect(v.servicing?.lateCharges.every((c) => c.treatment === 'INCOME')).toBe(true);
    expect(reason(await assessLateCharges(TENANT, ID, finance))).toBe('NO_LATE_CHARGE_DUE');
    const n = v.servicing?.lateCharges[0]?.scheduleNumber ?? 0;
    expect(reason(await waiveLateCharge(TENANT, ID, n, 'Customer disputed the debit date', finance))).toBe(
      'FOUR_EYES_SELF_WAIVER',
    );
    const waived = expectOk(await waiveLateCharge(TENANT, ID, n, 'Customer disputed the debit date', checker));
    expect(waived.servicing?.lateCharges[0]?.waivedBy).toBe(checker);
  });
});

describe('hardship', () => {
  it('pauses collections and late charges; whoever placed the hold does not lift it', async () => {
    expectOk(await setHardship(TENANT, ID, 'Owner hospitalised; business closed for a month', officer));
    expect(reason(await presentCollections(TENANT, ID, finance))).toBe('HARDSHIP_HOLD');
    expect(reason(await assessLateCharges(TENANT, ID, finance))).toBe('HARDSHIP_HOLD');
    expect(reason(await liftHardship(TENANT, ID, officer))).toBe('FOUR_EYES_SELF_CONFIRMATION');
    expectOk(await liftHardship(TENANT, ID, checker));
    expectOk(await presentCollections(TENANT, ID, finance));
  });
});

describe('restructuring', () => {
  it('takes effect only when a second person approves; then the arrears are in the new schedule and the facility is current', async () => {
    const before = await getApplication(TENANT, ID);
    expect(before?.servicing?.position.daysPastDue).toBeGreaterThan(0);
    const proposed = expectOk(
      await proposeRestructure(
        TENANT,
        ID,
        { firstDueDate: monthAhead(), numberOfPayments: 24, reason: 'Seasonal downturn; longer term agreed' },
        officer,
      ),
    );
    const rs = proposed.servicing?.restructures.at(-1);
    expect(rs?.rows).toHaveLength(24);
    // Still in arrears until approved.
    expect(proposed.servicing?.position.daysPastDue).toBeGreaterThan(0);
    expect(
      reason(
        await proposeRestructure(
          TENANT,
          ID,
          { firstDueDate: monthAhead(), numberOfPayments: 12, reason: 'A second proposal meanwhile' },
          officer,
        ),
      ),
    ).toBe('RESTRUCTURE_PENDING');
    expect(reason(await approveRestructure(TENANT, ID, rs?.restructureId ?? '', officer))).toBe(
      'FOUR_EYES_SELF_APPROVAL',
    );
    const approved = expectOk(await approveRestructure(TENANT, ID, rs?.restructureId ?? '', checker));
    expect(approved.servicing?.position.daysPastDue).toBe(0);
    expect(approved.servicing?.position.outstandingTotal.minorUnits).toBe(rs?.totalAfter.minorUnits);
    // A term loan re-amortised at its rate costs more interest over the longer term: shown before approval.
    expect(rs?.totalAfter.minorUnits).toBeGreaterThan(0n);
  });
});
