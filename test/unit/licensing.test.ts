/**
 * Installation licensing (ADR 0006): canonical form, signature verification,
 * term rules, the state function, the gate, check-in handling and the request
 * file. The prohibited outcomes themselves are in test/compliance/licensing.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { checkInRequest, handleCheckIn } from '../../core/licensing/check-in.ts';
import { addMonths, dayNumber, formatInstant, parseDate, parseInstant } from '../../core/licensing/dates.ts';
import { licenceBanner, licenceRefusalText, LICENCE_GATE_REASONS } from '../../core/licensing/explain.ts';
import { assertNewBusinessPermitted, licenceRejection } from '../../core/licensing/gate.ts';
import { PRODUCTION_KEYRING } from '../../core/licensing/keys.ts';
import { parseLicence, parseSignedFile, type SignedDocument } from '../../core/licensing/licence.ts';
import { inMemoryLicenceRepository } from '../../core/licensing/repository.ts';
import { licenceRequestFile } from '../../core/licensing/request-file.ts';
import { licenceState } from '../../core/licensing/state.ts';
import { canonicalJson, createVerifier, verifyLicenceFile } from '../../core/licensing/verify.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { INSTALLATION, annual, at, poc, testIssuer, testVerifier, uuid } from '../support/licensing.ts';

const issuer = testIssuer();
const verifier = testVerifier(issuer);
const installation = { installationId: INSTALLATION, verifier };
const doc = (text: string): SignedDocument => expectOk(parseSignedFile(text));

describe('canonical serialisation', () => {
  it('sorts keys by code unit, keeps array order, writes no whitespace', () => {
    expect(canonicalJson({ b: [2, 1], a: 'x', A: null, c: { z: true, y: false } })).toBe(
      '{"A":null,"a":"x","b":[2,1],"c":{"y":false,"z":true}}',
    );
  });
  it('writes Arabic literally and escapes as JSON.stringify does', () => {
    expect(canonicalJson({ n: 'مؤسسة "أ"\n' })).toBe('{"n":"مؤسسة \\"أ\\"\\n"}');
  });
  it('has no canonical form for a fraction', () => {
    expect(canonicalJson({ n: 1.5 })).toBeUndefined();
  });
  it('is independent of the key order a document arrives in', () => {
    const l = annual();
    const reversed = Object.fromEntries(Object.entries(l).reverse());
    expect(canonicalJson(reversed)).toBe(canonicalJson(l));
  });
});

describe('calendar arithmetic, in integers', () => {
  it('round-trips dates and instants', () => {
    expect(formatInstant(parseInstant('2026-10-09T13:45:07Z') ?? 0n)).toBe('2026-10-09T13:45:07Z');
    expect(parseInstant('2026-10-09T13:45:07Z')).toBe(at('2026-10-09', 0) + 13n * 3600n + 45n * 60n + 7n);
  });
  it('refuses a day that is not on the calendar', () => {
    expect(parseDate('2026-02-29')).toBeUndefined();
    expect(parseDate('2028-02-29')).toBeDefined();
  });
  it('adds calendar months, clamping to the month end', () => {
    expect(addMonths({ year: 2026, month: 1, day: 31 }, 1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(addMonths({ year: 2026, month: 12, day: 15 }, 1)).toEqual({ year: 2027, month: 1, day: 15 });
    expect(dayNumber({ year: 1970, month: 1, day: 1 })).toBe(0n);
  });
});

describe('the licence parser is strict', () => {
  it('accepts exactly the ADR fields', () => {
    expect(parseLicence(annual()).ok).toBe(true);
  });
  it('refuses an unknown key', () => {
    const r = parseLicence({ ...annual(), maxStaffUsers: 10 });
    expect(r.ok ? undefined : r.error.reason).toBe('UNKNOWN_KEY');
  });
  it('refuses a missing key', () => {
    const { keyId: _k, ...rest } = annual();
    const r = parseLicence(rest);
    expect(r.ok ? undefined : r.error.reason).toBe('MALFORMED');
  });
  it('refuses a fractional tenant count', () => {
    const r = parseLicence({ ...annual(), maxActiveTenants: 2.5 });
    expect(r.ok).toBe(false);
  });
  it('refuses an envelope with anything beside the licence and its signature', () => {
    const file = JSON.parse(issuer.signLicence(annual())) as Record<string, unknown>;
    const r = parseSignedFile(JSON.stringify({ ...file, note: 'hello' }));
    expect(r.ok ? undefined : r.error.reason).toBe('UNKNOWN_KEY');
  });
});

describe('verification', () => {
  it('verifies a licence signed by a key in the keyring', () => {
    expect(verifyLicenceFile(issuer.signLicence(annual()), verifier, INSTALLATION).ok).toBe(true);
  });
  it('refuses a key it does not hold', () => {
    const other = testIssuer('another-key');
    const r = verifyLicenceFile(other.signLicence(annual({ keyId: 'another-key' })), verifier, INSTALLATION);
    expect(r.ok ? undefined : r.error.reason).toBe('KEY_UNKNOWN');
  });
  it('accepts a POC of exactly one calendar month and an ANNUAL of twelve months and a day', () => {
    expect(verifyLicenceFile(issuer.signLicence(poc()), verifier, INSTALLATION).ok).toBe(true);
    const a = annual({ notBefore: '2026-01-01', notAfter: '2027-01-02' });
    expect(verifyLicenceFile(issuer.signLicence(a), verifier, INSTALLATION).ok).toBe(true);
  });
  it('refuses a term that ends before it starts, and grace days that do not match the kind', () => {
    const r1 = verifyLicenceFile(issuer.signLicence(annual({ notAfter: '2026-01-01' })), verifier, INSTALLATION);
    expect(r1.ok ? undefined : r1.error.reason).toBe('TERM_NOT_POSITIVE');
    const r2 = verifyLicenceFile(issuer.signLicence(poc({ graceDays: 30 })), verifier, INSTALLATION);
    expect(r2.ok ? undefined : r2.error.reason).toBe('GRACE_DAYS_MISMATCH');
  });
  it('the compiled-in production keyring is empty until provisioning', () => {
    expect(Object.keys(PRODUCTION_KEYRING)).toEqual([]);
  });
});

const history = (...licences: string[]): SignedDocument[] => licences.map(doc);

describe('the state function', () => {
  const a = annual();
  const h = history(issuer.signLicence(a));

  it('is VALID inside the term', () => {
    const s = licenceState(h, installation, at('2026-06-01'), undefined);
    expect(s.status).toBe('VALID');
    expect(s.effective?.licenceId).toBe(a.licenceId);
  });
  it.each([
    ['2026-11-15', 60],
    ['2026-12-10', 30],
    ['2026-12-28', 7],
  ])('ANNUAL is EXPIRING on %s at the %i-day threshold', (date, threshold) => {
    const s = licenceState(h, installation, at(date), undefined);
    expect(s.status).toBe('EXPIRING');
    expect(s.expiringThreshold).toBe(threshold);
  });
  it.each([
    ['2026-10-26', 7],
    ['2026-10-30', 3],
  ])('POC is EXPIRING on %s at the %i-day threshold', (date, threshold) => {
    const s = licenceState(history(issuer.signLicence(poc())), installation, at(date), undefined);
    expect(s.status).toBe('EXPIRING');
    expect(s.expiringThreshold).toBe(threshold);
  });
  it('is GRACE for graceDays after the end, then NEW_BUSINESS_BLOCKED', () => {
    expect(licenceState(h, installation, at('2027-01-15'), undefined).status).toBe('GRACE');
    expect(licenceState(h, installation, at('2027-01-30', 23), undefined).status).toBe('GRACE');
    const after = licenceState(h, installation, at('2027-01-31', 0), undefined);
    expect(after.status).toBe('NEW_BUSINESS_BLOCKED');
    expect(after.reason).toBe('GRACE_ENDED');
  });
  it('is NEW_BUSINESS_BLOCKED before the licence starts', () => {
    expect(licenceState(h, installation, at('2025-12-20'), undefined).reason).toBe('NOT_YET_VALID');
  });
  it('a renewal installed ahead of time keeps the installation out of EXPIRING', () => {
    const renewal = annual({ notBefore: '2027-01-01', notAfter: '2028-01-01', supersedes: a.licenceId });
    const s = licenceState([...h, doc(issuer.signLicence(renewal))], installation, at('2026-12-28'), undefined);
    expect(s.status).toBe('VALID');
    expect(s.effective?.licenceId).toBe(a.licenceId);
    expect(s.tail?.licenceId).toBe(renewal.licenceId);
    // And it takes over on its own notBefore.
    expect(
      licenceState([...h, doc(issuer.signLicence(renewal))], installation, at('2027-01-02'), undefined).effective
        ?.licenceId,
    ).toBe(renewal.licenceId);
  });
  it('raises the high-water mark, never lowers it', () => {
    expect(licenceState(h, installation, at('2026-06-01'), at('2026-05-01')).highWaterMarkEpochSeconds).toBe(
      at('2026-06-01'),
    );
    expect(licenceState(h, installation, at('2026-06-01'), at('2026-06-01', 20)).highWaterMarkEpochSeconds).toBe(
      at('2026-06-01', 20),
    );
  });
  it('tolerates a clock less than a day behind the mark', () => {
    expect(licenceState(h, installation, at('2026-06-01'), at('2026-06-02', 6)).status).toBe('VALID');
  });
  it('keeps a history entry that no longer verifies visible, and does not use it', () => {
    const s = licenceState(
      [...h, { kind: 'LICENCE', document: JSON.stringify(annual()), signature: 'A'.repeat(86) }],
      installation,
      at('2026-06-01'),
      undefined,
    );
    expect(s.refused).toHaveLength(1);
    expect(s.status).toBe('VALID');
  });
});

describe('the gate', () => {
  const s = licenceState(history(issuer.signLicence(annual())), installation, at('2026-06-01'), undefined);
  const ask = (over: Partial<Parameters<typeof assertNewBusinessPermitted>[0]> = {}) =>
    assertNewBusinessPermitted({ state: s, productCode: 'bnpl', jurisdiction: 'SA', activeTenantCount: 2, ...over });

  it('permits an entitled product in an entitled jurisdiction within the tenant limit', () => {
    expect(ask().ok).toBe(true);
  });
  it('names itself as the decider, as an offer names apr.ts', () => {
    const r = ask({ productCode: 'embedded-lending' });
    expect(r.ok ? undefined : r.error.decidedBy).toBe('core/licensing/gate.ts');
  });
  it('maps a refusal to OP-LICENCE / LICENCE_NOT_ACTIVE with the reason in context', () => {
    const r = ask({ productCode: 'embedded-lending' });
    if (r.ok) throw new Error('expected a refusal');
    expect(licenceRejection(r.error)).toEqual({
      control: 'OP-LICENCE',
      reason: 'LICENCE_NOT_ACTIVE',
      detail: r.error.detail,
      context: { licenceReason: 'PRODUCT_NOT_LICENSED' },
    });
  });
  it('has words, in both languages, for every reason it can give', () => {
    for (const reason of LICENCE_GATE_REASONS) {
      const t = licenceRefusalText(reason);
      expect(t.en.length).toBeGreaterThan(20);
      expect(t.ar).toMatch(/[؀-ۿ]/);
    }
  });
});

describe('banner', () => {
  it('shows nothing while VALID, attention while EXPIRING or in GRACE, blocked after', () => {
    const h = history(issuer.signLicence(annual()));
    expect(licenceBanner(licenceState(h, installation, at('2026-06-01'), undefined))).toBeUndefined();
    expect(licenceBanner(licenceState(h, installation, at('2026-12-20'), undefined))?.tone).toBe('attention');
    expect(licenceBanner(licenceState(h, installation, at('2027-01-10'), undefined))?.tone).toBe('attention');
    expect(licenceBanner(licenceState(h, installation, at('2027-03-01'), undefined))?.tone).toBe('blocked');
  });
});

describe('check-in', () => {
  const a = annual();
  const s = licenceState(history(issuer.signLicence(a)), installation, at('2026-06-01'), undefined);

  it('sends only the licence id, installation id, product version and state', () => {
    expect(checkInRequest(s, INSTALLATION, '1.4.0')).toEqual({
      licenceId: a.licenceId,
      installationId: INSTALLATION,
      productVersion: '1.4.0',
      state: 'VALID',
    });
  });
  it('a failed check-in changes nothing', () => {
    expect(handleCheckIn({ kind: 'UNAVAILABLE', reason: 'timeout' }, verifier, INSTALLATION, new Set())).toEqual({
      kind: 'NO_CHANGE',
      why: 'UNAVAILABLE',
    });
  });
  it('installs a newer verified licence and skips one already installed', () => {
    const renewal = annual({ notBefore: '2027-01-01', notAfter: '2028-01-01', supersedes: a.licenceId });
    const h = handleCheckIn(
      { kind: 'ANSWERED', files: [issuer.signLicence(a), issuer.signLicence(renewal)] },
      verifier,
      INSTALLATION,
      new Set([a.licenceId]),
    );
    expect(h.kind === 'INSTALL' ? h.install.map((i) => i.subjectId) : []).toEqual([renewal.licenceId]);
  });
  it('refuses an unsigned or forged answer and installs nothing', () => {
    const forged = testIssuer(issuer.keyId).signLicence(annual());
    const h = handleCheckIn({ kind: 'ANSWERED', files: [forged] }, verifier, INSTALLATION, new Set());
    expect(h.kind === 'INSTALL' ? [h.install.length, h.refused[0]?.reason] : []).toEqual([0, 'SIGNATURE_INVALID']);
  });
});

describe('the request file', () => {
  it('carries the installation, the current licence, the jurisdiction and the version — and nothing else', () => {
    const a = annual();
    const s = licenceState(history(issuer.signLicence(a)), installation, at('2026-06-01'), undefined);
    const file = licenceRequestFile({
      installationId: INSTALLATION,
      state: s,
      jurisdiction: 'SA',
      productVersion: '1.4.0',
      nowEpochSeconds: at('2026-06-01', 0),
    });
    expect(file).toEqual({
      format: 'sanad-licence-request/1',
      installationId: INSTALLATION,
      currentLicenceId: a.licenceId,
      jurisdiction: 'SA',
      productVersion: '1.4.0',
      requestedAt: '2026-06-01T00:00:00Z',
    });
  });
});

describe('the in-memory repository keeps four eyes and an append-only history', () => {
  const signed = doc(issuer.signLicence(annual()));
  it('refuses the proposer deciding, installs on a second person’s approval', async () => {
    const repo = inMemoryLicenceRepository({ installationId: INSTALLATION });
    const id = expectOk(
      await repo.propose({ signed, subjectId: uuid(), proposedBy: 'admin-1', correlationId: uuid() }),
    );
    const self = await repo.decide({ proposalId: id, approve: true, decidedBy: 'admin-1', correlationId: uuid() });
    expect(self.ok ? undefined : self.error.reason).toBe('FOUR_EYES_SELF_DECISION');
    expect(await repo.history()).toHaveLength(0);
    expect((await repo.decide({ proposalId: id, approve: true, decidedBy: 'admin-2', correlationId: uuid() })).ok).toBe(
      true,
    );
    const installed = await repo.history();
    expect(installed.map((e) => [e.installedBy, e.approvedBy])).toEqual([['admin-1', 'admin-2']]);
  });
  it('remembers the highest time seen', async () => {
    const repo = inMemoryLicenceRepository();
    expect(await repo.observeClock(100n)).toBeUndefined();
    expect(await repo.observeClock(50n)).toBe(100n);
    expect((await repo.installation()).highWaterMarkEpochSeconds).toBe(100n);
  });
});

describe('a verifier outside production', () => {
  it('uses the compiled-in keyring when no test keyring is given', () => {
    const v = expectOk(createVerifier({ nodeEnv: 'development' }));
    expect(v.mode).toBe('NON_PRODUCTION');
    expect(v.keyIds()).toEqual([]);
  });
});
