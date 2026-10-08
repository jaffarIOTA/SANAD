/**
 * What the SME pipeline screens show, computed from the business service's
 * views — and nothing else. Pure: every function takes the views and an
 * observed instant, so the dashboard's figures can be tested without a page.
 *
 *   - the stage clock: how long an application has sat in its current stage
 *     against the stage target (PIPELINE_STAGES, ILLUSTRATIVE targets from the
 *     partner's prototype);
 *   - the status chip on a card ("Day 5 of 5 ⚠ SLA", "Offer sent day 2",
 *     "DPD 34");
 *   - the four dashboard figures and the kanban grouping;
 *   - the repayment-schedule excerpt the offer screen shows (first rows, last
 *     rows, an ellipsis between);
 *   - display formatting for integer ratios (per ten thousand) — display only,
 *     never arithmetic on a decision.
 *
 * Nothing here decides anything. A chip says what the state machine already
 * recorded; a figure is a count or a sum of recorded amounts.
 */

import type { FactValue } from '@sanad/core/decisioning/sme-assessment.ts';
import { REASONS } from '@sanad/origination/problem.ts';

import { type BusinessApplicationView, PIPELINE_STAGES, TARGET_TURNAROUND_SECONDS } from './business.ts';

const DAY = 86_400n;
/** Asia/Dubai has no daylight saving: UTC+4 all year. */
export const UAE_OFFSET_SECONDS = 4n * 3_600n;

/**
 * A stage is "near" its target once 80% of the target has elapsed.
 * ILLUSTRATIVE: an operations choice for the dashboard, not a fund standard.
 */
export const NEAR_SLA_PER_TEN_THOUSAND = 8_000n;

export type DisplayStage = 5 | 6 | 7 | 8 | 9;
export const SANAD_STAGES: readonly DisplayStage[] = [5, 6, 7, 8, 9];

const CLOSED = new Set(['WITHDRAWN', 'DECLINED']);

// =============================================================================
// Stage clock
// =============================================================================

export interface StageClock {
  readonly stage: DisplayStage;
  readonly enteredAtEpochSeconds: bigint;
  readonly elapsedSeconds: bigint;
  readonly targetSeconds?: bigint;
  /** 1-based: the first day in the stage is day 1. A count, not an amount. */
  readonly day: number;
  /** The target in whole days, where the stage has one. */
  readonly targetDays?: number;
  readonly state: 'ON_TRACK' | 'NEAR' | 'BREACHED' | 'ONGOING';
}

const ordered = (v: BusinessApplicationView): BusinessApplicationView['events'] => [...v.events].sort((a, b) => a.sequence - b.sequence);

/** When the application entered the stage it shows at: the last event that moved it to a different stage. */
export function stageEnteredAt(v: BusinessApplicationView): bigint {
  let stage: number = 5;
  let entered = v.application.receivedAtEpochSeconds;
  for (const e of ordered(v)) {
    if (e.toStage !== null && e.toStage !== stage) {
      stage = e.toStage;
      entered = e.atEpochSeconds;
    }
  }
  return entered;
}

export function stageClock(v: BusinessApplicationView, nowEpochSeconds: bigint): StageClock {
  const stage = v.displayStage as DisplayStage;
  const enteredAtEpochSeconds = stageEnteredAt(v);
  const elapsedSeconds = nowEpochSeconds > enteredAtEpochSeconds ? nowEpochSeconds - enteredAtEpochSeconds : 0n;
  const day = Number(elapsedSeconds / DAY) + 1;
  const target = PIPELINE_STAGES.find((s) => s.stage === stage)?.targetSeconds;
  if (target === undefined) return { stage, enteredAtEpochSeconds, elapsedSeconds, day, state: 'ONGOING' };
  const state = elapsedSeconds > target ? 'BREACHED' : elapsedSeconds * 10_000n >= target * NEAR_SLA_PER_TEN_THOUSAND ? 'NEAR' : 'ON_TRACK';
  return { stage, enteredAtEpochSeconds, elapsedSeconds, targetSeconds: target, day, targetDays: Number(target / DAY), state };
}

// =============================================================================
// Status chip
// =============================================================================

export type ChipTone = 'neutral' | 'brand' | 'good' | 'warn' | 'bad';

export interface StatusChip {
  readonly code: string;
  readonly en: string;
  readonly ar: string;
  readonly tone: ChipTone;
}

const lastEventAt = (v: BusinessApplicationView, type: string): bigint | undefined => {
  const hits = ordered(v).filter((e) => e.eventType === type);
  return hits[hits.length - 1]?.atEpochSeconds;
};

