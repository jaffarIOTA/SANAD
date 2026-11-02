/**
 * The security register's arithmetic and rules, pure: lending value after the
 * tenant's haircut, cover rounded down and loan-to-value rounded up (neither
 * ever flattering), only confirmed and current items counted, and each
 * catalogue requirement met only by what the policy maps it to.
 */
import { describe, expect, it } from 'vitest';

import fundAeSecurity from '../../config/tenants/sme-fund-ae/credit-policy/security.json' with { type: 'json' };
import { money } from '../../core/kernel/money.ts';
import { expectOk } from '../../core/kernel/result.ts';
import {
  type CollateralItem,
  type Guarantee,
  type SecurityPolicy,
  lendingValue,
  parseSecurityPolicy,
  securityPosition,
  validateCollateralEntry,
  validateGuaranteeEntry,
} from '../../core/origination/security-register.ts';

const DAY = 86_400n;
const NOW = 1_800_000_000n;
const policy: SecurityPolicy = expectOk(parseSecurityPolicy(fundAeSecurity));
const confirmed = { recordedBy: 'officer-1', recordedAtEpochSeconds: NOW, confirmedBy: 'checker-1', confirmedAtEpochSeconds: NOW };
type Loose<T> = { [K in keyof T]?: T[K] | undefined };
const item = (over: Loose<CollateralItem>): CollateralItem => ({
  itemId: 'COL-001',
  kind: 'REAL_ESTATE',
  description: 'Warehouse, plot 12',
  marketValue: money(1_000_000_00n, 'AED'),
  valuedAtEpochSeconds: NOW - DAY,
  valuerRef: 'valuer-1',
  charge: 'NOT_APPLICABLE',
  ...confirmed,
  ...over,
}) as CollateralItem;
const guarantee = (ref: string, over: Loose<Guarantee> = {}): Guarantee => ({
  guaranteeId: `GUA-${ref}`,
  guarantorKind: 'PERSONAL',
  guarantorRef: ref,
  guarantorName: ref,
  limit: { kind: 'UNLIMITED' },
  ...confirmed,
  ...over,
}) as Guarantee;
const owners = [{ ref: 'owner-1', displayName: 'Owner One' }, { ref: 'owner-2', displayName: 'Owner Two' }];
const requested = money(700_000_00n, 'AED');

describe('the tenant policy', () => {
  it('parses, with a haircut for every kind and a mapping for every catalogue code', () => {
    expect(policy.haircutsPerTenThousand.CASH_DEPOSIT).toBe(0);
    expect(Object.keys(policy.requirements).sort()).toEqual(['INSURANCE', 'PERSONAL_GUARANTEE', 'PROMISSORY_NOTE', 'UNDERLYING_ASSET']);
    expect(policy.policyRef).toMatch(/^ILLUSTRATIVE/);
  });
  it('refuses a haircut out of range or a requirement it does not know', () => {
    const r1 = parseSecurityPolicy({ ...fundAeSecurity, haircutsPerTenThousand: { ...fundAeSecurity.haircutsPerTenThousand, VEHICLE: 10_001 } });
    expect(r1.ok ? 'parsed' : r1.error.reason).toBe('SECURITY_POLICY_INVALID');
    const r2 = parseSecurityPolicy({ ...fundAeSecurity, requirements: { X: { kind: 'WHATEVER' } } });
    expect(r2.ok ? 'parsed' : r2.error.reason).toBe('SECURITY_POLICY_INVALID');
  });
});

describe('lending value, cover and loan-to-value', () => {
  it('takes the haircut and rounds down', () => {
    // 30% off real estate: 1,000,000.00 → 700,000.00; an odd minor unit rounds down.
    expect(lendingValue(item({}), policy).minorUnits).toBe(700_000_00n);
    expect(lendingValue(item({ marketValue: money(3n, 'AED') }), policy).minorUnits).toBe(2n);
  });
  it('rounds cover down and loan-to-value up', () => {
    const p = securityPosition({ collateral: [item({ marketValue: money(1_000_001n, 'AED') })], guarantees: [] }, money(700_001n, 'AED'), [], owners, policy, NOW);
    // lending value 700,000 (rounded down from 700,000.7)
    expect(p.lendingValue.minorUnits).toBe(700_000n);
    expect(p.coveragePerTenThousand).toBe(9_999n); // 700000/700001 = 0.99999…, down
    expect(p.loanToValuePerTenThousand).toBe(10_001n); // 700001/700000 = 1.0000014…, up
  });
  it('counts nothing unconfirmed, withdrawn or valued too long ago', () => {
    const p = securityPosition(
      {
        collateral: [
          item({ itemId: 'A', confirmedBy: undefined, confirmedAtEpochSeconds: undefined }),
          item({ itemId: 'B', withdrawnBy: 'officer-1' }),
          item({ itemId: 'C', valuedAtEpochSeconds: NOW - 366n * DAY }),
        ],
        guarantees: [],
      },
      requested,
      [],
      owners,
      policy,
      NOW,
    );
    expect(p.lendingValue.minorUnits).toBe(0n);
    expect(p.loanToValuePerTenThousand).toBeUndefined();
    expect(p.staleItemIds).toEqual(['C']);
    expect(p.awaitingConfirmation).toBe(1);
  });
});

