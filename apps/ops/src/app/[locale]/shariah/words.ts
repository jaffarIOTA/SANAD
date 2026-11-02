/**
 * The Shariah governance screens' words (W6b, W6c): the checks, what each
 * finding means, severities and incident states, in plain Arabic and English
 * for Shariah reviewers and the Board — no technical vocabulary (SDD FP-07).
 * Display only; the decisions are the checks' and the incident lifecycle's.
 */
import type { IncidentSeverity, IncidentStatus } from '@sanad/core/shariah/incidents.ts';
import type { StatusTone } from '@sanad/design/primitives.tsx';

export type Words = { readonly en: string; readonly ar: string };

/** What each finding means, in words a Shariah reviewer reads. */
export const FINDING: Readonly<Record<string, Words>> = {
  HASH_CHAIN_BROKEN: {
    en: 'A leg does not chain to the leg before it: the sequence of contracts cannot be verified from the documents.',
    ar: 'أحد العقود لا يرتبط بالعقد الذي قبله، فلا يمكن التحقق من تسلسل العقود من المستندات.',
  },
  TIMESTAMPS_NOT_MONOTONIC: {
    en: 'A leg is timestamped no later than the leg before it.',
    ar: 'أحد العقود مؤرخ في وقت لا يلي العقد الذي قبله.',
  },
  SEQUENCE_NOT_MONOTONIC: { en: 'The legs’ sequence numbers do not rise.', ar: 'أرقام تسلسل العقود لا تتصاعد.' },
  FIRST_LEG_HAS_PREDECESSOR: {
    en: 'The first leg refers to a predecessor.',
    ar: 'العقد الأول يُشير إلى عقد سابق.',
  },
  DOCUMENT_ALREADY_BOUND_TO_A_LEG: {
    en: 'One document is bound to two legs.',
    ar: 'مستند واحد مرتبط بعقدين.',
  },
  LEGS_NOT_THE_STRUCTURE: {
    en: 'The legs executed are not the structure’s legs in its order.',
    ar: 'العقود المنفّذة ليست عقود الهيكل بترتيبه.',
  },
  STATE_AHEAD_OF_LEGS: {
    en: 'The transaction stands at a step whose contracts were not executed.',
    ar: 'المعاملة في مرحلة لم تُنفَّذ عقودها.',
  },
  GATE_PASSED_WITHOUT_EVIDENCE: {
    en: 'The transaction is past a gate whose evidence is no longer valid.',
    ar: 'تجاوزت المعاملة مرحلة لم تعد بيّنتها صالحة.',
  },
  SOLD_WITHOUT_GATE: {
    en: 'The sale was offered before every gate held: ownership or possession was not evidenced at the time.',
    ar: 'عُرض البيع قبل استيفاء كل المراحل: لم تثبت الملكية أو الحيازة حينها.',
  },
  SOLD_BEFORE_RISK_PERIOD: {
    en: 'The sale was offered before the goods were held at the institution’s risk for the board’s interval.',
    ar: 'عُرض البيع قبل أن تبقى البضاعة في ضمان المؤسسة المدة التي حددتها الهيئة.',
  },
  PARTY_CHANGED_BETWEEN_LEGS: {
    en: 'The seller or the buyer is not the same on every leg.',
    ar: 'البائع أو المشتري ليس هو نفسه في كل العقود.',
  },
  PARTIES_NOT_DISTINCT: {
    en: 'Seller, buyer and institution are not three distinct parties (‘inah).',
    ar: 'البائع والمشتري والمؤسسة ليسوا ثلاثة أطراف متمايزة (عينة).',
  },
  SELLER_NOT_THE_INVOICE_ISSUER: {
    en: 'The goods were bought from someone other than the invoice’s issuer.',
    ar: 'اشتُريت البضاعة من غير مُصدر الفاتورة.',
  },
  GOODS_SCREENING_NOT_RECORDED: {
    en: 'The goods screened at opening were not recorded, so they cannot be screened again.',
    ar: 'لم تُسجَّل البضاعة التي فُحصت عند الفتح، فلا يمكن فحصها مجدداً.',
  },
  GOODS_EXCLUDED_AT_OPENING: {
    en: 'The goods were excluded by the board’s register in force when the transaction opened.',
    ar: 'كانت البضاعة مستبعدة في سجل الهيئة الساري عند فتح المعاملة.',
  },
  GOODS_EXCLUDED_SINCE: {
    en: 'The board has excluded these goods since the transaction opened.',
    ar: 'استبعدت الهيئة هذه البضاعة بعد فتح المعاملة.',
  },
  SALE_PRICE_NOT_COST_PLUS_PROFIT: {
    en: 'The sale price is not the cost plus the profit disclosed.',
    ar: 'ثمن البيع لا يساوي التكلفة مضافاً إليها الربح المُفصح عنه.',
  },
  EXECUTED_APPROVAL_NOT_IN_REGISTER: {
    en: 'The approval this transaction was executed under is not in the approvals register.',
    ar: 'الاعتماد الذي نُفّذت بموجبه المعاملة غير مقيّد في سجل الاعتمادات.',
  },
  TEMPLATE_NOT_IN_APPROVAL: {
    en: 'A leg was executed on a template version its approval does not cover.',
    ar: 'نُفّذ أحد العقود على إصدار نموذج لا يشمله اعتماده.',
  },
  DOCUMENT_DIFFERS_FROM_TEMPLATE: {
    en: 'An executed document differs from what its approved template makes of the transaction’s figures.',
    ar: 'أحد المستندات المنفّذة يختلف عما يُنتجه نموذجه المعتمد من أرقام المعاملة.',
  },
  DOCUMENT_NOT_REBUILT: {
    en: 'An executed document could not be rebuilt from its template to compare it.',
    ar: 'تعذّر إعادة بناء أحد المستندات المنفّذة من نموذجه لمقارنته.',
  },
  REVIEWER_OBSERVATION: { en: 'A Shariah reviewer’s observation.', ar: 'ملاحظة مراجع شرعي.' },
};

