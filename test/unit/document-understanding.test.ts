/**
 * Document intelligence D1 (core/documents/understanding.ts): recognising what
 * a document is from its text, and reading the dates it declares — pure,
 * deterministic, configured per tenant. And the configuration's own
 * invariants: every checklist type a catalogue claims is one the tenant's
 * checklists actually ask for.
 */
import { describe, expect, it } from 'vitest';

import { TENANT_CODES, loadDocumentChecklist, loadDocumentTypeCatalogue } from '@sanad/config/loader.ts';
import { expectOk, ok } from '@sanad/core/kernel/result.ts';
import {
  classify,
  findingsOf,
  normaliseText,
  parseDocumentTypeCatalogue,
  readFacts,
  rulesEngine,
} from '@sanad/core/documents/understanding.ts';
import type { DocumentExtractionPort } from '@sanad/core/ports/document-extraction.ts';

const saudi = expectOk(loadDocumentTypeCatalogue('bank-a'));
const definition = (kind: string) => {
  const d = saudi.types.find((t) => t.kind === kind);
  if (d === undefined) throw new Error(kind);
  return d;
};

const CR = `Kingdom of Saudi Arabia — Ministry of Commerce
Commercial Registration  CR Number 1010000002
Issue Date: 2025-03-14   Expiry Date: 14/03/2027
السجل التجاري`;

const STATEMENT = `Example Bank — Account Statement
Statement Period: 01/04/2026 - 30/09/2026
IBAN SA03 8000 0000 6080 1016 7519
Opening Balance 120,000.00   Closing Balance 98,500.00`;

describe('normalising text', () => {
  it('reads Arabic-Indic digits as digits, drops diacritics and unifies interchangeable letters', () => {
    expect(normaliseText('٢٠٢٧/٠٣/١٤')).toBe('2027/03/14');
    expect(normaliseText('إِدارة   الهويّة')).toBe(normaliseText('ادارة الهوية'));
    expect(normaliseText('Commercial  REGISTRATION')).toBe('commercial registration');
  });
});

describe('recognising a document', () => {
  it('recognises a commercial registration and a bank statement, with a confidence', () => {
    expect(classify(CR, saudi)).toMatchObject({ status: 'RECOGNISED', kind: 'COMMERCIAL_REGISTRATION' });
    const st = classify(STATEMENT, saudi);
    expect(st).toMatchObject({ status: 'RECOGNISED', kind: 'BANK_STATEMENT' });
    if (st.status === 'RECOGNISED') expect(st.confidencePerTenThousand).toBe(10_000);
  });

  it('claims nothing it cannot tell apart, and says so when there is nothing to read', () => {
    expect(classify('A letter about a meeting next week.', saudi)).toEqual({ status: 'UNRECOGNISED' });
    expect(classify('   ', saudi)).toEqual({ status: 'UNREADABLE', reason: 'NO_TEXT' });
    // Strongly both a VAT and a zakat certificate: neither is claimed.
    const both = classify(
      'VAT Registration Certificate — Value Added Tax — Zakat Certificate — Certificate of Zakat',
      saudi,
    );
    expect(both.status).toBe('AMBIGUOUS');
  });
});

describe('reading the dates a document declares', () => {
  it('reads Gregorian dates in either order, day first where the year is last', () => {
    expect(readFacts(CR, definition('COMMERCIAL_REGISTRATION'))).toEqual([
      { fact: 'ISSUE_DATE', status: 'READ', value: { date: '2025-03-14', calendar: 'GREGORIAN' } },
      { fact: 'EXPIRY_DATE', status: 'READ', value: { date: '2027-03-14', calendar: 'GREGORIAN' } },
    ]);
  });

  it('reads a Hijri date as Hijri, in Arabic-Indic digits, without converting it', () => {
    const facts = readFacts('بطاقة الهوية الوطنية — تاريخ الانتهاء ١٤٤٨/٠٧/٢٠', definition('NATIONAL_ID'));
    expect(facts).toEqual([{ fact: 'EXPIRY_DATE', status: 'READ', value: { date: '1448-07-20', calendar: 'HIJRI' } }]);
  });

  it('reads a statement period as its two dates, and says NOT_READ where the label has no date', () => {
    expect(readFacts(STATEMENT, definition('BANK_STATEMENT'))).toEqual([
      {
        fact: 'STATEMENT_PERIOD',
        status: 'READ',
        from: { date: '2026-04-01', calendar: 'GREGORIAN' },
        to: { date: '2026-09-30', calendar: 'GREGORIAN' },
      },
    ]);
    expect(readFacts('Account Statement — Statement Period: to follow', definition('BANK_STATEMENT'))).toEqual([
      { fact: 'STATEMENT_PERIOD', status: 'NOT_READ' },
    ]);
    // An impossible date is not read as one.
    expect(readFacts('Expiry Date: 2027-14-40', definition('NATIONAL_ID'))).toEqual([
      { fact: 'EXPIRY_DATE', status: 'NOT_READ' },
    ]);
  });
});

