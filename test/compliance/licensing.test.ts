/**
 * Installation licensing (ADR 0006) — the prohibited outcomes.
 *
 * Each test attempts something the licence must not allow, or attempts to stop
 * something the licence must never stop, and passes only when the attempt
 * fails. Run against the real gate, the real services runtime and the real
 * workbench and partner-API code paths, with a stand-in issuer whose key pair
 * is generated per run (test/support/licensing.ts).
 */

import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureLicenceCheckIn } from '../../adapters/licensing/check-in/fixture.ts';
import { civilOf, formatDate } from '../../core/licensing/dates.ts';
import { assertNewBusinessPermitted } from '../../core/licensing/gate.ts';
import type { Licence, Revocation } from '../../core/licensing/licence.ts';
import { parseSignedFile } from '../../core/licensing/licence.ts';
import { inMemoryLicenceRepository } from '../../core/licensing/repository.ts';
import { licenceState } from '../../core/licensing/state.ts';
import { createVerifier, verifyLicenceFile } from '../../core/licensing/verify.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { money } from '../../core/kernel/money.ts';
import { applyPayment, createObligation } from '../../products/murabaha-scf/obligation/obligation.ts';
import { priceMurabaha } from '../../products/murabaha-scf/pricing/murabaha.ts';
import type { FinancialMetric } from '../../core/applicant/financials.ts';
import {
  READ_FIGURE_SOURCES,
  SEED_PRINCIPALS,
  checklistStatus,
  decideInCommittee,
  generateOffer,
  handOver,
  ingestReadFigures,
  listApplications,
  presentDocument,
  proposeFigures,
  recordAssessmentInputs,
  recordDisbursed,
  recordPortfolioStatus,
  recordSigned,
  resetBusinessStore,
  runAssessment,
  sendOffer,
  submitForAssessment,
  validateDocument,
  verifyFigure,
  withdrawApplication,
} from '../../apps/ops/src/server/business.ts';
import { inMemoryIdempotencyStore } from '../../services/origination/src/idempotency.ts';
import {
  configureLicensingForTests,
  currentLicence,
  decideLicenceInstall,
  newBusinessPermitted,
  proposeLicenceInstall,
  runLicenceCheckIn,
} from '../../services/origination/src/licensing.ts';
import type { CredentialRegistry, PartnerPrincipal } from '../../services/origination/src/principal.ts';
import { inMemoryRequestRepository } from '../../services/origination/src/repository.ts';
import { BASE_PATH, createService, developmentTimestamps } from '../../services/origination/src/server.ts';
import { INSTALLATION, OTHER_INSTALLATION, annual, poc, testIssuer, testVerifier, uuid } from '../support/licensing.ts';

const issuer = testIssuer();
const verifier = testVerifier(issuer);

// -- Calendar relative to the real today, because the workbench stamps acts with the real clock -----------------

const DAY = 86_400n;
const realNow = (): bigint => BigInt(Math.floor(Date.now() / 1000));
const todayDay = (): bigint => realNow() / DAY;
/** The UTC date `k` days from today. */
const day = (k: number): string => formatDate(civilOf(todayDay() + BigInt(k)));

// -- A licensing runtime per test: in-memory store, the test issuer's key, a clock the test moves -----------------

let clock = realNow();
let repository = inMemoryLicenceRepository({ installationId: INSTALLATION });

function useRuntime(): void {
  clock = realNow();
  repository = inMemoryLicenceRepository({ installationId: INSTALLATION, clock: () => clock });
  configureLicensingForTests({ repository, verifier, clock: () => clock });
}

/** Install through Admin's own path: one administrator proposes, a different one approves. */
async function install(fileText: string): Promise<void> {
  const proposed = await proposeLicenceInstall({ fileText, proposedBy: 'admin-maker' });
  if (!proposed.ok) throw new Error(`proposal refused: ${proposed.error.refusal.reason}`);
  const decided = await decideLicenceInstall({ proposalId: proposed.value, approve: true, decidedBy: 'admin-checker' });
  if (!decided.ok) throw new Error(`approval refused: ${decided.error.refusal.reason}`);
}

/** An ANNUAL in force today with plenty of term left. */
const inForce = (over: Partial<Licence> = {}): Licence => annual({ notBefore: day(-30), notAfter: day(300), ...over });

