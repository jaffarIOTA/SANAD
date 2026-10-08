/**
 * Configuration changes under maker-checker. Each case attempts an outcome
 * the rules forbid — a change in force without approval, a person approving
 * their own proposal, a configuration approved that could not be loaded, a
 * decided revision changed — and passes only when the attempt fails.
 */
import { describe, expect, it } from 'vitest';

import { decideRevision, effectiveRevision, proposeRevision, type Revision } from '@sanad/core/config/revision.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { parseProductCatalogue } from '@sanad/core/products/catalogue.ts';
import { ISLAMIC_PRODUCT_CODES } from '@sanad/core/products/registry.ts';
import { bnpl } from '@sanad/products/bnpl/index.ts';
import bankA from '../../config/tenants/bank-a/products/catalogue.json' with { type: 'json' };

const T0 = 1_791_000_000n;
const parse = (raw: unknown) => parseProductCatalogue(raw, ISLAMIC_PRODUCT_CODES);
const propose = (rawPayload: unknown, id = 'rev-1') => proposeRevision({ id, tenantId: 'bank-a', area: 'PRODUCTS', rawPayload, summary: 'test change', effectiveFromEpochSeconds: T0 + 100n, proposedBy: 'adm-01', proposedAtEpochSeconds: T0, parse });

describe('a configuration change takes effect only when approved by a second person', () => {
  it('a proposed revision is never the effective one', () => {
    const r = expectOk(propose(bankA));
    expect(effectiveRevision([r], T0 + 1_000n)).toBeUndefined();
  });
  it('the proposer may not approve or reject their own revision', () => {
    const r = expectOk(propose(bankA));
    const self = decideRevision(r, { decidedBy: 'adm-01', decidedAtEpochSeconds: T0 + 1n, approve: true });
    expect(self.ok).toBe(false); if (!self.ok) expect(self.error.reason).toBe('FOUR_EYES_SELF_DECISION');
    const selfReject = decideRevision(r, { decidedBy: 'adm-01', decidedAtEpochSeconds: T0 + 1n, approve: false, reason: 'changed my mind' });
    expect(selfReject.ok).toBe(false);
  });
  it('approved by another, it is effective from its stated moment and not before', () => {
    const approved = expectOk(decideRevision(expectOk(propose(bankA)), { decidedBy: 'adm-02', decidedAtEpochSeconds: T0 + 1n, approve: true }));
    expect(effectiveRevision([approved], T0 + 99n)).toBeUndefined();
    expect(effectiveRevision([approved], T0 + 100n)?.id).toBe('rev-1');
  });
  it('a rejected revision is never effective, and a rejection says why', () => {
    const r = expectOk(propose(bankA));
    expect(decideRevision(r, { decidedBy: 'adm-02', decidedAtEpochSeconds: T0 + 1n, approve: false }).ok).toBe(false);
    const rejected = expectOk(decideRevision(r, { decidedBy: 'adm-02', decidedAtEpochSeconds: T0 + 1n, approve: false, reason: 'limit too high' }));
    expect(effectiveRevision([rejected], T0 + 1_000n)).toBeUndefined();
  });
  it('a decided revision cannot be decided again', () => {
    const approved = expectOk(decideRevision(expectOk(propose(bankA)), { decidedBy: 'adm-02', decidedAtEpochSeconds: T0 + 1n, approve: true }));
    const again = decideRevision(approved, { decidedBy: 'adm-03', decidedAtEpochSeconds: T0 + 2n, approve: false, reason: 'late' });
    expect(again.ok).toBe(false); if (!again.ok) expect(again.error.reason).toBe('REVISION_ALREADY_DECIDED');
  });
  it('the latest effective approved revision wins; ties go to the later decision', () => {
    const a = expectOk(decideRevision(expectOk(propose(bankA, 'a')), { decidedBy: 'adm-02', decidedAtEpochSeconds: T0 + 1n, approve: true }));
    const b: Revision = { ...expectOk(decideRevision(expectOk(propose(bankA, 'b')), { decidedBy: 'adm-02', decidedAtEpochSeconds: T0 + 5n, approve: true })), effectiveFromEpochSeconds: T0 + 200n };
    const c: Revision = { ...expectOk(decideRevision(expectOk(propose(bankA, 'c')), { decidedBy: 'adm-02', decidedAtEpochSeconds: T0 + 9n, approve: true })), effectiveFromEpochSeconds: T0 + 200n };
    expect(effectiveRevision([a, b, c], T0 + 150n)?.id).toBe('a');
    expect(effectiveRevision([a, b, c], T0 + 250n)?.id).toBe('c');
  });
});

describe('a configuration that could not be loaded cannot be proposed', () => {
  it('a catalogue the production parser refuses is refused at proposal, with the parser’s reason', () => {
    const r = propose({ version: 'x', entries: 'nope' });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('REVISION_PAYLOAD_INVALID');
  });
  it('an Islamic product without a board ruling cannot be proposed (SH-18 holds at the admin screen too)', () => {
    const stripped = { ...bankA, entries: bankA.entries.map((e) => (e.productCode === 'tawarruq-personal' ? { ...e, boardRulingRef: undefined } : e)) };
    const r = propose(stripped);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.control).toBe('SH-18');
  });
  it('Murabaha cannot be mapped onto a core banking product by configuration (SH-01): its fixed price would be booked under a rate', () => {
    const mapped = { ...bankA, entries: bankA.entries.map((e) => (e.productCode === 'murabaha-scf' ? { ...e, coreBankingProductCode: 'TAWRROUQ' } : e)) };
    const r = propose(mapped);
    expect(r.ok).toBe(false);
    const parsed = parse(mapped);
    expect(parsed.ok).toBe(false); if (!parsed.ok) { expect(parsed.error.control).toBe('SH-01'); expect(parsed.error.reason).toBe('CORE_PRODUCT_NOT_FOR_ACCOUNT_POSTED_PRODUCT'); }
  });
  it('a rate-priced product may carry a core product code, and only a well-formed one', () => {
    const withCode = (code: unknown) => ({ ...bankA, entries: bankA.entries.map((e) => (e.productCode === 'tawarruq-personal' ? { ...e, coreBankingProductCode: code } : e)) });
    expect(propose(withCode('TAWRROUQ')).ok).toBe(true);
    for (const bad of ['', '   ', 42, 'x'.repeat(65)]) {
      const r = parse(withCode(bad));
      expect(r.ok, String(bad)).toBe(false); if (!r.ok) expect(r.error.reason).toBe('CATALOGUE_CORE_PRODUCT_CODE');
    }
  });
  it('a BNPL term sheet over the Art. 22(1) limit without a SAMA variation is refused by the module parser the screen runs before proposing', () => {
    const entry = bankA.entries.find((e) => e.productCode === 'bnpl');
    expect(entry).toBeDefined();
    const over = { ...(entry?.terms as Record<string, unknown>), consumerLimitMinorUnits: '1000001' };
    const terms = bnpl.validateTerms(over);
    expect(terms.ok).toBe(false); if (!terms.ok) expect(terms.error.reason).toBe('TERMS_LIMIT_ABOVE_RULES');
  });
});
