/**
 * Document intelligence D1 through the real upload path: an uploaded
 * document is read, and its findings kept for the checker. Each case attempts
 * something the findings must never do, and passes only when they do not:
 *
 *   - decide: a finding — pass or fail — never validates or refuses a
 *     document; it stays PENDING for a person other than the uploader;
 *   - block: a document the engine cannot read (an image, an unrecognised
 *     page, no engine at all) is presented exactly as before;
 *   - copy: what is kept is the kind, the dates and the check outcome — not
 *     the identity or licence number written on the page;
 *   - guess: a kind it cannot tell apart is said to be ambiguous or
 *     unrecognised, never claimed.
 *
 * In memory (sme-fund-ae), the demonstration reader (FIXTURE): no document
 * engine is configured in the test environment.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import {
  getApplication,
  listApplications,
  resetBusinessStore,
  validateDocument,
} from '../../apps/ops/src/server/business.ts';
import { uploadBusinessDocument } from '../../apps/ops/src/server/business-storage.ts';
import {
  documentUnderstandingFor,
  findingsFor,
  resetFindings,
} from '../../services/origination/src/documents/findings.ts';

const T = 'sme-fund-ae';
const sample = (lines: string) => new TextEncoder().encode(`%PDF-1.7\n${lines}\n%%EOF`);
const LICENCE = sample(`Department of Economy and Tourism — Trade License
License No 778899001
Issue Date: 2025-01-10   Expiry Date: 09/01/2027`);
const STATEMENT = sample(`Emirates Example Bank — Account Statement
Statement Period: 01/04/2026 - 30/09/2026
Opening Balance 120,000.00 Closing Balance 98,500.00`);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let open = '';
beforeEach(async () => {
  resetBusinessStore();
  resetFindings();
  const views = await listApplications(T);
  open =
    views.find((v) => v.application.status === 'RECEIVED' || v.application.status === 'SPREADING')?.application
      .applicationId ?? '';
  expect(open).not.toBe('');
});

const findings = () => findingsFor(T, { kind: 'BUSINESS_APPLICATION', ref: open });
const latest = async () => [...(await findings()).values()].at(-1);

describe('reading what was uploaded', () => {
  it('recognises the document, reads its dates, and says it matches the type presented', async () => {
    expectOk(await uploadBusinessDocument(T, open, 'TRADE_LICENCE', LICENCE, 'officer-1', 'c'));
    expect(await latest()).toMatchObject({
      declaredType: 'TRADE_LICENCE',
      classification: { status: 'RECOGNISED', kind: 'TRADE_LICENCE' },
      checks: expect.arrayContaining([{ check: 'TYPE_MATCHES_DECLARED', outcome: 'PASS' }]),
      facts: [
        { fact: 'ISSUE_DATE', status: 'READ', value: { date: '2025-01-10', calendar: 'GREGORIAN' } },
        { fact: 'EXPIRY_DATE', status: 'READ', value: { date: '2027-01-09', calendar: 'GREGORIAN' } },
      ],
      engine: 'rules@1',
      source: 'FIXTURE',
    });
  });

  it('flags a document presented as something it is not — and still leaves the decision to a person', async () => {
    expectOk(await uploadBusinessDocument(T, open, 'TRADE_LICENCE', STATEMENT, 'officer-1', 'c'));
    expect(await latest()).toMatchObject({
      classification: { kind: 'BANK_STATEMENT' },
      checks: expect.arrayContaining([{ check: 'TYPE_MATCHES_DECLARED', outcome: 'FAIL' }]),
    });
    const doc = (await getApplication(T, open))?.documents.at(-1);
    expect(doc?.validationStatus).toBe('PENDING');
    // A failed finding refuses nothing on its own; a passing one accepts nothing: four eyes stand either way.
    const own = await validateDocument(T, open, doc?.documentRef ?? '', 'VALID', 'officer-1');
    expect(own.ok ? 'validated' : own.error.reason).toBe('FOUR_EYES_REQUIRED');
    expectOk(await validateDocument(T, open, doc?.documentRef ?? '', 'INVALID', 'checker-1'));
  });

  it('a statement may stand for either statement type the checklist asks for', async () => {
    expectOk(await uploadBusinessDocument(T, open, 'PERSONAL_BANK_STATEMENT_12M', STATEMENT, 'officer-1', 'c'));
    expect((await latest())?.checks[0]?.outcome).toBe('PASS');
  });

  it('presents what it cannot read exactly as before: an image, an unrecognised page', async () => {
    const before = (await getApplication(T, open))?.documents.length ?? 0;
    expectOk(await uploadBusinessDocument(T, open, 'TRADE_LICENCE', PNG, 'officer-1', 'c'));
    expect(await latest()).toMatchObject({
      classification: { status: 'UNREADABLE', reason: 'MEDIA_NOT_READ' },
      checks: expect.arrayContaining([{ check: 'TYPE_MATCHES_DECLARED', outcome: 'UNREADABLE' }]),
    });
    expectOk(
      await uploadBusinessDocument(T, open, 'RENTAL_CONTRACT', sample('Minutes of a meeting'), 'officer-1', 'c'),
    );
    expect((await latest())?.classification).toEqual({ status: 'UNRECOGNISED' });
    expect((await getApplication(T, open))?.documents.length).toBe(before + 2);
  });

  it('keeps the kind, dates and outcome — never the number written on the page', async () => {
    expectOk(await uploadBusinessDocument(T, open, 'TRADE_LICENCE', LICENCE, 'officer-1', 'c'));
    const kept = JSON.stringify(await latest(), (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
    expect(kept).not.toContain('778899001');
    expect(kept).not.toMatch(/Department of Economy/);
  });
});

describe('where no engine may read', () => {
  it('a deployed process without a document engine has none, and a demonstration reader is refused there', async () => {
    const deployed = { NODE_ENV: 'production', SANAD_DATABASE_URL: '' };
    expect(await documentUnderstandingFor(T, undefined, deployed)).toBeUndefined();
  });
});
