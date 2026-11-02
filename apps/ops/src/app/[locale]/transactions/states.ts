/**
 * The Murabaha transaction's states as staff read them, in the sequence's
 * order (products/murabaha-scf/sequencing/state.ts). Display only: the state
 * machine decides every move; this names where a transaction is.
 */
export const SEQUENCE: readonly string[] = [
  'DRAFT',
  'TRADE_VALIDATION',
  'LIMIT_RESERVED',
  'WAAD_EXECUTED',
  'PURCHASE_EXECUTED',
  'OWNERSHIP_ACQUIRED',
  'POSSESSION_CONFIRMED',
  'SALE_OFFERED',
  'EXECUTED',
  'ACTIVE',
  'SETTLED',
];

export const STATE_LABEL: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  DRAFT: { en: 'Draft', ar: 'مسودة' },
  TRADE_VALIDATION: { en: 'Trade validation', ar: 'التحقق من التجارة' },
  REJECTED: { en: 'Rejected', ar: 'مرفوضة' },
  LIMIT_RESERVED: { en: 'Limit reserved', ar: 'حُجز الحد' },
  WAAD_EXECUTED: { en: 'Wa’d executed', ar: 'نُفّذ الوعد' },
  PURCHASE_EXECUTED: { en: 'Purchase executed', ar: 'نُفّذ الشراء' },
  OWNERSHIP_ACQUIRED: { en: 'Ownership acquired', ar: 'انتقلت الملكية' },
  POSSESSION_CONFIRMED: { en: 'Possession confirmed', ar: 'تأكد القبض' },
  SALE_OFFERED: { en: 'Sale offered', ar: 'عُرض البيع' },
  OFFER_LAPSED: { en: 'Offer lapsed', ar: 'انقضى العرض' },
  UNWIND: { en: 'Unwound', ar: 'فُكّت' },
  EXECUTED: { en: 'Sale executed', ar: 'نُفّذ البيع' },
  ACTIVE: { en: 'Active', ar: 'نشطة' },
  SETTLED: { en: 'Settled', ar: 'مسددة' },
  DELINQUENT: { en: 'Delinquent', ar: 'متعثرة' },
  HARDSHIP: { en: 'Hardship', ar: 'تعثر' },
  RESCHEDULED: { en: 'Rescheduled', ar: 'أُعيدت جدولتها' },
  WRITTEN_OFF: { en: 'Written off', ar: 'مشطوبة' },
  RESOLVED: { en: 'Resolved', ar: 'سُوّيت' },
};

export const GATE_LABEL: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  GATE_1_OWNERSHIP: { en: 'Gate 1 — ownership evidence', ar: 'البوابة ١ — دليل الملكية' },
  GATE_2_POSSESSION: { en: 'Gate 2 — possession evidence', ar: 'البوابة ٢ — دليل القبض' },
  GATE_3_RISK_PERIOD: { en: 'Gate 3 — risk-holding interval', ar: 'البوابة ٣ — مدة تحمّل المخاطر' },
};

type Words = { readonly en: string; readonly ar: string };

export const EVIDENCE_TYPE_LABEL: Readonly<Record<string, Words>> = {
  OWNERSHIP_INVOICE: { en: 'Ownership invoice (cleared)', ar: 'فاتورة الملكية (معتمدة)' },
  TITLE_RECORD: { en: 'Title record', ar: 'سجل الملكية' },
  DELIVERY_NOTE: { en: 'Delivery note', ar: 'إشعار تسليم' },
  WAREHOUSE_RECEIPT: { en: 'Warehouse receipt', ar: 'إيصال مستودع' },
  CONSTRUCTIVE_POSSESSION: { en: 'Constructive possession (qabd hukmi)', ar: 'قبض حكمي' },
};

