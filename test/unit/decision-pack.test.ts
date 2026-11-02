/**
 * The decision pack's pure rules: deviations read from route reasons, the
 * tenant's covenant templates, condition validation, and a digest that is one
 * value per pack — unchanged by key order or a withdrawn item, changed by any
 * live one.
 */
import { describe, expect, it } from 'vitest';

import fundAePack from '../../config/tenants/sme-fund-ae/credit-policy/decision-pack.json' with { type: 'json' };
import { expectOk } from '../../core/kernel/result.ts';
import {
  type Condition,
  attachedCount,
  deviationsOf,
  packDigest,
  parseDecisionPackPolicy,
  validateCondition,
  validateJustification,
} from '../../core/origination/decision-pack.ts';

const policy = expectOk(parseDecisionPackPolicy(fundAePack));
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);
const cond = (id: string, over: Partial<Condition> = {}): Condition => ({
  conditionId: id,
  kind: 'PRECEDENT',
  textEn: 'Board resolution',
  textAr: 'قرار مجلس الإدارة',
  addedBy: 'checker-1',
  addedAtEpochSeconds: 1n,
  ...over,
});

describe('the tenant policy', () => {
  it('parses, every financial covenant naming its ratio and minimum', () => {
    expect(policy.policyRef).toMatch(/^ILLUSTRATIVE/);
    const dscr = policy.covenantTemplates.find((t) => t.code === 'DSCR_MIN');
    expect(dscr).toMatchObject({ kind: 'FINANCIAL', metric: 'DEBT_SERVICE_COVER', minimumPerTenThousand: 14_000, frequency: 'ANNUAL' });
  });
  it('refuses a financial covenant without a minimum, and duplicate codes', () => {
    const noMin = { ...fundAePack, covenantTemplates: [{ code: 'X', kind: 'FINANCIAL', metric: 'M', frequency: 'ANNUAL', labelEn: 'x', labelAr: 'س' }] };
    expect(reason(parseDecisionPackPolicy(noMin))).toBe('DECISION_PACK_POLICY_INVALID');
    const dup = { ...fundAePack, covenantTemplates: [fundAePack.covenantTemplates[0], fundAePack.covenantTemplates[0]] };
    expect(reason(parseDecisionPackPolicy(dup))).toBe('DECISION_PACK_POLICY_INVALID');
  });
});

describe('deviations', () => {
  it('are every route reason that departs from policy; straight through and a knock-out are not', () => {
    const d = deviationsOf(
      [
        { code: 'STP_AMOUNT_WITHIN_STP_MAXIMUM_NOT_MET', detail: 'a' },
        { code: 'ALL_STP_CONDITIONS_MET', detail: '' },
        { code: 'KNOCKOUT_FAILED', detail: 'KO_DSCR' },
        { code: 'EQUITY_BELOW_RISK_ALIGNED_MINIMUM', detail: 'b' },
      ],
      { EQUITY_BELOW_RISK_ALIGNED_MINIMUM: { text: 'Owner injects cash at signing', by: 'checker-1', atEpochSeconds: 1n } },
    );
    expect(d.map((x) => x.code)).toEqual(['STP_AMOUNT_WITHIN_STP_MAXIMUM_NOT_MET', 'EQUITY_BELOW_RISK_ALIGNED_MINIMUM']);
    expect(d[0]?.justification).toBeUndefined();
    expect(d[1]?.justification?.by).toBe('checker-1');
  });
  it('a justification states a real mitigant', () => {
    expect(reason(validateJustification('ok'))).toBe('JUSTIFICATION_LENGTH');
    expect(reason(validateJustification('Guarantor 784-1990-1234567-1 is strong'))).toBe('IDENTITY_NUMBER_IN_FREE_TEXT');
  });
});

describe('conditions', () => {
  const entry = { kind: 'SUBSEQUENT', textEn: 'Charge registered', textAr: 'تسجيل الرهن', dueDaysAfterDisbursement: 60 };
  it('a subsequent one is due within the policy’s limit; a precedent one has no due days', () => {
    expect(expectOk(validateCondition(entry, policy)).dueDaysAfterDisbursement).toBe(60);
    expect(reason(validateCondition({ ...entry, dueDaysAfterDisbursement: policy.maxSubsequentDueDays + 1 }, policy))).toBe('CONDITION_DUE_INVALID');
    expect(reason(validateCondition({ ...entry, kind: 'PRECEDENT' }, policy))).toBe('CONDITION_DUE_INVALID');
  });
  it('English is English and Arabic is Arabic', () => {
    expect(reason(validateCondition({ ...entry, textAr: 'Charge registered' }, policy))).toBe('CONDITION_TEXT_INVALID');
    expect(reason(validateCondition({ ...entry, textEn: 'تسجيل الرهن' }, policy))).toBe('CONDITION_TEXT_INVALID');
  });
  it('withdrawn items do not count towards the cap', () => {
    expect(attachedCount([cond('CON-001'), cond('CON-002', { withdrawnBy: 'x' })], [])).toBe(1);
  });
});

describe('the digest', () => {
  const base = { applicationId: 'FR-1', assessmentRef: 'asm-1', deviations: [], conditions: [cond('CON-001')], covenants: [] };
  it('is the same for the same pack, and ignores a withdrawn item', () => {
    expect(packDigest(base)).toBe(packDigest({ ...base }));
    expect(packDigest({ ...base, conditions: [cond('CON-001'), cond('CON-002', { withdrawnBy: 'x' })] })).toBe(packDigest(base));
  });
  it('changes with any live item or the assessment it rests on', () => {
    expect(packDigest({ ...base, conditions: [cond('CON-001', { textEn: 'Board resolution, signed' })] })).not.toBe(packDigest(base));
    expect(packDigest({ ...base, assessmentRef: 'asm-2' })).not.toBe(packDigest(base));
  });
});
