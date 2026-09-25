import { describe, expect, it } from 'vitest';
import { grant, requireConsent, validConsent, withdraw } from '../../core/consent/consent.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { tsaInstant } from '../../core/time/tsa.ts';

const at = (s: number) => tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const g = (over = {}) => expectOk(grant({ consentId: 'c1', tenantId: 'bank-a', counterpartyId: 'cp-1', type: 'CREDIT_BUREAU', version: '2026-09', purpose: 'credit assessment for programme prg-0001', channel: 'PORTAL', evidenceRef: 'sess-9f2', grantedAt: at(100), ...over }));

describe('consent is recorded with evidence and purpose', () => {
  it('refuses a grant with no evidence or no purpose', () => {
    expect(grant({ consentId: 'c', tenantId: 't', counterpartyId: 'cp', type: 'SCREENING', version: '1', purpose: 'x', channel: 'PORTAL', evidenceRef: ' ', grantedAt: at(1) }).ok).toBe(false);
    expect(grant({ consentId: 'c', tenantId: 't', counterpartyId: 'cp', type: 'SCREENING', version: '1', purpose: ' ', channel: 'PORTAL', evidenceRef: 'e', grantedAt: at(1) }).ok).toBe(false);
  });
  it('refuses an expiry before the grant', () => { expect(grant({ consentId: 'c', tenantId: 't', counterpartyId: 'cp', type: 'SCREENING', version: '1', purpose: 'p', channel: 'PORTAL', evidenceRef: 'e', grantedAt: at(10), expiresAt: at(5) }).ok).toBe(false); });
});

describe('the gate before a third-party call', () => {
  it('passes with a live consent and refuses without one', () => {
    expect(requireConsent([g()], 'cp-1', 'CREDIT_BUREAU', at(200)).ok).toBe(true);
    const r = requireConsent([g()], 'cp-1', 'SCREENING', at(200)); expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('CONSENT_MISSING');
    expect(requireConsent([g()], 'cp-2', 'CREDIT_BUREAU', at(200)).ok).toBe(false);
  });
  it('is not valid before it was granted, nor after it expires', () => {
    expect(validConsent([g({ expiresAt: at(500) })], 'cp-1', 'CREDIT_BUREAU', at(99))).toBeUndefined();
    expect(validConsent([g({ expiresAt: at(500) })], 'cp-1', 'CREDIT_BUREAU', at(500))).toBeUndefined();
    expect(validConsent([g({ expiresAt: at(500) })], 'cp-1', 'CREDIT_BUREAU', at(499))).toBeDefined();
  });
  it('a withdrawal is a new record; the grant stays and stops being valid from then', () => {
    const w = expectOk(withdraw(g(), 'c2', at(300), 'PORTAL', 'sess-a1'));
    const records = [g(), w];
    expect(records).toHaveLength(2);
    expect(validConsent(records, 'cp-1', 'CREDIT_BUREAU', at(299))).toBeDefined();
    expect(validConsent(records, 'cp-1', 'CREDIT_BUREAU', at(300))).toBeUndefined();
    expect(withdraw(w, 'c3', at(400), 'PORTAL', 'x').ok).toBe(false);
  });
});