export const EVIDENCE_SOURCE_LABEL: Readonly<Record<string, Words>> = {
  E_INVOICING_AUTHORITY: { en: 'E-invoicing authority', ar: 'هيئة الفوترة الإلكترونية' },
  ANCHOR_SYSTEM: { en: 'Anchor’s system', ar: 'نظام المورّد الرئيسي' },
  PARTNER: { en: 'Partner (logistics, warehouse)', ar: 'شريك (شحن أو مستودع)' },
  UPLOAD: { en: 'Uploaded by operations', ar: 'رفعته العمليات' },
};

export const EVIDENCE_STATUS_LABEL: Readonly<Record<string, Words>> = {
  VALID: { en: 'Valid', ar: 'صالح' },
  INVALID: { en: 'Not valid', ar: 'غير صالح' },
  PENDING: { en: 'Awaiting a checker', ar: 'بانتظار المراجِع' },
};

/** What a step that went through says, by the notice code the action sends back. */
export const NOTICE: Readonly<Record<string, Words>> = {
  OBLIGATION_BOOKED: {
    en: 'The obligation is booked: the schedule in Sanad, the receivable in the core banking platform.',
    ar: 'قُيّد الالتزام: الجدول في سند، والمديونية في النظام المصرفي الأساسي.',
  },
  LIMIT_RESERVED: {
    en: 'Trade validated and the cost held against the programme.',
    ar: 'تم التحقق من التجارة وحُجزت التكلفة من حد البرنامج.',
  },
  WAAD_EXECUTED: { en: 'The wa’d is executed.', ar: 'نُفّذ الوعد.' },
  PURCHASE_EXECUTED: { en: 'The purchase is executed.', ar: 'نُفّذ الشراء.' },
  OWNERSHIP_EVIDENCE_RECORDED: {
    en: 'The e-invoicing authority answered; the invoice is recorded.',
    ar: 'أجابت هيئة الفوترة الإلكترونية وسُجّلت الفاتورة.',
  },
  OWNERSHIP_ACQUIRED: { en: 'Gate 1 passed: ownership acquired.', ar: 'اجتيزت البوابة ١: انتقلت الملكية.' },
  POSSESSION_EVIDENCE_RECORDED: {
    en: 'Possession evidence recorded; a checker validates it.',
    ar: 'سُجّل دليل القبض، ويتحقق منه مراجِع.',
  },
  EVIDENCE_VALIDATED: { en: 'Evidence validated.', ar: 'اعتُمد الدليل.' },
  EVIDENCE_REFUSED: {
    en: 'Evidence refused; it stays on file and discharges nothing.',
    ar: 'رُفض الدليل؛ يبقى في الملف ولا يستوفي شيئاً.',
  },
  POSSESSION_CONFIRMED: {
    en: 'Gate 2 passed: possession confirmed. The risk-holding interval has started.',
    ar: 'اجتيزت البوابة ٢: تأكد القبض، وبدأت مدة تحمّل المخاطر.',
  },
  SALE_OFFERED: {
    en: 'Gate 3 passed: the sale is offered to the distributor.',
    ar: 'اجتيزت البوابة ٣: عُرض البيع على الموزع.',
  },
  OFFER_LAPSED: { en: 'The offer lapsed.', ar: 'انقضى العرض.' },
  UNWOUND: {
    en: 'The transaction is unwound, with the goods’ disposition recorded.',
    ar: 'فُكّت المعاملة وسُجّل مآل البضاعة.',
  },
};

/**
 * Why a step was refused, by reason code, as the person reads it. The control
 * code is shown beside it. A code not here falls back to a plain statement
 * that the sequence refused the step — never a generic decline.
 */
