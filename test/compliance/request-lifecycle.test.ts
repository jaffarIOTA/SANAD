/**
 * The request lifecycle additions from the BRD: information from outside
 * (§11, §16), servicing failure with a controlled retry ledger (§21), and
 * resubmission after a return with a diff and re-validation (MC-007/008/009).
 *
 * Each is a pure transition over attested instants. The adversarial angle:
 * nothing here can be used to skip a step, revive a decided request, or
 * resubmit a request as a different one.
 */
import { describe, expect, it } from 'vitest';

import { loadOriginationPolicy } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  expire, provideInformation, raise, recordServicingFailure, requestInformation, resubmit, retryServicing,
  returnToMaker, submitForReview, withdraw,
  type AwaitingReview, type AwaitingServicingResponse, type OriginationRequestCore, type Principal,
} from '@sanad/core/origination/request.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

const at = (s: number) => tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const policy = expectOk(loadOriginationPolicy('bank-a'));
const maker: Principal = { principalId: 'stf-maker-01', tenantId: 'bank-a' };
const checker: Principal = { principalId: 'stf-checker-01', tenantId: 'bank-a', authority: 'SENIOR_CHECKER' };

function core(over: Partial<OriginationRequestCore> = {}): OriginationRequestCore {
  return {
    requestId: 'req-l', tenantId: 'bank-a', programmeId: 'prg-0001', counterpartyId: 'cp', channel: 'MAKER_CHECKER',
    identification: { kind: 'STAFF_PRINCIPAL', principalId: 'stf-maker-01' },
    tradeReference: { type: 'CLEARED_INVOICE', invoiceUuid: 'u', invoiceHash: 'h', issuerCr: '1010000002', recipientCr: '7001000001' },
    requestedAmount: money(10_000_000n), requestedTenorDays: 60, correlationId: 'c', raisedAt: at(1_000), ...over,
  };
}
const awaitingReview = (over: Partial<OriginationRequestCore> = {}): AwaitingReview => {
  const r = expectOk(submitForReview(expectOk(raise({ core: core(over), maker, policy })), at(1_100)));
  if (r.state !== 'AWAITING_REVIEW') throw new Error('expected review'); return r;
};
const awaitingServicing = (): AwaitingServicingResponse => {
  const r = expectOk(submitForReview(expectOk(raise({ core: core({ channel: 'EMBEDDED_AGGREGATOR', identification: { kind: 'AGGREGATOR_ON_BEHALF', aggregatorId: 'hungerstation', credentialRef: 'c', merchantMandateRef: 'm' } }), maker, policy })), at(1_100)));
  if (r.state !== 'AWAITING_SERVICING_RESPONSE') throw new Error('expected servicing'); return r;
};

describe('information from outside the institution', () => {
  it('parks the request with what is needed, and returns it to review when it arrives', () => {
    const pending = expectOk(requestInformation(awaitingReview(), checker, 'DOCUMENTS', [' zakat certificate ', '', 'signatory evidence'], at(1_200)));
    expect(pending.state).toBe('PENDING_INFORMATION'); expect(pending.items).toEqual(['zakat certificate', 'signatory evidence']); expect(pending.requestedBy).toEqual(checker);
    const back = provideInformation(pending, at(1_300)); expect(back.state).toBe('AWAITING_REVIEW'); expect(back.submittedAt.epochSeconds).toBe(1_100n);
  });
  it('refuses a request for nothing', () => { expect(requestInformation(awaitingReview(), checker, 'COUNTERPARTY', ['  '], at(1)).ok).toBe(false); });
  it('can be withdrawn and can expire, but cannot be approved from', () => {
    const pending = expectOk(requestInformation(awaitingReview(), checker, 'PARTNER', ['x'], at(1_200)));
    expect(withdraw(pending).state).toBe('WITHDRAWN');
    expect(expire(pending, policy, at(1_200 + 1_209_600)).ok).toBe(true);
    expect(expire(pending, policy, at(1_200 + 1_209_599)).ok).toBe(false);
  });
});