describe('requirements', () => {
  it('needs a confirmed personal guarantee from every owner', () => {
    const one = securityPosition({ collateral: [], guarantees: [guarantee('owner-1')] }, requested, ['PERSONAL_GUARANTEE'], owners, policy, NOW);
    expect(one.complete).toBe(false);
    expect(one.requirements[0]?.missingOwners).toEqual(['owner-2']);
    const both = securityPosition({ collateral: [], guarantees: [guarantee('owner-1'), guarantee('owner-2')] }, requested, ['PERSONAL_GUARANTEE'], owners, policy, NOW);
    expect(both.complete).toBe(true);
    const unconfirmed = securityPosition(
      { collateral: [], guarantees: [guarantee('owner-1'), guarantee('owner-2', { confirmedBy: undefined })] },
      requested, ['PERSONAL_GUARANTEE'], owners, policy, NOW,
    );
    expect(unconfirmed.complete).toBe(false);
  });
  it('meets a collateral requirement only with that kind, current and confirmed', () => {
    const note = item({ kind: 'PROMISSORY_NOTE' });
    expect(securityPosition({ collateral: [note], guarantees: [] }, requested, ['PROMISSORY_NOTE'], owners, policy, NOW).complete).toBe(true);
    expect(securityPosition({ collateral: [item({})], guarantees: [] }, requested, ['UNDERLYING_ASSET'], owners, policy, NOW).complete).toBe(false);
  });
  it('never meets a code the policy does not map, so a new catalogue code cannot be forgotten', () => {
    const p = securityPosition({ collateral: [], guarantees: [] }, requested, ['NEW_CODE'], owners, policy, NOW);
    expect(p.requirements[0]).toMatchObject({ code: 'NEW_CODE', met: false, unmapped: true });
  });
  it('a variant with no requirements is complete', () => {
    expect(securityPosition({ collateral: [], guarantees: [] }, requested, [], owners, policy, NOW).complete).toBe(true);
  });
});

describe('entries', () => {
  const entry = {
    kind: 'VEHICLE',
    description: 'Delivery van',
    marketValueMinorUnits: 90_000_00n,
    valuedAtEpochSeconds: NOW - DAY,
    valuerRef: 'valuer-1',
    charge: 'NOT_APPLICABLE',
  };
  const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);
  it('accepts a well-formed item in the tenant currency', () => {
    expect(expectOk(validateCollateralEntry(entry, 'AED', NOW)).marketValue).toEqual(money(90_000_00n, 'AED'));
  });
  it('refuses an identity number, a future valuation, a zero value and a registered charge without its reference', () => {
    expect(reason(validateCollateralEntry({ ...entry, description: 'Van of 784-1990-1234567-1' }, 'AED', NOW))).toBe('IDENTITY_NUMBER_IN_FREE_TEXT');
    expect(reason(validateCollateralEntry({ ...entry, valuedAtEpochSeconds: NOW + DAY }, 'AED', NOW))).toBe('VALUATION_IN_FUTURE');
    expect(reason(validateCollateralEntry({ ...entry, marketValueMinorUnits: 0n }, 'AED', NOW))).toBe('COLLATERAL_VALUE_INVALID');
    expect(reason(validateCollateralEntry({ ...entry, charge: 'REGISTERED' }, 'AED', NOW))).toBe('CHARGE_REF_REQUIRED');
    expect(reason(validateCollateralEntry({ ...entry, kind: 'GOLD_BARS' }, 'AED', NOW))).toBe('COLLATERAL_KIND_INVALID');
  });
  it('takes a personal guarantor’s name from the owner record, and refuses anyone who is not an owner', () => {
    const g = expectOk(validateGuaranteeEntry({ guarantorKind: 'PERSONAL', guarantorRef: 'owner-2', guarantorName: 'typed name' }, owners, 'AED'));
    expect(g.guarantorName).toBe('Owner Two');
    expect(reason(validateGuaranteeEntry({ guarantorKind: 'PERSONAL', guarantorRef: 'stranger', guarantorName: '' }, owners, 'AED'))).toBe('GUARANTOR_NOT_AN_OWNER');
    expect(reason(validateGuaranteeEntry({ guarantorKind: 'CORPORATE', guarantorRef: 'cr-1', guarantorName: 'Parent Co', limitMinorUnits: 0n }, owners, 'AED'))).toBe('GUARANTEE_LIMIT_INVALID');
  });
});
