/**
 * The Murabaha transaction's states as staff read them, in the sequence's
 * order (products/murabaha-scf/sequencing/state.ts). Display only: the state
 * machine decides every move; this names where a transaction is.
 */
import { APPROVAL_REFUSAL_REASONS, approvalRefusalText } from '@sanad/core/shariah/explain.ts';

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
  APPROVAL_CHANGE_PROPOSED: {
    en: 'Proposed. It takes effect in the register only when a second Shariah reviewer confirms it.',
    ar: 'اقتُرح التغيير، ولا يسري في السجل إلا بعد أن يؤكده مراجع شرعي ثانٍ.',
  },
  APPROVAL_CHANGE_CONFIRMED: {
    en: 'Confirmed: the register now says so, from this moment.',
    ar: 'تم التأكيد: أصبح السجل يقول ذلك من هذه اللحظة.',
  },
  APPROVAL_CHANGE_REJECTED: {
    en: 'Rejected. The register is unchanged.',
    ar: 'رُفض التغيير، ولم يتغير السجل.',
  },
  FACILITY_PROPOSED: {
    en: 'The facility is proposed; a second person approves it before the distributor may draw.',
    ar: 'اقتُرح التسهيل، ويعتمده شخص ثانٍ قبل أن يسحب الموزع.',
  },
  FACILITY_APPROVED: {
    en: 'Approved: this is now the distributor’s facility in the programme.',
    ar: 'اعتُمد: أصبح هذا تسهيل الموزع في البرنامج.',
  },
  FACILITY_REJECTED: {
    en: 'Rejected, with the reason recorded. The facility in force is unchanged.',
    ar: 'رُفض وسُجّل السبب. لم يتغير التسهيل القائم.',
  },
  LATE_AMOUNT_PROPOSED: {
    en: 'Late amounts are proposed on the instalments unpaid beyond the grace days. Nothing is billed until two people agree.',
    ar: 'اقتُرحت مبالغ تأخير على الأقساط غير المدفوعة بعد مهلة السماح. لا يُفوتر شيء حتى يتفق شخصان.',
  },
  LATE_AMOUNT_ASSESSED: {
    en: 'The assessment is recorded; a second person confirms it.',
    ar: 'سُجّل التقييم، ويؤكده شخص ثانٍ.',
  },
  LATE_AMOUNT_CONFIRMED: {
    en: 'Confirmed. Able but unwilling: billed through SADAD on its own bill. Unable: hardship, not billed.',
    ar: 'تأكّد. القادر غير الراغب: يُفوتر عبر سداد بفاتورة مستقلة. العاجز: تعثّر ولا يُفوتر.',
  },
  LATE_AMOUNT_SENT_BACK: {
    en: 'The assessment went back to the officer. Nothing was billed.',
    ar: 'أُعيد التقييم إلى الموظف، ولم يُفوتر شيء.',
  },
  LATE_BILL_PRESENTED: {
    en: 'The late amount is presented to SADAD again.',
    ar: 'عُرض مبلغ التأخير على سداد من جديد.',
  },
  CHARITY_DISBURSEMENT_PROPOSED: {
    en: 'The recipient is proposed; a second person approves the disbursement.',
    ar: 'اقتُرح المستفيد، ويعتمد الصرف شخص ثانٍ.',
  },
  CHARITY_DISBURSED: {
    en: 'Approved: the payment to the board-approved recipient is instructed, and the charity entry is closed.',
    ar: 'اعتُمد: وُجّهت الدفعة إلى الجهة المعتمدة من الهيئة، وأُقفل قيد التبرع.',
  },
  CHARITY_DISBURSEMENT_DECLINED: {
    en: 'Declined. The amount stays held for charity.',
    ar: 'رُفض. يبقى المبلغ محتجزاً للتبرع.',
  },
  SADAD_FILE_FIXTURE_RECORDED: {
    en: 'Fixture: SADAD has the payment. It is applied when SADAD’s paid-bills file is next read (Reconciliation).',
    ar: 'تجريبي: سجّل سداد الدفعة. تُطبّق عند قراءة ملف الفواتير المدفوعة التالي (المطابقة).',
  },
  RECONCILED: {
    en: 'SADAD’s paid-bills file is read; what matched is applied.',
    ar: 'قُرئ ملف الفواتير المدفوعة من سداد، وطُبّق ما تطابق.',
  },
  COLLECTION_PRESENTED: {
    en: 'The instalments falling due are presented to SADAD for the distributor to pay.',
    ar: 'عُرضت الأقساط المستحقة على سداد ليدفعها الموزع.',
  },
  SELLER_PAYMENT_REINSTRUCTED: {
    en: 'The seller’s payment is instructed again, as a new payment.',
    ar: 'أُعيد توجيه دفعة البائع كدفعة جديدة.',
  },
  SELLER_PAYMENT_RESULT: { en: 'The payment’s result is recorded.', ar: 'سُجّلت نتيجة الدفعة.' },
  PAYMENT_RECEIVED: {
    en: 'The receipt is applied to what the distributor owes.',
    ar: 'طُبّق المبلغ المحصّل على ما يدين به الموزع.',
  },
  PAYMENT_RETURNED: {
    en: 'The return is recorded; the instalment can be presented again.',
    ar: 'سُجّل الارتجاع، ويمكن عرض القسط من جديد.',
  },
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

