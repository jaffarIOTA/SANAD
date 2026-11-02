/**
 * The decision pack (UAE M4): the credit memo the decision rests on, the
 * deviations from policy with their justifications, and the conditions and
 * covenants the facility will carry.
 *
 * - The memo is assembled by the server from what is already recorded —
 *   applicant, request, assessment, ratios, bureau, security, credit notes,
 *   committee approvals. Nothing on it is typed here.
 * - Deviations are read from the assessment's route reasons; credit writes the
 *   mitigant; the committee cannot approve while one is unjustified, and a
 *   member who justified one does not approve.
 * - Conditions and covenants are capped by the risk band; covenants come only
 *   from the institution's templates. The pack locks once a committee member
 *   approves, and is frozen by its SHA-256 at approval.
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { localeFromSegment } from '@sanad/i18n/strings.ts';

import {
  addConditionAction,
  addCovenantAction,
  justifyDeviationAction,
  withdrawPackItemAction,
} from '../../../../../server/business-actions.ts';
import { decisionPack, getApplication, securityStatus, syncBusiness } from '../../../../../server/business.ts';
import { formatPercent, formatPoints, formatTimes } from '../../../../../server/business-dashboard.ts';
import { staffJurisdiction } from '../../../../../server/jurisdiction.ts';
import { pageStaff } from '../../../../../server/session.ts';
import { Gate } from '../../../Gate.tsx';
import {
  ApplicationShell,
  BTN_PRIMARY,
  BTN_SMALL,
  Chip,
  Field,
  FormContext,
  INPUT,
  Id,
  SectionCard,
  formatters,
} from '../../ui.tsx';

type Query = { readonly notice?: string; readonly control?: string; readonly reason?: string };

const DEVIATION: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  SCORE_BELOW_FLOOR: { en: 'Cumulative score below the lowest risk band', ar: 'الدرجة التراكمية دون أدنى فئة مخاطر' },
  ABOVE_RISK_ALIGNED_MAXIMUM: {
    en: 'Amount above the risk level’s maximum',
    ar: 'المبلغ يتجاوز الحد الأقصى لفئة المخاطر',
  },
  EQUITY_BELOW_RISK_ALIGNED_MINIMUM: {
    en: 'Own contribution below the risk level’s minimum',
    ar: 'المساهمة الذاتية دون الحد الأدنى لفئة المخاطر',
  },
  STP_AMOUNT_WITHIN_STP_MAXIMUM_NOT_MET: {
    en: 'Amount above the straight-through maximum',
    ar: 'المبلغ يتجاوز حد الاعتماد المباشر',
  },
  STP_RISK_LEVEL_ALLOWED_NOT_MET: {
    en: 'Risk level not allowed straight through',
    ar: 'فئة المخاطر لا تسمح بالاعتماد المباشر',
  },
  STP_COLLATERAL_COVERAGE_MINIMUM_NOT_MET: {
    en: 'Collateral cover below the straight-through minimum',
    ar: 'تغطية الضمان دون حد الاعتماد المباشر',
  },
};

const RATIO: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  DEBT_SERVICE_COVER: { en: 'Debt-service cover', ar: 'تغطية خدمة الدين' },
  CURRENT_RATIO: { en: 'Current ratio', ar: 'نسبة التداول' },
  SALES_GROWTH: { en: 'Sales growth', ar: 'نمو المبيعات' },
  OWNER_DEBT_BURDEN: { en: 'Owner debt burden', ar: 'عبء الدين على المالك' },
};

const FREQUENCY: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  QUARTERLY: { en: 'quarterly', ar: 'ربع سنوي' },
  SEMI_ANNUAL: { en: 'half-yearly', ar: 'نصف سنوي' },
  ANNUAL: { en: 'annually', ar: 'سنوي' },
};

const KIND: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  FINANCIAL: { en: 'Financial', ar: 'مالي' },
  INFORMATION: { en: 'Information', ar: 'إفصاح' },
  NEGATIVE: { en: 'Negative', ar: 'امتناع' },
};

const H3 = 'mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet';

export default async function DecisionPackPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly applicationId: string }>;
  readonly searchParams: Promise<Query>;
}): Promise<ReactElement> {
  const { locale: segment, applicationId: rawId } = await params;
  const query = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const applicationId = decodeURIComponent(rawId);
  const staff = await pageStaff(segment);
  const j = await staffJurisdiction(staff.tenantId);
  if (j.tenant === undefined) notFound();
  await syncBusiness(j.tenant);
  const view = await getApplication(j.tenant, applicationId);
  if (view === undefined) notFound();
  const [pack, security] = await Promise.all([
    decisionPack(j.tenant, applicationId),
    securityStatus(j.tenant, applicationId),
  ]);
  const f = formatters(locale === 'ar-SA', view.currency);
  const { t } = f;
  const a = view.application;
  const run = view.latestAssessment;
  const amount = (minor: bigint) => (
    <>
      <bdi className="tabular-nums">{f.money(minor)}</bdi>{' '}
      <span className="text-[12px] font-normal text-ink-quiet">{f.cur}</span>
    </>
  );
  const pct = (perTenThousand: bigint) => <bdi className="tabular-nums">{f.digits(formatPercent(perTenThousand))}</bdi>;
  const times = (perTenThousand: bigint) => <bdi className="tabular-nums">{f.digits(formatTimes(perTenThousand))}</bdi>;

  return (
    <ApplicationShell
      segment={segment}
      view={view}
      screen="decision"
      query={query}
      f={f}
      title={t('Decision pack', 'حزمة القرار')}
    >
      {run === undefined ? (
        <SectionCard id="memo" title={t('Credit memo', 'المذكرة الائتمانية')}>
          <p className="text-[13px] text-ink-quiet">
            {t('The decision pack opens once the application has been assessed.', 'تُفتح حزمة القرار بعد تقييم الطلب.')}
          </p>
        </SectionCard>
      ) : (
        <>
          {/* -- Credit memo -------------------------------------------------------------------- */}
          <SectionCard
            id="memo"
            title={t('Credit memo', 'المذكرة الائتمانية')}
            note={t(
              'Assembled from what is recorded on the application. Nothing here is typed on this screen.',
              'مُجمَّعة مما هو مسجَّل على الطلب، ولا يُدخل فيها شيء من هذه الشاشة.',
            )}
            aside={
              pack.ok && pack.value.frozen !== undefined ? (
                <Chip tone="good">{t('Frozen at approval', 'مُجمَّدة عند الاعتماد')}</Chip>
              ) : undefined
            }
          >
            <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-credit-memo>
              <Field label={t('Applicant', 'المتقدم')}>
                {f.arabic ? (a.applicant.businessNameAr ?? a.applicant.businessNameEn) : a.applicant.businessNameEn}
              </Field>
              <Field label={t('Years in operation', 'سنوات التشغيل')}>{f.n(a.applicant.yearsInOperation)}</Field>
              <Field label={t('Amount requested', 'المبلغ المطلوب')}>{amount(a.requested.minorUnits)}</Field>
              <Field label={t('Tenor', 'المدة')}>
                {t(`${f.n(a.tenorMonths)} months`, `${f.n(a.tenorMonths)} شهراً`)}
              </Field>
              <Field label={t('Cumulative score', 'الدرجة التراكمية')}>
                {run.assessment.scorecard === undefined ? (
                  '—'
                ) : (
                  <bdi className="tabular-nums">
                    {f.digits(formatPoints(run.assessment.scorecard.cumulativeScorePerTenThousand))}
                  </bdi>
                )}
              </Field>
              <Field label={t('Risk level', 'فئة المخاطر')}>
                {run.assessment.riskLabel === undefined
                  ? '—'
                  : t(run.assessment.riskLabel.en, run.assessment.riskLabel.ar)}
              </Field>
              <Field label={t('Route', 'المسار')}>
                {run.assessment.outcome === 'STRAIGHT_THROUGH'
                  ? t('Straight through', 'اعتماد مباشر')
                  : run.assessment.outcome === 'DECLINE'
                    ? t('Decline', 'رفض')
                    : t('Credit committee', 'لجنة الائتمان')}
              </Field>
              <Field label={t('Bureau score', 'درجة المكتب الائتماني')}>
                {view.assessmentInputs === undefined ? '—' : f.n(view.assessmentInputs.bureau.score)}
              </Field>
              {run.ratios.map((r) => (
                <Field key={r.code} label={t(RATIO[r.code]?.en ?? r.code, RATIO[r.code]?.ar ?? r.code)}>
                  {r.code === 'SALES_GROWTH' || r.code === 'OWNER_DEBT_BURDEN'
                    ? pct(r.perTenThousand)
                    : times(r.perTenThousand)}
                </Field>
              ))}
              {security.ok ? (
                <>
                  <Field label={t('Security lending value', 'القيمة الإقراضية للضمانات')}>
                    {amount(security.value.position.lendingValue.minorUnits)}
                  </Field>
                  <Field label={t('Loan to value', 'نسبة التمويل إلى القيمة')}>
                    {security.value.position.loanToValuePerTenThousand === undefined
                      ? '—'
                      : pct(security.value.position.loanToValuePerTenThousand)}
                  </Field>
                </>
              ) : null}
            </dl>
            {a.creditNotes === undefined ? null : (
              <div className="mt-5">
                <h3 className={H3}>{t('Credit report notes', 'ملاحظات التقرير الائتماني')}</h3>
                <p className="whitespace-pre-wrap text-[14px] text-ink">{a.creditNotes.text}</p>
                <p className="mt-1 text-[11px] text-ink-quiet">
                  {t('Recorded by', 'سجّلها')} <Id>{a.creditNotes.recordedBy}</Id>
                </p>
              </div>
            )}
            {(a.committeeApprovals ?? []).length === 0 ? null : (
              <div className="mt-5">
                <h3 className={H3}>{t('Committee approvals', 'موافقات اللجنة')}</h3>
                <ul className="flex list-none flex-col gap-1 p-0 text-[13px]">
                  {(a.committeeApprovals ?? []).map((c) => (
                    <li key={c.decidedBy}>
                      <Id>{c.decidedBy}</Id> — {amount(c.amount.minorUnits)} ·{' '}
                      {t(`${f.n(c.tenorMonths)} months`, `${f.n(c.tenorMonths)} شهراً`)} · {c.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {pack.ok ? (
              <p className="mt-5 text-[11px] text-ink-quiet" data-pack-digest>
                {pack.value.frozen === undefined
                  ? t('Fingerprint of the pack as it stands', 'بصمة الحزمة بوضعها الحالي')
                  : t('Fingerprint frozen at approval', 'البصمة المُجمَّدة عند الاعتماد')}
                : <Id>{(pack.value.frozen?.digest ?? pack.value.digest).slice(0, 16)}</Id>
                {pack.value.frozen !== undefined && pack.value.frozen.digest !== pack.value.digest ? (
                  <span className="ms-2">
                    <Chip tone="bad">{t('Changed since approval', 'تغيّرت بعد الاعتماد')}</Chip>
                  </span>
                ) : null}
              </p>
            ) : null}
          </SectionCard>

          {!pack.ok ? (
            <SectionCard id="pack" title={t('Decision pack', 'حزمة القرار')}>
              <p className="text-[13px] text-blocked">{pack.error.detail}</p>
            </SectionCard>
          ) : (
            <>
              {/* -- Deviations ------------------------------------------------------------------ */}
              <SectionCard
                id="deviations"
                title={t('Deviations from policy', 'الاستثناءات من السياسة')}
                note={t(
                  'Read from the assessment. Each needs a justification before the committee approves, and whoever justifies one does not approve the case.',
                  'مستخرجة من التقييم. يحتاج كل منها إلى مبرر قبل اعتماد اللجنة، ولا يعتمد الطلبَ من برّر استثناءً فيه.',
                )}
                aside={
                  <Chip tone={pack.value.deviations.every((d) => d.justification !== undefined) ? 'good' : 'warn'}>
                    {pack.value.deviations.length === 0
                      ? t('None', 'لا يوجد')
                      : t(
                          `${f.n(pack.value.deviations.filter((d) => d.justification === undefined).length)} to justify`,
                          `${f.n(pack.value.deviations.filter((d) => d.justification === undefined).length)} بحاجة إلى مبرر`,
                        )}
                  </Chip>
                }
              >
                {pack.value.deviations.length === 0 ? (
                  <p className="text-[13px] text-ink-quiet">
                    {t('The case meets the policy as assessed.', 'يستوفي الطلب السياسة كما قُيّم.')}
                  </p>
                ) : (
                  <ul className="flex list-none flex-col gap-4 p-0" data-deviations>
                    {pack.value.deviations.map((d) => (
                      <li key={d.code} className="rounded-tile border border-line p-4">
                        <p className="text-[14px] font-medium text-heading">
                          {t(DEVIATION[d.code]?.en ?? d.code, DEVIATION[d.code]?.ar ?? d.code)}
                        </p>
                        <p className="text-[12px] text-ink-quiet">
                          <bdi dir="ltr">{d.detail}</bdi>
                        </p>
                        {d.justification === undefined ? null : (
                          <div className="mt-2 text-[13px] text-ink">
                            <p className="whitespace-pre-wrap">{d.justification.text}</p>
                            <p className="text-[11px] text-ink-quiet">
                              {t('Justified by', 'برّره')} <Id>{d.justification.by}</Id>
                            </p>
                          </div>
                        )}
                        {pack.value.editable ? (
                          <Gate staff={staff} act="BUSINESS_CREDIT_NOTES" arabic={f.arabic}>
                            <form action={justifyDeviationAction} className="mt-3 grid gap-2">
                              <FormContext segment={segment} applicationId={a.applicationId} screen="decision" />
                              <input type="hidden" name="code" value={d.code} />
                              <label className="grid gap-1 text-[13px]">
                                {d.justification === undefined
                                  ? t('Mitigant', 'العامل المخفِّف')
                                  : t('Replace the justification', 'استبدال المبرر')}
                                <textarea
                                  name="justification"
                                  required
                                  minLength={10}
                                  maxLength={1000}
                                  rows={3}
                                  className={INPUT}
                                />
                              </label>
                              <button type="submit" className={BTN_SMALL}>
                                {t('Record justification', 'تسجيل المبرر')}
                              </button>
                            </form>
                          </Gate>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              {/* -- Conditions and covenants ---------------------------------------------------- */}
              <SectionCard
                id="conditions"
                title={t('Conditions and covenants', 'الشروط والتعهدات')}
                note={t(
                  'Stated in the offer letter. Conditions precedent are met before first drawdown; conditions subsequent within the days given after it.',
                  'تُذكر في خطاب العرض. تُستوفى الشروط المسبقة قبل السحب الأول، واللاحقة خلال الأيام المحددة بعده.',
                )}
                aside={
                  <Chip
                    tone={
                      pack.value.maxConditions === undefined || pack.value.attached <= pack.value.maxConditions
                        ? 'neutral'
                        : 'bad'
                    }
                  >
                    {pack.value.maxConditions === undefined
                      ? t(`${f.n(pack.value.attached)} attached`, `${f.n(pack.value.attached)} مُضاف`)
                      : t(
                          `${f.n(pack.value.attached)} of ${f.n(pack.value.maxConditions)} the risk band allows`,
                          `${f.n(pack.value.attached)} من ${f.n(pack.value.maxConditions)} تسمح بها فئة المخاطر`,
                        )}
                  </Chip>
                }
              >
                <h3 className={H3}>{t('Conditions', 'الشروط')}</h3>
                {pack.value.conditions.length === 0 ? (
                  <p className="mb-4 text-[13px] text-ink-quiet">{t('None attached.', 'لم يُضف شيء.')}</p>
                ) : (
                  <ul
                    className="mb-4 flex list-none flex-col divide-y divide-line rounded-tile border border-line p-0"
                    data-conditions
                  >
                    {pack.value.conditions.map((c) => (
                      <li
                        key={c.conditionId}
                        className={`flex flex-wrap items-center gap-3 px-4 py-3 ${c.withdrawnBy === undefined ? '' : 'opacity-60'}`}
                      >
                        <Chip tone="neutral">
                          {c.kind === 'PRECEDENT'
                            ? t('Precedent', 'مسبق')
                            : t(
                                `Subsequent · ${f.n(c.dueDaysAfterDisbursement ?? 0)} days`,
                                `لاحق · ${f.n(c.dueDaysAfterDisbursement ?? 0)} يوماً`,
                              )}
                        </Chip>
                        <span className="min-w-0 flex-1 basis-[240px] text-[14px] text-heading">
                          {t(c.textEn, c.textAr)}
                        </span>
                        <span className="text-[11px] text-ink-quiet">
                          <Id>{c.conditionId}</Id> · <Id>{c.addedBy}</Id>
                        </span>
                        {c.withdrawnBy !== undefined ? (
                          <Chip tone="neutral">{t('Withdrawn', 'مسحوب')}</Chip>
                        ) : pack.value.editable ? (
                          <WithdrawButton
                            segment={segment}
                            applicationId={a.applicationId}
                            itemId={c.conditionId}
                            staff={staff}
                            f={f}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                <h3 className={H3}>{t('Covenants', 'التعهدات')}</h3>
                {pack.value.covenants.length === 0 ? (
                  <p className="mb-4 text-[13px] text-ink-quiet">{t('None attached.', 'لم يُضف شيء.')}</p>
                ) : (
                  <ul
                    className="mb-4 flex list-none flex-col divide-y divide-line rounded-tile border border-line p-0"
                    data-covenants
                  >
                    {pack.value.covenants.map((c) => (
                      <li
                        key={c.covenantId}
                        className={`flex flex-wrap items-center gap-3 px-4 py-3 ${c.withdrawnBy === undefined ? '' : 'opacity-60'}`}
                      >
                        <Chip tone="neutral">
                          {t(KIND[c.template.kind]?.en ?? '', KIND[c.template.kind]?.ar ?? '')}
                          {c.template.frequency === undefined
                            ? ''
                            : ` · ${t(FREQUENCY[c.template.frequency]?.en ?? '', FREQUENCY[c.template.frequency]?.ar ?? '')}`}
                        </Chip>
                        <span className="min-w-0 flex-1 basis-[240px] text-[14px] text-heading">
                          {t(c.template.labelEn, c.template.labelAr)}
                        </span>
                        <span className="text-[11px] text-ink-quiet">
                          <Id>{c.covenantId}</Id> · <Id>{c.addedBy}</Id>
                        </span>
                        {c.withdrawnBy !== undefined ? (
                          <Chip tone="neutral">{t('Withdrawn', 'مسحوب')}</Chip>
                        ) : pack.value.editable ? (
                          <WithdrawButton
                            segment={segment}
                            applicationId={a.applicationId}
                            itemId={c.covenantId}
                            staff={staff}
                            f={f}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                {pack.value.editable ? (
                  <Gate staff={staff} act="BUSINESS_CREDIT_NOTES" arabic={f.arabic}>
                    <div className="grid gap-4 lg:grid-cols-2">
                      <details className="rounded-tile border border-line p-4" data-add-condition>
                        <summary className="cursor-pointer select-none text-[14px] font-semibold text-heading">
                          {t('Attach a condition', 'إضافة شرط')}
                        </summary>
                        {pack.value.suggested.length === 0 ? null : (
                          <div className="mt-3 grid gap-2">
                            <p className="text-[12px] text-ink-quiet">
                              {t('Suggested by the security register:', 'مقترح من سجل الضمانات:')}
                            </p>
                            {pack.value.suggested.map((s) => (
                              <form
                                key={s.textEn}
                                action={addConditionAction}
                                className="flex flex-wrap items-center gap-2"
                              >
                                <FormContext segment={segment} applicationId={a.applicationId} screen="decision" />
                                <input type="hidden" name="kind" value="PRECEDENT" />
                                <input type="hidden" name="textEn" value={s.textEn} />
                                <input type="hidden" name="textAr" value={s.textAr} />
                                <span className="min-w-0 flex-1 text-[13px]">{t(s.textEn, s.textAr)}</span>
                                <button type="submit" className={BTN_SMALL}>
                                  {t('Attach', 'إضافة')}
                                </button>
                              </form>
                            ))}
                          </div>
                        )}
                        <form action={addConditionAction} className="mt-3 grid gap-3">
                          <FormContext segment={segment} applicationId={a.applicationId} screen="decision" />
                          <label className="grid gap-1 text-[13px]">
                            {t('Kind', 'النوع')}
                            <select name="kind" className={INPUT} defaultValue="PRECEDENT">
                              <option value="PRECEDENT">
                                {t('Precedent — before first drawdown', 'مسبق — قبل السحب الأول')}
                              </option>
                              <option value="SUBSEQUENT">
                                {t('Subsequent — after first drawdown', 'لاحق — بعد السحب الأول')}
                              </option>
                            </select>
                          </label>
                          <label className="grid gap-1 text-[13px]">
                            {t('In English', 'بالإنجليزية')}
                            <input name="textEn" required minLength={3} maxLength={300} dir="ltr" className={INPUT} />
                          </label>
                          <label className="grid gap-1 text-[13px]">
                            {t('In Arabic', 'بالعربية')}
                            <input name="textAr" required minLength={3} maxLength={300} dir="rtl" className={INPUT} />
                          </label>
                          <label className="grid gap-1 text-[13px]">
                            {t(
                              `Due within (days after first drawdown, subsequent only, up to ${f.n(pack.value.maxSubsequentDueDays)})`,
                              `يُستحق خلال (أيام بعد السحب الأول، للاحق فقط، حتى ${f.n(pack.value.maxSubsequentDueDays)})`,
                            )}
                            <input name="dueDays" inputMode="numeric" dir="ltr" className={INPUT} />
                          </label>
                          <button type="submit" className={BTN_PRIMARY}>
                            {t('Attach condition', 'إضافة الشرط')}
                          </button>
                        </form>
                      </details>
                      <details className="rounded-tile border border-line p-4" data-add-covenant>
                        <summary className="cursor-pointer select-none text-[14px] font-semibold text-heading">
                          {t('Attach a covenant', 'إضافة تعهد')}
                        </summary>
                        <form action={addCovenantAction} className="mt-3 grid gap-3">
                          <FormContext segment={segment} applicationId={a.applicationId} screen="decision" />
                          <label className="grid gap-1 text-[13px]">
                            {t('From the institution’s list', 'من قائمة المؤسسة')}
                            <select name="templateCode" required className={INPUT} defaultValue="">
                              <option value="" disabled>
                                {t('Choose…', 'اختر…')}
                              </option>
                              {pack.value.templates
                                .filter(
                                  (tpl) =>
                                    !pack.value.covenants.some(
                                      (c) => c.withdrawnBy === undefined && c.template.code === tpl.code,
                                    ),
                                )
                                .map((tpl) => (
                                  <option key={tpl.code} value={tpl.code}>
                                    {t(tpl.labelEn, tpl.labelAr)}
                                  </option>
                                ))}
                            </select>
                          </label>
                          <button type="submit" className={BTN_PRIMARY}>
                            {t('Attach covenant', 'إضافة التعهد')}
                          </button>
                        </form>
                      </details>
                    </div>
                  </Gate>
                ) : null}
                <p className="mt-4 text-[11px] text-ink-quiet">
                  {t(
                    'Covenant thresholds and the longest condition subsequent are the institution’s policy.',
                    'حدود التعهدات وأطول مدة للشرط اللاحق من سياسة المؤسسة.',
                  )}
                </p>
              </SectionCard>
            </>
          )}
        </>
      )}
    </ApplicationShell>
  );
}

function WithdrawButton({
  segment,
  applicationId,
  itemId,
  staff,
  f,
}: {
  readonly segment: string;
  readonly applicationId: string;
  readonly itemId: string;
  readonly staff: Awaited<ReturnType<typeof pageStaff>>;
  readonly f: ReturnType<typeof formatters>;
}): ReactElement {
  return (
    <Gate staff={staff} act="BUSINESS_CREDIT_NOTES" arabic={f.arabic}>
      <form action={withdrawPackItemAction}>
        <FormContext segment={segment} applicationId={applicationId} screen="decision" />
        <input type="hidden" name="itemId" value={itemId} />
        <button type="submit" className="text-[12px] font-medium text-ink-quiet hover:text-blocked hover:underline">
          {f.t('Withdraw', 'سحب')}
        </button>
      </form>
    </Gate>
  );
}
