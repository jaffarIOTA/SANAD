/**
 * Servicing S3, pure: a term loan re-amortised at its signed rate; an
 * Islamic facility's outstanding price re-spread with its total exactly
 * unchanged; late charges once per instalment beyond the grace days, as
 * charity for an Islamic facility.
 */
import { describe, expect, it } from 'vitest';

import { money } from '../../core/kernel/money.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { facilityPosition } from '../../core/servicing/instalment-position.ts';
import { lateChargesDue, parseServicingPolicy } from '../../core/servicing/late-charges.ts';
import { reamortise, respreadPrice } from '../../core/servicing/restructure.ts';

const sar = (v: bigint) => money(v, 'SAR');
const terms = { effectiveDate: '2027-04-01', firstDueDate: '2027-05-10', numberOfPayments: 12, paymentDay: 10 };
const policy = expectOk(
  parseServicingPolicy({ policyRef: 'ILLUSTRATIVE test', lateCharge: { graceDays: 5, amountMinorUnits: '20000' }, restructuring: { maxPayments: 60 } }),
);

describe('restructuring', () => {
  it('re-spreads an Islamic facility’s outstanding price without changing its total', () => {
    const rows = expectOk(respreadPrice(sar(1_000_001n), sar(77_777n), terms, 60));
    expect(rows).toHaveLength(12);
    expect(rows.reduce((a, r) => a + r.principal.minorUnits + r.charge.minorUnits, 0n)).toBe(1_077_778n);
    expect(rows[0]?.dueDate).toBe('2027-05-10');
    expect(rows.at(-1)?.dueDate).toBe('2028-04-10');
  });

  it('re-amortises a term loan at its rate: interest on top of the principal', () => {
    const rows = expectOk(reamortise(sar(1_000_000n), 600n, terms, 60));
    const principal = rows.reduce((a, r) => a + r.principal.minorUnits, 0n);
    const interest = rows.reduce((a, r) => a + r.charge.minorUnits, 0n);
    expect(principal).toBe(1_000_000n);
    expect(interest).toBeGreaterThan(0n);
  });

  it('refuses terms beyond the policy or out of order', () => {
    const r1 = respreadPrice(sar(100n), sar(0n), { ...terms, numberOfPayments: 61 }, 60);
    expect(r1.ok ? 'ok' : r1.error.reason).toBe('RESTRUCTURE_TERMS_INVALID');
    const r2 = respreadPrice(sar(100n), sar(0n), { ...terms, firstDueDate: '2027-03-01' }, 60);
    expect(r2.ok ? 'ok' : r2.error.reason).toBe('RESTRUCTURE_TERMS_INVALID');
  });
});

describe('late charges', () => {
  const schedule = [1, 2].map((n) => ({ number: n, dueDate: `2027-0${String(n)}-10`, principal: sar(90_000n), charge: sar(10_000n) }));
  it('one per instalment overdue beyond the grace days, never twice; charity when Islamic', () => {
    const pos = facilityPosition(schedule, [], '2027-01-16', 'SAR');
    expect(lateChargesDue(pos, policy, new Set(), false, 'SAR').map((c) => [c.instalmentNumber, c.treatment])).toEqual([[1, 'INCOME']]);
    expect(lateChargesDue(facilityPosition(schedule, [], '2027-01-15', 'SAR'), policy, new Set(), false, 'SAR')).toHaveLength(0);
    expect(lateChargesDue(pos, policy, new Set([1]), false, 'SAR')).toHaveLength(0);
    expect(lateChargesDue(pos, policy, new Set(), true, 'SAR')[0]?.treatment).toBe('CHARITY');
  });
});
