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

export const GATE_STATUS: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  NOT_STARTED: { en: 'Not yet in play', ar: 'لم تبدأ بعد' },
  PENDING: { en: 'Waiting', ar: 'بالانتظار' },
  SATISFIED: { en: 'Satisfied', ar: 'مستوفاة' },
};
