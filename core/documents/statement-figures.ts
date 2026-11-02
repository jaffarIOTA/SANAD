/**
 * Figures read from a financial statement's tables, as proposals for a person
 * to verify. Pure; integer arithmetic only.
 *
 * What the document engine returns is a grid of cell texts (core/ports/
 * document-extraction.ts). This turns the grid into figures under rules
 * that would rather read nothing than read wrong:
 * - a row counts only when its label is exactly one of the tenant's labels for
 *   a metric (configuration: config/tenants/<t>/credit-policy/statement-reading.json),
 *   after case, spacing and a trailing colon or note reference are ignored;
 * - a column counts only under a year the table itself states (a row of years);
 *   a table that states none is skipped, never guessed;
 * - an amount is digits in groups of three with up to two decimals, brackets
 *   for a negative (Arabic-Indic digits accepted); anything else is skipped;
 * - a statement presented in thousands or millions is refused whole: scaling
 *   is a judgement for the person keying, not for the reader;
 * - a table read with less than the tenant's confidence is skipped;
 * - the same metric and year read twice with different amounts is skipped.
 * The latest year's revenue is ANNUAL_REVENUE and the year before it
 * PRIOR_YEAR_REVENUE; the other metrics are read for the latest year only.
 * Every figure is then a proposal like any other: a different person verifies
 * it against the document before it is used (core/applicant/financials.ts).
 */
import type { FinancialMetric } from '../applicant/financials.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { ExtractedContent } from '../ports/document-extraction.ts';

/** The metrics a statement reader may propose. Debt service and owner-level figures come from rails or a person. */
export type StatementMetric = Extract<
  FinancialMetric,
  'ANNUAL_REVENUE' | 'NET_PROFIT' | 'CURRENT_ASSETS' | 'CURRENT_LIABILITIES'
>;
const STATEMENT_METRICS: readonly StatementMetric[] = [
  'ANNUAL_REVENUE',
  'NET_PROFIT',
  'CURRENT_ASSETS',
  'CURRENT_LIABILITIES',
];

export interface StatementReadingPolicy {
  readonly policyRef: string;
  /** The document types whose tables are read. */
  readonly documentTypes: readonly string[];
  /** A table read with less confidence than this is skipped (per ten thousand: 9000 = 90%). */
  readonly minimumConfidencePerTenThousand: number;
  /** The row labels that mean each metric, in each language the tenant's statements use. */
  readonly labels: Readonly<Record<StatementMetric, readonly string[]>>;
}

export interface StatementFigure {
  readonly metric: FinancialMetric;
  /** FY and the year the table states, e.g. FY2025. */
  readonly periodLabel: string;
  readonly minorUnits: bigint;
  /** Where it was read: page (from 1), the row label as printed, the cell text as printed. */
  readonly evidence: { readonly page: number; readonly label: string; readonly text: string };
}

export interface SkippedRow {
  readonly page: number;
  readonly label: string;
  readonly reason:
    'NO_YEAR_HEADER' | 'LOW_CONFIDENCE' | 'AMOUNT_UNREADABLE' | 'NEGATIVE_NOT_ALLOWED' | 'CONFLICTING_VALUES';
}

export interface StatementReading {
  readonly figures: readonly StatementFigure[];
  readonly skipped: readonly SkippedRow[];
}

const fail = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);

export function parseStatementReadingPolicy(raw: unknown): Result<StatementReadingPolicy> {
  if (typeof raw !== 'object' || raw === null)
    return fail('STATEMENT_POLICY_INVALID', 'The statement-reading policy is not an object');
  const p = raw as Record<string, unknown>;
  const conf = p['minimumConfidencePerTenThousand'];
  if (typeof conf !== 'number' || !Number.isInteger(conf) || conf < 5000 || conf > 10000)
    return fail('STATEMENT_POLICY_INVALID', 'minimumConfidencePerTenThousand is an integer from 5000 to 10000');
  const types = p['documentTypes'];
  if (
    !Array.isArray(types) ||
    types.length === 0 ||
    !types.every((t) => typeof t === 'string' && /^[A-Z0-9_]{2,64}$/.test(t))
  )
    return fail('STATEMENT_POLICY_INVALID', 'documentTypes lists the document types read');
  const labels = p['labels'];
  if (typeof labels !== 'object' || labels === null)
    return fail('STATEMENT_POLICY_INVALID', 'labels maps each metric to its row labels');
  const out: Partial<Record<StatementMetric, readonly string[]>> = {};
  for (const m of STATEMENT_METRICS) {
    const ls = (labels as Record<string, unknown>)[m];
    if (
      !Array.isArray(ls) ||
      ls.length === 0 ||
      !ls.every((l) => typeof l === 'string' && normaliseLabel(l).length > 0)
    )
      return fail('STATEMENT_POLICY_INVALID', `labels.${m} lists at least one row label`);
    out[m] = ls.map((l: string) => normaliseLabel(l));
  }
  const seen = new Map<string, StatementMetric>();
  for (const m of STATEMENT_METRICS)
    for (const l of out[m] ?? []) {
      if (seen.has(l) && seen.get(l) !== m)
        return fail('STATEMENT_POLICY_INVALID', `The label "${l}" means two metrics`);
      seen.set(l, m);
    }
  if (typeof p['policyRef'] !== 'string' || p['policyRef'].length === 0)
    return fail('STATEMENT_POLICY_INVALID', 'policyRef names where the policy comes from');
  return ok({
    policyRef: p['policyRef'],
    documentTypes: types as string[],
    minimumConfidencePerTenThousand: conf,
    labels: out as Record<StatementMetric, readonly string[]>,
  });
}