describe('the servicing platform could not be reached', () => {
  it('holds the request with a ledger, never declines', () => {
    const one = expectOk(recordServicingFailure(awaitingServicing(), at(1_200), 'timeout'));
    const two = expectOk(recordServicingFailure(one, at(1_600), 'HTTP 503'));
    expect(two.state).toBe('SERVICING_UNAVAILABLE'); expect(two.attempts.map((a) => a.reason)).toEqual(['timeout', 'HTTP 503']);
  });
  it('refuses a failure without a reason', () => { expect(recordServicingFailure(awaitingServicing(), at(1), '').ok).toBe(false); });
  it('retries automatically within policy: backoff first, then a maximum', () => {
    const one = expectOk(recordServicingFailure(awaitingServicing(), at(1_200), 'timeout'));
    const soon = retryServicing(one, at(1_200 + policy.servicingRetry.backoffSeconds - 1), policy); expect(soon.ok).toBe(false); if (!soon.ok) expect(soon.error.reason).toBe('SERVICING_RETRY_TOO_SOON');
    const ok1 = expectOk(retryServicing(one, at(1_200 + policy.servicingRetry.backoffSeconds), policy)); expect(ok1.state).toBe('AWAITING_SERVICING_RESPONSE'); expect(ok1.attempts).toHaveLength(1);
    let cur = one;
    for (let i = 1; i < policy.servicingRetry.maxAttempts; i += 1) cur = expectOk(recordServicingFailure(cur, at(10_000 * (i + 1)), `fail ${String(i)}`));
    const exhausted = retryServicing(cur, at(10_000_000), policy); expect(exhausted.ok).toBe(false); if (!exhausted.ok) expect(exhausted.error.reason).toBe('SERVICING_RETRIES_EXHAUSTED');
  });
  it('a named person may resubmit beyond the maximum, with a note that is recorded', () => {
    let cur = expectOk(recordServicingFailure(awaitingServicing(), at(1_200), 'timeout'));
    for (let i = 1; i < policy.servicingRetry.maxAttempts; i += 1) cur = expectOk(recordServicingFailure(cur, at(10_000 * (i + 1)), `fail ${String(i)}`));
    expect(retryServicing(cur, at(10_000_000), policy, { by: checker, note: ' ' }).ok).toBe(false);
    const manual = expectOk(retryServicing(cur, at(10_000_000), policy, { by: checker, note: 'platform confirmed back by vendor' }));
    expect(manual.state).toBe('AWAITING_SERVICING_RESPONSE');
    const last = manual.attempts?.[manual.attempts.length - 1];
    expect(last?.manual?.by).toEqual(checker); expect(last?.manual?.note).toContain('vendor');
  });
});

describe('resubmission after a return keeps the identity and shows the diff', () => {
  const returned = () => expectOk(returnToMaker(awaitingReview(), checker, 'tenor too long for this programme', ));
  it('a non-material change goes back to review carrying the diff', () => {
    const r = expectOk(resubmit(returned(), core({ requestedTenorDays: 45 }), at(2_000), policy));
    expect(r.state).toBe('AWAITING_REVIEW'); expect(r.changes?.fields).toEqual(['requestedTenorDays']); expect(r.changes?.material).toBe(false); expect(r.changes?.returnedNote).toContain('tenor');
    expect(r.core.requestId).toBe('req-l');
  });
  it('a material change re-validates and, on a servicing channel, discards the earlier answer', () => {
    const agg = expectOk(submitForReview(expectOk(raise({ core: core({ channel: 'EMBEDDED_AGGREGATOR', identification: { kind: 'AGGREGATOR_ON_BEHALF', aggregatorId: 'hungerstation', credentialRef: 'c', merchantMandateRef: 'm' } }), maker, policy })), at(1_100)));
    if (agg.state !== 'AWAITING_SERVICING_RESPONSE') throw new Error('x');
    // Pretend servicing answered and it went to review, then was returned.
    const inReview: AwaitingReview = { state: 'AWAITING_REVIEW', core: agg.core, maker: agg.maker, submittedAt: agg.submittedAt, servicing: { decision: 'APPROVED', reference: 'svc', respondedAt: at(1_150) } };
    const ret = expectOk(returnToMaker(inReview, checker, 'wrong amount'));
    const r = expectOk(resubmit(ret, { ...ret.core, requestedAmount: money(12_000_000n) }, at(2_000), policy));
    expect(r.state).toBe('AWAITING_SERVICING_RESPONSE'); expect(r.changes?.material).toBe(true); expect('servicing' in r).toBe(false);
  });
  it('refuses to change identity, tenant or channel', () => {
    expect(resubmit(returned(), core({ requestId: 'other' }), at(2_000), policy).ok).toBe(false);
    expect(resubmit(returned(), core({ channel: 'AGENT_ASSISTED', identification: { kind: 'AGENT', agentId: 'agt-rm-104', branchCode: 'RUH-01' } }), at(2_000), policy).ok).toBe(false);
  });
  it('re-runs validation — a resubmission cannot smuggle in what a fresh request would be refused', () => {
    const r = resubmit(returned(), core({ requestedAmount: money(0n) }), at(2_000), policy);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('REQUESTED_AMOUNT_NOT_POSITIVE');
  });
});