/** The one-line status on a kanban card or a table row. Arabic digits are applied by the caller. */
export function statusChip(v: BusinessApplicationView, nowEpochSeconds: bigint): StatusChip {
  const a = v.application;
  if (a.status === 'WITHDRAWN') return { code: 'WITHDRAWN', en: 'Withdrawn', ar: 'مسحوب', tone: 'neutral' };
  if (a.status === 'DECLINED') return { code: 'DECLINED', en: 'Declined', ar: 'مرفوض', tone: 'bad' };
  if (v.displayStage === 9 && v.portfolio !== undefined) return { code: 'DPD', en: `DPD ${String(v.portfolio.daysPastDue)}`, ar: `متأخر ${String(v.portfolio.daysPastDue)} يوماً`, tone: 'bad' };
  if (a.status === 'DISBURSED') return { code: 'ON_TRACK', en: 'On track', ar: 'منتظم', tone: 'good' };

  const clock = stageClock(v, nowEpochSeconds);
  const ofTarget = (en: string, ar: string): StatusChip => {
    const day = String(clock.day);
    const target = String(clock.targetDays ?? 0);
    if (clock.state === 'BREACHED') return { code: 'SLA_BREACHED', en: `${en} · Day ${day} of ${target} — SLA breached`, ar: `${ar} · اليوم ${day} من ${target} — تجاوز المدة`, tone: 'bad' };
    if (clock.state === 'NEAR') return { code: 'SLA_NEAR', en: `Day ${day} of ${target} ⚠ SLA`, ar: `اليوم ${day} من ${target} ⚠ المدة`, tone: 'warn' };
    return { code: 'IN_STAGE', en: `${en} · Day ${day} of ${target}`, ar: `${ar} · اليوم ${day} من ${target}`, tone: 'brand' };
  };

  switch (a.status) {
    case 'RECEIVED':
      return ofTarget('Received', 'مستلم');
    case 'SPREADING': {
      const unverified = v.figures.filter((f) => f.figure.status !== 'VERIFIED').length;
      return unverified > 0 && clock.state === 'ON_TRACK'
        ? { code: 'FIGURES_TO_VERIFY', en: `${String(unverified)} figures to verify · Day ${String(clock.day)} of ${String(clock.targetDays ?? 0)}`, ar: `${String(unverified)} أرقام للتحقق · اليوم ${String(clock.day)} من ${String(clock.targetDays ?? 0)}`, tone: 'brand' }
        : ofTarget('Analysis', 'التحليل');
    }
    case 'SUBMITTED':
      return clock.state === 'ON_TRACK' ? { code: 'AWAITING_SCORING', en: 'Awaiting scoring', ar: 'بانتظار التقييم', tone: 'brand' } : ofTarget('Awaiting scoring', 'بانتظار التقييم');
    case 'ASSESSED':
      return { code: 'SCORING_COMPLETE', en: 'Scoring complete · awaiting checker', ar: 'اكتمل التقييم · بانتظار المراجِع', tone: 'good' };
    case 'IN_COMMITTEE':
      return ofTarget('With committee', 'لدى اللجنة');
    case 'APPROVED':
      return { code: 'APPROVED', en: 'Approved · offer to issue', ar: 'معتمد · بانتظار العرض', tone: 'good' };
    case 'OFFER_SENT': {
      const sent = a.offer?.sentAtEpochSeconds ?? lastEventAt(v, 'OFFER_SENT') ?? clock.enteredAtEpochSeconds;
      const day = Number((nowEpochSeconds > sent ? nowEpochSeconds - sent : 0n) / DAY) + 1;
      return { code: 'OFFER_SENT', en: `Offer sent day ${String(day)}`, ar: `أُرسل العرض · اليوم ${String(day)}`, tone: clock.state === 'BREACHED' ? 'bad' : clock.state === 'NEAR' ? 'warn' : 'brand' };
    }
    case 'SIGNED':
      return { code: 'SIGNED', en: 'Signed · awaiting disbursement', ar: 'موقّع · بانتظار الصرف', tone: 'good' };
    default:
      return { code: a.status, en: a.status, ar: a.status, tone: 'neutral' };
  }
}

// =============================================================================
// Turnaround and the four figures
// =============================================================================

/** When an application stopped moving: disbursed, declined or withdrawn. Undefined while open. */
export function closedAt(v: BusinessApplicationView): bigint | undefined {
  const a = v.application;
  if (a.disbursement !== undefined) return a.disbursement.atEpochSeconds;
  if (a.withdrawal !== undefined) return a.withdrawal.atEpochSeconds;
  if (a.status === 'DECLINED') return a.committee?.atEpochSeconds ?? lastEventAt(v, 'ASSESSED') ?? lastEventAt(v, 'COMMITTEE_DECLINED');
  return undefined;
}