export const SETTLEMENT_REFUSAL: Readonly<Record<string, Words>> = {
  NOTHING_TO_COLLECT: {
    en: 'No instalment falls due within the collection window, or every one due is already presented.',
    ar: 'لا يحلّ أي قسط خلال نافذة التحصيل، أو أن كل قسط مستحق معروض بالفعل.',
  },
  SELLER_PAYMENT_NOT_FAILED: {
    en: 'The seller’s payment is in hand or under way; there is nothing to instruct again.',
    ar: 'دفعة البائع منجزة أو قيد التنفيذ؛ لا شيء يُعاد توجيهه.',
  },
  RESULT_ALREADY_RECORDED: { en: 'That result is already recorded.', ar: 'هذه النتيجة مسجّلة بالفعل.' },
  RESULT_OUT_OF_ORDER: {
    en: 'That result cannot follow what was already reported.',
    ar: 'لا يمكن أن تلي هذه النتيجة ما سبق الإبلاغ عنه.',
  },
  OVERPAYMENT: {
    en: 'More than is owed was reported. It is not absorbed; operations returns the difference.',
    ar: 'أُبلغ عن مبلغ يزيد عما هو مستحق. لا يُستوعب الفرق، وتعيده العمليات.',
  },
  RETURN_AFTER_SETTLEMENT: {
    en: 'A payment came back on a settled obligation. It is not applied automatically; operations resolves it.',
    ar: 'ارتجعت دفعة على التزام مسدّد. لا تُطبّق تلقائياً، وتعالجها العمليات.',
  },
  COLLECTION_NOT_FOUND: { en: 'No bill was presented under that reference.', ar: 'لم تُعرض فاتورة بهذا المرجع.' },
  PAYMENT_NOT_FOUND: { en: 'No payment was instructed under that reference.', ar: 'لم تُوجَّه دفعة بهذا المرجع.' },
  OBLIGATION_NOT_BOOKED: { en: 'The obligation is not booked yet.', ar: 'لم يُقيّد الالتزام بعد.' },
};

