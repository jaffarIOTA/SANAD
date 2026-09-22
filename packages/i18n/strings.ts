/**
 * Copy.
 *
 * Authored in Arabic and translated to English, not the other way round, so
 * that neither reads like a translation (FP-01). Legal and Shariah terms use
 * the register the Board and the courts use rather than a plain-language
 * paraphrase (SDD §7.5).
 *
 * Decline and block wording is *not* here. That comes from the credit policy
 * and from the control catalogue, because a refusal is a regulated
 * communication the institution authors and approves, not a string a developer
 * writes (BR-C04, RC-11).
 */

export type Locale = 'ar-SA' | 'en-SA';

export interface Strings {
  readonly appName: string;
  readonly availableLimit: string;
  readonly chooseTheTrade: string;
  readonly chooseTheTradeHelp: string;
  readonly invoice: string;
  readonly availableForFinance: string;
  readonly alreadyFinanced: string;
  readonly cost: string;
  readonly profit: string;
  readonly total: string;
  readonly murabahaOffer: string;
  readonly maturityDate: string;
  readonly readContract: string;
  readonly disclosureNote: string;
  readonly blockedBy: string;
  readonly noTradesTitle: string;
  readonly noTradesBody: string;
  readonly back: string;
}

const ar: Strings = {
  appName: 'وصل',
  availableLimit: 'الحد المتاح',
  chooseTheTrade: 'اختر الفاتورة',
  chooseTheTradeHelp:
    'يبدأ التمويل من صفقة حقيقية. اختر فاتورة صادرة عنك ومعتمدة لدى هيئة الفوترة.',
  invoice: 'فاتورة',
  availableForFinance: 'متاحة للتمويل',
  alreadyFinanced: 'مموّلة مسبقًا',
  cost: 'التكلفة',
  profit: 'الربح',
  total: 'الإجمالي',
  murabahaOffer: 'عرض المرابحة',
  maturityDate: 'تاريخ الاستحقاق',
  readContract: 'اقرأ العقد ومتابعة',
  disclosureNote: 'الإجمالي ثابت ولا يتغيّر بعد التوقيع.',
  blockedBy: 'الضابط',
  noTradesTitle: 'لا توجد فواتير متاحة حاليًا',
  noTradesBody: 'ستظهر هنا الفواتير المعتمدة لدى هيئة الفوترة والقابلة للتمويل.',
  back: 'رجوع',
};

const en: Strings = {
  appName: 'Wasl',
  availableLimit: 'Available limit',
  chooseTheTrade: 'Choose the invoice',
  chooseTheTradeHelp:
    'Finance starts from a real trade. Choose an invoice you issued that has cleared with the e-invoicing authority.',
  invoice: 'Invoice',
  availableForFinance: 'Available for finance',
  alreadyFinanced: 'Already financed',
  cost: 'Cost',
  profit: 'Profit',
  total: 'Total',
  murabahaOffer: 'Murabaha offer',
  maturityDate: 'Maturity date',
  readContract: 'Read the contract and continue',
  disclosureNote: 'The total is fixed and does not change after signing.',
  blockedBy: 'Control',
  noTradesTitle: 'No invoices are available yet',
  noTradesBody:
    'Invoices that have cleared with the e-invoicing authority and can be financed will appear here.',
  back: 'Back',
};

export const STRINGS: Readonly<Record<Locale, Strings>> = { 'ar-SA': ar, 'en-SA': en };

export const isRtl = (locale: Locale): boolean => locale === 'ar-SA';
export const htmlLang = (locale: Locale): string => (locale === 'ar-SA' ? 'ar' : 'en');

/**
 * URL segments.
 *
 * Both languages are routes, not a toggle over one route. English is a mirror
 * of the Arabic rather than an afterthought on top of it, and giving each its
 * own URL is what makes "complete parity of content" (NFR-07) something you
 * can actually check — you can open both and compare.
 *
 * Arabic is first in this list, and it is the default anything unrecognised
 * resolves to.
 */
export const LOCALE_SEGMENTS = ['ar', 'en'] as const;
export type LocaleSegment = (typeof LOCALE_SEGMENTS)[number];

export const DEFAULT_SEGMENT: LocaleSegment = 'ar';

export function localeFromSegment(segment: string): Locale | undefined {
  if (segment === 'ar') return 'ar-SA';
  if (segment === 'en') return 'en-SA';
  return undefined;
}

export const segmentFromLocale = (locale: Locale): LocaleSegment =>
  locale === 'ar-SA' ? 'ar' : 'en';

/** The other language, for the switch in the header. */
export const otherSegment = (segment: LocaleSegment): LocaleSegment =>
  segment === 'ar' ? 'en' : 'ar';

/** Always written in its own language, never translated (العربية, not "Arabic"). */
export const LANGUAGE_NAME: Readonly<Record<LocaleSegment, string>> = {
  ar: 'العربية',
  en: 'English',
};