/** Seconds from hand-over (stage 5) to disbursement or closure, or to now while open. Stages 1–4 happen upstream and are not measured here. */
export function turnaroundSeconds(v: BusinessApplicationView, nowEpochSeconds: bigint): bigint {
  const end = closedAt(v) ?? nowEpochSeconds;
  const start = v.application.receivedAtEpochSeconds;
  return end > start ? end - start : 0n;
}

/** Whole days, rounded down. A count. */
export const wholeDays = (seconds: bigint): number => Number(seconds / DAY);

function monthKey(epochSeconds: bigint, offsetSeconds: bigint): string {
  const d = new Date(Number((epochSeconds + offsetSeconds) * 1000n));
  return `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface PipelineSummary {
  /** In origination: stages 5–7, not declined or withdrawn. */
  readonly activeCount: number;
  /** Disbursed: stages 8–9. */
  readonly portfolioCount: number;
  /** At stage 5, not withdrawn. */
  readonly pendingAssessmentCount: number;
  /** Of those, near or past the stage-5 target. */
  readonly nearSlaCount: number;
  readonly breachedCount: number;
  /** Approved (straight through or by committee) in the current calendar month, UAE time. */
  readonly approvedThisMonthCount: number;
  /** Facility amounts disbursed in the current calendar month, minor units of the tenant's currency. */
  readonly disbursedThisMonthMinorUnits: bigint;
  readonly disbursedThisMonthCount: number;
  /** Mean hand-over-to-disbursement time of the disbursed applications, in tenths of a day; absent when none is disbursed. */
  readonly averageTurnaroundTenthsOfDay?: bigint;
  readonly completedCount: number;
  readonly targetDays: number;
  /** Open (not withdrawn, not declined) applications by the stage they show at. */
  readonly byStage: Readonly<Record<DisplayStage, readonly BusinessApplicationView[]>>;
}

export function summarisePipeline(views: readonly BusinessApplicationView[], nowEpochSeconds: bigint, offsetSeconds: bigint = UAE_OFFSET_SECONDS): PipelineSummary {
  const open = views.filter((v) => !CLOSED.has(v.application.status));
  const thisMonth = monthKey(nowEpochSeconds, offsetSeconds);
  const inMonth = (at: bigint | undefined): boolean => at !== undefined && monthKey(at, offsetSeconds) === thisMonth;

  const stage5 = open.filter((v) => v.displayStage === 5);
  const clocks = stage5.map((v) => stageClock(v, nowEpochSeconds));

  const approvedThisMonth = views.filter((v) => inMonth(lastEventAt(v, 'APPROVED_STRAIGHT_THROUGH') ?? lastEventAt(v, 'COMMITTEE_APPROVED')));
  const disbursedThisMonth = views.filter((v) => inMonth(v.application.disbursement?.atEpochSeconds));

  const completed = views.filter((v) => v.application.disbursement !== undefined);
  const sum = completed.reduce((s, v) => s + turnaroundSeconds(v, nowEpochSeconds), 0n);
  const n = BigInt(completed.length);
  // Tenths of a day, rounded half up: (sum × 10 + n·DAY/2) ÷ (n·DAY).
  const averageTurnaroundTenthsOfDay = n === 0n ? undefined : (sum * 10n + (n * DAY) / 2n) / (n * DAY);

  const byStage = { 5: [], 6: [], 7: [], 8: [], 9: [] } as Record<DisplayStage, BusinessApplicationView[]>;
  for (const v of open) byStage[v.displayStage as DisplayStage].push(v);

  return {
    activeCount: open.filter((v) => v.displayStage <= 7).length,
    portfolioCount: open.filter((v) => v.displayStage >= 8).length,
    pendingAssessmentCount: stage5.length,
    nearSlaCount: clocks.filter((c) => c.state === 'NEAR' || c.state === 'BREACHED').length,
    breachedCount: clocks.filter((c) => c.state === 'BREACHED').length,
    approvedThisMonthCount: approvedThisMonth.length,
    disbursedThisMonthMinorUnits: disbursedThisMonth.reduce((s, v) => s + v.application.requested.minorUnits, 0n),
    disbursedThisMonthCount: disbursedThisMonth.length,
    ...(averageTurnaroundTenthsOfDay === undefined ? {} : { averageTurnaroundTenthsOfDay }),
    completedCount: completed.length,
    targetDays: Number(TARGET_TURNAROUND_SECONDS / DAY),
    byStage,
  };
}

/** The most recently touched applications first: the dashboard's activity table. */
export function recentActivity(views: readonly BusinessApplicationView[], limit = 8): readonly BusinessApplicationView[] {
  const last = (v: BusinessApplicationView): bigint => ordered(v).at(-1)?.atEpochSeconds ?? v.application.receivedAtEpochSeconds;
  return [...views].sort((a, b) => (last(a) > last(b) ? -1 : last(a) < last(b) ? 1 : 0)).slice(0, limit);
}

// =============================================================================
// Schedule excerpt
// =============================================================================

export interface ScheduleExcerpt<T> {
  readonly head: readonly T[];
  /** How many rows the ellipsis stands for; 0 when the schedule is shown whole. */
  readonly omitted: number;
  readonly tail: readonly T[];
}

/** The first `headCount` and last `tailCount` rows, or every row when that is no shorter. */
export function scheduleExcerpt<T>(rows: readonly T[], headCount = 5, tailCount = 3): ScheduleExcerpt<T> {
  if (rows.length <= headCount + tailCount + 1) return { head: [...rows], omitted: 0, tail: [] };
  return { head: rows.slice(0, headCount), omitted: rows.length - headCount - tailCount, tail: rows.slice(rows.length - tailCount) };
}

// =============================================================================
// Documents
// =============================================================================

export type DocumentGroup = 'CORE' | 'FINANCIAL' | 'PROJECT_COLLATERAL';

/**
 * How the stage-5 screen groups a variant's checklist. A presentation
 * grouping only: the checklist configuration carries no group, and whether a
 * document is mandatory comes from the checklist, never from here.
 */
const GROUP_OF: Readonly<Record<string, DocumentGroup>> = {
  TRADE_LICENCE: 'CORE',
  OWNER_EMIRATES_ID: 'CORE',
  PERSONAL_BUREAU_REPORT: 'CORE',
  COMPANY_PROFILE: 'CORE',
  PERSONAL_BANK_STATEMENT_12M: 'FINANCIAL',
  COMPANY_BANK_STATEMENT_12M: 'FINANCIAL',
  AUDITED_FINANCIALS_2Y: 'FINANCIAL',
  SALARY_CERTIFICATE: 'FINANCIAL',
  WPS_SALARY_REPORT: 'FINANCIAL',
  SUPPLIER_QUOTATIONS: 'PROJECT_COLLATERAL',
  RENTAL_CONTRACT: 'PROJECT_COLLATERAL',
  ASSET_VALUATION_REPORT: 'PROJECT_COLLATERAL',
};

export const documentGroup = (documentType: string): DocumentGroup => GROUP_OF[documentType] ?? 'PROJECT_COLLATERAL';

// =============================================================================
// Display formatting (display only — never fed back into a decision)
// =============================================================================

const pad2 = (n: bigint): string => n.toString().padStart(2, '0');
const sign = (v: bigint): [string, bigint] => (v < 0n ? ['-', -v] : ['', v]);

/** 14000 → '1.40×' (per ten thousand, truncated to two places). */
export function formatTimes(perTenThousand: bigint): string {
  const [s, v] = sign(perTenThousand);
  return `${s}${(v / 10_000n).toString()}.${pad2((v % 10_000n) / 100n)}×`;
}

/** 388 → '3.88%'. */
export function formatPercent(perTenThousand: bigint): string {
  const [s, v] = sign(perTenThousand);
  return `${s}${(v / 100n).toString()}.${pad2(v % 100n)}%`;
}

/** A section or criterion score, per ten thousand, as points out of 100: 7760 → '77.60'. */
export const formatPoints = (perTenThousand: bigint): string => {
  const [s, v] = sign(perTenThousand);
  return `${s}${(v / 100n).toString()}.${pad2(v % 100n)}`;
};

/** The facts held "×" rather than as a percentage. */
const TIMES_FACTS = new Set(['dscrPerTenThousand', 'currentRatioPerTenThousand', 'commitmentRatioPerTenThousand']);

const asBigint = (v: FactValue | number | string): bigint | undefined => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return undefined;
};

/** A policy fact for display, by its name: ratios as ×, shares as %, the risk-analysis score out of 10, flags as yes/no. */
export function formatFact(fact: string, value: FactValue | number | string | undefined, arabic: boolean): string {
  if (value === undefined) return '—';
  if (typeof value === 'boolean') return value ? (arabic ? 'نعم' : 'Yes') : (arabic ? 'لا' : 'No');
  if (fact === 'sectorPriority' && value === 'PRIORITY') return arabic ? 'ذو أولوية' : 'Priority';
  if (fact === 'sectorPriority' && value === 'NON_PRIORITY') return arabic ? 'غير ذي أولوية' : 'Non-priority';
  const n = asBigint(value);
  if (n === undefined) return String(value);
  if (fact === 'riskAnalysisScorePerTenThousand') { const [s, v] = sign(n); return `${s}${(v / 1_000n).toString()}.${pad2((v % 1_000n) / 10n)} / 10`; }
  if (TIMES_FACTS.has(fact)) return formatTimes(n);
  if (fact.endsWith('PerTenThousand')) return formatPercent(n);
  return n.toString();
}

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as const;

/**
 * A quantity's Latin digits to Arabic-Indic, for Arabic screens: the digits,
 * the decimal point between two digits (٫), the thousands comma between two
 * digits (٬) and the percent sign (٪). A full stop that ends a sentence is
 * not between two digits and is left alone. Identifiers (versions, hashes,
 * references) are never passed through this; they stay Latin inside <bdi>.
 */
export const arabicDigits = (s: string): string =>
  s
    .replace(/(\d)\.(?=\d)/g, '$1٫')
    .replace(/(\d),(?=\d)/g, '$1٬')
    .replace(/%/g, '٪')
    .replace(/\d/g, (d) => ARABIC_INDIC[Number(d)] ?? d);

// =============================================================================
// Notices and refusals
// =============================================================================

export const NOTICES: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  FIGURE_PROPOSED: { en: 'Figure recorded. It is used once verified.', ar: 'سُجّل الرقم، ويُعتمد بعد التحقق منه.' },
  FIGURE_VERIFIED: { en: 'Figure verified.', ar: 'تم التحقق من الرقم.' },
  DOCUMENT_PRESENTED: { en: 'Document recorded by reference.', ar: 'سُجّل المستند بمرجعه.' },
  INPUTS_RECORDED: { en: 'Assessment inputs recorded.', ar: 'سُجّلت مدخلات التقييم.' },
  SUBMITTED: { en: 'Submitted to credit assessment.', ar: 'أُحيل الطلب إلى التقييم الائتماني.' },
  ASSESSED: { en: 'Assessment run and recorded.', ar: 'نُفّذ التقييم وسُجّل.' },
  APPROVED: { en: 'Approved straight through by the checker.', ar: 'اعتمده المراجِع مباشرةً.' },
  COMMITTEE_APPROVED: { en: 'Approved by the credit committee.', ar: 'اعتمدته لجنة الائتمان.' },
  COMMITTEE_DECLINED: { en: 'Declined by the credit committee.', ar: 'رفضته لجنة الائتمان.' },
  OFFER_GENERATED: { en: 'Offer letter generated.', ar: 'أُعدّ خطاب العرض.' },
  OFFER_SENT: { en: 'Offer sent: the notification is queued on the outbox.', ar: 'أُرسل العرض: الإشعار في قائمة الإرسال.' },
  SIGNED: { en: 'Signature recorded.', ar: 'سُجّل التوقيع.' },
  DISBURSED: { en: 'Disbursement recorded.', ar: 'سُجّل الصرف.' },
  PORTFOLIO_RECORDED: { en: 'Portfolio status recorded.', ar: 'سُجّلت حالة المحفظة.' },
  WITHDRAWN: { en: 'Application withdrawn.', ar: 'سُحب الطلب.' },
};

/**
 * The refusals the business screens can come back with, worded for the
 * officer in both languages. The page renders a refusal from this map by its
 * reason code and nothing else: the redirect's query string is not trusted
 * to carry words (a crafted link could otherwise put any sentence inside the
 * workbench's own refusal panel).
 */
export const REFUSALS: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  FIGURES_NOT_VERIFIED: { en: 'Every required figure is verified before the application goes to credit assessment.', ar: 'يجب التحقق من جميع الأرقام المطلوبة قبل الإحالة إلى التقييم.' },
  DOCUMENTS_MISSING: { en: 'Every mandatory document is presented before the application goes to credit assessment.', ar: 'يجب تقديم جميع المستندات الإلزامية قبل الإحالة إلى التقييم.' },
  FOUR_EYES_REQUIRED: { en: 'A figure keyed by an officer is verified by a different officer (four eyes).', ar: 'الرقم الذي أدخله موظف يتحقق منه موظف آخر (مبدأ العيون الأربع).' },
  FOUR_EYES_SELF_APPROVAL: { en: 'The officer who submitted the application may not approve or decide it.', ar: 'لا يجوز للموظف الذي أحال الطلب أن يعتمده أو يبت فيه.' },
  TRANSITION_NOT_ALLOWED: { en: 'This action is not available at the application’s current stage.', ar: 'هذا الإجراء غير متاح في المرحلة الحالية للطلب.' },
  AMOUNT_MALFORMED: { en: 'Enter the amount as a number with at most two decimals.', ar: 'أدخل المبلغ رقماً بخانتين عشريتين على الأكثر.' },
  AMOUNT_NOT_POSITIVE: { en: 'The amount must be positive.', ar: 'يجب أن يكون المبلغ موجباً.' },
  INPUT_MALFORMED: { en: 'Each assessment input is a whole number; the collateral value is an amount.', ar: 'كل مدخل من مدخلات التقييم عدد صحيح، وقيمة الضمان مبلغ.' },
  INPUT_OUT_OF_RANGE: { en: 'A per-ten-thousand input is between 0 and 100,000.', ar: 'المدخل المعبَّر عنه من عشرة آلاف يقع بين ٠ و١٠٠٬٠٠٠.' },
  DOCUMENT_REF_INVALID: { en: 'A document is presented by its reference, not its content.', ar: 'يُقدَّم المستند بمرجعه، لا بمحتواه.' },
  DOCUMENT_TYPE_INVALID: { en: 'The document type is a code from the checklist.', ar: 'نوع المستند رمز من قائمة المستندات.' },
  ASSESSMENT_INPUTS_MISSING: { en: 'Record the bureau result and the officer’s assessment inputs before scoring.', ar: 'سجّل نتيجة المكتب الائتماني ومدخلات الموظف قبل التقييم.' },
  COMMITTEE_REASON_REQUIRED: { en: 'A committee decision is recorded with its reason.', ar: 'يُسجَّل قرار اللجنة مع سببه.' },
  SIGNED_LETTER_NOT_SENT_LETTER: { en: 'The signature is on a different letter from the one sent.', ar: 'التوقيع على خطاب غير الخطاب المرسل.' },
  OFFER_NOT_GENERATED: { en: 'Generate the offer letter first.', ar: 'أعدّ خطاب العرض أولاً.' },
  FIGURE_NOT_FOUND: { en: 'There is no current figure with that id; it may have been replaced.', ar: 'لا يوجد رقم حالي بهذا المعرّف؛ ربما استُبدل.' },
  FIGURE_ALREADY_VERIFIED: { en: 'A verified figure is replaced by a new one, never verified again.', ar: 'الرقم المتحقق منه يُستبدل برقم جديد، ولا يُعاد التحقق منه.' },
  BUREAU_REF_INVALID: { en: 'The bureau report is recorded by its reference.', ar: 'يُسجَّل تقرير المكتب الائتماني بمرجعه.' },
  BUREAU_SCORE_INVALID: { en: 'The bureau score is the bureau’s own whole number.', ar: 'درجة المكتب الائتماني عدد صحيح كما يصدره المكتب.' },
  EMPLOYEES_INVALID: { en: 'Full-time employees is a whole, non-negative count.', ar: 'عدد الموظفين بدوام كامل عدد صحيح غير سالب.' },
  EXPERIENCE_INVALID: { en: 'Relevant experience is a whole number of years.', ar: 'الخبرة ذات الصلة عدد صحيح من السنوات.' },
  COLLATERAL_NEGATIVE: { en: 'The collateral value is not negative.', ar: 'قيمة الضمان ليست سالبة.' },
  DAYS_PAST_DUE_INVALID: { en: 'Days past due is a whole, non-negative count.', ar: 'أيام التأخر عدد صحيح غير سالب.' },
  ARREARS_NEGATIVE: { en: 'Arrears are not negative.', ar: 'المتأخرات ليست سالبة.' },
  WITHDRAWAL_REASON_REQUIRED: { en: 'A withdrawal records why.', ar: 'يُذكر سبب السحب.' },
  SPREAD_INCOMPLETE: { en: 'Every required figure is verified first.', ar: 'يجب التحقق من جميع الأرقام المطلوبة أولاً.' },
  NOT_STRAIGHT_THROUGH: { en: 'Only a straight-through assessment is approved without the committee.', ar: 'لا يُعتمد دون اللجنة إلا الطلب المؤهل للاعتماد المباشر.' },
  SIGNATURE_REF_REQUIRED: { en: 'The signing service’s reference is required.', ar: 'مرجع خدمة التوقيع مطلوب.' },
  PAYMENT_REF_REQUIRED: { en: 'The payment instruction’s reference is required.', ar: 'مرجع أمر الدفع مطلوب.' },
  CHANNEL_REQUIRED: { en: 'At least one notification channel is required.', ar: 'يلزم وجود قناة إشعار واحدة على الأقل.' },
  BUSINESS_APPLICATION_NOT_FOUND: { en: 'There is no business application with that id for this institution.', ar: 'لا يوجد طلب منشأة بهذا المعرّف لدى هذه المؤسسة.' },
  PRODUCT_NOT_IN_CATALOGUE: { en: 'The product is not enabled in this institution’s catalogue.', ar: 'المنتج غير مفعّل في كتالوج هذه المؤسسة.' },
  RATIO_DENOMINATOR_ZERO: { en: 'The debt burden before this facility needs a positive annual revenue.', ar: 'يتطلب عبء الدين قبل هذا التمويل إيرادات سنوية موجبة.' },
  NO_ACTIVE_TENANT: { en: 'No institution is onboarded under the deployment’s jurisdiction.', ar: 'لا توجد مؤسسة مسجلة في الولاية التي يعمل بها التطبيق.' },
};

const GENERIC_REFUSAL = { en: 'The action could not be completed. See the control code below.', ar: 'تعذّر تنفيذ الإجراء. راجع رمز الضابط أدناه.' } as const;

/**
 * A refusal's explanation in the screen's language, from its reason code
 * only: the workbench's own wording, then the service's Arabic wording for
 * a reason it raises itself, then a generic line naming the control.
 */
export function refusalText(reason: string | undefined, arabic: boolean): string {
  const known = reason === undefined ? undefined : REFUSALS[reason];
  if (known !== undefined) return arabic ? known.ar : known.en;
  const service = arabic && reason !== undefined ? (REASONS as Readonly<Record<string, string>>)[reason] : undefined;
  return service ?? (arabic ? GENERIC_REFUSAL.ar : GENERIC_REFUSAL.en);
}

/** A control code or reason code from the query string, shown only when it has the shape of one (e.g. OP-DETERMINACY, FIGURES_NOT_VERIFIED). */
export const isControlCode = (s: string | undefined): s is string => s !== undefined && /^[A-Z]{2,8}-[A-Z0-9-]{2,40}$/.test(s);
export const isReasonCode = (s: string | undefined): s is string => s !== undefined && /^[A-Z][A-Z0-9_]{2,60}$/.test(s);

/**
 * What a business action's redirect may carry. A `message` parameter, if a
 * link has one, is not part of it and is never read: refusal words come only
 * from the reason-code map above.
 */
export interface ShellQuery {
  readonly notice?: string;
  readonly control?: string;
  readonly reason?: string;
}

/** The refusal panel's content from a redirect's query, or undefined when there is none — words from the reason map only. */
export function refusalFromQuery(query: ShellQuery, arabic: boolean): { readonly control: string; readonly explanation: string } | undefined {
  if (!isControlCode(query.control)) return undefined;
  const reason = isReasonCode(query.reason) ? query.reason : undefined;
  return { control: reason === undefined ? query.control : `${query.control} · ${reason}`, explanation: refusalText(reason, arabic) };
}

// =============================================================================
// Display words (codes are never shown raw)
// =============================================================================

type Words = { readonly en: string; readonly ar: string };

/** 'STRAIGHT_THROUGH' → 'Straight through'. The English last resort for a code no map knows yet. */
export function humanise(code: string): string {
  const words = code.toLowerCase().split('_').filter((w) => w !== '').join(' ');
  return words === '' ? code : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/** A code's words from a bilingual map; an unmapped code is humanised in English and named as unmapped in Arabic — never shown raw. */
export function codeWords(map: Readonly<Record<string, Words>>, code: string, arabic: boolean): string {
  const l = map[code];
  if (l !== undefined) return arabic ? l.ar : l.en;
  return arabic ? 'قيمة غير مُعرَّفة' : humanise(code);
}

/** An application's status, with the chip tone it shows in. */
export const STATUS_WORDS: Readonly<Record<string, Words & { readonly tone: ChipTone }>> = {
  RECEIVED: { en: 'Received', ar: 'مستلم', tone: 'brand' },
  SPREADING: { en: 'Financial analysis', ar: 'التحليل المالي', tone: 'brand' },
  SUBMITTED: { en: 'Submitted', ar: 'مُحال للتقييم', tone: 'brand' },
  ASSESSED: { en: 'Assessed · straight through', ar: 'مُقيَّم · اعتماد مباشر', tone: 'good' },
  IN_COMMITTEE: { en: 'With credit committee', ar: 'لدى لجنة الائتمان', tone: 'warn' },
  APPROVED: { en: 'Approved', ar: 'معتمد', tone: 'good' },
  DECLINED: { en: 'Declined', ar: 'مرفوض', tone: 'bad' },
  OFFER_SENT: { en: 'Offer sent', ar: 'أُرسل العرض', tone: 'brand' },
  SIGNED: { en: 'Signed', ar: 'موقّع', tone: 'good' },
  DISBURSED: { en: 'Disbursed', ar: 'مصروف', tone: 'good' },
  WITHDRAWN: { en: 'Withdrawn', ar: 'مسحوب', tone: 'neutral' },
};

/** The fund's risk levels. The policy's own band labels are preferred where the policy is loaded. */
export const RISK_LEVEL_LABELS: Readonly<Record<string, Words>> = {
  VERY_LOW: { en: 'Very low risk', ar: 'مخاطر منخفضة جداً' },
  LOW: { en: 'Low risk', ar: 'مخاطر منخفضة' },
  MEDIUM: { en: 'Medium risk', ar: 'مخاطر متوسطة' },
  MODERATE: { en: 'Moderate risk', ar: 'مخاطر متوسطة' },
  HIGH: { en: 'High risk', ar: 'مخاطر مرتفعة' },
  VERY_HIGH: { en: 'Very high risk', ar: 'مخاطر مرتفعة جداً' },
};

/** The assessment's route (AssessmentOutcome). */
export const ROUTE_LABELS: Readonly<Record<string, Words>> = {
  STRAIGHT_THROUGH: { en: 'Straight through — checker approval', ar: 'اعتماد مباشر — بموافقة المراجِع' },
  COMMITTEE: { en: 'Credit committee', ar: 'لجنة الائتمان' },
  REFER: { en: 'Referred to the credit committee', ar: 'مُحال إلى لجنة الائتمان' },
  DECLINE: { en: 'Decline', ar: 'رفض' },
};

/** A risk level's words: the policy's band label for it if given, else the static map. */
export function riskLevelWords(level: string, arabic: boolean, bands?: readonly { readonly level: string; readonly label: Words }[]): string {
  const band = bands?.find((b) => b.level === level);
  if (band !== undefined) return arabic ? band.label.ar : band.label.en;
  return codeWords(RISK_LEVEL_LABELS, level, arabic);
}

/**
 * The variant's provenance note. The catalogue's own `note` is an English
 * engineering note that names where the illustrative values came from,
 * vendor included; it is not screen copy and is not rendered. This neutral
 * line says what an officer needs: the values are illustrative until the
 * fund's product paper replaces them.
 */
export const VARIANT_NOTE: Words = {
  en: 'Illustrative values from the partner’s initial prototype — to be replaced by the fund’s product paper.',
  ar: 'قيم توضيحية من نموذج الشريك الأولي — تُستبدل بورقة منتجات الصندوق.',
};

// =============================================================================
// The offer screen's copy
// =============================================================================

/** The line the offer email puts between its English body and its Arabic summary (core/notifications/offer-notification.ts). */
export const ARABIC_SUMMARY_MARKER = '— ملخص بالعربية —';

/** The offer email's body split at the Arabic summary marker, so an Arabic screen can show the Arabic first. No `arabic` part when there is no marker. */
export function splitOfferEmail(body: string): { readonly english: string; readonly arabic?: string } {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.trim() === ARABIC_SUMMARY_MARKER);
  if (at < 0) return { english: body };
  return { english: lines.slice(0, at).join('\n').trimEnd(), arabic: lines.slice(at + 1).join('\n').trim() };
}

/** The Confirm & Send button's words: the channels it really sends on, and no document that does not exist yet. */
export const SEND_LABEL: Words = { en: 'Confirm & Send — Email + SMS', ar: 'تأكيد وإرسال — بريد + رسالة نصية' };

/** The third automated action: the letter goes by reference; a PDF arrives once the document platform is licensed. */
export const LETTER_ACTION: { readonly title: Words; readonly body: Words } = {
  title: { en: 'Offer letter (by reference)', ar: 'خطاب العرض (بالمرجع)' },
  body: {
    en: 'The hashed bilingual letter, sent by its reference and version. The PDF arrives when the document platform is licensed; until then the letter is the structured version previewed below.',
    ar: 'الخطاب الثنائي اللغة، يُرسل بمرجعه وإصداره (بصمته الرقمية). يصل ملف PDF عند ترخيص منصة المستندات؛ وإلى ذلك الحين فالخطاب هو النسخة المنظمة المعروضة أدناه.',
  },
};
