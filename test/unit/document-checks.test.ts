/**
 * Document intelligence D2 (core/documents/document-checks.ts): the checks a
 * checklist item declares on what a document says — recency, expiry, period
 * coverage, the registration number and the business name — evaluated
 * against what was read. Pure: the reading date is passed in, a Hijri date
 * converts through the converter given. And the configuration's invariant:
 * every check a checklist declares can be made from a fact the catalogue
 * reads for that document.
 */
import { describe, expect, it } from 'vitest';

import { TENANT_CODES, loadDocumentChecklist, loadDocumentTypeCatalogue } from '@sanad/config/loader.ts';
import { type CheckContext, evaluateChecks, parseCheckRules } from '@sanad/core/documents/document-checks.ts';
import {
  type Understanding,
  findingsOf,
  matchName,
  matchRegistration,
  readFacts,
} from '@sanad/core/documents/understanding.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';

import { gregorianOfUmmAlQura, ummAlQuraIso } from '../../services/origination/src/hijri.ts';

const saudi = expectOk(loadDocumentTypeCatalogue('bank-a'));
const kind = (k: string) => {
  const d = saudi.types.find((t) => t.kind === k);
  if (d === undefined) throw new Error(k);
  return d;
};
const ctx: CheckContext = {
  asOf: '2026-10-19',
  toGregorian: (d) => (d.calendar === 'GREGORIAN' ? d.date : gregorianOfUmmAlQura(d.date)),
};
const read = (text: string, k: string): Understanding => ({
  classification: { status: 'RECOGNISED', kind: k, confidencePerTenThousand: 10_000, markersMatched: 3 },
  facts: readFacts(text, kind(k)),
  pagesRead: 1,
});
const run = (rules: unknown, u: Understanding, typeMatches = true) =>
  evaluateChecks(expectOk(parseCheckRules(rules, 'test')), u, typeMatches, ctx);

describe('declaring checks', () => {
  it('parses each known check and refuses a malformed or repeated one', () => {
    expect(
      expectOk(
        parseCheckRules(
          [
            { check: 'NOT_EXPIRED', minimumRemainingDays: 30 },
            { check: 'ISSUED_WITHIN', days: 90 },
            { check: 'PERIOD_COVERS', months: 12 },
          ],
          'x',
        ),
      ),
    ).toHaveLength(3);
    for (const bad of [
      'NOT_EXPIRED',
      [{ check: 'NOT_A_CHECK' }],
      [{ check: 'ISSUED_WITHIN' }],
      [{ check: 'ISSUED_WITHIN', days: 1.5 }],
      [{ check: 'PERIOD_COVERS', months: 0 }],
      [{ check: 'NAME_FOUND' }, { check: 'NAME_FOUND' }],
    ])
      expect(parseCheckRules(bad, 'x').ok).toBe(false);
  });
});

describe('dates on the document', () => {
  it('passes an unexpired document and fails an expired one, saying what it saw', () => {
    expect(run([{ check: 'NOT_EXPIRED' }], read('Expiry Date: 14/03/2027', 'COMMERCIAL_REGISTRATION'))).toEqual([
      { check: 'NOT_EXPIRED', outcome: 'PASS', observed: '2027-03-14' },
    ]);
    expect(run([{ check: 'NOT_EXPIRED' }], read('Expiry Date: 2026-10-19', 'COMMERCIAL_REGISTRATION'))).toEqual([
      { check: 'NOT_EXPIRED', outcome: 'FAIL', observed: '2026-10-19' },
    ]);
  });

  it('holds an expiry to the margin the policy wants left', () => {
    const u = read('Expiry Date: 2026-11-10', 'COMMERCIAL_REGISTRATION');
    expect(run([{ check: 'NOT_EXPIRED', minimumRemainingDays: 30 }], u)[0]).toMatchObject({
      outcome: 'FAIL',
      limit: '30d',
    });
    expect(run([{ check: 'NOT_EXPIRED', minimumRemainingDays: 20 }], u)[0]?.outcome).toBe('PASS');
  });

  it('compares a Hijri date on the Umm al-Qura calendar, and says it was Hijri', () => {
    // 1448-05-04 is 2026-10-15: four days before the reading date.
    const expired = read('Expiry Date: 1448/05/04', 'COMMERCIAL_REGISTRATION');
    expect(run([{ check: 'NOT_EXPIRED' }], expired)).toEqual([
      { check: 'NOT_EXPIRED', outcome: 'FAIL', observed: '1448-05-04', calendar: 'HIJRI' },
    ]);
    expect(
      run([{ check: 'NOT_EXPIRED' }], read('Expiry Date: 1449/05/04', 'COMMERCIAL_REGISTRATION'))[0]?.outcome,
    ).toBe('PASS');
  });

  it('a Hijri date that is no day of the calendar is unreadable, never the nearest day', () => {
    const noSuchDay: CheckContext = { ...ctx, toGregorian: () => undefined };
    const u = read('Expiry Date: 1449/05/04', 'COMMERCIAL_REGISTRATION');
    expect(evaluateChecks([{ check: 'NOT_EXPIRED' }], u, true, noSuchDay)).toEqual([
      { check: 'NOT_EXPIRED', outcome: 'UNREADABLE' },
    ]);
  });

  it('holds an issue date to its recency, and refuses one dated after the reading', () => {
    const rule = [{ check: 'ISSUED_WITHIN', days: 30 }];
    expect(run(rule, read('Report Date: 2026-09-25', 'CREDIT_BUREAU_REPORT'))[0]?.outcome).toBe('PASS');
    expect(run(rule, read('Report Date: 2026-08-01', 'CREDIT_BUREAU_REPORT'))[0]).toEqual({
      check: 'ISSUED_WITHIN',
      outcome: 'FAIL',
      observed: '2026-08-01',
      limit: '30d',
    });
    expect(run(rule, read('Report Date: 2026-12-01', 'CREDIT_BUREAU_REPORT'))[0]?.outcome).toBe('FAIL');
  });

  it('a date it could not read is unreadable, never a failure', () => {
    expect(run([{ check: 'NOT_EXPIRED' }], read('Commercial Registration', 'COMMERCIAL_REGISTRATION'))).toEqual([
      { check: 'NOT_EXPIRED', outcome: 'UNREADABLE' },
    ]);
  });
});

