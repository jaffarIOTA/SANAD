/**
 * The snapshot assembler: every rail answers, is unavailable, or was not
 * asked for want of consent — and each is a recorded fact the engine
 * refers on, never an exception and never an approval.
 */
import { describe, expect, it } from 'vitest';

import { type ConsentRecord, grant } from '@sanad/core/consent/consent.ts';
import { type SnapshotSources, assembleSnapshot } from '@sanad/core/decisioning/assemble.ts';
import { evaluateCreditPolicy } from '@sanad/core/decisioning/engine.ts';
import { loadCreditPolicyVersions } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk, ok } from '@sanad/core/kernel/result.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

const at = (s: number) =>
  tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const T0 = 1_791_000_000;
const CR = '4030000003';
const ANCHOR = '1010000002';

function consents(types: ConsentRecord['type'][]): ConsentRecord[] {
  return types.map((type) =>
    expectOk(
      grant({
        consentId: `cns-${type}`,
        tenantId: 'bank-a',
        counterpartyId: 'cpt-0001',
        type,
        version: '1',
        purpose: 'credit application',
        channel: 'PORTAL',
        evidenceRef: 'ev',
        grantedAt: at(T0 - 100),
      }),
    ),
  );
}

function sources(
  over: Partial<SnapshotSources> = {},
  consented: ConsentRecord['type'][] = ['CREDIT_BUREAU', 'SCREENING'],
): SnapshotSources {
  return {
    master: {
      get: () =>
        Promise.resolve(
          ok({
            counterpartyId: 'cpt-0001',
            tenantId: 'bank-a',
            commercialRegistration: CR,
            legalNameAr: 'ش',
            legalNameEn: 'Co',
            legalForm: 'LLC',
            segment: 'SME',
            status: 'ACTIVE' as const,
            signatoryRefs: ['sig-1'],
            kycStatus: 'VERIFIED' as const,
          }),
        ),
      findByRegistration: () => Promise.resolve(ok(undefined)),
      beginOnboarding: () => Promise.resolve(ok({ counterpartyId: 'x' })),
    },
    registry: {
      lookup: () =>
        Promise.resolve(
          ok({
            kind: 'ANSWERED' as const,
            value: {
              commercialRegistration: CR,
              legalNameAr: 'ش',
              legalNameEn: 'Co',
              legalForm: 'LLC',
              status: 'ACTIVE' as const,
              activityCodes: ['46900'],
              registeredAtGregorian: '2021-01-01',
              paidCapitalMinorUnits: 50_000_000n,
              signatoryRefs: ['sig-1'],
              lookupRef: 'lk',
              retrievedAtEpochSeconds: BigInt(T0 - 3600),
            },
          }),
        ),
    },
    screening: {
      screen: () =>
        Promise.resolve(
          ok({
            screeningReference: 'scr',
            screenedAt: at(T0 - 7200),
            overall: 'CLEAR' as const,
            perCheck: [
              { check: 'SANCTIONS' as const, outcome: 'CLEAR' as const },
              { check: 'PEP' as const, outcome: 'CLEAR' as const },
              { check: 'ADVERSE_MEDIA' as const, outcome: 'CLEAR' as const },
            ],
          }),
        ),
    },
    bureau: {
      request: () =>
        Promise.resolve(
          ok({
            kind: 'REPORT' as const,
            summary: {
              bureauReference: 'b',
              retrievedAt: at(T0 - 86_400),
              totalExposure: money(120_000_000n),
              overdueAmount: money(0n),
              worstDelinquencyDays: 0,
              activeFacilities: 2,
              defaults: [],
            },
          }),
        ),
      report: () => Promise.resolve(ok({ kind: 'ACKNOWLEDGED' as const, acknowledgementRef: 'a' })),
    },
    eInvoicing: {
      validateInvoice: () => Promise.reject(new Error('unused')),
      fetchTradeHistory: () =>
        Promise.resolve(
          ok({
            registrationNumber: CR,
            window: { fromDateGregorian: 'x', toDateGregorian: 'y' },
            clearedInvoiceCount: 420,
            totalClearedValue: money(3_600_000_000n),
            distinctBuyerCount: 9,
            perBuyer: [
              {
                buyerCr: ANCHOR,
                invoiceCount: 260,
                totalValue: money(2_400_000_000n),
                medianDaysToPayment: 34,
                creditNoteCount: 2,
              },
            ],
          }),
        ),
    },
    programmes: {
      facts: () =>
        Promise.resolve(
          ok({
            anchorRecourse: 'PARTIAL' as const,
            programmeLimitMinorUnits: 10_000_000_000n,
            programmeUtilisedMinorUnits: 1_000_000_000n,
            sectorCode: 'BUILDING_MATERIALS',
            goodsCategoryCode: 'CEMENT',
            anchorCr: ANCHOR,
          }),
        ),
    },
    exposure: {
      exposure: () => Promise.resolve(ok({ platform: money(0n), coreBanking: money(0n), group: money(0n) })),
    },
    consents: { records: () => Promise.resolve(consents(consented)) },
    permissibility: { assess: () => 'PERMITTED' as const },
    ...over,
  };
}
const request = {
  tenantId: 'bank-a',
  counterpartyId: 'cpt-0001',
  programmeId: 'prg-0001',
  snapshotId: 'snp',
  at: at(T0),
  correlationId: 'c',
};