const ARABIC_DIGITS = /[٠-٩]/g;
const asciiDigits = (s: string) => s.replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660));

/** Lower case, single spaces, no trailing colon or "(note 5)", no thousands separators in Arabic text. */
export function normaliseLabel(s: string): string {
  return asciiDigits(s)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\(\s*(?:note|notes|إيضاح)\s*\d+\s*\)/g, '')
    .replace(/[:：]\s*$/, '')
    .trim();
}

/** An amount as printed, in minor units (two decimals), or undefined when it is not plainly one. */
export function parseStatementAmount(printed: string): bigint | undefined {
  const s = asciiDigits(printed).replace(/٬/g, ',').replace(/٫/g, '.').replace(/\s+/g, '');
  const m = /^(\()?(-)?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?(\))?$/.exec(s);
  if (m === null) return undefined;
  const [, open, minus, whole, fraction, close] = m;
  if ((open === undefined) !== (close === undefined) || (open !== undefined && minus !== undefined)) return undefined;
  const units = BigInt((whole ?? '').replace(/,/g, '')) * 100n + BigInt((fraction ?? '').padEnd(2, '0'));
  return open !== undefined || minus !== undefined ? -units : units;
}

/** A statement presented in thousands or millions: refused whole. */
const SCALED =
  /(?:['’‘]\s?000\b|\bin\s+(?:thousands|millions)\b|\bthousands?\s+of\b|\bmillions?\s+of\b|بالآلاف|بالملايين)/i;

const YEAR = /^(?:19|20)\d{2}$/;

export function readStatementFigures(
  content: ExtractedContent,
  policy: StatementReadingPolicy,
): Result<StatementReading> {
  if (content.pages.some((p) => SCALED.test(asciiDigits(p.plainText))))
    return fail(
      'STATEMENT_SCALE_NOT_UNITS',
      'The statement is presented in thousands or millions; key its figures by hand',
    );
  const byLabel = new Map<string, StatementMetric>();
  for (const m of STATEMENT_METRICS) for (const l of policy.labels[m]) byLabel.set(l, m);

  const candidates = new Map<string, StatementFigure[]>();
  const skipped: SkippedRow[] = [];
  content.pages.forEach((page, pageIndex) => {
    for (const table of page.tables) {
      const cell = new Map(table.cells.map((c) => [`${c.row}:${c.column}`, asciiDigits(c.text).trim()]));
      const rows = [...new Set(table.cells.map((c) => c.row))].sort((a, b) => a - b);
      const columns = [...new Set(table.cells.map((c) => c.column))].filter((c) => c > 0).sort((a, b) => a - b);
      // The year each value column is under: the first row whose filled value cells are all years.
      const yearRow = rows.find((r) => {
        const filled = columns.map((c) => cell.get(`${r}:${c}`) ?? '').filter((t) => t.length > 0);
        return filled.length > 0 && filled.every((t) => YEAR.test(t));
      });
      const matched = rows.flatMap((r) => {
        const label = cell.get(`${r}:0`) ?? '';
        const metric = byLabel.get(normaliseLabel(label));
        return metric === undefined ? [] : [{ r, label, metric }];
      });
      if (matched.length === 0) continue;
      if (yearRow === undefined) {
        for (const x of matched) skipped.push({ page: pageIndex + 1, label: x.label, reason: 'NO_YEAR_HEADER' });
        continue;
      }
      if (table.confidencePerTenThousand < policy.minimumConfidencePerTenThousand) {
        for (const x of matched) skipped.push({ page: pageIndex + 1, label: x.label, reason: 'LOW_CONFIDENCE' });
        continue;
      }
      const years = new Map(
        columns.flatMap((c) => {
          const t = cell.get(`${yearRow}:${c}`) ?? '';
          return YEAR.test(t) ? [[c, Number(t)] as const] : [];
        }),
      );
      const latest = Math.max(...years.values());
      for (const { r, label, metric } of matched) {
        for (const [column, year] of years) {
          const wanted: FinancialMetric | undefined =
            year === latest
              ? metric
              : metric === 'ANNUAL_REVENUE' && year === latest - 1
                ? 'PRIOR_YEAR_REVENUE'
                : undefined;
          if (wanted === undefined) continue;
          const text = cell.get(`${r}:${column}`) ?? '';
          const minorUnits = parseStatementAmount(text);
          if (minorUnits === undefined) {
            skipped.push({ page: pageIndex + 1, label, reason: 'AMOUNT_UNREADABLE' });
            continue;
          }
          if (minorUnits < 0n && wanted !== 'NET_PROFIT') {
            skipped.push({ page: pageIndex + 1, label, reason: 'NEGATIVE_NOT_ALLOWED' });
            continue;
          }
          const key = `${wanted}|FY${year}`;
          candidates.set(key, [
            ...(candidates.get(key) ?? []),
            { metric: wanted, periodLabel: `FY${year}`, minorUnits, evidence: { page: pageIndex + 1, label, text } },
          ]);
        }
      }
    }
  });

  const figures: StatementFigure[] = [];
  for (const found of candidates.values()) {
    const first = found[0];
    if (first === undefined) continue;
    if (found.every((f) => f.minorUnits === first.minorUnits)) figures.push(first);
    else
      for (const f of found)
        skipped.push({ page: f.evidence.page, label: f.evidence.label, reason: 'CONFLICTING_VALUES' });
  }
  return ok({ figures, skipped });
}