describe('statement periods', () => {
  const rules = [
    { check: 'PERIOD_COVERS', months: 12 },
    { check: 'PERIOD_ENDS_WITHIN', days: 45 },
  ];

  it('passes twelve whole months ending recently', () => {
    expect(run(rules, read('Statement Period: 01/10/2025 - 30/09/2026', 'BANK_STATEMENT'))).toEqual([
      { check: 'PERIOD_COVERS', outcome: 'PASS', observed: '2025-10-01..2026-09-30', limit: '12m' },
      { check: 'PERIOD_ENDS_WITHIN', outcome: 'PASS', observed: '2026-09-30', limit: '45d' },
    ]);
  });

  it('fails six months, and a statement that ended too long ago', () => {
    expect(run(rules, read('Statement Period: 01/01/2026 - 30/06/2026', 'BANK_STATEMENT'))).toEqual([
      { check: 'PERIOD_COVERS', outcome: 'FAIL', observed: '2026-01-01..2026-06-30', limit: '12m' },
      { check: 'PERIOD_ENDS_WITHIN', outcome: 'FAIL', observed: '2026-06-30', limit: '45d' },
    ]);
  });

  it('counts whole months from any day: 31 January to 30 January a year on is twelve', () => {
    expect(
      run(
        [{ check: 'PERIOD_COVERS', months: 12 }],
        read('Statement Period: 31/01/2025 - 30/01/2026', 'BANK_STATEMENT'),
      )[0]?.outcome,
    ).toBe('PASS');
    expect(
      run(
        [{ check: 'PERIOD_COVERS', months: 12 }],
        read('Statement Period: 31/01/2025 - 29/01/2026', 'BANK_STATEMENT'),
      )[0]?.outcome,
    ).toBe('FAIL');
  });
});

describe('the wrong document', () => {
  it('has every content check unreadable: the dates of the wrong document say nothing about the right one', () => {
    expect(run([{ check: 'NOT_EXPIRED' }], read('Expiry Date: 2020-01-01', 'COMMERCIAL_REGISTRATION'), false)).toEqual([
      { check: 'NOT_EXPIRED', outcome: 'UNREADABLE' },
    ]);
  });

  it('findingsOf puts the type check first and the content checks after it', () => {
    const u = read('Expiry Date: 14/03/2027', 'COMMERCIAL_REGISTRATION');
    const f = findingsOf(
      u,
      'OWNER_NATIONAL_ID',
      saudi,
      { engine: 'rules@1', source: 'FIXTURE' },
      { rules: [{ check: 'NOT_EXPIRED' }], context: ctx },
    );
    expect(f.checks).toEqual([
      { check: 'TYPE_MATCHES_DECLARED', outcome: 'FAIL' },
      { check: 'NOT_EXPIRED', outcome: 'UNREADABLE' },
    ]);
  });
});

