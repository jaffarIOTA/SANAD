/**
 * Credit Assessment — stage 5 → 6.
 *
 * Before scoring: the inputs the scorecard reads beyond the statements (the
 * bureau snapshot, the officer's assessments, the collateral), then Run.
 * After scoring, read-only, from the recorded trace — never recomputed here:
 *
 *   - the debt-burden breakdown and the score tiles;
 *   - the scoring matrix for both sections, the cumulative formula;
 *   - the knock-outs, each with threshold, value and result;
 *   - the decisioning path: risk level, route (straight through or the
 *     credit committee) with its reasons, and the risk-aligned terms;
 *   - the decision: the checker approves a straight-through case, a committee
 *     member (a different principal from the submitting officer) decides a
 *     referred one; then the offer is generated.
 *
 * Every threshold, weight and band is the fund's policy, ILLUSTRATIVE until
 * the fund supplies its own (config/tenants/sme-fund-ae/credit-policy).
 */

import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { loadSmeAssessmentPolicy } from '@sanad/config/loader.ts';
import type { CriterionRisk, SectionTrace } from '@sanad/core/decisioning/sme-assessment.ts';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import {
  approveStraightThroughAction,
  committeeDecisionAction,
  generateOfferAction,
  recordAssessmentInputsAction,
  runAssessmentAction,
} from '../../../../../server/business-actions.ts';
import {
  type CommitteeApprovalDefaults,
  committeeApprovalDefaults,
  getApplication,
  syncBusiness,
} from '../../../../../server/business.ts';
import { pageStaff } from '../../../../../server/session.ts';
import type { StaffPrincipal } from '../../../../../server/staff.ts';
import { Gate } from '../../../Gate.tsx';
import { formatFact, formatPercent, formatPoints } from '../../../../../server/business-dashboard.ts';
import { staffJurisdiction } from '../../../../../server/jurisdiction.ts';
import {
  ApplicationShell,
  BTN_PRIMARY,
  BTN_SECONDARY,
  Chip,
  DisabledAction,
  DividedBy,
  Field,
  FormContext,
  type Formatters,
  INPUT,
  Id,
  MetricTile,
  ROUTE_LABELS,
  SectionCard,
  TH,
  TH_END,
  formatters,
  RequestedVsApproved,
  humanise,
  label,
  riskLevelLabel,
} from '../../ui.tsx';

type Query = {
  readonly notice?: string;
  readonly control?: string;
  readonly reason?: string;
  readonly tenant?: string;
};

const RISK_TONE: Readonly<Record<CriterionRisk, 'good' | 'warn' | 'bad'>> = {
  LOW: 'good',
  MODERATE: 'warn',
  HIGH: 'bad',
};
const RISK_LABEL: Readonly<Record<CriterionRisk, { readonly en: string; readonly ar: string }>> = {
  LOW: { en: 'Low', ar: 'منخفضة' },
  MODERATE: { en: 'Moderate', ar: 'متوسطة' },
  HIGH: { en: 'High', ar: 'مرتفعة' },
};

const ROUTE_TONE: Readonly<Record<string, 'good' | 'warn' | 'bad'>> = {
  STRAIGHT_THROUGH: 'good',
  COMMITTEE: 'warn',
  REFER: 'warn',
  DECLINE: 'bad',
};

/** Comparison operators as symbols; a code is never shown. */
const OPERATOR: Readonly<Record<string, string>> = { LTE: '≤', GTE: '≥', LT: '<', GT: '>', EQ: '=' };

const REASON: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  KNOCKOUT_FAILED: { en: 'A knock-out criterion failed', ar: 'لم يُستوفَ أحد معايير الاستبعاد' },
  SCORE_BELOW_FLOOR: { en: 'Cumulative score below the lowest risk band', ar: 'الدرجة التراكمية دون أدنى فئة مخاطر' },
  ABOVE_RISK_ALIGNED_MAXIMUM: {
    en: 'Requested amount above the risk level’s maximum',
    ar: 'المبلغ المطلوب يتجاوز الحد الأقصى لفئة المخاطر',
  },
  EQUITY_BELOW_RISK_ALIGNED_MINIMUM: {
    en: 'Own contribution below the risk level’s minimum',
    ar: 'المساهمة الذاتية دون الحد الأدنى لفئة المخاطر',
  },
  STP_AMOUNT_WITHIN_STP_MAXIMUM_NOT_MET: {
    en: 'Amount above the straight-through maximum',
    ar: 'المبلغ يتجاوز الحد الأقصى للاعتماد المباشر',
  },
  STP_RISK_LEVEL_ALLOWED_NOT_MET: {
    en: 'Risk level not allowed straight through',
    ar: 'فئة المخاطر لا تسمح بالاعتماد المباشر',
  },
  STP_COLLATERAL_COVERAGE_MINIMUM_NOT_MET: {
    en: 'Collateral coverage below the straight-through minimum',
    ar: 'تغطية الضمان دون الحد الأدنى للاعتماد المباشر',
  },
  ALL_STP_CONDITIONS_MET: { en: 'Every straight-through condition is met', ar: 'جميع شروط الاعتماد المباشر مستوفاة' },
};

const STP_CHECK: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  AMOUNT_WITHIN_STP_MAXIMUM: { en: 'Amount within the straight-through maximum', ar: 'المبلغ ضمن حد الاعتماد المباشر' },
  RISK_LEVEL_ALLOWED: { en: 'Risk level allowed', ar: 'فئة المخاطر مسموح بها' },
  COLLATERAL_COVERAGE_MINIMUM: { en: 'Collateral coverage', ar: 'تغطية الضمان' },
};

/** A weight per ten thousand as a whole percentage where it is one: 4000 → '40%'. */
const weight = (w: bigint | number): string => {
  const v = BigInt(w);
  return v % 100n === 0n ? `${(v / 100n).toString()}%` : formatPercent(v);
};