describe('findings', () => {
  const meta = { engine: 'rules@1', source: 'FIXTURE' as const };
  it('checks the presented type against the kind read: a kind may stand for several checklist types', () => {
    const read = { classification: classify(STATEMENT, saudi), facts: [], pagesRead: 1 };
    expect(findingsOf(read, 'COMPANY_BANK_STATEMENT_12M', saudi, meta).checks).toEqual([
      { check: 'TYPE_MATCHES_DECLARED', outcome: 'PASS' },
    ]);
    expect(findingsOf(read, 'BANK_STATEMENT_6M', saudi, meta).checks[0]?.outcome).toBe('PASS');
    expect(findingsOf(read, 'COMMERCIAL_REGISTRATION', saudi, meta).checks[0]?.outcome).toBe('FAIL');
    const unread = { classification: { status: 'UNRECOGNISED' as const }, facts: [], pagesRead: 1 };
    expect(findingsOf(unread, 'COMMERCIAL_REGISTRATION', saudi, meta).checks[0]?.outcome).toBe('UNREADABLE');
  });

  it('records which engine and catalogue version produced them, so they can be reproduced and compared', () => {
    const f = findingsOf(
      { classification: classify(CR, saudi), facts: [], pagesRead: 1 },
      'COMMERCIAL_REGISTRATION',
      saudi,
      meta,
    );
    expect(f).toMatchObject({ engine: 'rules@1', catalogueVersion: saudi.catalogueVersion, source: 'FIXTURE' });
  });
});

describe('the rules engine', () => {
  const extraction = (text: string, kind: 'ANSWERED' | 'UNAVAILABLE' = 'ANSWERED'): DocumentExtractionPort => ({
    source: 'FIXTURE',
    extract: () =>
      Promise.resolve(
        ok(
          kind === 'ANSWERED'
            ? { kind: 'ANSWERED' as const, value: { pages: [{ plainText: text, tables: [] }] } }
            : { kind: 'UNAVAILABLE' as const, reason: 'down' },
        ),
      ),
  });
  const run = (engine: ReturnType<typeof rulesEngine>, mediaType = 'application/pdf') =>
    engine.understand({
      tenantId: 'bank-a',
      bytes: new Uint8Array([1]),
      mediaType,
      catalogue: saudi,
      correlationId: 'c',
    });

  it('reads a PDF into a classification and its facts', async () => {
    const r = expectOk(await run(rulesEngine(extraction(CR))));
    expect(r.kind).toBe('ANSWERED');
    if (r.kind === 'ANSWERED') {
      expect(r.value.classification).toMatchObject({ kind: 'COMMERCIAL_REGISTRATION' });
      expect(r.value.facts.map((f) => f.status)).toEqual(['READ', 'READ']);
    }
  });

  it('presents an image unread rather than guessing, and passes an engine outage through', async () => {
    const image = expectOk(await run(rulesEngine(extraction(CR)), 'image/png'));
    expect(image).toEqual({
      kind: 'ANSWERED',
      value: { classification: { status: 'UNREADABLE', reason: 'MEDIA_NOT_READ' }, facts: [], pagesRead: 0 },
    });
    expect(expectOk(await run(rulesEngine(extraction(CR, 'UNAVAILABLE')))).kind).toBe('UNAVAILABLE');
  });
});

describe('the catalogue configuration', () => {
  it('refuses an engine other than the rules, until another is approved', () => {
    const r = parseDocumentTypeCatalogue({ ...structuredClone(saudi), engine: 'LLM' });
    expect(r.ok ? 'accepted' : r.error.reason).toBe('DOCUMENT_TYPES_INVALID');
  });

  it('refuses a checklist type claimed by two kinds', () => {
    const twice = structuredClone(saudi) as unknown as { types: { satisfies: string[] }[] };
    twice.types[1]?.satisfies.push('COMMERCIAL_REGISTRATION');
    expect(parseDocumentTypeCatalogue(twice).ok).toBe(false);
  });

  it.each(TENANT_CODES)('%s: every type its catalogue claims is one its checklists ask for', (tenant) => {
    const catalogue = expectOk(loadDocumentTypeCatalogue(tenant));
    const asked = new Set<string>();
    for (const programme of [
      'prg-0001',
      'sme-sa-term',
      'sme-ae-small-loan',
      'sme-ae-working-capital',
      'sme-ae-fixed-assets',
      'sme-ae-expansion',
      'sme-ae-first-time-founders',
      'sme-ae-advanced-tech',
    ]) {
      const c = loadDocumentChecklist(tenant, programme);
      if (c.ok) for (const i of c.value.items) asked.add(i.documentType);
    }
    const unknown = catalogue.types.flatMap((t) => t.satisfies).filter((s) => !asked.has(s));
    expect(unknown).toEqual([]);
  });
});