export const SEVERITY: Readonly<Record<IncidentSeverity, Words & { readonly tone: StatusTone }>> = {
  LOW: { en: 'Low', ar: 'منخفضة', tone: 'progress' },
  MEDIUM: { en: 'Medium', ar: 'متوسطة', tone: 'progress' },
  HIGH: { en: 'High', ar: 'عالية', tone: 'blocked' },
  MATERIAL: { en: 'Material', ar: 'جوهرية', tone: 'blocked' },
};

export const STATUS: Readonly<Record<IncidentStatus, Words>> = {
  RAISED: { en: 'Raised', ar: 'مُثارة' },
  TRIAGED: { en: 'Triaged', ar: 'مُصنّفة' },
  REMEDIATION_PLANNED: { en: 'Remediation planned', ar: 'خطة المعالجة معدّة' },
  REMEDIATED: { en: 'Remediated', ar: 'عولجت' },
  CLOSED: { en: 'Closed', ar: 'مغلقة' },
};

export const CHECK: Readonly<Record<string, Words>> = {
  SEQUENCE_INTEGRITY: { en: 'Sequence integrity', ar: 'سلامة التسلسل' },
  EVIDENCE_COMPLETENESS: { en: 'Evidence completeness', ar: 'اكتمال البيّنات' },
  RISK_PERIOD: { en: 'Risk period', ar: 'مدة الضمان' },
  COUNTERPARTY_DISTINCTNESS: { en: 'Counterparty distinctness', ar: 'تمايز الأطراف' },
  GOODS_PERMISSIBILITY: { en: 'Goods permissibility', ar: 'إباحة البضاعة' },
  DISCLOSURE_ACCURACY: { en: 'Disclosure accuracy', ar: 'دقة الإفصاح' },
  TEMPLATE_DRIFT: { en: 'Template drift', ar: 'انحراف النماذج' },
  MANUAL: { en: 'Reviewer’s observation', ar: 'ملاحظة المراجع' },
};
