/**
 * What the portal says, in both languages, by code. A refusal arrives from the
 * server as a control and a reason code; the words are this map's, so nothing
 * a link carries is ever shown as the institution's words, and no refusal is a
 * generic decline.
 */
export type Words = { readonly en: string; readonly ar: string };

export const NOTICE: Readonly<Record<string, Words>> = {
  APPROVE_IN_APP: {
    en: 'Approve the sign-in in your national identity app, then continue here.',
    ar: 'وافق على تسجيل الدخول في تطبيق الهوية الوطنية، ثم تابع هنا.',
  },
  APPROVE_SIGNATURE_IN_APP: {
    en: 'Approve the signature in your national identity app, then confirm here.',
    ar: 'وافق على التوقيع في تطبيق الهوية الوطنية، ثم أكّد هنا.',
  },
  ACCEPTED_AND_BOOKED: {
    en: 'You accepted the offer. The sale is concluded and the amount due is booked on the schedule below.',
    ar: 'قبلت العرض. تمّ البيع وقُيّد المبلغ المستحق وفق الجدول أدناه.',
  },
  ACCEPTED: {
    en: 'You accepted the offer. The sale is concluded; the bank books the amount due shortly.',
    ar: 'قبلت العرض. تمّ البيع، ويقيّد البنك المبلغ المستحق قريباً.',
  },
};

export const REFUSAL: Readonly<Record<string, Words>> = {
  SIGN_IN_REFUSED: {
    en: 'This person cannot sign in for a distributor here. Check the reference, or ask the bank to add you as a signatory.',
    ar: 'لا يمكن لهذا الشخص الدخول نيابة عن موزّع هنا. تحقّق من المرجع، أو اطلب من البنك إضافتك مفوّضاً بالتوقيع.',
  },
  SIGN_IN_EXPIRED: { en: 'The sign-in request expired. Start again.', ar: 'انتهت مهلة طلب الدخول. ابدأ من جديد.' },
  IDENTITY_UNAVAILABLE: {
    en: 'The national identity service cannot be reached right now. Nothing was signed; try again shortly.',
    ar: 'تعذّر الوصول إلى خدمة الهوية الوطنية الآن. لم يُوقَّع شيء؛ حاول بعد قليل.',
  },
  IDENTITY_NOT_CONFIRMED: {
    en: 'The national identity service did not confirm it was you. Start again.',
    ar: 'لم تؤكّد خدمة الهوية الوطنية أنك صاحب الطلب. ابدأ من جديد.',
  },
  SIGNATURE_EXPIRED: { en: 'The signature request expired. Start again.', ar: 'انتهت مهلة طلب التوقيع. ابدأ من جديد.' },
  SIGNATURE_NOT_CONFIRMED: {
    en: 'The national identity service did not confirm the signature. Nothing was accepted.',
    ar: 'لم تؤكّد خدمة الهوية الوطنية التوقيع. لم يُقبل شيء.',
  },
  OFFER_CHANGED: {
    en: 'The offer is no longer the one you signed. Nothing was accepted.',
    ar: 'لم يعد العرض هو الذي وقّعت عليه. لم يُقبل شيء.',
  },
  OFFER_NOT_OPEN: { en: 'This offer is not open for acceptance.', ar: 'هذا العرض غير متاح للقبول.' },
  OFFER_EXPIRED: {
    en: 'The offer has lapsed. The bank can issue a new one.',
    ar: 'انقضت مدة العرض. يمكن للبنك إصدار عرض جديد.',
  },
  ACCEPTANCE_NOT_AFTER_OFFER: {
    en: 'Acceptance must come after the offer. Try again in a moment.',
    ar: 'يجب أن يأتي القبول بعد العرض. حاول بعد لحظة.',
  },
  PARTIES_NOT_DISTINCT: {
    en: 'The goods would return to the party they were bought from, so this sale cannot be concluded.',
    ar: 'ستعود البضاعة إلى الطرف الذي اشتُريت منه، فلا يمكن إتمام هذا البيع.',
  },
  BUY_BACK_TO_ORIGINAL_SELLER: {
    en: 'The goods would return to the party they were bought from, so this sale cannot be concluded.',
    ar: 'ستعود البضاعة إلى الطرف الذي اشتُريت منه، فلا يمكن إتمام هذا البيع.',
  },
  TRANSACTION_NOT_FOUND: { en: 'There is no such offer for your company.', ar: 'لا يوجد عرض كهذا لمنشأتك.' },
  TRANSACTION_MOVED: {
    en: 'This offer changed meanwhile. The page shows where it now stands.',
    ar: 'تغيّر هذا العرض في الأثناء، وتعرض الصفحة وضعه الحالي.',
  },
  STEP_NOT_AVAILABLE: {
    en: 'This offer is not open for acceptance as it stands.',
    ar: 'هذا العرض غير متاح للقبول في وضعه الحالي.',
  },
};

export const STATE: Readonly<Record<string, Words>> = {
  SALE_OFFERED: { en: 'Offer awaiting your acceptance', ar: 'عرض بانتظار قبولك' },
  OFFER_LAPSED: { en: 'Offer lapsed', ar: 'انقضى العرض' },
  EXECUTED: { en: 'Accepted — booking', ar: 'مقبول — قيد التسجيل' },
  ACTIVE: { en: 'Amount due on schedule', ar: 'مبلغ مستحق وفق الجدول' },
  SETTLED: { en: 'Settled', ar: 'مسدّد' },
  DELINQUENT: { en: 'Overdue', ar: 'متأخر' },
  HARDSHIP: { en: 'Hardship', ar: 'تعثّر' },
  RESCHEDULED: { en: 'Rescheduled', ar: 'معاد جدولته' },
};

export const say = (
  map: Readonly<Record<string, Words>>,
  code: string | undefined,
  arabic: boolean,
): string | undefined => {
  const w = code === undefined ? undefined : map[code];
  return w === undefined ? undefined : arabic ? w.ar : w.en;
};
