import { describe, expect, it } from 'vitest';

import {
  type OfferLetterInput,
  buildOfferLetter,
  containsIdentityPattern,
  displayVersion,
  formatMoney,
  formatPerTenThousand,
  offerLetterVersion,
} from '../../core/documents/offer-letter.ts';
import { money } from '../../core/kernel/money.ts';
import { expectOk } from '../../core/kernel/result.ts';
import {
  SIGNING_LINK_PLACEHOLDER,
  buildOfferNotifications,
  isMaskedEmail,
  isMaskedMobile,
  previewOfferNotifications,
} from '../../core/notifications/offer-notification.ts';

const aed = (minor: bigint) => money(minor, 'AED');
const sar = (minor: bigint) => money(minor, 'SAR');

// Illustrative figures only; the schedule totals come from the product module's quote.
const aeConventional: OfferLetterInput = {
  jurisdiction: { code: 'AE', contractualCalendars: ['GREGORIAN'] },
  applicationReference: 'APP-2026-000417',
  applicantBusinessName: { en: 'Example Trading LLC', ar: 'مثال للتجارة ذ.م.م' },
  productVariantName: { en: 'SME Term Finance', ar: 'تمويل المنشآت لأجل' },
  family: 'CONVENTIONAL',
  facilityAmount: aed(200_000_000n),
  tenorMonths: 60,
  graceMonths: 6,
  rateBp: 150n,
  equityContributionPerTenThousand: 2_000n,
  offerDate: '2026-10-08',
  validUntil: '2026-11-07',
  totals: { instalment: aed(3_782_000n), totalCharge: aed(4_228_000n), totalPayable: aed(204_228_000n) },
  institutionLegalName: { en: 'Example SME Development Fund', ar: 'صندوق مثال لتنمية المشاريع' },
  signatories: [
    { party: 'LENDER', role: { en: 'Authorised Signatory', ar: 'المفوض بالتوقيع' } },
    { party: 'BORROWER', role: { en: 'Authorised Signatory', ar: 'المفوض بالتوقيع' } },
  ],
  conditions: [{ en: 'Trade licence valid at drawdown.', ar: 'رخصة تجارية سارية عند السحب.' }],
};

const saIslamic: OfferLetterInput = {
  ...aeConventional,
  jurisdiction: { code: 'SA', contractualCalendars: ['GREGORIAN', 'HIJRI'] },
  family: 'ISLAMIC',
  productVariantName: { en: 'SME Tawarruq Finance', ar: 'تمويل المنشآت بالتورق' },
  facilityAmount: sar(200_000_000n),
  totals: { instalment: sar(3_782_000n), totalCharge: sar(4_228_000n), totalPayable: sar(204_228_000n) },
};

const hijri = (iso: string): string => `hijri(${iso})`;
const all = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

describe('formatting is integer arithmetic over minor units', () => {
  it('formats money with the currency code and two decimals', () => {
    expect(formatMoney(aed(200_000_000n))).toBe('AED 2,000,000.00');
    expect(formatMoney(sar(5n))).toBe('SAR 0.05');
    expect(formatMoney(aed(123_456_789n))).toBe('AED 1,234,567.89');
  });
  it('formats basis points for display', () => {
    expect(formatPerTenThousand(150n)).toBe('1.50%');
    expect(formatPerTenThousand(2_000n)).toBe('20.00%');
    expect(formatPerTenThousand(5n)).toBe('0.05%');
  });
});

