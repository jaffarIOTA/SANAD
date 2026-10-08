/**
 * Product variants of SME finance by Tawarruq: the named offerings a tenant
 * lists under one module (a small facility, working capital, fixed assets,
 * expansion…), each with its own ceiling, tenor band, grace (profit-only
 * instalments), owner contribution band, minimum years in operation,
 * purposes, document checklist and collateral.
 *
 * The module-level credit rule and guarantee apply to every variant; a
 * variant only narrows. Everything here is the tenant's configuration, and a
 * value the tenant has not confirmed says so in the variant's `note`.
 *
 * The same code exists in `sme-term-conventional/variants.ts`. It is written
 * again here rather than imported, because product modules are isolated from
 * each other; `test/compliance/sme-variants.test.ts` runs the same cases
 * against both and checks that the two bodies are identical.
 */

import { CURRENCY_CODES, type CurrencyCode, type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { QuoteRequest } from '@sanad/core/products/module.ts';

/** A coded item with its label in both languages: a purpose, a collateral requirement, a knock-out note. */
export interface VariantLabel {
  readonly code: string;
  readonly labelEn: string;
  readonly labelAr: string;
}

export interface SmeVariant {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly maxAmount: Money;
  readonly minMonths: number;
  readonly maxMonths: number;
  /** Interest-only (or profit-only) instalments allowed at the start. 0 = no grace. */
  readonly maxGraceMonths: number;
  /** The owner's own contribution to the project cost, per ten thousand. */
  readonly minContributionPerTenThousand: number;
  readonly maxContributionPerTenThousand: number;
  /** Whole years the enterprise has operated. 0 = no minimum. */
  readonly minYearsInOperation: number;
  readonly purposes: readonly VariantLabel[];
  /** The programme id of the variant's document checklist (config/loader.ts). Absent = the programme's own checklist applies. */
  readonly documentChecklistRef?: string;
  readonly collateral: readonly VariantLabel[];
  /** Knock-out rules shown to the officer and the applicant. Display only; the rules that decide are the credit rule's. */
  readonly knockOutNotes?: readonly VariantLabel[];
  /** Where a value is illustrative or still to be confirmed, the note says which and from what source. */
  readonly note?: string;
}

/** What the applicant chose, validated against the variant. */
export interface VariantChoice {
  readonly variant: SmeVariant;
  readonly months: number;
  readonly graceMonths: number;
  readonly contributionPerTenThousand: number;
  readonly purpose: VariantLabel;
  /** Present when the variant has a minimum, or when the request supplied it. */
  readonly yearsInOperation?: number;
  readonly disbursementDate: string;
  readonly firstDueDate: string;
  readonly paymentDay: number;
}

const VARIANT_KEYS = new Set([
  'code',
  'nameEn',
  'nameAr',
  'maxAmountMinorUnits',
  'minMonths',
  'maxMonths',
  'maxGraceMonths',
  'minContributionPerTenThousand',
  'maxContributionPerTenThousand',
  'minYearsInOperation',
  'purposes',
  'documentChecklistRef',
  'collateral',
  'knockOutNotes',
  'note',
]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isIntString = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const bad = (reason: string, detail: string, context?: Record<string, string>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

export function parseCurrency(raw: unknown): Result<CurrencyCode> {
  if (typeof raw !== 'string' || !(CURRENCY_CODES as readonly string[]).includes(raw))
    return bad('TERMS_CURRENCY', `currency is one of ${CURRENCY_CODES.join(', ')}`);
  return ok(raw as CurrencyCode);
}

function parseLabels(raw: unknown, where: string, allowEmpty: boolean): Result<readonly VariantLabel[]> {
  if (!Array.isArray(raw) || (!allowEmpty && raw.length === 0))
    return bad(
      'TERMS_VARIANT_LABELS',
      `${where} is a ${allowEmpty ? '' : 'non-empty '}list of { code, labelEn, labelAr }`,
      { where },
    );
  const seen = new Set<string>();
  const out: VariantLabel[] = [];
  for (const item of raw) {
    if (
      !isRecord(item) ||
      !isText(item['code']) ||
      !isText(item['labelEn']) ||
      !isText(item['labelAr']) ||
      Object.keys(item).some((k) => !['code', 'labelEn', 'labelAr'].includes(k))
    ) {
      return bad('TERMS_VARIANT_LABELS', `${where} items are { code, labelEn, labelAr }`, { where });
    }
    if (seen.has(item['code']))
      return bad('TERMS_VARIANT_LABEL_DUPLICATE', `${where} repeats a code`, { where, code: item['code'] });
    seen.add(item['code']);
    out.push({ code: item['code'], labelEn: item['labelEn'], labelAr: item['labelAr'] });
  }
  return ok(out);
}

function parseVariant(raw: unknown, index: number, currency: CurrencyCode, minAmount: Money): Result<SmeVariant> {
  const where = `variants[${String(index)}]`;
  if (!isRecord(raw)) return bad('TERMS_VARIANT_MALFORMED', `${where} is an object`, { where });
  const unknown = Object.keys(raw).filter((k) => !VARIANT_KEYS.has(k));
  if (unknown.length > 0)
    return bad('TERMS_VARIANT_UNKNOWN_KEY', `Unknown key in ${where}`, { where, keys: unknown.join(',') });
  if (!isText(raw['code']) || !/^[A-Z][A-Z0-9_]*$/.test(raw['code']))
    return bad('TERMS_VARIANT_CODE', `${where}.code is an upper-case code`, { where });
  if (!isText(raw['nameEn']) || !isText(raw['nameAr']))
    return bad('TERMS_VARIANT_NAME', `${where} is named in both languages`, { where });
  if (!isIntString(raw['maxAmountMinorUnits']))
    return bad('TERMS_VARIANT_AMOUNT', `${where}.maxAmountMinorUnits is an integer string`, { where });
  const maxAmount = money(BigInt(raw['maxAmountMinorUnits']), currency);
  if (maxAmount.minorUnits < minAmount.minorUnits)
    return bad('TERMS_VARIANT_AMOUNT', `${where}.maxAmountMinorUnits is at least the product minimum`, { where });
  const minMonths = raw['minMonths'];
  const maxMonths = raw['maxMonths'];
  if (!isPosInt(minMonths) || !isPosInt(maxMonths) || minMonths > maxMonths)
    return bad('TERMS_VARIANT_MONTHS', `${where}: minMonths ≤ maxMonths, both positive integers`, { where });
  const grace = raw['maxGraceMonths'];
  if (!isWhole(grace) || grace >= maxMonths)
    return bad('TERMS_VARIANT_GRACE', `${where}.maxGraceMonths is a whole number below maxMonths`, { where });
  const minC = raw['minContributionPerTenThousand'];
  const maxC = raw['maxContributionPerTenThousand'];
  if (!isWhole(minC) || !isWhole(maxC) || minC > maxC || maxC > 10_000)
    return bad(
      'TERMS_VARIANT_CONTRIBUTION',
      `${where}: 0 ≤ minContributionPerTenThousand ≤ maxContributionPerTenThousand ≤ 10000`,
      { where },
    );
  const years = raw['minYearsInOperation'];
  if (!isWhole(years)) return bad('TERMS_VARIANT_YEARS', `${where}.minYearsInOperation is a whole number`, { where });
  const purposes = parseLabels(raw['purposes'], `${where}.purposes`, false);
  if (!purposes.ok) return purposes;
  const collateral = parseLabels(raw['collateral'], `${where}.collateral`, true);
  if (!collateral.ok) return collateral;
  const notes =
    raw['knockOutNotes'] === undefined
      ? ok(undefined)
      : parseLabels(raw['knockOutNotes'], `${where}.knockOutNotes`, false);
  if (!notes.ok) return notes;
  if (raw['documentChecklistRef'] !== undefined && !isText(raw['documentChecklistRef']))
    return bad('TERMS_VARIANT_CHECKLIST', `${where}.documentChecklistRef names a programme checklist`, { where });
  if (raw['note'] !== undefined && !isText(raw['note']))
    return bad('TERMS_VARIANT_NOTE', `${where}.note is text`, { where });
  return ok({
    code: raw['code'],
    nameEn: raw['nameEn'],
    nameAr: raw['nameAr'],
    maxAmount,
    minMonths,
    maxMonths,
    maxGraceMonths: grace,
    minContributionPerTenThousand: minC,
    maxContributionPerTenThousand: maxC,
    minYearsInOperation: years,
    purposes: purposes.value,
    collateral: collateral.value,
    ...(raw['documentChecklistRef'] === undefined ? {} : { documentChecklistRef: raw['documentChecklistRef'] }),
    ...(notes.value === undefined ? {} : { knockOutNotes: notes.value }),
    ...(raw['note'] === undefined ? {} : { note: raw['note'] }),
  });
}

/** A non-empty list of variants with unique codes. */
export function parseVariants(raw: unknown, currency: CurrencyCode, minAmount: Money): Result<readonly SmeVariant[]> {
  if (!Array.isArray(raw) || raw.length === 0) return bad('TERMS_VARIANTS', 'variants is a non-empty list');
  const out: SmeVariant[] = [];
  const seen = new Set<string>();
  for (const [i, v] of raw.entries()) {
    const parsed = parseVariant(v, i, currency, minAmount);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.code))
      return bad('TERMS_VARIANT_DUPLICATE', 'Two variants share a code', { code: parsed.value.code });
    seen.add(parsed.value.code);
    out.push(parsed.value);
  }
  return ok(out);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A whole number from a preference string, or undefined when absent; `null` when present but malformed. */
function wholePreference(prefs: Readonly<Record<string, string>>, key: string): number | undefined | null {
  const v = prefs[key];
  if (v === undefined) return undefined;
  if (!/^\d{1,6}$/.test(v)) return null;
  return Number(v);
}

/**
 * The applicant's choices, from `QuoteRequest.preferences`, checked against
 * the chosen variant. Dates are never defaulted: an offer's schedule rests on
 * the dates the applicant and the institution agreed, so a quote without them
 * is refused.
 *
 * Preferences read: `variant`, `purpose`, `graceMonths` (absent = 0),
 * `contributionPerTenThousand` (absent = 0), `yearsInOperation` (required
 * when the variant has a minimum; the business facts do not carry it yet),
 * `disbursementDate` and `firstDueDate` (ISO, required), `paymentDay`
 * (absent = the first due date's day of month).
 */
export function chooseVariant(
  variants: readonly SmeVariant[],
  currency: CurrencyCode,
  request: QuoteRequest,
): Result<VariantChoice> {
  if (request.requestedAmount.currency !== currency) {
    return bad('CURRENCY_MISMATCH', 'The request is not in the currency of this term sheet', {
      requested: request.requestedAmount.currency,
      product: currency,
    });
  }
  const prefs = request.preferences ?? {};
  const code = prefs['variant'];
  if (code === undefined || code.length === 0)
    return bad('VARIANT_REQUIRED', 'Choose one of the product variants', {
      variants: variants.map((v) => v.code).join(','),
    });
  const variant = variants.find((v) => v.code === code);
  if (variant === undefined) return bad('VARIANT_UNKNOWN', 'No such variant of this product', { variant: code });
  const at = { variant: variant.code };

  if (request.requestedAmount.minorUnits > variant.maxAmount.minorUnits)
    return reject('OP-LIMIT', 'AMOUNT_EXCEEDS_VARIANT', 'Above the maximum for this variant', {
      ...at,
      max: String(variant.maxAmount.minorUnits),
    });
  const months = Math.round(request.requestedTenorDays / 30);
  if (months < variant.minMonths || months > variant.maxMonths)
    return bad('TENOR_OUTSIDE_VARIANT', 'Tenor outside what this variant allows', {
      ...at,
      months: String(months),
      min: String(variant.minMonths),
      max: String(variant.maxMonths),
    });

  const grace = wholePreference(prefs, 'graceMonths');
  if (grace === null) return bad('GRACE_MALFORMED', 'graceMonths is a whole number', at);
  const graceMonths = grace ?? 0;
  if (graceMonths > variant.maxGraceMonths)
    return reject('OP-LIMIT', 'GRACE_EXCEEDS_VARIANT', 'More grace than this variant allows', {
      ...at,
      max: String(variant.maxGraceMonths),
    });
  if (graceMonths >= months) return bad('GRACE_NOT_BELOW_TENOR', 'The grace period is shorter than the tenor', at);

  const contribution = wholePreference(prefs, 'contributionPerTenThousand');
  if (contribution === null || (contribution !== undefined && contribution > 10_000))
    return bad('CONTRIBUTION_MALFORMED', 'contributionPerTenThousand is a whole number in [0, 10000]', at);
  const contributionPerTenThousand = contribution ?? 0;
  if (
    contributionPerTenThousand < variant.minContributionPerTenThousand ||
    contributionPerTenThousand > variant.maxContributionPerTenThousand
  ) {
    return reject(
      'OP-LIMIT',
      'CONTRIBUTION_OUTSIDE_VARIANT',
      'The owner’s contribution is outside the band this variant requires',
      { ...at, min: String(variant.minContributionPerTenThousand), max: String(variant.maxContributionPerTenThousand) },
    );
  }

  const years = wholePreference(prefs, 'yearsInOperation');
  if (years === null) return bad('YEARS_IN_OPERATION_MALFORMED', 'yearsInOperation is a whole number', at);
  if (variant.minYearsInOperation > 0) {
    if (years === undefined)
      return bad(
        'YEARS_IN_OPERATION_REQUIRED',
        'This variant has a minimum time in operation; the enterprise’s years in operation are required',
        at,
      );
    if (years < variant.minYearsInOperation)
      return reject(
        'OP-LIMIT',
        'YEARS_IN_OPERATION_BELOW_VARIANT',
        'The enterprise has not operated long enough for this variant',
        { ...at, min: String(variant.minYearsInOperation) },
      );
  }

  const purposeCode = prefs['purpose'];
  if (purposeCode === undefined || purposeCode.length === 0)
    return bad('PURPOSE_REQUIRED', 'State the purpose of the financing', {
      ...at,
      purposes: variant.purposes.map((p) => p.code).join(','),
    });
  const purpose = variant.purposes.find((p) => p.code === purposeCode);
  if (purpose === undefined)
    return reject('OP-LIMIT', 'PURPOSE_NOT_ALLOWED', 'This variant does not finance that purpose', {
      ...at,
      purpose: purposeCode,
    });

  const disbursementDate = prefs['disbursementDate'];
  if (disbursementDate === undefined)
    return bad('DISBURSEMENT_DATE_REQUIRED', 'The schedule is dated: the disbursement date is required', at);
  const firstDueDate = prefs['firstDueDate'];
  if (firstDueDate === undefined)
    return bad('FIRST_DUE_DATE_REQUIRED', 'The schedule is dated: the first due date is required', at);
  if (!ISO_DATE.test(disbursementDate) || !ISO_DATE.test(firstDueDate))
    return bad('DATE_MALFORMED', 'Dates are ISO calendar dates, YYYY-MM-DD', at);
  const day = wholePreference(prefs, 'paymentDay');
  if (day === null || (day !== undefined && (day < 1 || day > 31)))
    return bad('PAYMENT_DAY_MALFORMED', 'paymentDay is a day of the month, 1 to 31', at);
  const paymentDay = day ?? Number(firstDueDate.slice(8, 10));

  return ok({
    variant,
    months,
    graceMonths,
    contributionPerTenThousand,
    purpose,
    ...(years === undefined ? {} : { yearsInOperation: years }),
    disbursementDate,
    firstDueDate,
    paymentDay,
  });
}
