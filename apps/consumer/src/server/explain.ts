/** Refusals as the applicant should read them: specific, respectful, in their language. */
const EXPLANATIONS: Readonly<Record<string, { readonly ar: string; readonly en: string }>> = {
  DEDUCTION_RATIO_EXCEEDED: {
    ar: 'القسط الشهري لهذا المبلغ يتجاوز النسبة المسموح بها من دخلك وفق قواعد الإقراض المسؤول. جرّب مبلغاً أقل أو مدة أطول.',
    en: 'The monthly instalment for this amount would exceed the share of your income the responsible-lending rules allow. Try a smaller amount or a longer term.',
  },
  AMOUNT_EXCEEDS_PRODUCT: {
    ar: 'المبلغ المطلوب أعلى من الحد الأقصى لهذا المنتج.',
    en: 'The amount requested is above this product’s maximum.',
  },
  TENOR_OUTSIDE_PRODUCT: {
    ar: 'المدة المطلوبة خارج نطاق هذا المنتج.',
    en: 'The term requested is outside what this product allows.',
  },
  BNPL_CONSUMER_LIMIT_EXCEEDED: {
    ar: 'هذا الشراء يتجاوز الحد المسموح به للعميل في منتجات اشترِ الآن وادفع لاحقاً.',
    en: 'This purchase would take you over the buy-now-pay-later limit.',
  },
  BENCHMARK_UNAVAILABLE: {
    ar: 'تعذّر الحصول على المؤشر الذي يُسعَّر منه هذا المنتج الآن. لن نقدّم عرضاً بسعر قديم؛ حاول لاحقاً.',
    en: 'The benchmark this product is priced from is not available right now. We will not quote on a stale rate; please try again later.',
  },
  OFFER_EXPIRED: { ar: 'انتهت صلاحية هذا العرض. اطلب عرضاً جديداً.', en: 'This offer has expired. Ask for a new one.' },
  OFFER_ALREADY_ACCEPTED: { ar: 'تم قبول هذا العرض من قبل.', en: 'This offer has already been accepted.' },
  DISCLOSURE_VERSION_MISMATCH: {
    ar: 'تغيّر الإفصاح منذ عرضه عليك. اقرأه مرة أخرى قبل القبول.',
    en: 'The disclosure changed since it was shown to you. Read it again before accepting.',
  },
  CONFIRMATION_REQUIRED: {
    ar: 'يلزم تأكيد قراءة الإفصاح قبل القبول.',
    en: 'Please confirm you have read the disclosure before accepting.',
  },
  IDENTITY_UNAVAILABLE: {
    ar: 'خدمة الهوية الوطنية غير متاحة الآن. حاول لاحقاً.',
    en: 'The national identity service is not available right now. Please try again later.',
  },
  APPLICANT_REF_MALFORMED: {
    ar: 'أدخل مرجع المتقدّم بالصيغة الصحيحة.',
    en: 'Enter the applicant reference in the expected form.',
  },
  AMOUNT_NOT_POSITIVE: { ar: 'أدخل مبلغاً موجباً.', en: 'Enter a positive amount.' },
  MONTHS_NOT_POSITIVE: { ar: 'أدخل عدد الأشهر.', en: 'Enter the number of months.' },
  PRODUCT_NOT_ENABLED: { ar: 'هذا المنتج غير متاح حالياً.', en: 'This product is not available at the moment.' },
  OFFER_NOT_FOUND: { ar: 'لم نجد هذا العرض.', en: 'We could not find that offer.' },
};

export function explain(reason: string, arabic: boolean): string {
  const e = EXPLANATIONS[reason];
  if (e !== undefined) return arabic ? e.ar : e.en;
  return arabic ? `تعذّر إكمال الطلب (${reason}).` : `The request could not be completed (${reason}).`;
}