describe('assembleSnapshot', () => {
  it('builds a snapshot the policy approves from rails that all answer, with anchor trade picked out', async () => {
    const s = expectOk(await assembleSnapshot(sources(), request));
    expect(s.registration.status).toBe('ACTIVE');
    expect(s.screening.sanctions).toBe('CLEAR');
    expect(s.bureau.availability).toBe('AVAILABLE');
    expect(s.tradeHistory.withAnchor.clearedInvoiceCount).toBe(260);
    expect(s.tradeHistory.largestBuyerSharePerTenThousand).toBe(6666);
    expect(s.consent.creditBureau).toBe(true);
    expect(s.signatory.assertionId).toBe('sig-1');
    const policy = expectOk(loadCreditPolicyVersions('bank-a', 'wasl-distributor'))[0]!;
    expect(evaluateCreditPolicy(policy, s, 'd').outcome).toBe('APPROVE');
  });
  it('without bureau consent the bureau is NOT_CONSENTED and never called; the engine refers', async () => {
    let called = false;
    const s = expectOk(
      await assembleSnapshot(
        sources(
          {
            bureau: {
              request: () => {
                called = true;
                return Promise.resolve(ok({ kind: 'UNAVAILABLE' as const, reason: 'x' }));
              },
              report: () => Promise.resolve(ok({ kind: 'UNAVAILABLE' as const, reason: 'x' })),
            },
          },
          ['SCREENING'],
        ),
        request,
      ),
    );
    expect(called).toBe(false);
    expect(s.bureau.availability).toBe('NOT_CONSENTED');
    expect(s.consent.creditBureau).toBe(false);
    const policy = expectOk(loadCreditPolicyVersions('bank-a', 'wasl-distributor'))[0]!;
    expect(evaluateCreditPolicy(policy, s, 'd').outcome).not.toBe('APPROVE');
  });
  it('a registry that cannot be reached is UNKNOWN, a screening that cannot be reached is UNAVAILABLE — facts, not exceptions', async () => {
    const s = expectOk(
      await assembleSnapshot(
        sources({
          registry: { lookup: () => Promise.resolve(ok({ kind: 'UNAVAILABLE' as const, reason: 'down' })) },
          screening: { screen: () => Promise.resolve(ok({ kind: 'UNAVAILABLE' as const, reason: 'down' })) },
        }),
        request,
      ),
    );
    expect(s.registration.status).toBe('UNKNOWN');
    expect(s.screening.sanctions).toBe('UNAVAILABLE');
  });
  it('carries no personal datum: signatories and bureau by reference only', async () => {
    const s = expectOk(await assembleSnapshot(sources(), request));
    const text = JSON.stringify(s, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(text).not.toMatch(/nationalId|iqama|phone|email|dateOfBirth/i);
  });
});