/** An ANNUAL whose grace ended `daysAgo` days ago (term ended 30 + daysAgo days ago). */
const lapsed = (daysAgo = 2): Licence => annual({ notBefore: day(-200 - daysAgo), notAfter: day(-30 - daysAgo) });

beforeEach(() => {
  vi.stubEnv('SANAD_JURISDICTION', 'SA');
  useRuntime();
});
afterEach(() => {
  vi.unstubAllEnvs();
  configureLicensingForTests(undefined);
});

// =================================================================================================================

describe('after grace has ended, new business is refused and nothing owed to a customer is', () => {
  beforeEach(async () => {
    vi.stubEnv('SANAD_JURISDICTION', 'AE');
    // The illustrative book (with disbursed facilities) is built while unlicensed in development, then the licence lapses.
    configureLicensingForTests(undefined);
    resetBusinessStore({ seed: true });
    await listApplications('sme-fund-ae');
    useRuntime();
    await install(issuer.signLicence(lapsed()));
  });

  it('the state is NEW_BUSINESS_BLOCKED', async () => {
    const { state } = await currentLicence();
    expect([state.status, state.reason]).toEqual(['NEW_BUSINESS_BLOCKED', 'GRACE_ENDED']);
  });

  it('refuses a new application through the hand-over service', async () => {
    const r = await handOver(
      'sme-fund-ae',
      {
        applicationId: 'FR-00009901',
        upstreamRef: 'upstream-licence-9901',
        applicant: {
          businessNameEn: 'Licence Test Trading LLC',
          registrationRef: 'TL-LIC-9901',
          sector: 'TRADING',
          yearsInOperation: 5,
          owners: [{ displayName: 'Test Owner', ref: 'owner-lic-9901' }],
          upstreamVerificationRefs: ['ref-1'],
        },
        productCode: 'sme-term-conventional',
        variantCode: 'SMALL_LOAN',
        purpose: 'WORKING_CAPITAL',
        requestedMinorUnits: 80_000_000n,
        tenorMonths: 36,
        graceMonths: 0,
        contributionPerTenThousand: 2_000,
      },
      'upstream-record-dev-01',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect([r.error.control, r.error.reason]).toEqual(['OP-LICENCE', 'LICENCE_NOT_ACTIVE']);
      expect(r.error.context?.['licenceReason']).toBe('GRACE_ENDED');
    }
  });

  it('still records servicing on a disbursed facility (portfolio status, collections)', async () => {
    const disbursed = (await listApplications('sme-fund-ae')).find((a) => a.application.status === 'DISBURSED');
    expect(disbursed).toBeDefined();
    const r = await recordPortfolioStatus(
      'sme-fund-ae',
      disbursed?.application.applicationId ?? '',
      { daysPastDue: 0, arrearsMinorUnits: 0n },
      SEED_PRINCIPALS.officer,
    );
    expect(r.ok).toBe(true);
  });

  it('still lets an application in progress be withdrawn', async () => {
    const open = (await listApplications('sme-fund-ae')).find((a) =>
      ['RECEIVED', 'SPREADING', 'SUBMITTED', 'ASSESSED', 'OFFER_SENT'].includes(a.application.status),
    );
    expect(open).toBeDefined();
    const r = await withdrawApplication(
      'sme-fund-ae',
      open?.application.applicationId ?? '',
      'Customer withdrew',
      SEED_PRINCIPALS.officer,
    );
    expect(r.ok).toBe(true);
  });

  it('still takes a repayment on an existing contract — repayment never asks the licence', () => {
    const obligation = expectOk(
      createObligation({
        obligationId: 'obl-licence-1',
        transactionId: 'txn-licence-1',
        tenantId: 'tenant-1',
        pricing: expectOk(priceMurabaha(money(100_000n), money(2_500n))),
        instalments: [
          { sequenceNumber: 1, dueDateGregorian: '2026-11-01', dueDateHijri: '1448-05-10', amount: money(102_500n) },
        ],
      }),
    );
    const paid = applyPayment(obligation, money(50_000n));
    expect(paid.ok).toBe(true);
  });
});