export const LATE_AMOUNT_REFUSAL: Readonly<Record<string, Words>> = {
  NO_LATE_CHARGE_DUE: {
    en: 'No instalment is unpaid beyond the grace days without a late amount already.',
    ar: 'لا يوجد قسط غير مدفوع بعد مهلة السماح إلا وعليه مبلغ تأخير.',
  },
  LATE_AMOUNTS_NOT_RULED: {
    en: 'The board has ruled no late amounts for this institution.',
    ar: 'لم تقرّ الهيئة الشرعية مبالغ تأخير لهذه المؤسسة.',
  },
  LATE_AMOUNT_NOT_FOUND: {
    en: 'No late amount was proposed on that instalment.',
    ar: 'لم يُقترح مبلغ تأخير على هذا القسط.',
  },
  LATE_AMOUNT_NOT_IN_STATE: {
    en: 'That step does not apply to the late amount as it stands.',
    ar: 'لا تنطبق هذه الخطوة على مبلغ التأخير في وضعه الحالي.',
  },
  ASSESSMENT_REQUIRED: {
    en: 'Choose whether the distributor was able but unwilling, or unable.',
    ar: 'اختر ما إذا كان الموزع قادراً غير راغب أم عاجزاً.',
  },
  ASSESSMENT_NOTE_REQUIRED: {
    en: 'Say what the assessment rests on.',
    ar: 'اذكر ما يستند إليه التقييم.',
  },
  SEND_BACK_NOTE_REQUIRED: { en: 'Say why it goes back.', ar: 'اذكر سبب الإعادة.' },
  FOUR_EYES_SELF_CONFIRMATION: {
    en: 'Someone else decides on this: the person who did the work before it may not.',
    ar: 'يقرر في هذا شخص آخر؛ لا يجوز لمن أنجز الخطوة السابقة.',
  },
  LATE_BILL_STANDING: {
    en: 'The late amount’s bill is still standing at SADAD.',
    ar: 'فاتورة مبلغ التأخير ما زالت قائمة لدى سداد.',
  },
  LATE_AMOUNT_DIFFERS: {
    en: 'What was paid differs from the late amount billed. Nothing is raised to charity; operations resolves it.',
    ar: 'المدفوع يختلف عن مبلغ التأخير المفوتر. لم يُقيّد شيء للتبرع، وتعالجه العمليات.',
  },
  RETURN_AFTER_CHARITY_RAISED: {
    en: 'A late amount’s payment came back after it was raised to charity. The entry is not taken back silently; operations resolves it.',
    ar: 'ارتجعت دفعة مبلغ تأخير بعد قيده للتبرع. لا يُلغى القيد بصمت، وتعالجه العمليات.',
  },
  HARDSHIP_SUSPENDS_LATE_AMOUNTS: {
    en: 'The distributor was assessed unable to pay; late amounts are suspended.',
    ar: 'قُيّم الموزع عاجزاً عن السداد؛ تُعلّق مبالغ التأخير.',
  },
  RECIPIENT_NOT_APPROVED: {
    en: 'That recipient is not on the board-approved register.',
    ar: 'هذا المستفيد ليس في سجل الجهات المعتمدة من الهيئة.',
  },
  ALREADY_DISBURSED: { en: 'This charity entry is already disbursed.', ar: 'صُرف قيد التبرع هذا بالفعل.' },
  CHARITY_ACCOUNT_UNMAPPED: {
    en: 'No segregated charity liability account is configured. Nothing was raised.',
    ar: 'لم يُعدّ حساب التزام التبرع المستقل. لم يُقيّد شيء.',
  },
  CHARITY_ALREADY_RAISED: {
    en: 'This collection is already raised to charity.',
    ar: 'قُيّد هذا التحصيل للتبرع بالفعل.',
  },
};

