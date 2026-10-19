/**
 * Document intelligence D2 through the real upload path: the checks a
 * checklist item declares are held against what was read, and shown to the
 * checker. Each case attempts something a check must never do, and passes
 * only when it does not:
 *
 *   - decide: a failed check — an expired registration, another company's
 *     number, a short statement — refuses nothing; the document stays
 *     PENDING, the checker may still accept it, and the checklist counts it
 *     exactly as it did before D2 (product owner, 2026-10-19: always four eyes);
 *   - copy: the registration number and the business name are compared during
 *     the reading and dropped — neither is kept on the finding;
 *   - guess: a check that cannot be made is UNREADABLE, never a failure.
 *
 * In memory (bank-a), the demonstration reader (FIXTURE). The documents are
 * dated relative to the day the test runs, in Riyadh.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import {
  checklistStatus,
  getApplication,
  listApplications,
  resetBusinessStore,
  validateDocument,
} from '../../apps/ops/src/server/business.ts';
import { uploadBusinessDocument } from '../../apps/ops/src/server/business-storage.ts';
import { findingsFor, resetFindings } from '../../services/origination/src/documents/findings.ts';

const T = 'bank-a';
const sample = (lines: string) => new TextEncoder().encode(`%PDF-1.7\n${lines}\n%%EOF`);
const DAY = 86_400_000;
const riyadh = (offsetDays: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * DAY));

let open = '';
let cr = '';
let nameEn = '';
beforeEach(async () => {
  resetBusinessStore();
  resetFindings();
  const views = await listApplications(T);
  const v = views.find((x) => x.application.status === 'RECEIVED' || x.application.status === 'SPREADING');
  open = v?.application.applicationId ?? '';
  cr = v?.application.applicant.registrationRef ?? '';
  nameEn = v?.application.applicant.businessNameEn ?? '';
  expect(open).not.toBe('');
  expect(cr).toMatch(/^\d{10}$/);
});

const registration = (number: string, expiry: string) =>
  sample(`Kingdom of Saudi Arabia — Ministry of Commerce
Commercial Registration
${nameEn}
CR Number ${number}
Issue Date: ${riyadh(-400)}   Expiry Date: ${expiry}`);
const statement = (from: number, to: number) =>
  sample(`Example Bank — Account Statement
${nameEn}
Statement Period: ${riyadh(from)} - ${riyadh(to)}
Opening Balance 120,000.00   Closing Balance 98,500.00`);

const latest = async () => [...(await findingsFor(T, { kind: 'BUSINESS_APPLICATION', ref: open })).values()].at(-1);
const outcomes = async () => Object.fromEntries((await latest())?.checks.map((c) => [c.check, c.outcome]) ?? []);
const itemStatus = async (type: string) =>
  expectOk(await checklistStatus(T, open)).report.find((r) => r.item.documentType === type)?.status;

describe('checks the checklist declares', () => {
  it('passes a current registration with the application’s number and name', async () => {
    expectOk(
      await uploadBusinessDocument(T, open, 'COMMERCIAL_REGISTRATION', registration(cr, riyadh(300)), 'officer', 'c'),
    );
    expect(await outcomes()).toEqual({
      TYPE_MATCHES_DECLARED: 'PASS',
      NOT_EXPIRED: 'PASS',
      REGISTRATION_MATCHES: 'PASS',
      NAME_FOUND: 'PASS',
    });
  });

  it('fails an expired registration of another company — and decides nothing', async () => {
    const other = cr.replace(/\d$/, (d) => String((Number(d) + 1) % 10));
    expectOk(
      await uploadBusinessDocument(T, open, 'COMMERCIAL_REGISTRATION', registration(other, riyadh(-3)), 'officer', 'c'),
    );
    expect(await outcomes()).toMatchObject({ NOT_EXPIRED: 'FAIL', REGISTRATION_MATCHES: 'FAIL' });
    expect((await latest())?.checks.find((c) => c.check === 'NOT_EXPIRED')?.observed).toBe(riyadh(-3));

    // Still PENDING, counted by the checklist exactly as before: the checks are the checker's to weigh.
    const doc = (await getApplication(T, open))?.documents.at(-1);
    expect(doc?.validationStatus).toBe('PENDING');
    expect(await itemStatus('COMMERCIAL_REGISTRATION')).toBe('PENDING');
    // The checker may accept it regardless — a failed check is a reason to look, not a refusal.
    expectOk(await validateDocument(T, open, doc?.documentRef ?? '', 'VALID', 'stf-checker-01'));
    expect(await itemStatus('COMMERCIAL_REGISTRATION')).toBe('PRESENT');
  });

  it('holds a statement to twelve months ending recently', async () => {
    expectOk(await uploadBusinessDocument(T, open, 'COMPANY_BANK_STATEMENT_12M', statement(-380, -10), 'officer', 'c'));
    expect(await outcomes()).toMatchObject({ PERIOD_COVERS: 'PASS', PERIOD_ENDS_WITHIN: 'PASS', NAME_FOUND: 'PASS' });
    expectOk(await uploadBusinessDocument(T, open, 'COMPANY_BANK_STATEMENT_12M', statement(-260, -80), 'officer', 'c'));
    expect(await outcomes()).toMatchObject({ PERIOD_COVERS: 'FAIL', PERIOD_ENDS_WITHIN: 'FAIL' });
  });

  it('a check it cannot make is unreadable, never a failure', async () => {
    expectOk(
      await uploadBusinessDocument(
        T,
        open,
        'COMMERCIAL_REGISTRATION',
        sample('Commercial Registration\nMinistry of Commerce'),
        'officer',
        'c',
      ),
    );
    expect(await outcomes()).toEqual({
      TYPE_MATCHES_DECLARED: 'PASS',
      NOT_EXPIRED: 'UNREADABLE',
      REGISTRATION_MATCHES: 'UNREADABLE',
      NAME_FOUND: 'UNREADABLE',
    });
  });

  it('keeps the outcomes — never the registration number or the name compared', async () => {
    expectOk(
      await uploadBusinessDocument(T, open, 'COMMERCIAL_REGISTRATION', registration(cr, riyadh(300)), 'officer', 'c'),
    );
    const kept = JSON.stringify(await latest(), (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));
    expect(kept).not.toContain(cr);
    expect(kept).not.toContain(nameEn);
  });
});
