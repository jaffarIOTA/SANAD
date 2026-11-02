/**
 * The decision pack on a business application (UAE M4). Each case attempts
 * something the decision forbids and passes only when it is refused: a
 * committee approval over an unjustified deviation, an approval by the
 * member who argued for the exception, more conditions than the risk band
 * allows, a typed covenant, changing the pack once a member has approved it.
 *
 * The book is the service's in-memory seed for sme-fund-ae; its committee
 * cases arrive with their deviations justified by the checker.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  SEED_PRINCIPALS,
  addCondition,
  addCovenant,
  decideInCommittee,
  decisionPack,
  getApplication,
  listApplications,
  resetBusinessStore,
  withdrawPackItem,
} from '../../apps/ops/src/server/business.ts';

const TENANT = 'sme-fund-ae' as const;
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);
const cp = { kind: 'PRECEDENT', textEn: 'Board resolution approving the facility', textAr: 'قرار مجلس الإدارة بالموافقة على التمويل' };

let committeeCase = '';
beforeEach(async () => {
  resetBusinessStore();
  const views = await listApplications(TENANT);
  committeeCase = views.find((v) => v.application.status === 'IN_COMMITTEE')?.application.applicationId ?? '';
  expect(committeeCase).not.toBe('');
});

describe('deviations', () => {
  it('are read from the assessment, never typed; the committee case carries at least one, justified', async () => {
    const pack = expectOk(await decisionPack(TENANT, committeeCase));
    expect(pack.deviations.length).toBeGreaterThan(0);
    expect(pack.deviations.map((d) => d.code)).not.toContain('ALL_STP_CONDITIONS_MET');
    expect(pack.deviations.map((d) => d.code)).not.toContain('KNOCKOUT_FAILED');
    for (const d of pack.deviations) expect(d.justification?.by).toBe(SEED_PRINCIPALS.checker);
  });

  it('whoever justified a deviation does not approve the case', async () => {
    const r = await decideInCommittee(TENANT, committeeCase, {
      decidedBy: SEED_PRINCIPALS.checker,
      approved: true,
      reason: 'Within risk-aligned terms',
    });
    expect(reason(r)).toBe('FOUR_EYES_SELF_JUSTIFICATION');
  });
  // The refusal of an approval over an unjustified deviation: business-approved-terms.test.ts, end to end.
});

describe('conditions and covenants', () => {
  it('are capped by the risk band’s maximum', async () => {
    const pack = expectOk(await decisionPack(TENANT, committeeCase));
    const max = pack.maxConditions ?? 0;
    expect(max).toBeGreaterThan(0);
    for (let i = 0; i < max; i++)
      expectOk(await addCondition(TENANT, committeeCase, { ...cp, textEn: `${cp.textEn} ${String(i)}` }, 'checker-2'));
    expect(reason(await addCondition(TENANT, committeeCase, cp, 'checker-2'))).toBe('CONDITIONS_ABOVE_RISK_MAXIMUM');
    // Withdrawing one frees a place.
    const first = expectOk(await decisionPack(TENANT, committeeCase)).conditions[0]?.conditionId ?? '';
    expectOk(await withdrawPackItem(TENANT, committeeCase, first, 'checker-2'));
    expectOk(await addCondition(TENANT, committeeCase, cp, 'checker-2'));
  });

  it('a covenant comes only from the institution’s templates, once', async () => {
    expect(reason(await addCovenant(TENANT, committeeCase, 'DSCR_AT_LEAST_0_5', 'checker-2'))).toBe('COVENANT_UNKNOWN');
    const v = expectOk(await addCovenant(TENANT, committeeCase, 'DSCR_MIN', 'checker-2'));
    expect(v.pack.covenants.at(-1)?.template).toMatchObject({ code: 'DSCR_MIN', kind: 'FINANCIAL', minimumPerTenThousand: 14_000 });
    expect(reason(await addCovenant(TENANT, committeeCase, 'DSCR_MIN', 'checker-2'))).toBe('COVENANT_DUPLICATE');
  });

  it('refuses a malformed condition', async () => {
    expect(reason(await addCondition(TENANT, committeeCase, { ...cp, dueDaysAfterDisbursement: 30 }, 'checker-2'))).toBe(
      'CONDITION_DUE_INVALID',
    );
    expect(reason(await addCondition(TENANT, committeeCase, { ...cp, kind: 'SUBSEQUENT' }, 'checker-2'))).toBe('CONDITION_DUE_INVALID');
    expect(reason(await addCondition(TENANT, committeeCase, { ...cp, textEn: cp.textAr }, 'checker-2'))).toBe('CONDITION_TEXT_INVALID');
    expect(reason(await addCondition(TENANT, committeeCase, { ...cp, kind: 'SUBSEQUENT', dueDaysAfterDisbursement: 9999 }, 'checker-2'))).toBe(
      'CONDITION_DUE_INVALID',
    );
  });
});

describe('approval locks and freezes the pack', () => {
  it('nothing changes once a committee member has approved; at approval the pack is frozen by its digest', async () => {
    expectOk(await addCondition(TENANT, committeeCase, cp, 'checker-2'));
    const before = expectOk(await decisionPack(TENANT, committeeCase)).digest;
    expectOk(
      await decideInCommittee(TENANT, committeeCase, {
        decidedBy: SEED_PRINCIPALS.committee,
        approved: true,
        reason: 'Within risk-aligned terms',
      }),
    );
    expect(reason(await addCondition(TENANT, committeeCase, cp, 'checker-2'))).toBe('DECISION_PACK_LOCKED');
    expect(reason(await addCovenant(TENANT, committeeCase, 'AUDITED_FINANCIALS', 'checker-2'))).toBe('DECISION_PACK_LOCKED');
    const view = await getApplication(TENANT, committeeCase);
    if (view?.application.status === 'APPROVED') {
      expect(view.pack.frozen?.digest).toBe(before);
      expect(view.events.some((e) => e.eventType === 'DECISION_PACK_FROZEN')).toBe(true);
    } else {
      // Short of quorum: still in committee, the pack locked so every member approves the same one.
      expect(view?.application.status).toBe('IN_COMMITTEE');
    }
  });
});