describe('the Facility Offer Letter', () => {
  it('AE conventional: AED 2,000,000 over 60 months at 150 bp shows Interest rate and no Hijri date', () => {
    const letter = expectOk(buildOfferLetter(aeConventional));
    const rate = letter.terms.find((r) => r.code === 'RATE');
    expect(rate?.label).toEqual({ en: 'Interest rate', ar: 'معدل الفائدة' });
    expect(rate?.value.en).toBe('1.50% per annum');
    expect(letter.terms.find((r) => r.code === 'FACILITY_AMOUNT')?.value.en).toBe('AED 2,000,000.00');
    expect(letter.terms.find((r) => r.code === 'TENOR')?.value.en).toBe('60 months');
    expect(letter.repayment.find((r) => r.code === 'TOTAL_CHARGE')?.label.en).toBe('Total interest');
    expect(letter.offerDate.hijri).toBeUndefined();
    expect(letter.validUntil.hijri).toBeUndefined();
    expect(letter.offerDate.gregorian).toEqual({ en: '8 October 2026', ar: '٨ أكتوبر ٢٠٢٦' });
    expect(letter.calendars).toEqual(['GREGORIAN']);
    expect(letter.currency).toBe('AED');
    expect(all(letter)).not.toMatch(/profit|الربح/i);
  });

  it('SA Islamic: shows Profit rate and both calendars', () => {
    const letter = expectOk(buildOfferLetter(saIslamic, hijri));
    expect(letter.terms.find((r) => r.code === 'RATE')?.label).toEqual({ en: 'Profit rate', ar: 'معدل الربح' });
    expect(letter.repayment.find((r) => r.code === 'TOTAL_CHARGE')?.label.en).toBe('Total profit');
    expect(letter.offerDate.hijri).toBe('hijri(2026-10-08)');
    expect(letter.validUntil.hijri).toBe('hijri(2026-11-07)');
    expect(letter.offerDate.gregorian.en).toBe('8 October 2026');
    expect(letter.validity.ar).toContain('hijri(2026-11-07)');
    expect(all(letter)).not.toMatch(/interest|الفائدة/i);
  });

  it('refuses an SA letter with no Hijri formatter rather than inventing a conversion', () => {
    const r = buildOfferLetter(saIslamic);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('FOL_HIJRI_FORMATTER');
  });

  it('carries parties, conditions and signature blocks by role only', () => {
    const letter = expectOk(buildOfferLetter(aeConventional));
    expect(letter.title.en).toBe('Facility Offer Letter');
    expect(letter.parties.lender.en).toBe('Example SME Development Fund');
    expect(letter.signatures.map((s) => s.party)).toEqual(['LENDER', 'BORROWER']);
    expect(letter.signatures[1]?.partyName.en).toBe('Example Trading LLC');
    expect(letter.conditions.length).toBe(4); // given + validity + equity + grace
    expect(letter.repayment.find((r) => r.code === 'INSTALMENT_COUNT')?.value.en).toBe('54');
  });

  it('refuses inconsistent or malformed terms', () => {
    const cases: [Partial<OfferLetterInput>, string][] = [
      [{ totals: { ...aeConventional.totals, totalPayable: aed(1n) } }, 'FOL_TOTALS_INCONSISTENT'],
      [{ totals: { ...aeConventional.totals, instalment: sar(3_782_000n) } }, 'FOL_CURRENCY_MIXED'],
      [{ validUntil: '2026-10-01' }, 'FOL_VALIDITY'],
      [{ offerDate: '2026-02-30' }, 'FOL_DATE'],
      [{ graceMonths: 60 }, 'FOL_GRACE'],
      [{ equityContributionPerTenThousand: 10_001n }, 'FOL_EQUITY'],
      [{ signatories: [{ party: 'LENDER', role: { en: 'Signatory', ar: 'المفوض' } }] }, 'FOL_SIGNATORIES'],
      [{ conditions: [{ en: 'Holder 784199012345671 to sign', ar: 'x' }] }, 'FOL_IDENTITY_NUMBER'],
    ];
    for (const [patch, reason] of cases) {
      const r = buildOfferLetter({ ...aeConventional, ...patch });
      expect(r.ok, reason).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe(reason);
    }
  });
});

const LATIN_DIGIT = /[0-9]/;
const ARABIC_INDIC_DIGIT = /[٠-٩]/;