export const BOOKING_REFUSAL: Readonly<Record<string, Words>> = {
  CORE_BANKING_UNAVAILABLE: {
    en: 'The core banking platform is not connected here. Nothing was booked; the sale stays concluded.',
    ar: 'النظام المصرفي الأساسي غير متصل هنا. لم يُقيّد شيء، ويبقى البيع قائماً.',
  },
  CORE_BANKING_CALL_FAILED: {
    en: 'The core banking platform did not complete the booking. Nothing was written here; book it again.',
    ar: 'لم يُكمل النظام المصرفي الأساسي القيد. لم يُكتب شيء هنا؛ أعد القيد.',
  },
  MURABAHA_ACCOUNTS_NOT_CONFIGURED: {
    en: 'How a Murabaha is held in the core banking platform is not configured for this institution.',
    ar: 'لم تُعدّ طريقة قيد المرابحة في النظام المصرفي الأساسي لهذه المؤسسة.',
  },
  SCHEDULE_NOT_TOTAL: {
    en: 'The schedule does not sum to the fixed sale price, so nothing was booked.',
    ar: 'لا يساوي مجموع الجدول ثمن البيع الثابت، فلم يُقيّد شيء.',
  },
};

export const REFUSAL: Readonly<Record<string, Words>> = {
  ...BOOKING_REFUSAL,
  STEP_NOT_AVAILABLE: {
    en: 'That step does not apply to the transaction as it stands. Each step follows the one before it.',
    ar: 'لا تنطبق هذه الخطوة على المعاملة في وضعها الحالي؛ كل خطوة تأتي بعد سابقتها.',
  },
  STEP_UNKNOWN: { en: 'There is no such step.', ar: 'لا توجد خطوة بهذا الاسم.' },
  TRANSACTION_MOVED: {
    en: 'Someone else moved this transaction meanwhile. The page shows where it now stands.',
    ar: 'حرّك شخص آخر هذه المعاملة في الأثناء، وتعرض الصفحة وضعها الحالي.',
  },
  PARTIES_NOT_DISTINCT: {
    en: 'The goods would go back to the party they were bought from. That is ‘inah, and the trade is rejected.',
    ar: 'ستعود البضاعة إلى الطرف الذي اشتُريت منه، وهذا بيع عينة؛ فرُفضت التجارة.',
  },
  PROGRAMME_LIMIT_EXCEEDED: {
    en: 'The programme has no room for this cost. Nothing was held; try again when exposure falls.',
    ar: 'لا يتسع حد البرنامج لهذه التكلفة. لم يُحجز شيء؛ أعد المحاولة عند انخفاض التعرض.',
  },
  NO_ADMISSIBLE_EVIDENCE: {
    en: 'This gate has no valid evidence of a type the structure admits. Record it first.',
    ar: 'لا يوجد لهذه البوابة دليل صالح من نوع يقبله الهيكل. سجّله أولاً.',
  },
  EVIDENCE_DID_NOT_QUALIFY: {
    en: 'The evidence recorded does not meet the source or quality the structure requires.',
    ar: 'الدليل المسجّل لا يستوفي المصدر أو الجودة التي يشترطها الهيكل.',
  },
  RISK_PERIOD_NOT_ELAPSED: {
    en: 'The institution has not yet held the goods at its own risk for the interval the board set. The sale cannot be offered before then.',
    ar: 'لم تتحمل المؤسسة مخاطر البضاعة بعد للمدة التي حددتها الهيئة، فلا يجوز عرض البيع قبل ذلك.',
  },
  RISK_PERIOD_START_UNDETERMINED: {
    en: 'The attested moment possession began could not be determined.',
    ar: 'تعذّر تحديد اللحظة الموثّقة لبدء القبض.',
  },
  OWNERSHIP_INVOICE_IS_THE_TRADE_INVOICE: {
    en: 'That is the financed invoice, which names the distributor. Ownership is evidenced by the anchor’s invoice to the institution.',
    ar: 'هذه هي الفاتورة الممولة وهي باسم الموزع. يثبت الملك بفاتورة المورّد الرئيسي للمؤسسة.',
  },
  OWNERSHIP_INVOICE_ALREADY_EVIDENCED: {
    en: 'That invoice already evidences ownership of goods in another purchase.',
    ar: 'هذه الفاتورة تثبت بالفعل ملكية بضاعة في عملية شراء أخرى.',
  },
  INVOICE_REFERENCE_MALFORMED: {
    en: 'Name the invoice by its UUID and its hash.',
    ar: 'اذكر الفاتورة بمعرّفها الفريد وبصمتها.',
  },
  EINVOICING_UNAVAILABLE: {
    en: 'The e-invoicing authority cannot be reached from here. Nothing was recorded.',
    ar: 'تعذّر الوصول إلى هيئة الفوترة الإلكترونية من هنا. لم يُسجّل شيء.',
  },
  EVIDENCE_TYPE_NOT_ADMISSIBLE: {
    en: 'The structure does not admit that kind of evidence for possession.',
    ar: 'لا يقبل الهيكل هذا النوع من الأدلة لإثبات القبض.',
  },
  EVIDENCE_SOURCE_UNKNOWN: { en: 'Say where the evidence came from.', ar: 'اذكر مصدر الدليل.' },
  EVIDENCE_ALREADY_RECORDED: {
    en: 'That file is already on the transaction.',
    ar: 'هذا الملف موجود بالفعل في المعاملة.',
  },
  EVIDENCE_NOT_PENDING: { en: 'That evidence is not awaiting a decision.', ar: 'هذا الدليل لا ينتظر قراراً.' },
  FOUR_EYES_SELF_VERIFICATION: {
    en: 'You recorded this evidence; another person validates it (four eyes).',
    ar: 'أنت من سجّل هذا الدليل؛ يتحقق منه شخص آخر (مبدأ العيون الأربع).',
  },
  STORAGE_UNAVAILABLE: {
    en: 'No document store is available here. Nothing was recorded.',
    ar: 'لا يتوفر مخزن مستندات هنا. لم يُسجّل شيء.',
  },
  UPLOAD_EMPTY: { en: 'Choose a file to upload.', ar: 'اختر ملفاً لرفعه.' },
  UPLOAD_TOO_LARGE: { en: 'The file is larger than the platform accepts.', ar: 'الملف أكبر مما تقبله المنصة.' },
  UPLOAD_TYPE_NOT_ACCEPTED: { en: 'Only PDF, PNG and JPEG files are accepted.', ar: 'تُقبل ملفات PDF وPNG وJPEG فقط.' },
  OFFER_STILL_LIVE: { en: 'The offer has not expired yet.', ar: 'لم ينقضِ العرض بعد.' },
  OFFER_EXPIRED: { en: 'The offer has lapsed and must be reissued.', ar: 'انقضى العرض ويجب إعادة إصداره.' },
  GOODS_DISPOSITION_UNDOCUMENTED: {
    en: 'Say what happens to the goods the institution already holds before unwinding.',
    ar: 'بيّن مآل البضاعة التي تملكها المؤسسة قبل فك المعاملة.',
  },
  TEMPLATE_NOT_APPROVED: {
    en: 'The board has approved no template version for this leg’s document.',
    ar: 'لم تعتمد الهيئة نسخة نموذج لمستند هذا الطرف.',
  },
  DATABASE_REFUSED: {
    en: 'The database refused the step under the same rule. Nothing was written.',
    ar: 'رفضت قاعدة البيانات الخطوة وفق القاعدة نفسها. لم يُكتب شيء.',
  },
  COUNTERPARTY_NOT_CONFIGURED: {
    en: 'The distributor on this transaction is not onboarded.',
    ar: 'الموزع في هذه المعاملة غير مسجّل.',
  },
};

export const GATE_STATUS: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  NOT_STARTED: { en: 'Not yet in play', ar: 'لم تبدأ بعد' },
  PENDING: { en: 'Waiting', ar: 'بالانتظار' },
  SATISFIED: { en: 'Satisfied', ar: 'مستوفاة' },
};
