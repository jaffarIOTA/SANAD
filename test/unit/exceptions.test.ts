import { describe, expect, it } from 'vitest';
import { assign, escalate, note, open, ownerOf, resolve, resolverOf, slaBreached, statusOf } from '../../core/exceptions/exception.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { tsaInstant } from '../../core/time/tsa.ts';

const at = (s: number) => tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const ops = { principalId: 'ops-1', tenantId: 'bank-a' };
const credit = { principalId: 'credit-1', tenantId: 'bank-a' };
const opened = () => expectOk(open({ exceptionId: 'x1', tenantId: 'bank-a', subjectId: 'req_1', type: 'BUREAU_UNAVAILABLE', severity: 'HIGH', slaSeconds: 3600, by: ops, at: at(0), detail: 'bureau timed out twice' }));

describe('an exception is an append-only history', () => {
  it('opens OPEN with no owner', () => { const e = opened(); expect(statusOf(e)).toBe('OPEN'); expect(ownerOf(e)).toBeUndefined(); });
  it('cannot open without saying what is wrong', () => { expect(open({ exceptionId: 'x', tenantId: 'bank-a', subjectId: 's', type: 'KYC_MISMATCH', severity: 'LOW', slaSeconds: 10, by: ops, at: at(0), detail: '  ' }).ok).toBe(false); });
  it('assignment gives an owner and keeps every prior event', () => { const e = expectOk(assign(opened(), ops, credit, at(10))); expect(statusOf(e)).toBe('ASSIGNED'); expect(ownerOf(e)).toEqual(credit); expect(e.events).toHaveLength(2); });
  it('escalation changes owner and is recorded with its reason', () => { const e = expectOk(escalate(expectOk(assign(opened(), ops, credit, at(10))), credit, ops, 'needs committee', at(20))); expect(statusOf(e)).toBe('ESCALATED'); expect(ownerOf(e)).toEqual(ops); });
  it('refuses to escalate without a reason', () => { expect(escalate(opened(), ops, credit, '', at(1)).ok).toBe(false); });
  it('resolution requires saying how, and records who', () => { expect(resolve(opened(), credit, '', at(30)).ok).toBe(false); const e = expectOk(resolve(opened(), credit, 'bureau back; report obtained', at(30))); expect(statusOf(e)).toBe('RESOLVED'); expect(resolverOf(e)).toEqual(credit); });
  it('a resolved exception cannot be reopened by assignment or notes', () => { const e = expectOk(resolve(opened(), credit, 'done', at(30))); expect(assign(e, ops, credit, at(31)).ok).toBe(false); expect(note(e, ops, 'late note', at(31)).ok).toBe(false); });
  it('never has an owner outside its tenant', () => { expect(assign(opened(), ops, { principalId: 'x', tenantId: 'bank-b' }, at(1)).ok).toBe(false); });
});

describe('SLA is a pure function of events and an observed instant', () => {
  it('breaches only after the interval, and never once resolved', () => {
    expect(slaBreached(opened(), at(3600))).toBe(false);
    expect(slaBreached(opened(), at(3601))).toBe(true);
    expect(slaBreached(expectOk(resolve(opened(), credit, 'fixed', at(100))), at(99_999))).toBe(false);
  });
});