/** Why a facility step or a hold was refused (W5a). */
export const LIMIT_REFUSAL: Readonly<Record<string, Words>> = {
  NO_FACILITY: {
    en: 'The distributor has no approved facility in this programme. Nothing was held; a facility is proposed and approved under Facilities.',
    ar: 'لا يوجد للموزع تسهيل معتمد في هذا البرنامج. لم يُحجز شيء؛ يُقترح التسهيل ويُعتمد في صفحة التسهيلات.',
  },
  FACILITY_LIMIT_EXCEEDED: {
    en: 'The distributor’s facility has no room for this cost. Nothing was held.',
    ar: 'لا يتسع تسهيل الموزع لهذه التكلفة. لم يُحجز شيء.',
  },
  CONCENTRATION_SINGLE_TRADE_CAP: {
    en: 'This trade’s cost is above the institution’s single-trade cap. Nothing was held.',
    ar: 'تكلفة هذه الصفقة أعلى من الحد الأقصى للصفقة الواحدة لدى المؤسسة. لم يُحجز شيء.',
  },
  CONCENTRATION_DISTRIBUTOR_SHARE: {
    en: 'The distributor would hold more of the programme than the institution’s concentration policy allows. Nothing was held.',
    ar: 'سيتجاوز نصيب الموزع من البرنامج ما تسمح به سياسة التركّز لدى المؤسسة. لم يُحجز شيء.',
  },
  CONCENTRATION_ANCHOR_SHARE: {
    en: 'The anchor’s programmes would hold more of the book than the institution’s concentration policy allows. Nothing was held.',
    ar: 'سيتجاوز نصيب برامج الجهة الراعية من المحفظة ما تسمح به سياسة التركّز لدى المؤسسة. لم يُحجز شيء.',
  },
  DUPLICATE_FINANCING: {
    en: 'This invoice is already financed by another transaction. An invoice is financed once.',
    ar: 'هذه الفاتورة مموّلة بالفعل في معاملة أخرى. تُموّل الفاتورة مرة واحدة فقط.',
  },
  FACILITY_ABOVE_PROGRAMME: {
    en: 'A facility is never more than its programme’s limit.',
    ar: 'لا يزيد التسهيل أبداً على حد برنامجه.',
  },
  FACILITY_LIMIT_NOT_POSITIVE: { en: 'Enter the limit in riyals.', ar: 'أدخل الحد بالريال.' },
  FACILITY_RATIONALE_REQUIRED: { en: 'Say what the limit rests on.', ar: 'اذكر ما يستند إليه الحد.' },
  FACILITY_PROPOSAL_OPEN: {
    en: 'A proposal for this distributor and programme already awaits a decision.',
    ar: 'يوجد اقتراح لهذا الموزع والبرنامج بانتظار القرار.',
  },
  FACILITY_PROPOSAL_NOT_FOUND: { en: 'No such proposal.', ar: 'لا يوجد هذا الاقتراح.' },
  FACILITY_ALREADY_DECIDED: { en: 'That proposal is already decided.', ar: 'تم البت في هذا الاقتراح بالفعل.' },
  FOUR_EYES_SELF_APPROVAL: {
    en: 'Someone other than the proposer decides a facility.',
    ar: 'يبت في التسهيل شخص غير مقترحه.',
  },
  REJECTION_REASON_REQUIRED: { en: 'A rejection says why.', ar: 'يجب ذكر سبب الرفض.' },
  FACILITY_BELOW_EXPOSURE: {
    en: 'The distributor already holds more than this limit. A facility is never set below what it carries.',
    ar: 'يحتفظ الموزع بالفعل بأكثر من هذا الحد. لا يُحدّد التسهيل أبداً بأقل مما يحمله.',
  },
};

/** SH-17: new origination under an approval that is not in force (W6a). */
const SHARIAH_APPROVAL_REFUSAL: Readonly<Record<string, Words>> = Object.fromEntries(
  APPROVAL_REFUSAL_REASONS.flatMap((r) => {
    const words = approvalRefusalText(r);
    return words === undefined ? [] : [[r, words]];
  }),
);

export const REFUSAL: Readonly<Record<string, Words>> = {
  ...SHARIAH_APPROVAL_REFUSAL,
  ...BOOKING_REFUSAL,
  ...SETTLEMENT_REFUSAL,
  ...LATE_AMOUNT_REFUSAL,
  ...LIMIT_REFUSAL,
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
