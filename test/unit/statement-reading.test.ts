/**
 * Reading figures from a financial statement: the amount parser (digits in
 * threes, brackets for a loss, Arabic-Indic digits); the reader over the grid
 * the document engine actually returned for a synthetic two-year statement
 * (two tables merged, the year row mid-grid); everything it refuses to guess
 * (no year row, thousands, low confidence, conflicts, a negative revenue);
 * the tenant policy; the adapter's edge (confidence to an integer, a malformed
 * answer); and the service end to end — read figures enter through the
 * system's principal as OCR, sourced to the statement, unverified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type TenantCode, loadStatementReadingPolicy } from '@sanad/config/loader.ts';
import {
  type StatementReadingPolicy,
  parseStatementAmount,
  parseStatementReadingPolicy,
  readStatementFigures,
} from '@sanad/core/documents/statement-figures.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import type { ExtractedContent } from '@sanad/core/ports/document-extraction.ts';
import { EnvironmentCredentialProvider } from '../../adapters/kernel/credentials-environment.ts';
import { NutrientDocumentExtraction, contentOf } from '../../adapters/nutrient/document-extraction.ts';
import { READ_FIGURE_SOURCES, listApplications, resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import { readFiguresFromStatement } from '../../apps/ops/src/server/business-statement-reading.ts';
import { uploadBusinessDocument } from '../../apps/ops/src/server/business-storage.ts';

const ENV = {
  SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_BASE_URL: 'http://127.0.0.1:5000',
  SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_API_TOKEN: 'test-engine-token-not-real',
};
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);
const policy = (): StatementReadingPolicy => expectOk(loadStatementReadingPolicy('sme-fund-ae'));

/** The grid Document Engine 1.19 returned for the synthetic statement (verification README, V-06), as engine JSON. */
const ENGINE_ANSWER = {
  pages: [
    {
      plainText:
        'Lumen Date Farms LLC (SYNTHETIC)\r\nAudited financial statements for the year ended 31 December 2025. Amounts in AED.',
      keyValuePairs: [],
      tables: [
        {
          confidence: 100,
          cells: [
            ['Revenue', '4,250,000', '3,910,500'],
            ['Cost of sales', '(2,975,000)', '(2,737,350)'],
            ['Finance costs', '(96,000)', '(88,200)'],
            ['Net profit for the year', '412,750', '(35,400)'],
            ['Statement of financial position', '', ''],
            ['', '2025', '2024'],
            ['Total current assets', '1,820,300', '1,640,000'],
            ['Total current liabilities', '1,105,900', '1,020,450'],
          ].flatMap((row, rowIndex) =>
            row.map((text, columnIndex) => ({ rowIndex, columnIndex, text, isHeader: false, bbox: {} })),
          ),
        },
      ],
    },
  ],
};
const grid = (rows: string[][], confidencePerTenThousand = 10_000, plainText = ''): ExtractedContent => ({
  pages: [
    {
      plainText,
      tables: [
        {
          confidencePerTenThousand,
          cells: rows.flatMap((row, r) => row.map((text, c) => ({ row: r, column: c, text }))),
        },
      ],
    },
  ],
});

describe('amounts as printed', () => {
  it('reads digits in threes with up to two decimals, brackets or a minus for a loss, and Arabic-Indic digits', () => {
    expect(parseStatementAmount('4,250,000')).toBe(425_000_000n);
    expect(parseStatementAmount('4250000.5')).toBe(425_000_050n);
    expect(parseStatementAmount('(35,400)')).toBe(-3_540_000n);
    expect(parseStatementAmount('-35,400.25')).toBe(-3_540_025n);
    expect(parseStatementAmount('٤٬٢٥٠٬٠٠٠')).toBe(425_000_000n);
    expect(parseStatementAmount('١٢٫٥')).toBe(1_250n);
  });
  it('refuses anything that is not plainly one amount', () => {
    for (const s of [
      '',
      '4,25,000',
      '4.250.000',
      '1,000.123',
      '(35,400',
      '-(35,400)',
      'AED 4,250,000',
      '12e3',
      '4 250 000x',
    ])
      expect(parseStatementAmount(s), s).toBeUndefined();
  });
});