describe('matching the application', () => {
  const cr = kind('COMMERCIAL_REGISTRATION');

  it('compares the registration number after its label, as printed with spaces or dashes', () => {
    expect(matchRegistration('CR Number 1010-000 002', cr, '1010000002')).toBe('MATCHES');
    expect(matchRegistration('رقم السجل ١٠١٠٠٠٠٠٠٢', cr, '1010000002')).toBe('MATCHES');
    expect(matchRegistration('CR Number 1010000099', cr, '1010000002')).toBe('DIFFERS');
    expect(matchRegistration('Commercial Registration', cr, '1010000002')).toBe('NOT_READ');
    // Too short to compare meaningfully: not read, never a match.
    expect(matchRegistration('CR Number 1234', cr, '1234')).toBe('NOT_READ');
  });

  it('turns the match into a check: differs fails, not read is unreadable', () => {
    const u = (registration: 'MATCHES' | 'DIFFERS' | 'NOT_READ'): Understanding => ({
      ...read('', 'COMMERCIAL_REGISTRATION'),
      matches: { registration },
    });
    const rule = [{ check: 'REGISTRATION_MATCHES' }];
    expect(run(rule, u('MATCHES'))[0]?.outcome).toBe('PASS');
    expect(run(rule, u('DIFFERS'))[0]?.outcome).toBe('FAIL');
    expect(run(rule, u('NOT_READ'))[0]?.outcome).toBe('UNREADABLE');
  });

  it('finds the business by its distinctive words, in either script, ignoring its legal form', () => {
    expect(matchName('NAJD LANTERN WORKS COMPANY', ['Najd Lantern Works Co'])).toBe('FOUND');
    expect(matchName('شركة فوانيس نجد للصناعة', ['Najd Lantern Works Co', 'شركة فوانيس نجد للصناعة'])).toBe('FOUND');
    expect(matchName('Najd Trading Co', ['Najd Lantern Works Co'])).toBe('NOT_FOUND');
  });

  it('a name not found is unreadable, never a failure: rendered Arabic may simply not have been read', () => {
    const u: Understanding = { ...read('', 'COMMERCIAL_REGISTRATION'), matches: { name: 'NOT_FOUND' } };
    expect(run([{ check: 'NAME_FOUND' }], u)).toEqual([{ check: 'NAME_FOUND', outcome: 'UNREADABLE' }]);
  });
});

describe('Umm al-Qura to Gregorian', () => {
  it('round-trips every day of a span of years', () => {
    for (let day = Date.UTC(2024, 0, 1); day <= Date.UTC(2031, 11, 31); day += 7 * 86_400_000) {
      const iso = new Date(day).toISOString().slice(0, 10);
      expect(gregorianOfUmmAlQura(ummAlQuraIso(iso))).toBe(iso);
    }
  });

  it('refuses what is no date', () => {
    for (const bad of ['1448-13-01', '1448-00-10', '1448-05-31', '2026-10-19', 'not a date'])
      expect(gregorianOfUmmAlQura(bad)).toBeUndefined();
  });
});

describe('configuration', () => {
  const PROGRAMMES = [
    'prg-0001',
    'sme-sa-term',
    'sme-ae-advanced-tech',
    'sme-ae-expansion',
    'sme-ae-first-time-founders',
    'sme-ae-fixed-assets',
    'sme-ae-small-loan',
    'sme-ae-working-capital',
  ];
  const NEEDS = {
    NOT_EXPIRED: 'EXPIRY_DATE',
    ISSUED_WITHIN: 'ISSUE_DATE',
    PERIOD_ENDS_WITHIN: 'STATEMENT_PERIOD',
    PERIOD_COVERS: 'STATEMENT_PERIOD',
    REGISTRATION_MATCHES: 'REGISTRATION_NUMBER',
  } as const;

  it("every declared check can be made from a fact the catalogue reads for that item's documents", () => {
    for (const tenant of TENANT_CODES) {
      const catalogue = loadDocumentTypeCatalogue(tenant);
      if (!catalogue.ok) continue;
      for (const programme of PROGRAMMES) {
        const checklist = loadDocumentChecklist(tenant, programme);
        if (!checklist.ok) continue;
        for (const item of checklist.value.items)
          for (const rule of item.checks ?? []) {
            if (rule.check === 'NAME_FOUND') continue;
            const kinds = catalogue.value.types.filter((t) => t.satisfies.includes(item.documentType));
            expect(kinds.length, `${tenant} ${item.documentType}`).toBeGreaterThan(0);
            for (const k of kinds)
              expect(
                k.facts.map((f) => f.fact),
                `${tenant} ${item.documentType} ${rule.check}`,
              ).toContain(NEEDS[rule.check]);
          }
      }
    }
  });
});
