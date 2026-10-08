/**
 * The Facility Offer Letter (FOL).
 *
 * A pure builder: from the approved terms of a direct SME facility it produces
 * a structured, bilingual letter — title, parties, facility terms, repayment
 * summary, conditions, signature blocks and validity — and a content hash that
 * is the letter's version. The acceptance event records that version, so the
 * institution can show exactly which letter the applicant saw and signed.
 *
 * Nothing here is computed from a rate: the schedule totals arrive from the
 * product module's quote, the rate arrives as the approved snapshot in basis
 * points and is shown, never applied. Amounts are formatted from minor units
 * by integer arithmetic only.
 *
 * Dates are rendered in the jurisdiction's contractual calendars (ADR 0005):
 * Gregorian only where the profile says so, Gregorian and Hijri where Hijri is
 * also contractual. The platform does not convert calendars at render time
 * (a converted date can move between two renders); the Hijri string is
 * supplied by an injected formatter that reads the stored dual date.
 *
 * Numerals: the English parts are Latin; the Arabic parts write every
 * quantity — amounts, counts, rates, dates — in Arabic-Indic digits, with the
 * currency in words. The reference and the version hash are identifiers and
 * stay Latin in both. The digits are part of the content, so they are part of
 * the hash: a letter is the text the applicant reads.
 *
 * Signatories appear by role only. No personal name, no identity number and no
 * contact detail is ever part of the letter.
 */

import { createHash } from 'node:crypto';

