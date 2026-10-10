/**
 * SR-026: a consent-gated rail checks the consent itself, before any call out.
 *
 * Through the real consent ledger (`core/consent/ledger.ts`): a consent that is
 * unknown, expired, withdrawn, not yet granted, for another purpose or of
 * another tenant is refused, and the rail's transport is never called. So is a
 * request for a tenant other than the one whose credentials the adapter holds,
 * and every consent-gated call of an adapter with no ledger.
 */
import { describe, expect, it } from 'vitest';

import type { RailTransport } from '../../adapters/kernel/http-transport.ts';
import type { RailAdapterConfig } from '../../adapters/ksa/kernel/rail-adapter.ts';
import { GosiAdapter } from '../../adapters/ksa/gosi/adapter.ts';
import { SimahAdapter } from '../../adapters/ksa/simah/adapter.ts';
import type { ConsentRecord, ConsentType } from '../../core/consent/consent.ts';
import { consentLedger } from '../../core/consent/ledger.ts';
import { type CredentialProvider, SecretValue } from '../../core/ports/credentials.ts';
import type { CreditBureauPort } from '../../core/ports/credit-bureau.ts';
import type { EmploymentVerificationPort } from '../../core/ports/employment-verification.ts';
import { tsaInstant } from '../../core/time/tsa.ts';

const NOW = 1_800_000_000n;
const at = (s: bigint) => tsaInstant({ verified: true, genTimeEpochSeconds: s, tokenDigest: 'd', authorityId: 'test' });
const grant = (consentId: string, type: ConsentType, extra: Partial<ConsentRecord> = {}): ConsentRecord => ({
  consentId,
  tenantId: 'bank-a',
  counterpartyId: 'cp-1',
  type,
  version: 'v1',
  purpose: 'credit application',
  channel: 'PORTAL',
  evidenceRef: 'evidence-1',
  grantedAt: at(NOW - 100n),
  ...extra,
});
const RECORDS: readonly ConsentRecord[] = [
  grant('cns-live', 'CREDIT_BUREAU'),
  grant('cns-expired', 'CREDIT_BUREAU', { expiresAt: at(NOW - 1n) }),
  grant('cns-future', 'CREDIT_BUREAU', { grantedAt: at(NOW + 60n) }),
  grant('cns-employment', 'EMPLOYMENT_VERIFICATION'),
  grant('cns-other-tenant', 'CREDIT_BUREAU', { tenantId: 'fintech-b' }),
  grant('cns-withdrawn', 'CREDIT_BUREAU'),
  { ...grant('wdr-1', 'CREDIT_BUREAU'), withdraws: 'cns-withdrawn', withdrawnAt: at(NOW - 10n) },
];
const ledger = consentLedger(
  () => RECORDS,
  () => Promise.resolve(at(NOW)),
);

class Credentials implements CredentialProvider {
  get(): Promise<SecretValue> {
    return Promise.resolve(new SecretValue('a-provider-credential-value'));
  }
}
const config = (withLedger = true): RailAdapterConfig => ({
  tenantId: 'bank-a',
  provider: 'CREDIT_BUREAU',
  environment: 'sandbox',
  freshnessWindowSeconds: 0,
  failurePosture: 'FAIL_CLOSED',
  credentialTtlSeconds: 600,
  breaker: { failureThreshold: 2, resetAfterSeconds: 30, successThreshold: 1 },
  nowEpochSeconds: () => Number(NOW),
  baseUrl: 'https://rail.sandbox.example',
  ...(withLedger ? { consents: ledger } : {}),
});
/** A transport that counts the calls that reach it. */
const counting = () => {
  const t = { calls: 0 } as RailTransport & { calls: number };
  t.call = () => {
    t.calls += 1;
    return Promise.reject(new Error('the rail is not reached in this test'));
  };
  return t;
};
const bureau = (transport: RailTransport, withLedger = true) =>
  new SimahAdapter(config(withLedger), new Credentials(), transport, () =>
    Promise.resolve(at(NOW)),
  ) as CreditBureauPort;
const enquiry = (consentId: string, tenantId = 'bank-a') => ({
  tenantId,
  counterpartyId: 'cp-1',
  commercialRegistration: '1010000002',
  consentId,
  correlationId: 'c',
});

describe('a consent-gated rail checks the consent before calling out (SR-026)', () => {
  it.each([
    ['unknown', 'cns-nobody', 'CONSENT_NOT_FOUND'],
    ['expired', 'cns-expired', 'CONSENT_EXPIRED'],
    ['not yet granted', 'cns-future', 'CONSENT_NOT_YET_GRANTED'],
    ['withdrawn', 'cns-withdrawn', 'CONSENT_WITHDRAWN'],
    ['for another purpose', 'cns-employment', 'CONSENT_WRONG_PURPOSE'],
    ['of another tenant', 'cns-other-tenant', 'CONSENT_NOT_FOUND'],
    ['a withdrawal record', 'wdr-1', 'CONSENT_NOT_FOUND'],
    ['blank', '   ', 'CONSENT_MISSING'],
  ])('refuses a consent that is %s, and the transport is never called', async (_, consentId, reason) => {
    const t = counting();
    const r = await bureau(t).request(enquiry(consentId));
    expect(!r.ok && r.error.reason).toBe(reason);
    expect(t.calls).toBe(0);
  });

  it('refuses a request for a tenant other than the one whose credentials the adapter holds', async () => {
    const t = counting();
    const r = await bureau(t).request(enquiry('cns-other-tenant', 'fintech-b'));
    expect(!r.ok && r.error.reason).toBe('TENANT_MISMATCH');
    expect(t.calls).toBe(0);
  });

  it('refuses every consent-gated call when no ledger is configured', async () => {
    const t = counting();
    const r = await bureau(t, false).request(enquiry('cns-live'));
    expect(!r.ok && r.error.reason).toBe('CONSENT_UNVERIFIABLE');
    expect(t.calls).toBe(0);
  });

  it('calls out under a live consent of the right purpose and tenant', async () => {
    const t = counting();
    await bureau(t).request(enquiry('cns-live'));
    expect(t.calls).toBe(1);
  });

  it('asks each rail for its own purpose: an employment check under a bureau consent is refused', async () => {
    const t = counting();
    const gosi = new GosiAdapter(
      { ...config(), provider: 'EMPLOYMENT_VERIFICATION' },
      new Credentials(),
      t,
    ) as EmploymentVerificationPort;
    const r = await gosi.employment({
      tenantId: 'bank-a',
      applicantRef: 'a',
      consentId: 'cns-live',
      correlationId: 'c',
    });
    expect(!r.ok && r.error.reason).toBe('CONSENT_WRONG_PURPOSE');
    expect(t.calls).toBe(0);
    await gosi.employment({ tenantId: 'bank-a', applicantRef: 'a', consentId: 'cns-employment', correlationId: 'c' });
    expect(t.calls).toBe(1);
  });
});