describe('reading a statement’s tables', () => {
  it('reads the engine’s real grid: this year’s figures and last year’s revenue, under the year row it found', () => {
    const content = contentOf(ENGINE_ANSWER);
    if (content === undefined) throw new Error('shape');
    const r = expectOk(readStatementFigures(content, policy()));
    expect(r.figures.map((f) => [f.metric, f.periodLabel, f.minorUnits])).toEqual([
      ['ANNUAL_REVENUE', 'FY2025', 425_000_000n],
      ['PRIOR_YEAR_REVENUE', 'FY2024', 391_050_000n],
      ['NET_PROFIT', 'FY2025', 41_275_000n],
      ['CURRENT_ASSETS', 'FY2025', 182_030_000n],
      ['CURRENT_LIABILITIES', 'FY2025', 110_590_000n],
    ]);
    expect(r.figures[0]?.evidence).toEqual({ page: 1, label: 'Revenue', text: '4,250,000' });
    expect(r.skipped).toEqual([]);
  });

  it('reads Arabic labels and digits, and a loss for the year', () => {
    const r = expectOk(
      readStatementFigures(
        grid([
          ['', '٢٠٢٥', '٢٠٢٤'],
          ['الإيرادات', '٤٬٢٥٠٬٠٠٠', '٣٬٩١٠٬٥٠٠'],
          ['صافي الربح (إيضاح 7):', '(١٢٬٠٠٠)', '٥٠٬٠٠٠'],
        ]),
        policy(),
      ),
    );
    expect(r.figures.map((f) => [f.metric, f.periodLabel, f.minorUnits])).toEqual([
      ['ANNUAL_REVENUE', 'FY2025', 425_000_000n],
      ['PRIOR_YEAR_REVENUE', 'FY2024', 391_050_000n],
      ['NET_PROFIT', 'FY2025', -1_200_000n],
    ]);
  });

  it('guesses nothing: no year row, low confidence, a negative revenue, or two different amounts for one figure', () => {
    expect(expectOk(readStatementFigures(grid([['Revenue', '4,250,000']]), policy()))).toEqual({
      figures: [],
      skipped: [{ page: 1, label: 'Revenue', reason: 'NO_YEAR_HEADER' }],
    });
    expect(
      expectOk(
        readStatementFigures(
          grid(
            [
              ['', '2025'],
              ['Revenue', '4,250,000'],
            ],
            8999,
          ),
          policy(),
        ),
      ).skipped,
    ).toEqual([{ page: 1, label: 'Revenue', reason: 'LOW_CONFIDENCE' }]);
    expect(
      expectOk(
        readStatementFigures(
          grid([
            ['', '2025'],
            ['Revenue', '(4,250,000)'],
          ]),
          policy(),
        ),
      ).skipped,
    ).toEqual([{ page: 1, label: 'Revenue', reason: 'NEGATIVE_NOT_ALLOWED' }]);
    const conflict = expectOk(
      readStatementFigures(
        grid([
          ['', '2025'],
          ['Revenue', '4,250,000'],
          ['Sales', '4,300,000'],
        ]),
        policy(),
      ),
    );
    expect(conflict.figures).toEqual([]);
    expect(conflict.skipped.map((s) => s.reason)).toEqual(['CONFLICTING_VALUES', 'CONFLICTING_VALUES']);
    expect(
      expectOk(
        readStatementFigures(
          grid([
            ['', '2025'],
            ['Revenue', 'n/a'],
          ]),
          policy(),
        ),
      ).skipped[0]?.reason,
    ).toBe('AMOUNT_UNREADABLE');
  });

  it('reads only exact labels: a section heading or a similar caption is not a figure', () => {
    const r = expectOk(
      readStatementFigures(
        grid([
          ['', '2025'],
          ['Current assets', '1,820,300'],
          ['Revenue from related parties', '100,000'],
          ['Other revenue', '5,000'],
        ]),
        policy(),
      ),
    );
    expect(r).toEqual({ figures: [], skipped: [] });
  });

  it('refuses a statement presented in thousands or millions, whole', () => {
    for (const text of ["Amounts in AED '000", 'All amounts in thousands of Saudi riyals', 'المبالغ بالآلاف'])
      expect(
        reason(
          readStatementFigures(
            grid(
              [
                ['', '2025'],
                ['Revenue', '4,250'],
              ],
              10_000,
              text,
            ),
            policy(),
          ),
        ),
      ).toBe('STATEMENT_SCALE_NOT_UNITS');
  });
});