describe('the partner API refuses a new request after grace, and keeps serving what exists', () => {
  const PARTNER: PartnerPrincipal = {
    partnerId: 'partner-lic',
    tenantId: 'bank-a',
    channel: 'PARTNER_API',
    scopes: ['origination:read', 'origination:write'],
    credentialRef: 'cred-lic',
  };
  const TOKEN = 'test-token-lic';
  const registry: CredentialRegistry = {
    findByTokenDigest: (d) => (d === createHash('sha256').update(TOKEN, 'utf8').digest('hex') ? PARTNER : undefined),
  };
  let server: Server;
  let origin: string;
  const body = {
    programmeId: '018f3a2c-7b41-7c9e-9a11-3f0c2d5e6a70',
    counterpartyId: '018f3a2c-7b41-7c9e-9a11-4b1d3e6f7a81',
    tradeReference: { type: 'PURCHASE_ORDER', issuerCr: '1010223344', recipientCr: '2050667788' },
    requestedAmount: { minorUnits: '48500000', currency: 'SAR' },
    requestedTenorDays: 90,
    initiator: { kind: 'PARTNER_SYSTEM' },
  };
  const call = async (method: string, path: string, key: string = randomUUID(), payload: unknown = body) => {
    const r = await fetch(`${origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'idempotency-key': key },
      ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await r.text();
    return { status: r.status, body: text === '' ? undefined : (JSON.parse(text) as Record<string, any>) };
  };

  beforeAll(async () => {
    server = createService({
      repository: inMemoryRequestRepository(),
      idempotency: inMemoryIdempotencyStore(),
      credentials: registry,
      timestamps: developmentTimestamps(),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}${BASE_PATH}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses with OP-LICENCE in both languages, then accepts the same request and key once renewed', async () => {
    await install(issuer.signLicence(inForce()));
    const existing = await call('POST', '/requests');
    expect(existing.status).toBe(201);

    // The licence lapses: the clock moves past term and grace.
    clock = realNow() + 340n * DAY;
    const key = randomUUID();
    const refused = await call('POST', '/requests', key);
    expect(refused.status).toBe(422);
    expect(refused.body?.['control']).toBe('OP-LICENCE');
    expect(refused.body?.['reason']).toBe('LICENCE_NOT_ACTIVE');
    expect(refused.body?.['context']).toEqual({ licenceReason: 'GRACE_ENDED' });
    expect(String(refused.body?.['detailAr'])).toMatch(/[؀-ۿ]/);

    // What exists is still served: read and withdraw.
    const requestId = String(existing.body?.['requestId']);
    expect((await call('GET', `/requests/${requestId}`)).status).toBe(200);
    expect(
      (await call('PUT', `/requests/${requestId}/withdrawal`, randomUUID(), { reason: 'no longer needed' })).status,
    ).toBe(200);

    // Renewed: the same request with the same key now succeeds — the refusal was not bound to the key.
    await install(issuer.signLicence(annual({ notBefore: day(330), notAfter: day(600) })));
    const retried = await call('POST', '/requests', key);
    expect(retried.status).toBe(201);
  });
});

describe('a licence that is not genuine, not ours, or too long is refused', () => {
  it('a tampered signature', async () => {
    const file = JSON.parse(issuer.signLicence(inForce())) as { licence: Licence; signature: string };
    const tampered = JSON.stringify({ ...file, licence: { ...file.licence, maxActiveTenants: 500 } });
    const r = await proposeLicenceInstall({ fileText: tampered, proposedBy: 'admin-maker' });
    expect(r.ok ? undefined : r.error.refusal.reason).toBe('SIGNATURE_INVALID');
    expect(await repository.history()).toEqual([]);
  });

  it('a tampered licence already in the history is not used', () => {
    const file = JSON.parse(issuer.signLicence(inForce())) as { licence: Licence; signature: string };
    const forged = {
      kind: 'LICENCE' as const,
      document: JSON.stringify({ ...file.licence, products: ['bnpl', 'x-new'] }),
      signature: file.signature,
    };
    const s = licenceState([forged], { installationId: INSTALLATION, verifier }, realNow(), undefined);
    expect([s.status, s.reason]).toEqual(['NEW_BUSINESS_BLOCKED', 'NO_VALID_LICENCE']);
    expect(
      assertNewBusinessPermitted({ state: s, productCode: 'bnpl', jurisdiction: 'SA', activeTenantCount: 1 }).ok,
    ).toBe(false);
  });

  it('a licence for another installation', async () => {
    const r = await proposeLicenceInstall({
      fileText: issuer.signLicence(inForce({ installationId: OTHER_INSTALLATION })),
      proposedBy: 'admin-maker',
    });
    expect(r.ok ? undefined : r.error.refusal.reason).toBe('INSTALLATION_MISMATCH');
  });

  it('a 40-day POC, signed or not', async () => {
    const r = await proposeLicenceInstall({
      fileText: issuer.signLicence(poc({ notBefore: '2026-10-01', notAfter: '2026-11-10' })),
      proposedBy: 'admin-maker',
    });
    expect(r.ok ? undefined : r.error.refusal.reason).toBe('TERM_TOO_LONG');
  });

  it('an ANNUAL longer than twelve months and a day', () => {
    const r = verifyLicenceFile(
      issuer.signLicence(annual({ notBefore: '2026-01-01', notAfter: '2027-01-03' })),
      verifier,
      INSTALLATION,
    );
    expect(r.ok ? undefined : r.error.reason).toBe('TERM_TOO_LONG');
  });

  it('a licence approved by the administrator who proposed it', async () => {
    const proposed = expectOk(
      await proposeLicenceInstall({ fileText: issuer.signLicence(inForce()), proposedBy: 'admin-maker' }),
    );
    const self = await decideLicenceInstall({ proposalId: proposed, approve: true, decidedBy: 'admin-maker' });
    expect(self.ok ? undefined : self.error.refusal.reason).toBe('FOUR_EYES_SELF_DECISION');
    expect(await repository.history()).toEqual([]);
  });
});

describe('entitlements are refused in every state', () => {
  it('a product the licence does not name cannot be quoted', async () => {
    await install(issuer.signLicence(inForce({ products: ['murabaha-scf'] })));
    const r = await newBusinessPermitted({ productCode: 'bnpl' });
    expect(r.ok ? undefined : r.error.reason).toBe('PRODUCT_NOT_LICENSED');
    // …and not in grace either.
    clock = realNow() + 310n * DAY;
    expect((await currentLicence()).state.status).toBe('GRACE');
    const inGrace = await newBusinessPermitted({ productCode: 'bnpl' });
    expect(inGrace.ok ? undefined : inGrace.error.reason).toBe('PRODUCT_NOT_LICENSED');
    expect((await newBusinessPermitted({ productCode: 'murabaha-scf' })).ok).toBe(true);
  });

  it('a jurisdiction the licence does not name', async () => {
    await install(issuer.signLicence(inForce({ jurisdictions: ['AE'] })));
    const r = await newBusinessPermitted({ productCode: 'bnpl' });
    expect(r.ok ? undefined : r.error.reason).toBe('JURISDICTION_NOT_LICENSED');
  });

  it('more active tenants than the licence allows', async () => {
    // The Saudi deployment has two active tenants.
    await install(issuer.signLicence(inForce({ maxActiveTenants: 1 })));
    const r = await newBusinessPermitted({ productCode: 'bnpl' });
    expect(r.ok ? undefined : r.error.reason).toBe('TENANT_LIMIT_EXCEEDED');
  });
});

describe('the clock cannot be wound back to dodge expiry', () => {
  it('a clock more than a day behind the highest time seen blocks new business', async () => {
    await install(issuer.signLicence(inForce()));
    expect((await newBusinessPermitted({ productCode: 'bnpl' })).ok).toBe(true);
    clock = realNow() - 2n * DAY;
    const r = await newBusinessPermitted({ productCode: 'bnpl' });
    expect(r.ok ? undefined : r.error.reason).toBe('CLOCK_ROLLBACK');
    // Within a day of drift is tolerated; corrected, it resumes.
    clock = realNow() - 12n * 3_600n;
    expect((await newBusinessPermitted({ productCode: 'bnpl' })).ok).toBe(true);
  });
});

describe('POC extensions, a month at a time, without a cap', () => {
  it('a chain of four monthly POC licences keeps the installation VALID into month four', async () => {
    const months = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'];
    let previous: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const l = poc({ notBefore: months[i] ?? '', notAfter: months[i + 1] ?? '', supersedes: previous });
      ids.push(l.licenceId);
      previous = l.licenceId;
      await install(issuer.signLicence(l));
    }
    const at = (date: string): bigint => BigInt(Date.parse(`${date}T12:00:00Z`) / 1000);
    clock = at('2026-06-10');
    expect((await currentLicence()).state.status).toBe('VALID');
    clock = at('2026-09-10');
    const s = (await currentLicence()).state;
    expect(s.status).toBe('VALID');
    expect(s.effective?.licenceId).toBe(ids[3]);
    expect(s.licences).toHaveLength(4);
    expect((await newBusinessPermitted({ productCode: 'bnpl' })).ok).toBe(true);
  });
});

describe('a revocation starts the grace period, never an immediate stop', () => {
  it('revoked today: GRACE and still permitted; thirty days on: blocked', async () => {
    const l = inForce();
    await install(issuer.signLicence(l));
    const revocation: Revocation = {
      revocationId: uuid(),
      licenceId: l.licenceId,
      installationId: INSTALLATION,
      effectiveFrom: day(0),
      issuedAt: '2026-10-01T00:00:00Z',
      issuedBy: 'issuer-ops',
      keyId: issuer.keyId,
    };
    const result = await runLicenceCheckIn(
      fixtureLicenceCheckIn([{ kind: 'ANSWERED', files: [issuer.signRevocation(revocation)] }]),
    );
    expect(result).toEqual({ kind: 'INSTALLED', installed: 1, refused: 0 });
    const s = (await currentLicence()).state;
    expect([s.status, s.reason]).toEqual(['GRACE', 'REVOKED_IN_GRACE']);
    expect((await newBusinessPermitted({ productCode: 'bnpl' })).ok).toBe(true);
    clock = realNow() + 31n * DAY;
    expect((await newBusinessPermitted({ productCode: 'bnpl' })).ok).toBe(false);
  });

  it('a revocation not signed by the issuer is refused and changes nothing', async () => {
    const l = inForce();
    await install(issuer.signLicence(l));
    const forger = testIssuer(issuer.keyId);
    const r = await runLicenceCheckIn(
      fixtureLicenceCheckIn([
        {
          kind: 'ANSWERED',
          files: [
            forger.signRevocation({
              revocationId: uuid(),
              licenceId: l.licenceId,
              installationId: INSTALLATION,
              effectiveFrom: day(0),
              issuedAt: '2026-10-01T00:00:00Z',
              issuedBy: 'someone',
              keyId: issuer.keyId,
            }),
          ],
        },
      ]),
    );
    expect(r).toEqual({ kind: 'INSTALLED', installed: 0, refused: 1 });
    expect((await currentLicence()).state.status).toBe('VALID');
  });

  it('a failed check-in changes nothing, and sends only the four permitted fields', async () => {
    await install(issuer.signLicence(inForce()));
    const port = fixtureLicenceCheckIn(['THROWS']);
    expect(await runLicenceCheckIn(port)).toEqual({ kind: 'NO_CHANGE', why: 'UNAVAILABLE' });
    expect((await currentLicence()).state.status).toBe('VALID');
    expect(Object.keys(port.sent[0] ?? {}).sort()).toEqual(['installationId', 'licenceId', 'productVersion', 'state']);
  });
});

describe('production trusts only the compiled-in keys', () => {
  it('refuses an injected keyring when the caller says production', () => {
    const r = createVerifier({ nodeEnv: 'production', testKeyring: issuer.keyring });
    expect(r.ok ? undefined : r.error.reason).toBe('KEYRING_INJECTION_REFUSED');
  });

  it('refuses an injected keyring when the process is production, whatever the caller says', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const r = createVerifier({ nodeEnv: 'test', testKeyring: issuer.keyring });
    expect(r.ok ? undefined : r.error.reason).toBe('KEYRING_INJECTION_REFUSED');
    // And the runtime cannot be substituted at all.
    expect(() => configureLicensingForTests({ repository, verifier, clock: () => clock })).toThrow(/production/);
  });

  it('a production verifier does not accept the test issuer’s licence', () => {
    const production = expectOk(createVerifier({ nodeEnv: 'production' }));
    const r = verifyLicenceFile(issuer.signLicence(inForce()), production, INSTALLATION);
    expect(r.ok ? undefined : r.error.reason).toBe('KEY_UNKNOWN');
  });

  it('a production installation with no licence starts no new business', async () => {
    const production = expectOk(createVerifier({ nodeEnv: 'production' }));
    configureLicensingForTests({ repository, verifier: production, clock: () => clock });
    const r = await newBusinessPermitted({ productCode: 'bnpl' });
    expect(r.ok ? undefined : r.error.reason).toBe('NO_LICENCE');
  });

  it('a development installation with no licence is DEVELOPMENT_UNLICENSED and permits everything', async () => {
    expect((await currentLicence()).state.status).toBe('DEVELOPMENT_UNLICENSED');
    expect((await newBusinessPermitted({ productCode: 'anything-at-all' })).ok).toBe(true);
  });
});

describe('a customer who accepted before grace ended is never let down', () => {
  const blocked = () => {
    const l = lapsed(2);
    const s = licenceState(
      [expectOk(parseSignedFile(issuer.signLicence(l)))],
      { installationId: INSTALLATION, verifier },
      realNow(),
      undefined,
    );
    expect(s.status).toBe('NEW_BUSINESS_BLOCKED');
    return s;
  };

  it('an offer accepted before grace ended can still be booked', () => {
    const s = blocked();
    const acceptedInGrace = (s.graceEndsAtEpochSeconds ?? 0n) - DAY;
    const r = assertNewBusinessPermitted({
      state: s,
      productCode: 'bnpl',
      jurisdiction: 'SA',
      activeTenantCount: 2,
      booking: { offerAcceptedAtEpochSeconds: acceptedInGrace },
    });
    expect(r.ok && r.value.acceptedBeforeGraceEnded).toBe(true);
  });

  it('an offer accepted after grace ended cannot', () => {
    const s = blocked();
    const r = assertNewBusinessPermitted({
      state: s,
      productCode: 'bnpl',
      jurisdiction: 'SA',
      activeTenantCount: 2,
      booking: { offerAcceptedAtEpochSeconds: s.graceEndsAtEpochSeconds ?? 0n },
    });
    expect(r.ok ? undefined : r.error.reason).toBe('GRACE_ENDED');
  });

  it('through the workbench: an SME offer signed in grace is disbursed after grace has ended', async () => {
    vi.stubEnv('SANAD_JURISDICTION', 'AE');
    resetBusinessStore({ seed: false });
    // Grace ends at 00:00 UTC tomorrow: today the licence is in GRACE, and new business is still permitted.
    await install(issuer.signLicence(annual({ notBefore: day(-200), notAfter: day(-29) })));
    expect((await currentLicence()).state.status).toBe('GRACE');
    const T = 'sme-fund-ae';
    const ID = 'FR-00009950';
    const { officer, checker, committee, finance } = SEED_PRINCIPALS;
    const ok = (r: { ok: boolean }): void => expect(r.ok).toBe(true);

    ok(
      await handOver(
        T,
        {
          applicationId: ID,
          upstreamRef: 'upstream-licence-9950',
          applicant: {
            businessNameEn: 'Grace Period Trading LLC',
            registrationRef: 'TL-LIC-9950',
            sector: 'TRADING',
            yearsInOperation: 5,
            owners: [{ displayName: 'Test Owner', ref: 'owner-lic-9950' }],
            // The bureau consent is on record from the upstream system, as the assessment requires.
            upstreamVerificationRefs: ['uaepass:assert-lic', 'aecb:consent-lic'],
          },
          productCode: 'sme-term-conventional',
          variantCode: 'SMALL_LOAN',
          purpose: 'WORKING_CAPITAL',
          requestedMinorUnits: 80_000_000n,
          tenorMonths: 36,
          graceMonths: 0,
          contributionPerTenThousand: 2_000,
          contact: { partyRef: 'owner-lic-9950', emailMasked: 't***@example.com', mobileMasked: '+971 50 XXX XXXX' },
        },
        'upstream-record-dev-01',
      ),
    );
    const figures: readonly [FinancialMetric, string, bigint][] = [
      ['ANNUAL_REVENUE', 'FY2025', 520_000_000n],
      ['PRIOR_YEAR_REVENUE', 'FY2024', 480_000_000n],
      ['NET_PROFIT', 'FY2025', 90_000_000n],
      ['TOTAL_DEBT_SERVICE', 'FY2025', 6_000_000n],
      ['CURRENT_ASSETS', 'FY2025', 160_000_000n],
      ['CURRENT_LIABILITIES', 'FY2025', 95_000_000n],
      ['MONTHLY_GROSS_SALARY', '2026-09', 4_200_000n],
    ];
    ok(
      await ingestReadFigures(
        T,
        ID,
        figures.map(([metric, periodLabel, minorUnits]) => ({
          metric,
          periodLabel,
          minorUnits,
          sourceKind: 'OCR' as const,
          sourceRef: 'doc-statements',
        })),
        READ_FIGURE_SOURCES.ocr,
      ),
    );
    const keyed = expectOk(
      await proposeFigures(
        T,
        ID,
        [{ metric: 'MONTHLY_DEBT_OBLIGATIONS', periodLabel: '2026-09', minorUnits: 700_000n, sourceRef: 'doc-bureau' }],
        officer,
      ),
    );
    for (const f of keyed.figures)
      ok(await verifyFigure(T, ID, f.figureId, f.figure.sourceKind === 'OFFICER_ENTRY' ? checker : officer));
    const checklist = expectOk(await checklistStatus(T, ID));
    for (const item of checklist.checklist.items.filter((i) => i.required)) {
      ok(
        await presentDocument(
          T,
          ID,
          { documentType: item.documentType, documentRef: `doc-${item.documentType}` },
          officer,
        ),
      );
      ok(await validateDocument(T, ID, `doc-${item.documentType}`, 'VALID', checker));
    }
    ok(
      await recordAssessmentInputs(
        T,
        ID,
        {
          bureau: { reportRef: 'aecb:report-lic', consentId: 'aecb:consent-lic', score: 760n },
          fullTimeEmployees: 25,
          relevantExperienceYears: 6n,
          sectorPriority: 'PRIORITY',
          auditedFinancialsAvailable: true,
          commitmentRatioPerTenThousand: 10_200n,
          riskAnalysisScorePerTenThousand: 7_400n,
          portfolioRepaymentPerTenThousand: 8_600n,
          failedFilesRatePerTenThousand: 800n,
          collateralValueMinorUnits: 100_000_000n,
        },
        officer,
      ),
    );
    ok(await submitForAssessment(T, ID, officer));
    ok(await runAssessment(T, ID, checker));
    ok(await decideInCommittee(T, ID, { decidedBy: committee, approved: true, reason: 'Within risk-aligned terms' }));
    const dubaiToday = new Date(Math.floor((Date.now() + 4 * 3_600_000) / 86_400_000) * 86_400_000);
    const iso = (d: number): string => new Date(dubaiToday.getTime() + d * 86_400_000).toISOString().slice(0, 10);
    const offered = expectOk(await generateOffer(T, ID, officer, { disbursementDate: iso(0), firstDueDate: iso(30) }));
    ok(await sendOffer(T, ID, officer));
    // The borrower signs today — before grace ends at midnight UTC.
    ok(await recordSigned(T, ID, { letterVersion: offered.latestOffer?.letter.version ?? '' }, officer));

    // Grace ends. New business is refused…
    clock = realNow() + 3n * DAY;
    expect((await currentLicence()).state.status).toBe('NEW_BUSINESS_BLOCKED');
    const fresh = await generateOffer(T, ID, officer, {});
    expect(fresh.ok ? undefined : fresh.error.control).toBe('OP-LICENCE');
    // …but the facility the borrower already signed for is disbursed.
    const disbursed = await recordDisbursed(T, ID, finance);
    expect(disbursed.ok && disbursed.value.application.status).toBe('DISBURSED');
  });

  it('…and a quote in the same state is refused (booking is the only exception)', () => {
    const r = assertNewBusinessPermitted({
      state: blocked(),
      productCode: 'bnpl',
      jurisdiction: 'SA',
      activeTenantCount: 2,
    });
    expect(r.ok).toBe(false);
  });
});