import type { Calendar, JurisdictionCode } from '../jurisdiction/profile.ts';
import type { CurrencyCode, Money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { ProductFamily } from '../products/module.ts';

export interface BilingualText {
  readonly en: string;
  readonly ar: string;
}

/** Returns the stored Hijri rendering of a Gregorian ISO date (yyyy-mm-dd). */
export type HijriFormatter = (isoDate: string) => string;

export interface OfferLetterSignatory {
  readonly party: 'LENDER' | 'BORROWER';
  /** A role, never a person: 'Authorised Signatory', 'Head of Credit'. */
  readonly role: BilingualText;
}

export interface OfferLetterScheduleTotals {
  readonly instalment: Money;
  /** Total interest (conventional) or total profit (Islamic) over the tenor. */
  readonly totalCharge: Money;
  readonly totalPayable: Money;
}

export interface OfferLetterInput {
  readonly jurisdiction: {
    readonly code: JurisdictionCode;
    readonly contractualCalendars: readonly Calendar[];
  };
  readonly applicationReference: string;
  readonly applicantBusinessName: BilingualText;
  readonly productVariantName: BilingualText;
  readonly family: ProductFamily;
  readonly facilityAmount: Money;
  /** Counts of months, not amounts. */
  readonly tenorMonths: number;
  readonly graceMonths: number;
  /** The approved rate snapshot, in integer basis points. Shown, never applied here. */
  readonly rateBp: bigint;
  /**
   * The APR the platform computed for this offer (core/pricing/apr.ts), in
   * integer basis points. Passed in and shown as a labelled line; never
   * computed here. Absent, the letter carries no APR line.
   */
  readonly aprBp?: bigint;
  /** The applicant's own contribution, per ten thousand of the project cost. */
  readonly equityContributionPerTenThousand: bigint;
  /** ISO dates, yyyy-mm-dd. */
  readonly offerDate: string;
  readonly validUntil: string;
  readonly totals: OfferLetterScheduleTotals;
  readonly institutionLegalName: BilingualText;
  readonly signatories: readonly OfferLetterSignatory[];
  /** Conditions precedent from the approval, in both languages. */
  readonly conditions: readonly BilingualText[];
}

export interface LetterDate {
  readonly iso: string;
  readonly gregorian: BilingualText;
  /** Present only where the jurisdiction holds Hijri as a contractual calendar. */
  readonly hijri?: string;
}

export interface LetterRow {
  readonly code: string;
  readonly label: BilingualText;
  readonly value: BilingualText;
}

export interface OfferLetterContent {
  readonly jurisdiction: JurisdictionCode;
  readonly currency: CurrencyCode;
  readonly calendars: readonly Calendar[];
  readonly reference: string;
  readonly title: BilingualText;
  readonly parties: {
    readonly lender: BilingualText;
    readonly borrower: BilingualText;
  };
  readonly productVariant: BilingualText;
  readonly terms: readonly LetterRow[];
  readonly repayment: readonly LetterRow[];
  readonly conditions: readonly BilingualText[];
  readonly signatures: readonly {
    readonly party: 'LENDER' | 'BORROWER';
    readonly partyName: BilingualText;
    readonly role: BilingualText;
  }[];
  readonly offerDate: LetterDate;
  readonly validUntil: LetterDate;
  readonly validity: BilingualText;
}

export interface OfferLetter extends OfferLetterContent {
  /** sha256 (hex) of the canonical serialisation of the content. The acceptance records it. */
  readonly version: string;
}

// -- Formatting (integer arithmetic only) -------------------------------------

const groupThousands = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 200000000n AED → 'AED 2,000,000.00'. Two minor digits for both supported currencies. */
export function formatMoney(m: Money): string {
  const negative = m.minorUnits < 0n;
  const abs = negative ? -m.minorUnits : m.minorUnits;
  const whole = abs / 100n;
  const minor = (abs % 100n).toString().padStart(2, '0');
  return `${m.currency} ${negative ? '-' : ''}${groupThousands(whole.toString())}.${minor}`;
}

/** Per ten thousand (basis points) → '1.50%'. Display only. */
export function formatPerTenThousand(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}%`;
}

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;

/**
 * A quantity's Latin digits as Arabic-Indic, for the Arabic parts of the
 * letter and its notifications: the digits, a decimal point between two
 * digits (٫), a thousands comma between two digits (٬) and the percent sign
 * (٪). Quantities only — amounts, counts, rates, dates. Identifiers (the
 * reference, the version hash) are never passed through it and stay Latin.
 */
export function arabicIndic(s: string): string {
  return s
    .replace(/(\d)\.(?=\d)/g, '$1٫')
    .replace(/(\d),(?=\d)/g, '$1٬')
    .replace(/%/g, '٪')
    .replace(/\d/g, (d) => ARABIC_INDIC[Number(d)] ?? d);
}

/** Arabic-Indic (and extended Arabic-Indic) digits back to Latin, so a digit-run guard sees every script. */
function latinDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

const CURRENCY_AR: Readonly<Record<CurrencyCode, string>> = { AED: 'درهم إماراتي', SAR: 'ريال سعودي' };

/** 200000000n AED → '٢٬٠٠٠٬٠٠٠٫٠٠ درهم إماراتي': the Arabic part of a letter's amount. Integer arithmetic. */
export function formatMoneyAr(m: Money): string {
  const latin = formatMoney(m).slice(m.currency.length + 1);
  return `${arabicIndic(latin)} ${CURRENCY_AR[m.currency]}`;
}

const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const MONTHS_AR = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidIsoDate(iso: string): boolean {
  const m = ISO_DATE.exec(iso);
  if (m === null) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

function gregorian(iso: string): BilingualText {
  const m = ISO_DATE.exec(iso);
  const [year, month, day] = [m?.[1] ?? '', Number(m?.[2] ?? '1'), Number(m?.[3] ?? '1')];
  return {
    en: `${String(day)} ${MONTHS_EN[month - 1] ?? ''} ${year}`,
    ar: `${arabicIndic(String(day))} ${MONTHS_AR[month - 1] ?? ''} ${arabicIndic(year)}`,
  };
}

// -- Identity-pattern guard ---------------------------------------------------

/**
 * True where a text carries something shaped like a national identity number:
 * any run of ten or more digits (a Saudi national ID or Iqama is ten, a UAE
 * identity number fifteen), or the hyphenated 784- form. Used to refuse such a
 * value anywhere in a letter or a notification.
 */
export function containsIdentityPattern(text: string): boolean {
  // Arabic-Indic digits are digits too: an identity number written ١٠١٢٣٤٥٦٧٨ is still one.
  const latin = latinDigits(text);
  return /\d{10,}/.test(latin) || /\b784[- ]?\d{4}[- ]?\d{7}[- ]?\d\b/.test(latin);
}

// -- Canonical serialisation and the version ----------------------------------

function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** sha256 of the canonical serialisation: key order, whitespace and bigint encoding cannot change it. */
export function offerLetterVersion(content: OfferLetterContent): string {
  return createHash('sha256').update(canonical(content)).digest('hex');
}

/** The version as shown to a person: groups of eight, so no long digit run can appear. */
export function displayVersion(version: string, groups = 8): string {
  return (version.match(/.{1,8}/g) ?? []).slice(0, groups).join('-');
}

// -- Builder ------------------------------------------------------------------

const bad = (
  reason: string,
  detail: string,
  context?: Readonly<Record<string, string | number | boolean>>,
): Result<never> => reject('OP-DETERMINACY', reason, detail, context);

const nonEmpty = (t: BilingualText): boolean => t.en.trim().length > 0 && t.ar.trim().length > 0;

function rateLabel(family: ProductFamily): BilingualText {
  return family === 'ISLAMIC' ? { en: 'Profit rate', ar: 'معدل الربح' } : { en: 'Interest rate', ar: 'معدل الفائدة' };
}

function chargeLabel(family: ProductFamily): BilingualText {
  return family === 'ISLAMIC'
    ? { en: 'Total profit', ar: 'إجمالي الربح' }
    : { en: 'Total interest', ar: 'إجمالي الفائدة' };
}

/** A count of months: English Latin, Arabic in Arabic-Indic digits with the noun the count takes. */
function months(count: number): BilingualText {
  const n = arabicIndic(String(count));
  const ar = count === 1 ? 'شهر واحد' : count === 2 ? 'شهران' : count >= 3 && count <= 10 ? `${n} أشهر` : `${n} شهرًا`;
  return { en: `${String(count)} months`, ar };
}
/** A Latin quantity in English, the same quantity in Arabic-Indic digits in Arabic. */
const quantity = (text: string): BilingualText => ({ en: text, ar: arabicIndic(text) });
const amount = (m: Money): BilingualText => ({ en: formatMoney(m), ar: formatMoneyAr(m) });

function allTexts(input: OfferLetterInput): string[] {
  const b = (t: BilingualText): string[] => [t.en, t.ar];
  return [
    input.applicationReference,
    ...b(input.applicantBusinessName),
    ...b(input.productVariantName),
    ...b(input.institutionLegalName),
    ...input.signatories.flatMap((s) => b(s.role)),
    ...input.conditions.flatMap(b),
  ];
}

export function buildOfferLetter(input: OfferLetterInput, hijri?: HijriFormatter): Result<OfferLetter> {
  const currency = input.facilityAmount.currency;
  const calendars = input.jurisdiction.contractualCalendars;

  if (input.applicationReference.trim().length === 0)
    return bad('FOL_REFERENCE', 'The application reference is required');
  if (!nonEmpty(input.applicantBusinessName))
    return bad('FOL_BORROWER_NAME', 'The business name is required in both languages');
  if (!nonEmpty(input.productVariantName))
    return bad('FOL_PRODUCT_NAME', 'The product variant name is required in both languages');
  if (!nonEmpty(input.institutionLegalName))
    return bad('FOL_LENDER_NAME', 'The institution legal name is required in both languages');
  if (input.facilityAmount.minorUnits <= 0n) return bad('FOL_AMOUNT', 'The facility amount is positive');
  for (const [field, m] of [
    ['instalment', input.totals.instalment],
    ['totalCharge', input.totals.totalCharge],
    ['totalPayable', input.totals.totalPayable],
  ] as const) {
    if (m.currency !== currency)
      return bad('FOL_CURRENCY_MIXED', 'Every amount on the letter is in the facility currency', {
        field,
        expected: currency,
        given: m.currency,
      });
    if (m.minorUnits < 0n) return bad('FOL_TOTAL_NEGATIVE', 'Schedule totals are not negative', { field });
  }
  if (input.totals.totalPayable.minorUnits !== input.facilityAmount.minorUnits + input.totals.totalCharge.minorUnits) {
    return bad('FOL_TOTALS_INCONSISTENT', 'Total payable is the facility amount plus the total charge');
  }
  if (!Number.isInteger(input.tenorMonths) || input.tenorMonths <= 0)
    return bad('FOL_TENOR', 'The tenor is a positive whole number of months');
  if (!Number.isInteger(input.graceMonths) || input.graceMonths < 0 || input.graceMonths >= input.tenorMonths) {
    return bad('FOL_GRACE', 'The grace period is a whole number of months shorter than the tenor');
  }
  if (input.rateBp < 0n) return bad('FOL_RATE', 'The rate is not negative');
  if (input.aprBp !== undefined && input.aprBp < 0n) return bad('FOL_APR', 'The APR is not negative');
  if (input.equityContributionPerTenThousand < 0n || input.equityContributionPerTenThousand > 10_000n) {
    return bad('FOL_EQUITY', 'The equity contribution is between zero and ten thousand per ten thousand');
  }
  if (!isValidIsoDate(input.offerDate) || !isValidIsoDate(input.validUntil))
    return bad('FOL_DATE', 'Dates are ISO calendar dates (yyyy-mm-dd)');
  if (input.validUntil <= input.offerDate)
    return bad('FOL_VALIDITY', 'The offer is valid until a date after the offer date');
  if (!input.signatories.some((s) => s.party === 'LENDER') || !input.signatories.some((s) => s.party === 'BORROWER')) {
    return bad('FOL_SIGNATORIES', 'The letter carries at least one signature block for each party');
  }
  if (!input.signatories.every((s) => nonEmpty(s.role)))
    return bad('FOL_SIGNATORY_ROLE', 'Each signatory is named by role, in both languages');
  if (!input.conditions.every(nonEmpty)) return bad('FOL_CONDITION', 'Each condition is stated in both languages');
  if (allTexts(input).some(containsIdentityPattern)) {
    return bad('FOL_IDENTITY_NUMBER', 'An offer letter never carries an identity number');
  }

  const needsHijri = calendars.includes('HIJRI');
  if (needsHijri && hijri === undefined) {
    return bad('FOL_HIJRI_FORMATTER', 'The jurisdiction requires Hijri dates; a Hijri formatter is required', {
      jurisdiction: input.jurisdiction.code,
    });
  }
  const letterDate = (iso: string): LetterDate =>
    needsHijri && hijri !== undefined
      ? { iso, gregorian: gregorian(iso), hijri: hijri(iso) }
      : { iso, gregorian: gregorian(iso) };

  const offerDate = letterDate(input.offerDate);
  const validUntil = letterDate(input.validUntil);
  const lender = input.institutionLegalName;
  const borrower = input.applicantBusinessName;
  const rate = formatPerTenThousand(input.rateBp);

  const terms: LetterRow[] = [
    { code: 'PRODUCT', label: { en: 'Product', ar: 'المنتج' }, value: input.productVariantName },
    {
      code: 'FACILITY_AMOUNT',
      label: { en: 'Facility amount', ar: 'مبلغ التمويل' },
      value: amount(input.facilityAmount),
    },
    { code: 'TENOR', label: { en: 'Tenor', ar: 'مدة التمويل' }, value: months(input.tenorMonths) },
    { code: 'GRACE_PERIOD', label: { en: 'Grace period', ar: 'فترة السماح' }, value: months(input.graceMonths) },
    {
      code: 'RATE',
      label: rateLabel(input.family),
      value: { en: `${rate} per annum`, ar: `${arabicIndic(rate)} سنويًا` },
    },
    // The platform's APR, as computed by core/pricing/apr.ts and passed in — shown, never derived here.
    ...(input.aprBp === undefined
      ? []
      : [
          {
            code: 'APR',
            label: { en: 'Annual percentage rate (APR)', ar: 'معدل النسبة السنوي' },
            value: quantity(formatPerTenThousand(input.aprBp)),
          },
        ]),
    {
      code: 'EQUITY_CONTRIBUTION',
      label: { en: 'Equity contribution', ar: 'المساهمة الذاتية' },
      value: quantity(formatPerTenThousand(input.equityContributionPerTenThousand)),
    },
  ];

  const instalmentCount = input.tenorMonths - input.graceMonths;
  const repayment: LetterRow[] = [
    {
      code: 'INSTALMENT_COUNT',
      label: { en: 'Number of monthly instalments', ar: 'عدد الأقساط الشهرية' },
      value: quantity(String(instalmentCount)),
    },
    {
      code: 'INSTALMENT',
      label: { en: 'Monthly instalment', ar: 'القسط الشهري' },
      value: amount(input.totals.instalment),
    },
    { code: 'TOTAL_CHARGE', label: chargeLabel(input.family), value: amount(input.totals.totalCharge) },
    {
      code: 'TOTAL_PAYABLE',
      label: { en: 'Total amount payable', ar: 'إجمالي المبلغ المستحق' },
      value: amount(input.totals.totalPayable),
    },
  ];

  const standardConditions: BilingualText[] = [
    {
      en: `This offer must be accepted and signed by the Borrower on or before ${validUntil.gregorian.en}; after that date it lapses.`,
      ar: `يجب قبول هذا العرض وتوقيعه من المقترض في موعد أقصاه ${validUntil.gregorian.ar}${validUntil.hijri === undefined ? '' : ` (${validUntil.hijri})`}، وبعده يسقط العرض.`,
    },
  ];
  if (input.equityContributionPerTenThousand > 0n) {
    const share = formatPerTenThousand(input.equityContributionPerTenThousand);
    standardConditions.push({
      en: `The Borrower contributes ${share} of the project cost from its own funds before the first drawdown.`,
      ar: `يساهم المقترض بنسبة ${arabicIndic(share)} من تكلفة المشروع من موارده الذاتية قبل السحب الأول.`,
    });
  }
  if (input.graceMonths > 0) {
    standardConditions.push({
      en: `No principal instalment is due during the first ${String(input.graceMonths)} months.`,
      ar: `لا يستحق أي قسط من أصل التمويل خلال فترة السماح البالغة ${months(input.graceMonths).ar}.`,
    });
  }

  const content: OfferLetterContent = {
    jurisdiction: input.jurisdiction.code,
    currency,
    calendars: [...calendars],
    reference: input.applicationReference,
    title: { en: 'Facility Offer Letter', ar: 'خطاب عرض التمويل' },
    parties: { lender, borrower },
    productVariant: input.productVariantName,
    terms,
    repayment,
    conditions: [...input.conditions, ...standardConditions],
    signatures: input.signatories.map((s) => ({
      party: s.party,
      partyName: s.party === 'LENDER' ? lender : borrower,
      role: s.role,
    })),
    offerDate,
    validUntil,
    validity: {
      en: `Valid until ${validUntil.gregorian.en}`,
      ar: `ساري حتى ${validUntil.gregorian.ar}${validUntil.hijri === undefined ? '' : ` الموافق ${validUntil.hijri}`}`,
    },
  };

  return ok({ ...content, version: offerLetterVersion(content) });
}

/** The term row by code, for renderers and notifications. */
export function letterRow(letter: OfferLetterContent, code: string): LetterRow | undefined {
  return [...letter.terms, ...letter.repayment].find((r) => r.code === code);
}