describe('the statement-reading policy', () => {
  it('is configured for every tenant, and refuses a label that means two metrics or a confidence floor out of range', () => {
    for (const t of ['sme-fund-ae', 'bank-a', 'fintech-b'] as TenantCode[]) expectOk(loadStatementReadingPolicy(t));
    const base = {
      policyRef: 'test',
      documentTypes: ['AUDITED_FINANCIALS_2Y'],
      minimumConfidencePerTenThousand: 9000,
      labels: {
        ANNUAL_REVENUE: ['Revenue'],
        NET_PROFIT: ['Net profit'],
        CURRENT_ASSETS: ['A'],
        CURRENT_LIABILITIES: ['L'],
      },
    };
    expectOk(parseStatementReadingPolicy(base));
    expect(reason(parseStatementReadingPolicy({ ...base, labels: { ...base.labels, NET_PROFIT: ['revenue '] } }))).toBe(
      'STATEMENT_POLICY_INVALID',
    );
    expect(reason(parseStatementReadingPolicy({ ...base, minimumConfidencePerTenThousand: 0.9 }))).toBe(
      'STATEMENT_POLICY_INVALID',
    );
  });
});

describe('the Nutrient extraction adapter', () => {
  it('asks for json-content tables and text, and turns the engine’s confidence into an integer per ten thousand', async () => {
    let instructions: unknown;
    const impl = (async (_url: URL | string, init?: RequestInit) => {
      instructions = JSON.parse(String((init?.body as FormData).get('instructions')));
      return Response.json({ pages: [{ plainText: 'x', tables: [{ confidence: 99.38857, cells: [] }] }] });
    }) as typeof fetch;
    const engine = new NutrientDocumentExtraction(new EnvironmentCredentialProvider(() => undefined, ENV), {
      environment: 'sandbox',
      nowEpochSeconds: () => 1_800_000_000,
      fetchImpl: impl,
    });
    const r = expectOk(await engine.extract({ tenantId: 't', pdf: new Uint8Array([37]), correlationId: 'c' }));
    expect(instructions).toEqual({
      parts: [{ file: 'document' }],
      output: { type: 'json-content', plainText: true, tables: true },
    });
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: { pages: [{ plainText: 'x', tables: [{ confidencePerTenThousand: 9938, cells: [] }] }] },
    });
  });
  it('an answer of the wrong shape is not content', () => {
    expect(contentOf({ pages: 'x' })).toBeUndefined();
    expect(
      contentOf({ pages: [{ tables: [{ cells: [{ rowIndex: 'a', columnIndex: 0, text: 'x' }] }] }] }),
    ).toBeUndefined();
    expect(contentOf(null)).toBeUndefined();
  });
});

