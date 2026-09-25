/**
 * The origination policy — what a bank configures about intake — and the one
 * thing it must never be able to touch.
 *
 * The BRD asks for configurable approval hierarchies, agent limits, partner
 * entitlements, SLAs and expiry (§5.3, §7 MC-010, §11, §18, §23). All of it
 * is tenant configuration here. These tests prove two things: that the
 * configuration is enforced, and that none of it can reach a sequencing gate.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadOriginationPolicy, TENANT_CODES } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  authorityCovers,
  checkAgentEntitlement,
  checkPartnerEntitlement,
  isExpired,
  parseOriginationPolicy,
  requiredAuthority,
  slaStatus,
  type OriginationPolicy,
} from '@sanad/core/origination/policy.ts';
import {
  approve,
  expire,
  raise,
  submitForReview,
  type OriginationRequestCore,
  type Principal,
} from '@sanad/core/origination/request.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const at = (s: number) =>
  tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t-${String(s)}`, authorityId: 'test' });

const bankA = expectOk(loadOriginationPolicy('bank-a'));

function core(over: Partial<OriginationRequestCore> = {}): OriginationRequestCore {
  return {
    requestId: 'req-t', tenantId: 'bank-a', programmeId: 'prg-0001', counterpartyId: 'cp',
    channel: 'AGENT_ASSISTED',
    identification: { kind: 'AGENT', agentId: 'agt-fo-227', branchCode: 'JED-03' },
    tradeReference: { type: 'CLEARED_INVOICE', invoiceUuid: 'u', invoiceHash: 'h', issuerCr: '1010000002', recipientCr: '7001000001' },
    requestedAmount: money(10_000_000n), requestedTenorDays: 60, correlationId: 'c', raisedAt: at(1_000),
    ...over,
  };
}
const maker: Principal = { principalId: 'stf-maker-01', tenantId: 'bank-a' };

describe('the policy file is parsed strictly', () => {
  it.each(TENANT_CODES)('%s parses', (tenant) => {
    expect(loadOriginationPolicy(tenant).ok).toBe(true);
  });

  it('refuses an unknown section rather than ignoring it', () => {
    // A typo in a limit key would otherwise remove the limit while looking configured.
    const r = parseOriginationPolicy({ tenantId: 't', version: '1', approvalTiers: [{ authority: 'CHECKER' }], agentLimits: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('POLICY_UNKNOWN_SECTION');
  });

  it('refuses an amount written as a number', () => {
    const r = parseOriginationPolicy({ tenantId: 't', version: '1', approvalTiers: [{ upToMinorUnits: 25000000, authority: 'CHECKER' }, { authority: 'SENIOR_CHECKER' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('POLICY_AMOUNT_NOT_MINOR_UNITS');
  });

  it('refuses tiers that do not ascend, and an unbounded tier that is not last', () => {
    expect(parseOriginationPolicy({ tenantId: 't', version: '1', approvalTiers: [{ upToMinorUnits: '200', authority: 'CHECKER' }, { upToMinorUnits: '100', authority: 'SENIOR_CHECKER' }, { authority: 'CREDIT_COMMITTEE' }] }).ok).toBe(false);
    expect(parseOriginationPolicy({ tenantId: 't', version: '1', approvalTiers: [{ authority: 'CHECKER' }, { upToMinorUnits: '100', authority: 'SENIOR_CHECKER' }] }).ok).toBe(false);
  });

  it('refuses an SLA on a state a request cannot wait in', () => {
    const r = parseOriginationPolicy({ tenantId: 't', version: '1', approvalTiers: [{ authority: 'CHECKER' }], slaSeconds: { APPROVED: 100 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('POLICY_UNKNOWN_STATE');
  });

  it('contains nothing rate-shaped, by construction', () => {
    for (const tenant of TENANT_CODES) {
      const raw = readFileSync(`${ROOT}config/tenants/${tenant}/origination/policy.json`, 'utf8');
      expect(raw).not.toMatch(/rate|percent|margin|apr\b/i);
    }
  });
});

describe('the second-client test — two tenants, two answers, one code path', () => {
  it('bank-a has tiers and agents; fintech-b has a flat tier and none', () => {
    const b = expectOk(loadOriginationPolicy('fintech-b'));
    expect(bankA.approvalTiers.length).toBe(3);
    expect(b.approvalTiers.length).toBe(1);
    expect(bankA.agents.length).toBeGreaterThan(0);
    expect(b.agents.length).toBe(0);
    expect(bankA.slaSeconds.AWAITING_REVIEW).not.toBe(b.slaSeconds.AWAITING_REVIEW);
  });
});

describe('approval tiers govern who may approve a request', () => {
  it('maps an amount to the tier it falls in', () => {
    expect(requiredAuthority(bankA, money(25_000_000n))).toBe('CHECKER');
    expect(requiredAuthority(bankA, money(25_000_001n))).toBe('SENIOR_CHECKER');
    expect(requiredAuthority(bankA, money(100_000_000n))).toBe('SENIOR_CHECKER');
    expect(requiredAuthority(bankA, money(100_000_001n))).toBe('CREDIT_COMMITTEE');
  });

  it('a higher authority covers a lower requirement; absent means lowest', () => {
    expect(authorityCovers('CREDIT_COMMITTEE', 'CHECKER')).toBe(true);
    expect(authorityCovers('CHECKER', 'SENIOR_CHECKER')).toBe(false);
    expect(authorityCovers(undefined, 'CHECKER')).toBe(true);
    expect(authorityCovers(undefined, 'SENIOR_CHECKER')).toBe(false);
  });

  it('approve() refuses a checker whose authority does not cover the amount', () => {
    const keyed = expectOk(raise({ core: core({ channel: 'MAKER_CHECKER', identification: { kind: 'STAFF_PRINCIPAL', principalId: 'stf-maker-01' }, requestedAmount: money(42_000_000n) }), maker, policy: bankA }));
    const awaiting = expectOk(submitForReview(keyed, at(1_100)));
    if (awaiting.state !== 'AWAITING_REVIEW') throw new Error('unexpected');

    const junior: Principal = { principalId: 'stf-checker-01', tenantId: 'bank-a', authority: 'CHECKER' };
    const refused = approve(awaiting, junior, at(1_200), undefined, bankA);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.reason).toBe('APPROVAL_AUTHORITY_INSUFFICIENT');
      expect(refused.error.context?.['required']).toBe('SENIOR_CHECKER');
    }

    const senior: Principal = { ...junior, principalId: 'stf-checker-02', authority: 'SENIOR_CHECKER' };
    expect(approve(awaiting, senior, at(1_200), undefined, bankA).ok).toBe(true);
  });
});

describe('agent entitlement', () => {
  const id = { kind: 'AGENT' as const, agentId: 'agt-fo-227', branchCode: 'JED-03' };
  const req = { programmeId: 'prg-0001', requestedAmount: money(10_000_000n) };

  it('admits an active agent within programme, branch and limit', () => {
    expect(checkAgentEntitlement(bankA, id, req).ok).toBe(true);
  });
  it.each([
    [{ ...id, agentId: 'agt-nobody' }, req, 'AGENT_NOT_ENTITLED'],
    [{ ...id, agentId: 'agt-rm-088', branchCode: 'RUH-01' }, req, 'AGENT_SUSPENDED'],
    [{ ...id, branchCode: 'RUH-01' }, req, 'AGENT_OUTSIDE_BRANCH'],
    [id, { ...req, programmeId: 'prg-9999' }, 'AGENT_PROGRAMME_NOT_ENTITLED'],
    [id, { ...req, requestedAmount: money(15_000_001n) }, 'AGENT_LIMIT_EXCEEDED'],
  ])('refuses %o / %o with %s', (who, what, reason) => {
    const r = checkAgentEntitlement(bankA, who, what);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe(reason);
  });

  it('raise() applies it when given the policy', () => {
    const r = raise({ core: core({ identification: { kind: 'AGENT', agentId: 'agt-rm-088', branchCode: 'RUH-01' } }), maker, policy: bankA });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('AGENT_SUSPENDED');
  });
});

describe('partner entitlement', () => {
  const req = { programmeId: 'prg-0001', requestedAmount: money(10_000_000n), channel: 'PARTNER_API' as const };
  it('admits an active partner on its channel within limit', () => {
    expect(checkPartnerEntitlement(bankA, { kind: 'PARTNER_SYSTEM', partnerId: 'partner-dev-01', credentialRef: 'c' }, req).ok).toBe(true);
  });
  it('refuses a suspended partner', () => {
    const r = checkPartnerEntitlement(bankA, { kind: 'PARTNER_SYSTEM', partnerId: 'partner-suspended', credentialRef: 'c' }, req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('PARTNER_SUSPENDED');
  });
  it('refuses a partner on a channel it is not entitled to', () => {
    const r = checkPartnerEntitlement(bankA, { kind: 'AGGREGATOR_ON_BEHALF', aggregatorId: 'hungerstation', credentialRef: 'c', merchantMandateRef: 'm' }, req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('PARTNER_CHANNEL_MISMATCH');
  });
  it('refuses over the per-request limit with OP-LIMIT', () => {
    const r = checkPartnerEntitlement(bankA, { kind: 'AGGREGATOR_ON_BEHALF', aggregatorId: 'hungerstation', credentialRef: 'c', merchantMandateRef: 'm' }, { ...req, channel: 'EMBEDDED_AGGREGATOR', requestedAmount: money(20_000_001n) });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.control).toBe('OP-LIMIT'); expect(r.error.reason).toBe('PARTNER_LIMIT_EXCEEDED'); }
  });
});

describe('SLA and expiry are pure functions of attested time', () => {
  it('reports a breach only past the configured seconds', () => {
    expect(slaStatus(bankA, 'AWAITING_REVIEW', 0n, 86_400n)).toBe('WITHIN');
    expect(slaStatus(bankA, 'AWAITING_REVIEW', 0n, 86_401n)).toBe('BREACHED');
    expect(slaStatus(bankA, 'APPROVED', 0n, 10n ** 9n)).toBe('NONE');
  });

  it('expire() refuses before the interval and succeeds after — nothing can expire a request early', () => {
    const keyed = expectOk(raise({ core: core({ channel: 'MAKER_CHECKER', identification: { kind: 'STAFF_PRINCIPAL', principalId: 'stf-maker-01' } }), maker, policy: bankA }));
    const awaiting = expectOk(submitForReview(keyed, at(1_000)));
    if (awaiting.state !== 'AWAITING_REVIEW') throw new Error('unexpected');

    const early = expire(awaiting, bankA, at(1_000 + 1_209_599));
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.reason).toBe('REQUEST_NOT_YET_EXPIRED');

    const due = expire(awaiting, bankA, at(1_000 + 1_209_600));
    expect(due.ok).toBe(true);
    if (due.ok) { expect(due.value.state).toBe('EXPIRED'); expect(due.value.wasIn).toBe('AWAITING_REVIEW'); }
    expect(isExpired(bankA, 'AWAITING_REVIEW', 1_000n, 1_000n + 1_209_600n)).toBe(true);
  });
});

describe('none of this can reach a sequencing gate', () => {
  it('the sequencing modules import nothing from the origination policy and use none of its exports', () => {
    // Comments are stripped first: `core/sequencing` legitimately speaks of
    // the *timestamping* authority in prose, and a scan for behaviour is
    // looking for code. The identifiers below are this module's exports.
    const codeOnly = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const file of ['core/sequencing/transitions.ts', 'core/sequencing/gates.ts', 'core/sequencing/state.ts']) {
      const src = codeOnly(readFileSync(`${ROOT}${file}`, 'utf8'));
      expect(src, file).not.toMatch(/origination\/policy/);
      expect(src, file).not.toMatch(
        /\b(requiredAuthority|authorityCovers|ApprovalAuthority|ApprovalTier|checkAgentEntitlement|checkPartnerEntitlement|OriginationPolicy)\b/,
      );
    }
  });

  it('an approved request still opens a transaction in DRAFT and nothing later, whatever the authority', () => {
    // The type is the control: `openTransaction` returns `Draft`. This pins
    // that the addition of authority tiers did not widen it.
    const src = readFileSync(`${ROOT}core/origination/request.ts`, 'utf8');
    expect(src).toMatch(/export function openTransaction\([^)]*\): Result<Draft>/);
  });
});

/** Keeps the policy type in the import graph for the file-scan assertions above. */
const _typeOnly: OriginationPolicy | undefined = undefined;
void _typeOnly;