export default async function CreditAssessmentPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly applicationId: string }>;
  readonly searchParams: Promise<Query>;
}) {
  const { locale: segment, applicationId: rawId } = await params;
  const query = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const applicationId = decodeURIComponent(rawId);
  // The signed-in person's own institution, and only if the deployment has it active.
  const staff = await pageStaff(segment);
  const j = await staffJurisdiction(staff.tenantId);
  if (j.tenant === undefined) notFound();
  await syncBusiness(j.tenant);
  const view = await getApplication(j.tenant, applicationId);
  if (view === undefined) notFound();
  const f = formatters(locale === 'ar-SA', view.currency);
  const { t } = f;
  const policyResult = loadSmeAssessmentPolicy(j.tenant);
  const policy = policyResult.ok ? policyResult.value : undefined;
  const a = view.application;
  const run = view.latestAssessment;
  const inputs = view.assessmentInputs;
  // The committee form's starting figures and the limits beside them, from the server; the page only shows them.
  const approvalDefaults =
    a.status === 'IN_COMMITTEE' ? await committeeApprovalDefaults(j.tenant, applicationId) : undefined;
  // Inputs are recorded while the application is open (RECEIVED, SPREADING) and lock at submission; from then on they are shown read-only.
  const inputsOpen = ['RECEIVED', 'SPREADING'].includes(a.status);
  const fact = (name: string, value: unknown): string => f.digits(formatFact(name, value as bigint, f.arabic));
  const outOf100 = `/ ${f.n(100)}`;
  const route = run === undefined ? undefined : label(ROUTE_LABELS, run.assessment.outcome, f);
  const riskWords = (level: string): string => riskLevelLabel(level, f, policy?.riskBands);
  const reasonText = (code: string, detail: string): string => {
    if (code === 'KNOCKOUT_FAILED') {
      const ko = run?.assessment.knockouts.find((k) => k.code === detail);
      return `${t(REASON['KNOCKOUT_FAILED']?.en ?? '', REASON['KNOCKOUT_FAILED']?.ar ?? '')}${ko === undefined ? '' : `: ${f.digits(t(ko.label.en, ko.label.ar))}`}`;
    }
    const r = REASON[code];
    return r === undefined ? t(`${humanise(code)}: ${detail}`, 'سبب آخر مسجّل في أثر التقييم') : t(r.en, r.ar);
  };

  return (
    <ApplicationShell
      segment={segment}
      view={view}
      screen="assessment"
      query={query}
      f={f}
      title={t('Credit assessment', 'التقييم الائتماني')}
    >
      {/* -- Inputs ------------------------------------------------------------------------------- */}
      {inputsOpen || inputs !== undefined ? (
        <InputsCard
          segment={segment}
          applicationId={a.applicationId}
          view={view}
          editable={inputsOpen}
          staff={staff}
          f={f}
        />
      ) : null}

      {run === undefined ? (
        <section className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5 shadow-card sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-heading">{t('Run the assessment', 'تشغيل التقييم')}</h2>
            <p className="mt-0.5 text-[13px] text-ink-quiet">
              {t(
                'Knock-outs, the 40/60 scorecard, the risk level and the route — on the verified figures and the recorded inputs.',
                `معايير الاستبعاد وبطاقة الدرجات ${f.n(40)}/${f.n(60)} وفئة المخاطر والمسار — على الأرقام المتحقق منها والمدخلات المسجلة.`,
              )}
            </p>
            <p className="mt-1 text-[13px] text-ink-quiet" data-runs-assessment>
              {f.arabic ? (
                <>
                  يشغّله مراجِع — أنت (<Id>{staff.principalId}</Id>) — لا الموظف الذي أحال الطلب
                  {a.submittedBy === undefined ? null : (
                    <>
                      {' '}
                      (<Id>{a.submittedBy}</Id>)
                    </>
                  )}
                  .
                </>
              ) : (
                <>
                  Run by a checker — you (<Id>{staff.principalId}</Id>) — not the officer who submitted the application
                  {a.submittedBy === undefined ? null : (
                    <>
                      {' '}
                      (<Id>{a.submittedBy}</Id>)
                    </>
                  )}
                  .
                </>
              )}
            </p>
          </div>
          {a.status === 'SUBMITTED' && inputs !== undefined ? (
            <Gate staff={staff} act="BUSINESS_ASSESS" arabic={f.arabic} ownWork={a.submittedBy === staff.principalId}>
              <form action={runAssessmentAction}>
                <FormContext segment={segment} applicationId={a.applicationId} screen="assessment" />
                <button type="submit" className={BTN_PRIMARY}>
                  {t('Run assessment as checker', 'تشغيل التقييم بصفة المراجِع')}
                </button>
              </form>
            </Gate>
          ) : (
            <DisabledAction
              label={t('Run assessment', 'تشغيل التقييم')}
              reason={
                a.status !== 'SUBMITTED'
                  ? t(
                      'Submit the loan application first: every figure verified, every mandatory document present.',
                      'أحِل طلب التمويل أولاً: جميع الأرقام متحقق منها وجميع المستندات الإلزامية مقدمة.',
                    )
                  : t(
                      'The assessment inputs were not recorded before submission, and they lock at submission.',
                      'لم تُسجَّل مدخلات التقييم قبل الإحالة، وهي تُقفل عند الإحالة.',
                    )
              }
            />
          )}
        </section>
      ) : (
        <>
          {/* -- Score tiles ---------------------------------------------------------------------- */}
          <section aria-label={t('Scores', 'الدرجات')} className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {(run.assessment.scorecard?.sections ?? []).map((s) => (
              <MetricTile
                key={s.code}
                label={t(`${s.label.en} score`, `درجة ${s.label.ar}`)}
                value={f.digits(formatPoints(s.scorePerTenThousand))}
                unit={outOf100}
                sub={t(`weight ${weight(s.weightPerTenThousand)}`, `الوزن ${f.digits(weight(s.weightPerTenThousand))}`)}
              />
            ))}
            <MetricTile
              label={t('Cumulative score', 'الدرجة التراكمية')}
              value={
                run.assessment.scorecard === undefined
                  ? '—'
                  : f.digits(formatPoints(run.assessment.scorecard.cumulativeScorePerTenThousand))
              }
              unit={outOf100}
            />
            <MetricTile
              label={t('Bureau score', 'درجة المكتب الائتماني')}
              value={fact('bureauScore', run.facts['bureauScore'])}
              sub={t('AECB snapshot (fixture)', 'لقطة من المكتب (تجريبية)')}
            />
            <MetricTile
              label={t('Owner DBR', 'عبء الدين على المالك')}
              value={fact('ownerDbrPerTenThousand', run.facts['ownerDbrPerTenThousand'])}
            />
            <MetricTile
              label={t('Risk level', 'فئة المخاطر')}
              value={
                run.assessment.riskLabel === undefined
                  ? '—'
                  : t(run.assessment.riskLabel.en, run.assessment.riskLabel.ar)
              }
              tone={run.assessment.outcome === 'DECLINE' ? 'bad' : 'quiet'}
              sub={run.assessment.riskLevel === undefined ? t('not banded', 'غير مصنفة') : route}
            />
          </section>

          {/* -- DBR breakdown -------------------------------------------------------------------- */}
          <SectionCard
            title={t('Debt burden breakdown', 'تفصيل عبء الدين')}
            note={t('From the verified figures, before this facility.', 'من الأرقام المتحقق منها، قبل هذا التمويل.')}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <DbrLine
                title={t('Business DBR before this loan', 'عبء دين المنشأة قبل هذا التمويل')}
                numerator={t('Total debt service', 'إجمالي خدمة الدين')}
                numeratorValue={
                  view.figures.find((x) => x.figure.metric === 'TOTAL_DEBT_SERVICE')?.figure.verification?.value
                    .minorUnits
                }
                denominator={t('Annual revenue', 'الإيرادات السنوية')}
                denominatorValue={
                  view.figures.find((x) => x.figure.metric === 'ANNUAL_REVENUE')?.figure.verification?.value.minorUnits
                }
                result={fact('dbrBeforeLoanPerTenThousand', run.facts['dbrBeforeLoanPerTenThousand'])}
                note={t(
                  'ILLUSTRATIVE derivation, rounded up; scored as a criterion, not a knock-out.',
                  'اشتقاق توضيحي، مقرّب للأعلى؛ يُقيَّم معياراً لا معيار استبعاد.',
                )}
                f={f}
              />
              {(() => {
                const owner = run.ratios.find((r) => r.code === 'OWNER_DEBT_BURDEN');
                const ko = policy?.knockouts.find((k) => k.fact === 'ownerDbrPerTenThousand');
                return (
                  <DbrLine
                    title={t('Owner DBR', 'عبء الدين على المالك')}
                    numerator={t('Monthly debt obligations', 'الالتزامات الشهرية')}
                    numeratorValue={owner?.numeratorMinorUnits}
                    denominator={t('Monthly gross salary', 'الراتب الشهري الإجمالي')}
                    denominatorValue={owner?.denominatorMinorUnits}
                    result={fact('ownerDbrPerTenThousand', run.facts['ownerDbrPerTenThousand'])}
                    note={
                      ko === undefined
                        ? ''
                        : t(
                            `Knock-out: at most ${formatFact(ko.fact, ko.threshold, false)}. Rounded up.`,
                            `معيار استبعاد: ${f.digits(formatFact(ko.fact, ko.threshold, true))} كحد أقصى. مقرّب للأعلى.`,
                          )
                    }
                    f={f}
                  />
                );
              })()}
            </div>
          </SectionCard>

          {/* -- Knock-outs ---------------------------------------------------------------------- */}
          <SectionCard
            title={t('Knock-out criteria', 'معايير الاستبعاد')}
            note={t('Any failure declines before scoring.', 'أي إخفاق يؤدي إلى الرفض قبل احتساب الدرجات.')}
            aside={
              <Chip tone={run.assessment.failedKnockouts.length === 0 ? 'good' : 'bad'}>
                {run.assessment.failedKnockouts.length === 0
                  ? t('All passed', 'اجتيزت جميعها')
                  : t(
                      `${f.n(run.assessment.failedKnockouts.length)} failed`,
                      `${f.n(run.assessment.failedKnockouts.length)} لم يُستوفَ`,
                    )}
              </Chip>
            }
          >
            <div className="relative -mx-5 overflow-x-auto">
              <table className="w-full border-collapse text-[14px]">
                <thead>
                  <tr className="bg-sunken">
                    <th scope="col" className={`${TH} ps-5`}>
                      {t('Criterion', 'المعيار')}
                    </th>
                    <th scope="col" className={TH_END}>
                      {t('Threshold', 'الحد')}
                    </th>
                    <th scope="col" className={TH_END}>
                      {t('Value', 'القيمة')}
                    </th>
                    <th scope="col" className={`${TH} pe-5`}>
                      {t('Result', 'النتيجة')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {run.assessment.knockouts.map((k) => (
                    <tr key={k.code} className="border-t border-line">
                      <td className="py-3 ps-5 pe-3 font-medium text-heading">{f.digits(t(k.label.en, k.label.ar))}</td>
                      <td className="py-3 pe-3 text-end tabular-nums text-ink">
                        <bdi>
                          {OPERATOR[k.operator] ?? ''} {fact(k.fact, k.threshold)}
                        </bdi>
                      </td>
                      <td className="py-3 pe-3 text-end font-semibold tabular-nums text-heading">
                        <bdi>{fact(k.fact, k.actual)}</bdi>
                      </td>
                      <td className="py-3 pe-5">
                        <Chip tone={k.passed ? 'good' : 'bad'}>
                          {k.passed ? t('Pass', 'مستوفٍ') : t('Fail', 'غير مستوفٍ')}
                        </Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* -- Scoring matrix ------------------------------------------------------------------- */}
          {run.assessment.scorecard === undefined ? null : (
            <>
              <div className="grid gap-5 xl:grid-cols-2">
                {run.assessment.scorecard.sections.map((s) => (
                  <MatrixCard key={s.code} section={s} f={f} />
                ))}
              </div>
              <div
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-brand/30 bg-brand-wash px-5 py-4 text-[14px] text-brand-deep"
                aria-label={t('Cumulative score formula', 'معادلة الدرجة التراكمية')}
              >
                {run.assessment.scorecard.sections.map((s, i) => (
                  <span key={s.code} className="inline-flex items-center gap-2">
                    {i > 0 ? (
                      <span aria-hidden className="font-bold">
                        +
                      </span>
                    ) : null}
                    <span>
                      {t(s.label.en, s.label.ar)}{' '}
                      <bdi className="font-semibold tabular-nums">{f.digits(formatPoints(s.scorePerTenThousand))}</bdi>{' '}
                      × <bdi className="tabular-nums">{f.digits(weight(s.weightPerTenThousand))}</bdi>
                    </span>
                  </span>
                ))}
                <span aria-hidden className="font-bold">
                  =
                </span>
                <span className="text-[18px] font-bold tabular-nums">
                  {t('Cumulative', 'التراكمية')}{' '}
                  <bdi>{f.digits(formatPoints(run.assessment.scorecard.cumulativeScorePerTenThousand))}</bdi>
                </span>
                <span className="w-full text-[12px] text-ink-quiet">
                  {t(
                    'Computed from the unrounded section products, rounded down once.',
                    'تُحسب من حاصل الأقسام قبل التقريب، وتُقرّب للأدنى مرة واحدة.',
                  )}
                </span>
              </div>
            </>
          )}

          {/* -- Decisioning path ----------------------------------------------------------------- */}
          <SectionCard
            title={t('Decisioning path', 'مسار القرار')}
            note={
              f.arabic ? (
                <>
                  السياسة <Id>{run.assessment.policyId}</Id>، الإصدار <Id>{run.assessment.policyVersion}</Id> — توضيحية.
                  قيّمه <Id>{run.assessedBy}</Id> بتاريخ {f.epochDate(run.assessedAtEpochSeconds)}.
                </>
              ) : (
                <>
                  Policy <Id>{run.assessment.policyId}</Id>, version <Id>{run.assessment.policyVersion}</Id> —
                  ILLUSTRATIVE. Assessed by <Id>{run.assessedBy}</Id> on {f.epochDate(run.assessedAtEpochSeconds)}.
                </>
              )
            }
            aside={<Chip tone={ROUTE_TONE[run.assessment.outcome] ?? 'warn'}>{route}</Chip>}
          >
            <div className="grid gap-5 lg:grid-cols-3">
              <dl className="grid content-start gap-4">
                <Field label={t('Risk level', 'فئة المخاطر')}>
                  {run.assessment.riskLabel === undefined
                    ? '—'
                    : t(run.assessment.riskLabel.en, run.assessment.riskLabel.ar)}
                </Field>
                <Field label={t('Route', 'المسار')}>{route}</Field>
                <Field label={t('Why', 'السبب')}>
                  <ul className="flex list-none flex-col gap-1 p-0 text-[13px] font-normal">
                    {run.assessment.reasons.map((r, i) => (
                      <li key={`${r.code}-${String(i)}`}>{reasonText(r.code, r.detail)}</li>
                    ))}
                  </ul>
                </Field>
              </dl>
              <div className="min-w-0 lg:col-span-2">
                <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet">
                  {t('Straight-through conditions', 'شروط الاعتماد المباشر')}
                </h3>
                <ul className="flex list-none flex-col divide-y divide-line rounded-tile border border-line p-0">
                  {run.assessment.straightThroughChecks.map((c) => {
                    const stp = policy?.straightThrough;
                    const required =
                      c.check === 'AMOUNT_WITHIN_STP_MAXIMUM' && stp !== undefined
                        ? `≤ ${f.money(stp.maxFinancing.minorUnits)} ${f.cur}`
                        : c.check === 'COLLATERAL_COVERAGE_MINIMUM' && stp !== undefined
                          ? `≥ ${f.digits(formatPercent(BigInt(stp.minCollateralCoveragePerTenThousand)))}`
                          : c.check === 'RISK_LEVEL_ALLOWED'
                            ? c.required
                                .split('|')
                                .filter((l) => l !== '')
                                .map(riskWords)
                                .join(f.t(' or ', ' أو '))
                            : f.digits(c.required);
                    const actual =
                      c.check === 'AMOUNT_WITHIN_STP_MAXIMUM'
                        ? `${f.money(a.requested.minorUnits)} ${f.cur}`
                        : c.check === 'COLLATERAL_COVERAGE_MINIMUM'
                          ? fact('collateralCoveragePerTenThousand', run.facts['collateralCoveragePerTenThousand'])
                          : c.check === 'RISK_LEVEL_ALLOWED'
                            ? c.actual === ''
                              ? '—'
                              : riskWords(c.actual)
                            : f.digits(c.actual);
                    return (
                      <li key={c.check} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                        <span className="min-w-0 flex-1 basis-[180px] font-medium text-heading">
                          {t(STP_CHECK[c.check]?.en ?? c.check, STP_CHECK[c.check]?.ar ?? c.check)}
                        </span>
                        <span className="text-ink-quiet">
                          {t('required', 'المطلوب')} <bdi className="tabular-nums text-ink">{required}</bdi>
                        </span>
                        <span className="text-ink-quiet">
                          {t('actual', 'الفعلي')}{' '}
                          <bdi className="font-semibold tabular-nums text-heading">{actual}</bdi>
                        </span>
                        <Chip tone={c.passed ? 'good' : 'warn'}>
                          {c.passed ? t('Met', 'مستوفٍ') : t('Not met', 'غير مستوفٍ')}
                        </Chip>
                      </li>
                    );
                  })}
                </ul>
                {run.assessment.terms === undefined ? null : (
                  <>
                    <h3 className="mb-2 mt-4 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet">
                      {t('Risk-aligned terms', 'الشروط المرتبطة بالمخاطر')}
                    </h3>
                    <dl className="grid gap-4 rounded-tile border border-line px-4 py-3 sm:grid-cols-3">
                      <Field label={t('Maximum financing', 'الحد الأقصى للتمويل')}>
                        <bdi className="tabular-nums">{f.money(run.assessment.terms.maxFinancing.minorUnits)}</bdi>{' '}
                        <span className="text-[12px] font-normal text-ink-quiet">{f.cur}</span>
                      </Field>
                      <Field label={t('Minimum own contribution', 'الحد الأدنى للمساهمة الذاتية')}>
                        {f.digits(formatPercent(BigInt(run.assessment.terms.minEquityContributionPerTenThousand)))}
                      </Field>
                      <Field label={t('Maximum conditions', 'الحد الأقصى للشروط')}>
                        {f.n(run.assessment.terms.maxConditions)}
                      </Field>
                    </dl>
                  </>
                )}
              </div>
            </div>
          </SectionCard>

          <DecisionCard segment={segment} view={view} staff={staff} f={f} approvalDefaults={approvalDefaults} />
        </>
      )}
    </ApplicationShell>
  );
}

function DbrLine({
  title,
  numerator,
  numeratorValue,
  denominator,
  denominatorValue,
  result,
  note,
  f,
}: {
  readonly title: string;
  readonly numerator: string;
  readonly numeratorValue: bigint | undefined;
  readonly denominator: string;
  readonly denominatorValue: bigint | undefined;
  readonly result: string;
  readonly note: string;
  readonly f: Formatters;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-tile border border-line bg-sunken px-4 py-3">
      <h3 className="text-[13px] font-semibold text-heading">{title}</h3>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink">
        <span>
          {numerator}{' '}
          <bdi className="font-semibold tabular-nums">
            {numeratorValue === undefined ? '—' : f.money(numeratorValue)}
          </bdi>
        </span>
        <DividedBy f={f} />
        <span>
          {denominator}{' '}
          <bdi className="font-semibold tabular-nums">
            {denominatorValue === undefined ? '—' : f.money(denominatorValue)}
          </bdi>
        </span>
        <span className="text-[14px] font-semibold text-ink">{f.t('equals', 'يساوي')}</span>
        <bdi className="text-[18px] font-bold tabular-nums text-heading">{result}</bdi>
      </p>
      {note === '' ? null : <p className="text-[12px] text-ink-quiet">{note}</p>}
    </div>
  );
}

function MatrixCard({ section, f }: { readonly section: SectionTrace; readonly f: Formatters }): ReactElement {
  const { t } = f;
  return (
    <SectionCard
      title={t(`${section.label.en} — scoring matrix`, `${section.label.ar} — مصفوفة الدرجات`)}
      note={t(
        `Section weight ${weight(section.weightPerTenThousand)} · section score ${formatPoints(section.scorePerTenThousand)} / 100`,
        `وزن القسم ${f.digits(weight(section.weightPerTenThousand))} · درجة القسم ${f.digits(formatPoints(section.scorePerTenThousand))} / ${f.n(100)}`,
      )}
    >
      <div className="relative -mx-5 overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="bg-sunken">
              <th scope="col" className={`${TH} ps-5`}>
                {t('Criterion', 'المعيار')}
              </th>
              <th scope="col" className={TH}>
                {t('Input', 'المدخل')}
              </th>
              <th scope="col" className={TH_END}>
                {t('Score', 'الدرجة')}
              </th>
              <th scope="col" className={`${TH_END} hidden sm:table-cell`}>
                {t('Weight', 'الوزن')}
              </th>
              <th scope="col" className={`${TH} pe-5`}>
                {t('Risk', 'المخاطر')}
              </th>
            </tr>
          </thead>
          <tbody>
            {section.criteria.map((c) => (
              <tr key={c.code} className="border-t border-line align-top">
                <td className="py-2.5 ps-5 pe-3">
                  <span className="flex flex-col">
                    <span className="font-medium text-heading">{f.digits(t(c.label.en, c.label.ar))}</span>
                    <span className="text-[11px] text-ink-quiet">{f.digits(t(c.band.en, c.band.ar))}</span>
                  </span>
                </td>
                <td className="py-2.5 pe-3 tabular-nums text-ink">
                  <bdi>{f.digits(formatFact(c.fact, c.input, f.arabic))}</bdi>
                </td>
                <td className="py-2.5 pe-3 text-end font-semibold tabular-nums text-heading">
                  <bdi>{f.digits(formatPoints(c.scorePerTenThousand))}</bdi>
                </td>
                <td className="hidden py-2.5 pe-3 text-end tabular-nums text-ink-quiet sm:table-cell">
                  <bdi>{f.digits(weight(c.weightPerTenThousand))}</bdi>
                </td>
                <td className="py-2.5 pe-5">
                  <Chip tone={RISK_TONE[c.risk]}>{t(RISK_LABEL[c.risk].en, RISK_LABEL[c.risk].ar)}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

/** Minor units as the major-unit digit string a form field takes back: 12345n → '123.45'. Integer arithmetic. */
const majorUnits = (minor: bigint): string =>
  `${(minor / 100n).toString()}.${(minor % 100n).toString().padStart(2, '0')}`;

/**
 * The inputs the scorecard reads beyond the statements. Recorded by the
 * officer while the application is open; locked at submission and shown
 * read-only from then on. The bureau consent is chosen from the stage-4
 * verification references handed over — the service accepts no other.
 */
function InputsCard({
  segment,
  applicationId,
  view,
  editable,
  staff,
  f,
}: {
  readonly segment: string;
  readonly applicationId: string;
  readonly view: NonNullable<Awaited<ReturnType<typeof getApplication>>>;
  readonly editable: boolean;
  readonly staff: StaffPrincipal;
  readonly f: Formatters;
}): ReactElement {
  const { t } = f;
  const inputs = view.assessmentInputs;
  const consentRefs = view.application.applicant.upstreamVerificationRefs;
  const field = (name: string, en: string, ar: string, hint?: string, value?: string) => (
    <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-quiet">
      <span>
        {t(en, ar)}
        {hint === undefined ? null : <span className="text-ink-faint"> · {hint}</span>}
      </span>
      <input name={name} required inputMode="numeric" defaultValue={value} className={INPUT} />
    </label>
  );
  const per = t('per 10,000', `من ${f.n(10_000)}`);
  return (
    <SectionCard
      title={t('Assessment inputs', 'مدخلات التقييم')}
      note={t(
        'What the scorecard reads beyond the statements. The bureau result is a recorded snapshot until the AECB rail is verified.',
        'ما تقرؤه بطاقة الدرجات إضافةً إلى القوائم المالية. نتيجة المكتب الائتماني لقطة مسجلة إلى أن يُتحقق من الربط مع المكتب.',
      )}
      aside={
        <>
          {inputs === undefined ? (
            <Chip tone="warn">{t('Not recorded', 'غير مسجلة')}</Chip>
          ) : (
            <Chip tone="good">
              <span>
                {t('Recorded by', 'سجّلها')} <Id>{inputs.recordedBy}</Id>
              </span>
            </Chip>
          )}
          {editable ? null : <Chip tone="neutral">{t('Locked at submission', 'مقفلة منذ الإحالة')}</Chip>}
        </>
      }
    >
      {inputs === undefined ? null : (
        <dl className={`grid gap-4 sm:grid-cols-3 xl:grid-cols-4 ${editable ? 'mb-5' : ''}`} data-inputs-read-only>
          <Field label={t('Bureau report', 'تقرير المكتب')}>
            <Id className="text-[12px]">{inputs.bureau.reportRef}</Id>
          </Field>
          <Field label={t('Bureau consent', 'موافقة الاستعلام الائتماني')}>
            <Id className="text-[12px]">{inputs.bureau.consentId}</Id>
          </Field>
          <Field label={t('Bureau score', 'درجة المكتب')}>{f.n(inputs.bureau.score)}</Field>
          <Field label={t('Full-time employees', 'الموظفون بدوام كامل')}>{f.n(inputs.fullTimeEmployees)}</Field>
          <Field label={t('Relevant experience', 'الخبرة ذات الصلة')}>
            {t(`${f.n(inputs.relevantExperienceYears)} years`, `${f.n(inputs.relevantExperienceYears)} سنوات`)}
          </Field>
          <Field label={t('Sector priority', 'أولوية القطاع')}>
            {inputs.sectorPriority === 'PRIORITY' ? t('Priority', 'ذو أولوية') : t('Non-priority', 'غير ذي أولوية')}
          </Field>
          <Field label={t('Commitment assessment', 'تقييم الالتزام')}>
            <bdi className="tabular-nums">
              {f.digits(formatFact('commitmentRatioPerTenThousand', inputs.commitmentRatioPerTenThousand, f.arabic))}
            </bdi>
          </Field>
          <Field label={t('Risk analysis score', 'درجة تحليل المخاطر')}>
            <bdi className="tabular-nums">
              {f.digits(
                formatFact('riskAnalysisScorePerTenThousand', inputs.riskAnalysisScorePerTenThousand, f.arabic),
              )}
            </bdi>
          </Field>
          <Field label={t('Portfolio repayment', 'نسبة السداد في المحفظة')}>
            <bdi className="tabular-nums">
              {f.digits(
                formatFact('portfolioRepaymentPerTenThousand', inputs.portfolioRepaymentPerTenThousand, f.arabic),
              )}
            </bdi>
          </Field>
          <Field label={t('Failed files', 'الملفات المتعثرة')}>
            <bdi className="tabular-nums">
              {f.digits(formatFact('failedFilesRatePerTenThousand', inputs.failedFilesRatePerTenThousand, f.arabic))}
            </bdi>
          </Field>
          <Field label={t('Audited financials', 'قوائم مالية مدققة')}>
            {inputs.auditedFinancialsAvailable ? t('Available', 'متوفرة') : t('Not available', 'غير متوفرة')}
          </Field>
          <Field label={t('Collateral value', 'قيمة الضمان')}>
            <bdi className="tabular-nums">{f.money(inputs.collateralValue.minorUnits)}</bdi>{' '}
            <span className="text-[12px] font-normal text-ink-quiet">{f.cur}</span>
          </Field>
        </dl>
      )}
      {!editable ? null : (
        <details open={inputs === undefined} className="rounded-tile border border-line px-4 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold text-brand">
            {inputs === undefined ? t('Record inputs', 'تسجيل المدخلات') : t('Record again', 'إعادة التسجيل')}
          </summary>
          <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
            <form action={recordAssessmentInputsAction} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FormContext segment={segment} applicationId={applicationId} screen="assessment" />
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-quiet">
                {t('Bureau report reference', 'مرجع تقرير المكتب')}
                <input name="bureauReportRef" required defaultValue={inputs?.bureau.reportRef} className={INPUT} />
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-quiet">
                {t('Bureau consent (stage-4 reference)', 'موافقة الاستعلام (مرجع المرحلة ٤)')}
                <select
                  name="bureauConsentId"
                  required
                  defaultValue={inputs?.bureau.consentId ?? ''}
                  className={INPUT}
                  dir="ltr"
                >
                  <option value="" disabled>
                    {t('Choose the consent…', 'اختر الموافقة…')}
                  </option>
                  {consentRefs.map((ref) => (
                    <option key={ref} value={ref}>
                      {ref}
                    </option>
                  ))}
                </select>
              </label>
              {field('bureauScore', 'Bureau score', 'درجة المكتب', undefined, inputs?.bureau.score.toString())}
              {field(
                'fullTimeEmployees',
                'Full-time employees',
                'الموظفون بدوام كامل',
                undefined,
                inputs === undefined ? undefined : String(inputs.fullTimeEmployees),
              )}
              {field(
                'relevantExperienceYears',
                'Relevant experience (years)',
                'الخبرة ذات الصلة (سنوات)',
                undefined,
                inputs?.relevantExperienceYears.toString(),
              )}
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-quiet">
                {t('Sector priority', 'أولوية القطاع')}
                <select name="sectorPriority" defaultValue={inputs?.sectorPriority ?? 'NON_PRIORITY'} className={INPUT}>
                  <option value="PRIORITY">{t('Priority sector', 'قطاع ذو أولوية')}</option>
                  <option value="NON_PRIORITY">{t('Non-priority sector', 'قطاع غير ذي أولوية')}</option>
                </select>
              </label>
              {field(
                'commitmentRatioPerTenThousand',
                'Commitment assessment',
                'تقييم الالتزام',
                per,
                inputs?.commitmentRatioPerTenThousand.toString(),
              )}
              {field(
                'riskAnalysisScorePerTenThousand',
                'Risk analysis score',
                'درجة تحليل المخاطر',
                per,
                inputs?.riskAnalysisScorePerTenThousand.toString(),
              )}
              {field(
                'portfolioRepaymentPerTenThousand',
                'Portfolio repayment',
                'نسبة السداد في المحفظة',
                per,
                inputs?.portfolioRepaymentPerTenThousand.toString(),
              )}
              {field(
                'failedFilesRatePerTenThousand',
                'Failed files',
                'الملفات المتعثرة',
                per,
                inputs?.failedFilesRatePerTenThousand.toString(),
              )}
              <label className="flex min-w-0 flex-col gap-1 text-[12px] text-ink-quiet">
                {t(`Collateral value (${f.cur})`, `قيمة الضمان (${f.cur})`)}
                <input
                  name="collateralValue"
                  required
                  inputMode="decimal"
                  defaultValue={inputs === undefined ? undefined : majorUnits(inputs.collateralValue.minorUnits)}
                  className={INPUT}
                />
              </label>
              <label className="flex items-center gap-2 self-end pb-2 text-[13px] text-ink">
                <input
                  type="checkbox"
                  name="auditedFinancialsAvailable"
                  value="true"
                  defaultChecked={inputs?.auditedFinancialsAvailable ?? false}
                />
                {t('Audited financials available', 'قوائم مالية مدققة متوفرة')}
              </label>
              <div className="flex items-end">
                <button type="submit" className={BTN_SECONDARY}>
                  {t('Record inputs', 'تسجيل المدخلات')}
                </button>
              </div>
            </form>
          </Gate>
        </details>
      )}
    </SectionCard>
  );
}

/** Minor units as the plain figure an input holds (12345678 → '123456.78'): display only, integer arithmetic. */
const inputAmount = (minor: bigint): string => {
  const fraction = minor % 100n;
  return fraction === 0n
    ? (minor / 100n).toString()
    : `${(minor / 100n).toString()}.${fraction.toString().padStart(2, '0')}`;
};

/** The committee's approved amount and tenor, pre-filled with the server's defaults, with the limits stated beside them. */
function ApprovedTermsInputs({
  view,
  defaults,
  f,
}: {
  readonly view: NonNullable<Awaited<ReturnType<typeof getApplication>>>;
  readonly defaults: CommitteeApprovalDefaults | undefined;
  readonly f: Formatters;
}): ReactElement {
  const { t } = f;
  const a = view.application;
  const l = defaults?.limits;
  return (
    <fieldset className="flex flex-col gap-3 rounded-tile border border-line px-4 py-3">
      <legend className="px-1 text-[13px] font-semibold text-heading">
        {t('Approved terms (when approving)', 'الشروط المعتمدة (عند الاعتماد)')}
      </legend>
      <p className="text-[12px] text-ink-quiet" data-approval-limits>
        {t('Requested', 'المطلوب')}: <bdi className="tabular-nums">{f.money(a.requested.minorUnits)}</bdi> {f.cur} ·{' '}
        {t(`${f.n(a.tenorMonths)} months`, `${f.n(a.tenorMonths)} شهراً`)}
        {l === undefined ? null : (
          <>
            <br />
            {t(
              `Risk level ${riskLevelLabel(l.riskLevel, f)}: up to`,
              `فئة المخاطر ${riskLevelLabel(l.riskLevel, f)}: حتى`,
            )}{' '}
            <bdi className="tabular-nums">{f.money(l.riskBandMaxAmount.minorUnits)}</bdi> {f.cur} ·{' '}
            {t(
              `variant: up to ${f.money(l.variantMaxAmount.minorUnits)} ${f.cur}, ${f.n(l.variantMinMonths)}–${f.n(l.variantMaxMonths)} months`,
              `الفئة: حتى ${f.money(l.variantMaxAmount.minorUnits)} ${f.cur}، من ${f.n(l.variantMinMonths)} إلى ${f.n(l.variantMaxMonths)} شهراً`,
            )}
          </>
        )}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
          {t(`Approved amount (${f.cur})`, `المبلغ المعتمد (${f.cur})`)}
          <input
            type="text"
            name="approvedAmount"
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            defaultValue={defaults === undefined ? '' : inputAmount(defaults.amount.minorUnits)}
            className={`${INPUT} text-end tabular-nums`}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
          {t('Approved tenor (months)', 'المدة المعتمدة (بالأشهر)')}
          <input
            type="text"
            name="approvedTenorMonths"
            inputMode="numeric"
            dir="ltr"
            autoComplete="off"
            defaultValue={defaults === undefined ? '' : String(defaults.tenorMonths)}
            className={`${INPUT} text-end tabular-nums`}
          />
        </label>
      </div>
      <p className="text-[12px] text-ink-quiet">
        {t(
          'Pre-filled with the lower of the request and the risk level’s maximum, and the lower of the requested tenor and the variant’s maximum. The server checks the figures; the request itself is kept as submitted.',
          'مُعبّأة مسبقاً بالأقل من المبلغ المطلوب والحد الأقصى لفئة المخاطر، وبالأقل من المدة المطلوبة والحد الأقصى لمدة الفئة. يتحقق الخادم من الأرقام، ويبقى الطلب نفسه كما قُدِّم.',
        )}
      </p>
    </fieldset>
  );
}

function DecisionCard({
  segment,
  view,
  staff,
  f,
  approvalDefaults,
}: {
  readonly segment: string;
  readonly view: NonNullable<Awaited<ReturnType<typeof getApplication>>>;
  readonly staff: StaffPrincipal;
  readonly f: Formatters;
  readonly approvalDefaults: CommitteeApprovalDefaults | undefined;
}): ReactElement {
  const { t } = f;
  const a = view.application;
  const base = `/${segment}/business/${encodeURIComponent(a.applicationId)}`;
  let body: ReactElement;
  if (a.status === 'ASSESSED') {
    body = (
      <Gate staff={staff} act="BUSINESS_APPROVE" arabic={f.arabic} ownWork={a.submittedBy === staff.principalId}>
        <form action={approveStraightThroughAction} className="flex flex-wrap items-center justify-between gap-3">
          <FormContext segment={segment} applicationId={a.applicationId} screen="assessment" />
          <p className="text-[13px] text-ink-quiet">
            {f.arabic ? (
              <>
                اعتماد مباشر: يعتمده مراجِع — أنت (<Id>{staff.principalId}</Id>) — لا الموظف الذي أحاله (
                <Id>{a.submittedBy ?? '—'}</Id>).
              </>
            ) : (
              <>
                Straight through: approved by a checker — you (<Id>{staff.principalId}</Id>) — not the submitting
                officer (<Id>{a.submittedBy ?? '—'}</Id>).
              </>
            )}
          </p>
          <button type="submit" className={BTN_PRIMARY}>
            {t('Approve as checker', 'اعتماد بصفة المراجِع')}
          </button>
        </form>
      </Gate>
    );
  } else if (a.status === 'IN_COMMITTEE') {
    body = (
      <Gate staff={staff} act="BUSINESS_COMMITTEE" arabic={f.arabic} ownWork={a.submittedBy === staff.principalId}>
        <form action={committeeDecisionAction} className="flex flex-col gap-3">
          <FormContext segment={segment} applicationId={a.applicationId} screen="assessment" />
          <p className="text-[13px] text-ink-quiet">
            {f.arabic ? (
              <>
                بصفة عضو اللجنة <Id>{staff.principalId}</Id> — شخص غير الموظف الذي أحال الطلب (
                <Id>{a.submittedBy ?? '—'}</Id>).
              </>
            ) : (
              <>
                Acting as committee member <Id>{staff.principalId}</Id> — a different person from the submitting officer
                (<Id>{a.submittedBy ?? '—'}</Id>).
              </>
            )}
          </p>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="sr-only">{t('Decision', 'القرار')}</legend>
            <label className="flex items-center gap-2 text-[14px] text-ink">
              <input type="radio" name="approved" value="true" required />
              {t('Approve', 'اعتماد')}
            </label>
            <label className="flex items-center gap-2 text-[14px] text-ink">
              <input type="radio" name="approved" value="false" />
              {t('Decline', 'رفض')}
            </label>
          </fieldset>
          <ApprovedTermsInputs view={view} defaults={approvalDefaults} f={f} />
          <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
            {t('Reason (recorded with the decision)', 'السبب (يُسجَّل مع القرار)')}
            <textarea
              name="reason"
              required
              minLength={3}
              rows={2}
              className="w-full rounded-tile border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
          </label>
          <div>
            <button type="submit" className={BTN_PRIMARY}>
              {t('Record committee decision', 'تسجيل قرار اللجنة')}
            </button>
          </div>
        </form>
      </Gate>
    );
  } else if (a.status === 'APPROVED') {
    body = (
      <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
        <form action={generateOfferAction} className="flex flex-wrap items-end gap-3">
          <FormContext segment={segment} applicationId={a.applicationId} screen="offer" />
          <div className="w-full">
            <RequestedVsApproved view={view} f={f} />
          </div>
          <p className="w-full text-[13px] text-ink-quiet">
            {a.committee === undefined ? (
              t('Approved straight through.', 'معتمد مباشرة.')
            ) : (
              <>
                {t('Approved by', 'اعتمده')} <Id>{a.committee.decidedBy}</Id>: {a.committee.reason}
              </>
            )}{' '}
            {t(
              'Dates are optional; by default disbursement is 14 days after the offer and the first instalment on the 1st of a month at least 15 days later (ILLUSTRATIVE).',
              `التواريخ اختيارية؛ افتراضياً يكون الصرف بعد ${f.n(14)} يوماً من العرض وأول قسط في أول شهر يلي ذلك بـ ${f.n(15)} يوماً على الأقل (توضيحي).`,
            )}
          </p>
          <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
            {t('Disbursement date', 'تاريخ الصرف')}
            <input type="date" name="disbursementDate" className={INPUT} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
            {t('First due date', 'تاريخ أول قسط')}
            <input type="date" name="firstDueDate" className={INPUT} />
          </label>
          <button type="submit" className={BTN_PRIMARY}>
            {t('Generate offer', 'إعداد العرض')}
          </button>
        </form>
      </Gate>
    );
  } else if (a.status === 'DECLINED') {
    body = (
      <p className="text-[14px] text-blocked">
        {a.committee === undefined ? (
          t('Declined at assessment.', 'رُفض عند التقييم.')
        ) : (
          <>
            {t('Declined by', 'رفضه')} <Id>{a.committee.decidedBy}</Id>: {a.committee.reason}
          </>
        )}
      </p>
    );
  } else {
    body = (
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="w-full">
          <RequestedVsApproved view={view} f={f} />
        </div>
        <p className="text-[13px] text-ink-quiet">
          {a.committee === undefined
            ? t('Approved straight through.', 'معتمد مباشرة.')
            : t(`Committee: ${a.committee.reason}`, `اللجنة: ${a.committee.reason}`)}
        </p>
        <a href={`${base}/offer`} className={BTN_SECONDARY}>
          {t('Open offer & contract', 'فتح العرض والعقد')}
        </a>
      </div>
    );
  }
  return <SectionCard title={t('Decision', 'القرار')}>{body}</SectionCard>;
}