describe('numerals: Arabic-Indic in the Arabic parts, Latin in the English parts', () => {
  const letter = expectOk(buildOfferLetter(aeConventional));
  const rows = [...letter.terms, ...letter.repayment];

  it('writes every Arabic quantity in Arabic-Indic digits, and every English one in Latin digits', () => {
    for (const r of rows) {
      expect(r.value.ar, r.code).not.toMatch(LATIN_DIGIT);
      expect(r.value.en, r.code).not.toMatch(ARABIC_INDIC_DIGIT);
    }
    expect(letter.terms.find((r) => r.code === 'FACILITY_AMOUNT')?.value).toEqual({ en: 'AED 2,000,000.00', ar: '٢٬٠٠٠٬٠٠٠٫٠٠ درهم إماراتي' });
    expect(letter.terms.find((r) => r.code === 'TENOR')?.value.ar).toBe('٦٠ شهرًا');
    expect(letter.terms.find((r) => r.code === 'GRACE_PERIOD')?.value.ar).toBe('٦ أشهر');
    expect(letter.terms.find((r) => r.code === 'RATE')?.value.ar).toBe('١٫٥٠٪ سنويًا');
    expect(letter.terms.find((r) => r.code === 'EQUITY_CONTRIBUTION')?.value.ar).toBe('٢٠٫٠٠٪');
    expect(letter.repayment.find((r) => r.code === 'INSTALMENT_COUNT')?.value.ar).toBe('٥٤');
    expect(letter.validity.ar).toBe('ساري حتى ٧ نوفمبر ٢٠٢٦');
    for (const c of letter.conditions) {
      expect(c.ar).not.toMatch(LATIN_DIGIT);
      expect(c.en).not.toMatch(ARABIC_INDIC_DIGIT);
    }
  });

  it('keeps the identifiers Latin', () => {
    expect(letter.reference).toBe('APP-2026-000417');
    expect(letter.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the Arabic digits are part of the hashed content', () => {
    const { version, ...content } = letter;
    const latinised = { ...content, terms: content.terms.map((r) => ({ ...r, value: { ...r.value, ar: r.value.en } })) };
    expect(offerLetterVersion(latinised)).not.toBe(version);
  });

  it('still refuses an identity number written in Arabic-Indic digits', () => {
    expect(containsIdentityPattern('١٠١٢٣٤٥٦٧٨')).toBe(true);
    expect(containsIdentityPattern('٧٨٤-١٩٩٠-١٢٣٤٥٦٧-١')).toBe(true);
    expect(containsIdentityPattern('٢٬٠٠٠٬٠٠٠٫٠٠ درهم إماراتي')).toBe(false);
    const r = buildOfferLetter({ ...aeConventional, conditions: [{ en: 'Owner to sign', ar: 'يوقّع المالك ٧٨٤١٩٩٠١٢٣٤٥٦٧١' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('FOL_IDENTITY_NUMBER');
  });
});

describe('the APR line', () => {
  it('is absent when no APR is passed in', () => {
    const letter = expectOk(buildOfferLetter(aeConventional));
    expect(letter.terms.find((r) => r.code === 'APR')).toBeUndefined();
  });

  it('shows the APR the platform computed, labelled, in both numerals, right after the rate', () => {
    const letter = expectOk(buildOfferLetter({ ...aeConventional, aprBp: 163n }));
    const codes = letter.terms.map((r) => r.code);
    expect(codes.indexOf('APR')).toBe(codes.indexOf('RATE') + 1);
    expect(letter.terms.find((r) => r.code === 'APR')).toEqual({ code: 'APR', label: { en: 'Annual percentage rate (APR)', ar: 'معدل النسبة السنوي' }, value: { en: '1.63%', ar: '١٫٦٣٪' } });
    expect(letter.version).not.toBe(expectOk(buildOfferLetter(aeConventional)).version);
  });

  it('refuses a negative APR', () => {
    const r = buildOfferLetter({ ...aeConventional, aprBp: -1n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('FOL_APR');
  });
});

describe('the letter version is a content hash', () => {
  const base = expectOk(buildOfferLetter(aeConventional)).version;

  it('is a sha256 hex digest and stable when nothing changes', () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(expectOk(buildOfferLetter({ ...aeConventional })).version).toBe(base);
    const { version, ...content } = expectOk(buildOfferLetter(aeConventional));
    expect(offerLetterVersion(content)).toBe(version);
  });

  it('does not depend on key order', () => {
    const reordered = Object.fromEntries(Object.entries(aeConventional).reverse()) as unknown as OfferLetterInput;
    expect(expectOk(buildOfferLetter(reordered)).version).toBe(base);
  });

  it.each<[string, Partial<OfferLetterInput>]>([
    ['amount', { facilityAmount: aed(200_000_100n), totals: { ...aeConventional.totals, totalPayable: aed(204_228_100n) } }],
    ['tenor', { tenorMonths: 48 }],
    ['grace', { graceMonths: 3 }],
    ['rate', { rateBp: 151n }],
    ['equity', { equityContributionPerTenThousand: 2_500n }],
    ['offer date', { offerDate: '2026-10-09' }],
    ['valid until', { validUntil: '2026-11-08' }],
    ['instalment', { totals: { ...aeConventional.totals, instalment: aed(3_782_001n) } }],
    ['family', { family: 'ISLAMIC' }],
    ['reference', { applicationReference: 'APP-2026-000418' }],
    ['business name', { applicantBusinessName: { en: 'Other Trading LLC', ar: 'أخرى للتجارة' } }],
    ['condition', { conditions: [] }],
    ['signatory role', { signatories: [{ party: 'LENDER', role: { en: 'CEO', ar: 'الرئيس التنفيذي' } }, { party: 'BORROWER', role: { en: 'Owner', ar: 'المالك' } }] }],
  ])('changes when the %s changes', (_name, patch) => {
    expect(expectOk(buildOfferLetter({ ...aeConventional, ...patch })).version).not.toBe(base);
  });
});

describe('offer notifications', () => {
  const letter = expectOk(buildOfferLetter(aeConventional));
  const recipient = { partyRef: 'cp-0001', emailMasked: 'a***@example.com', mobileMasked: '+971 50 XXX XXXX' };

  it('the preview is exactly what would be sent', () => {
    expect(previewOfferNotifications(letter, recipient)).toEqual(buildOfferNotifications(letter, recipient));
  });

  it('email: English body with an Arabic summary, the version and the signing link placeholder', () => {
    const n = expectOk(previewOfferNotifications(letter, recipient));
    expect(n.letterVersion).toBe(letter.version);
    expect(n.email?.to).toBe('a***@example.com');
    expect(n.email?.subject).toContain('Facility Offer Letter');
    const body = n.email?.body ?? '';
    expect(body).toContain('AED 2,000,000.00');
    expect(body).toContain('Interest rate: 1.50% per annum');
    expect(body).toContain(SIGNING_LINK_PLACEHOLDER);
    expect(body).toContain(letter.version.slice(0, 8));
    expect(body.indexOf('Dear')).toBeLessThan(body.indexOf('ملخص بالعربية'));
  });

  it('SMS: Arabic first, then English; references the version; no identity-number pattern', () => {
    const n = expectOk(previewOfferNotifications(letter, recipient));
    const body = n.sms?.body ?? '';
    const [first, second] = body.split('\n');
    expect(first).toMatch(/[؀-ۿ]/);
    expect(second).toMatch(/^Example SME Development Fund: your facility offer/);
    expect(body).toContain(letter.version.slice(0, 8));
    expect(body).toContain(SIGNING_LINK_PLACEHOLDER);
    expect(body).not.toMatch(/\d{15}/);
    expect(body).not.toMatch(/784-?\d{4}-?\d{7}-?\d/);
    expect(n.sms?.to).toBe('+971 50 XXX XXXX');
  });

  it('Arabic lines write quantities in Arabic-Indic digits; English lines and the identifiers stay Latin', () => {
    const n = expectOk(previewOfferNotifications(letter, recipient));
    const [smsAr = '', smsEn = ''] = (n.sms?.body ?? '').split('\n');
    const ids = (s: string) => s.replace(letter.reference, '').replace(/[0-9a-f]{8}(-[0-9a-f]{8})*/g, '');
    expect(smsAr).toContain('٢٬٠٠٠٬٠٠٠٫٠٠ درهم إماراتي');
    expect(smsAr).toContain('٧ نوفمبر ٢٠٢٦');
    expect(smsAr).toContain(letter.reference);
    expect(ids(smsAr)).not.toMatch(LATIN_DIGIT);
    expect(smsEn).toContain('AED 2,000,000.00');
    expect(smsEn).not.toMatch(ARABIC_INDIC_DIGIT);
    const [english = '', arabic = ''] = (n.email?.body ?? '').split('— ملخص بالعربية —');
    expect(english).not.toMatch(ARABIC_INDIC_DIGIT);
    expect(arabic).toContain('٢٬٠٠٠٬٠٠٠٫٠٠ درهم إماراتي');
    expect(arabic).toContain('١٫٥٠٪ سنويًا');
    expect(arabic).toContain('٦٠ شهرًا');
    expect(arabic).toContain(displayVersion(letter.version));
    expect(ids(arabic)).not.toMatch(LATIN_DIGIT);
  });

  it('SA SMS carries both calendars', () => {
    const sa = expectOk(buildOfferLetter(saIslamic, hijri));
    const n = expectOk(previewOfferNotifications(sa, { partyRef: 'cp-2', mobileMasked: '+966 5X XXX XX34' }));
    expect(n.sms?.body).toContain('hijri(2026-11-07)');
    expect(n.email).toBeUndefined();
  });

  it('refuses an unmasked email or mobile', () => {
    for (const [patch, reason] of [
      [{ emailMasked: 'ahmed@example.com' }, 'OFFER_NOTICE_UNMASKED_EMAIL'],
      [{ mobileMasked: '+971 50 123 4567' }, 'OFFER_NOTICE_UNMASKED_MOBILE'],
    ] as const) {
      const r = previewOfferNotifications(letter, { ...recipient, ...patch });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe(reason);
    }
    expect(previewOfferNotifications(letter, { partyRef: 'cp-1' }).ok).toBe(false);
  });

  it('mask predicates', () => {
    expect(isMaskedEmail('a***@example.com')).toBe(true);
    expect(isMaskedEmail('ab***@example.com')).toBe(false);
    expect(isMaskedMobile('+971 50 XXX XXXX')).toBe(true);
    expect(isMaskedMobile('+971 501234567')).toBe(false);
    expect(containsIdentityPattern('784-1990-1234567-1')).toBe(true);
    expect(containsIdentityPattern('1012345678')).toBe(true);
    expect(containsIdentityPattern('AED 2,000,000.00')).toBe(false);
  });
});
