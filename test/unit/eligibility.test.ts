/**
 * The eligibility pre-check answers what the policy would decide, and leaves
 * no trace of having been asked.
 */
import { describe, expect, it } from 'vitest';

import { loadAllForTenant } from '@sanad/config/loader.ts';
import { preCheck, REASON_BELOW_REQUESTED } from '@sanad/core/decisioning/eligibility.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { at, strongApplicant } from '../support/fixtures.ts';

const versions = expectOk(loadAllForTenant('bank-a')).creditPolicies;
const evaluatedAt = at(1_791_000_000);
const query = (over: Parameters<typeof strongApplicant>[1] = {}, amount = 5_000_000n) => ({
  snapshot: strongApplicant('bank-a', over),
  requestedAmount: money(amount),
  requestedTenorDays: 60,
  evaluatedAt,
});

describe('eligibility pre-check', () => {
  it('approves a strong applicant and names the policy version it used', () => {
    const r = expectOk(preCheck(versions, query()));
    expect(r.outcome).toBe('APPROVE'); expect(r.policyId).toBe('wasl-distributor'); expect(r.policyVersion).toBe('1.0.0'); expect(r.persisted).toBe(false);
  });
  it('declines an applicant whose registration is not active, with the reason', () => {
    const r = expectOk(preCheck(versions, query({ registration: { status: 'EXPIRED' } })));
    expect(r.outcome).toBe('DECLINE'); expect(r.reasonCodes).toContain('R_REGISTRATION_NOT_ACTIVE');
  });
  it('refers when a source is inconclusive rather than approving on a gap', () => {
    const r = expectOk(preCheck(versions, query({ screening: { sanctions: 'UNAVAILABLE' } })));
    expect(r.outcome).toBe('REFER'); expect(r.reasonCodes).toContain('R_SCREENING_UNAVAILABLE');
  });
  it('refers, not approves, when the engine would grant less than was asked', () => {
    const r = expectOk(preCheck(versions, query({}, 900_000_000_000n)));
    expect(r.outcome).toBe('REFER'); expect(r.reasonCodes).toContain(REASON_BELOW_REQUESTED);
  });
  it('refuses a non-positive amount', () => {
    expect(preCheck(versions, query({}, 0n)).ok).toBe(false);
  });
  it('answers with nothing rate-shaped', () => {
    for (const k of Object.keys(expectOk(preCheck(versions, query())))) expect(k).not.toMatch(/rate|price|margin|apr/i);
  });
});