describe('reading through the service', () => {
  const statementPdf = new TextEncoder().encode('%PDF-1.7\nsynthetic audited statements\n%%EOF');
  beforeEach(() => {
    vi.stubEnv('SANAD_DATABASE_URL', '');
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    vi.stubGlobal('fetch', async () => Response.json(ENGINE_ANSWER));
    resetBusinessStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  const openApplication = async () => {
    const v = (await listApplications('sme-fund-ae')).find(
      (x) => x.application.status === 'RECEIVED' || x.application.status === 'SPREADING',
    );
    if (v === undefined) throw new Error('no open seed');
    return v.application.applicationId;
  };

  it('proposes the statement’s figures through the system principal, as OCR, sourced to the statement, unverified', async () => {
    const id = await openApplication();
    const uploaded = expectOk(
      await uploadBusinessDocument('sme-fund-ae', id, 'AUDITED_FINANCIALS_2Y', statementPdf, 'stf-ae-officer-01', 'c'),
    );
    const doc =
      uploaded.documents.find((d) => d.documentType === 'AUDITED_FINANCIALS_2Y' && d.content)?.documentRef ?? '';
    const v = expectOk(await readFiguresFromStatement('sme-fund-ae', id, doc, 'c'));
    // The read figures supersede the seed's for the same metric and year; the current set carries them.
    const added = v.figures.filter((f) => f.figure.sourceRef === doc);
    expect(added).toHaveLength(5);
    expect(added.map((f) => [f.figure.metric, f.figure.periodLabel])).toEqual(
      expect.arrayContaining([
        ['ANNUAL_REVENUE', 'FY2025'],
        ['PRIOR_YEAR_REVENUE', 'FY2024'],
        ['NET_PROFIT', 'FY2025'],
        ['CURRENT_ASSETS', 'FY2025'],
        ['CURRENT_LIABILITIES', 'FY2025'],
      ]),
    );
    for (const f of added) {
      expect(f.figure.sourceKind).toBe('OCR');
      // No person keyed it: the figure names no one, and the event names the reading system.
      expect(f.figure.enteredBy).toBeUndefined();
      expect(f.figure.status).not.toBe('VERIFIED');
    }
    expect(v.events.at(-1)?.actor).toBe(READ_FIGURE_SOURCES.ocr);
  });

  it('reads only a statement type the policy names, only an uploaded PDF, and nothing when the engine is down', async () => {
    const id = await openApplication();
    const bank = expectOk(
      await uploadBusinessDocument(
        'sme-fund-ae',
        id,
        'COMPANY_BANK_STATEMENT_12M',
        statementPdf,
        'stf-ae-officer-01',
        'c',
      ),
    );
    expect(
      reason(await readFiguresFromStatement('sme-fund-ae', id, bank.documents.at(-1)?.documentRef ?? '', 'c')),
    ).toBe('STATEMENT_TYPE_NOT_READ');
    expect(reason(await readFiguresFromStatement('sme-fund-ae', id, 'doc-nowhere', 'c'))).toBe(
      'SECURITY_EVIDENCE_NOT_ON_FILE',
    );
    // Different bytes from the bank statement's: a file is stored and recorded by its hash.
    const statement = new TextEncoder().encode('%PDF-1.7\nsynthetic audited statements, second file\n%%EOF');
    const fs = expectOk(
      await uploadBusinessDocument('sme-fund-ae', id, 'AUDITED_FINANCIALS_2Y', statement, 'stf-ae-officer-01', 'c'),
    );
    const doc = fs.documents.find((d) => d.documentType === 'AUDITED_FINANCIALS_2Y' && d.content)?.documentRef ?? '';
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    expect(reason(await readFiguresFromStatement('sme-fund-ae', id, doc, 'c'))).toBe('DOCUMENT_READING_UNAVAILABLE');
    const after = (await listApplications('sme-fund-ae')).find((x) => x.application.applicationId === id);
    expect(after?.figures.filter((f) => f.figure.sourceRef === doc)).toEqual([]);
  });

  it('reads nothing once the application has left credit assessment', async () => {
    const decided = (await listApplications('sme-fund-ae')).find((x) => x.application.status === 'OFFER_SENT');
    const id = decided?.application.applicationId ?? '';
    expect(
      reason(await readFiguresFromStatement('sme-fund-ae', id, decided?.documents[0]?.documentRef ?? '', 'c')),
    ).toBe('TRANSITION_NOT_ALLOWED');
  });
});
