/**
 * Loan Application — stage 5 of the SME direct-lending journey.
 *
 * The application arrives from the upstream customer record (stages 1–4
 * happen in the government portal and the core banking platform). Here the
 * officer:
 *
 *   - checks the applicant and the product request against the variant's
 *     limits (from the tenant's catalogue);
 *   - verifies every financial figure read from the statements (OCR), a rail,
 *     or keyed by an officer — four eyes: a keyed figure is verified by the
 *     checker, never by whoever keyed it (core/applicant/financials.ts);
 *   - sees the ratios the verified spread supports, against the minimums in
 *     the fund's credit policy (ILLUSTRATIVE), and the owner's debt burden;
 *   - completes the variant's document checklist by reference;
 *   - submits to credit assessment — refused by the domain, and disabled
 *     here with the reason, until every figure is verified and every
 *     mandatory document is present.
 *
 * No rule lives in this page: every refusal is the service's.
 */

import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import { loadSmeAssessmentPolicy } from '@sanad/config/loader.ts';
import type { FinancialRatio, FinancialRatioCode } from '@sanad/core/applicant/financials.ts';
import type { SmeAssessmentPolicy } from '@sanad/core/decisioning/sme-assessment.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { proposeFigureAction, presentDocumentAction, submitForAssessmentAction, verifyFigureAction, withdrawApplicationAction } from '../../../../server/business-actions.ts';
import { BUSINESS_ROLES, checklistStatus, figureReadiness, getApplication, productVariants, syncBusiness } from '../../../../server/business.ts';
import { type DocumentGroup, documentGroup, formatFact, formatPercent } from '../../../../server/business-dashboard.ts';
import { workbenchJurisdiction } from '../../../../server/jurisdiction.ts';
import { ApplicationShell, BTN_PRIMARY, BTN_SECONDARY, BTN_SMALL, Chip, DisabledAction, DividedBy, Field, FormContext, type Formatters, INPUT, Id, METRIC_LABELS, SECTOR_LABELS, SectionCard, TH, TH_END, formatters, label, variantProvenanceNote } from '../ui.tsx';

type Query = { readonly notice?: string; readonly control?: string; readonly reason?: string; readonly tenant?: string };

const RATIO_TILES: readonly { readonly code: FinancialRatioCode; readonly fact?: string; readonly en: string; readonly ar: string; readonly times: boolean }[] = [
  { code: 'DEBT_SERVICE_COVER', fact: 'dscrPerTenThousand', en: 'Debt service coverage', ar: 'تغطية خدمة الدين', times: true },
  { code: 'CURRENT_RATIO', fact: 'currentRatioPerTenThousand', en: 'Current ratio', ar: 'نسبة التداول', times: true },
  { code: 'SALES_GROWTH', fact: 'salesGrowthPerTenThousand', en: 'Sales growth', ar: 'نمو المبيعات', times: false },
  { code: 'NET_MARGIN', en: 'Net margin', ar: 'هامش صافي الربح', times: false },
];

const SOURCE: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  OCR: { en: 'OCR · statement', ar: 'قراءة آلية · القوائم' },
  RAIL: { en: 'Rail', ar: 'ربط إلكتروني' },
  OFFICER_ENTRY: { en: 'Keyed by officer', ar: 'إدخال موظف' },
};

const GROUPS: readonly { readonly id: DocumentGroup; readonly en: string; readonly ar: string }[] = [
  { id: 'CORE', en: 'Core documents', ar: 'المستندات الأساسية' },
  { id: 'FINANCIAL', en: 'Financial documents', ar: 'المستندات المالية' },
  { id: 'PROJECT_COLLATERAL', en: 'Project & collateral', ar: 'المشروع والضمانات' },
];

const ITEM_STATUS: Readonly<Record<string, { readonly en: string; readonly ar: string; readonly tone: 'good' | 'bad' | 'warn' | 'neutral' }>> = {
  PRESENT: { en: 'Uploaded', ar: 'مرفوع', tone: 'good' },
  MISSING: { en: 'Missing', ar: 'غير مرفوع', tone: 'bad' },
  EXPIRED: { en: 'Expired', ar: 'منتهي الصلاحية', tone: 'bad' },
  INVALID: { en: 'Invalid', ar: 'غير صالح', tone: 'bad' },
  PENDING: { en: 'Validating', ar: 'قيد التحقق', tone: 'warn' },
};

const OPEN = new Set(['RECEIVED', 'SPREADING']);

/** The knock-out on a fact in the fund's policy: the minimum (or maximum) a ratio tile is held against. */
function knockoutOn(policy: SmeAssessmentPolicy | undefined, fact: string | undefined) {
  return fact === undefined ? undefined : policy?.knockouts.find((k) => k.fact === fact);
}

export default async function LoanApplicationPage({ params, searchParams }: { readonly params: Promise<{ readonly locale: string; readonly applicationId: string }>; readonly searchParams: Promise<Query> }) {
  const { locale: segment, applicationId: rawId } = await params;
  const query = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const applicationId = decodeURIComponent(rawId);
  const j = await workbenchJurisdiction(query.tenant);
  if (j.tenant === undefined) notFound();
  await syncBusiness(j.tenant);
  const view = await getApplication(j.tenant, applicationId);
  if (view === undefined) notFound();
  const f = formatters(locale === 'ar-SA', view.currency);
  const { t } = f;

  const [readiness, checklist, variants] = await Promise.all([figureReadiness(j.tenant, applicationId), checklistStatus(j.tenant, applicationId), productVariants(j.tenant)]);
  const policyResult = loadSmeAssessmentPolicy(j.tenant);
  const policy = policyResult.ok ? policyResult.value : undefined;
  const a = view.application;
  const variant = variants.get(a.variantCode);
  const open = OPEN.has(a.status);
  const purpose = variant?.purposes.find((p) => p.code === a.purpose);
  const handover = view.events.find((e) => e.eventType === 'HANDED_OVER');

  const unverified = view.figures.filter((x) => x.figure.status !== 'VERIFIED');
  const missingFigures = readiness.ok ? [...readiness.value.missingFigures, ...readiness.value.unverifiedFigures] : [];
  const missingDocs = checklist.ok ? checklist.value.report.filter((r) => r.item.required && r.status !== 'PRESENT') : [];
  const ready = readiness.ok && readiness.value.spreadComplete && checklist.ok && checklist.value.complete;

  return (
    <ApplicationShell segment={segment} view={view} screen="application" query={query} f={f} title={t('Loan application', 'طلب التمويل')}>
      {/* -- Hand-over banner ---------------------------------------------------------------- */}
      <div role="note" className="flex flex-col gap-1.5 rounded-card border border-brand/30 bg-brand-wash px-5 py-4 text-[14px] text-brand-deep">
        <p className="font-semibold">
          {t(`Handed over from the upstream customer record at stage 4${handover === undefined ? '' : ` on ${f.epochDate(handover.atEpochSeconds)}`}.`, `مستلم من سجل العميل في الأنظمة السابقة عند المرحلة ${f.n(4)}${handover === undefined ? '' : ` بتاريخ ${f.epochDate(handover.atEpochSeconds)}`}.`)}
        </p>
        <p className="text-[13px] text-ink">
          {t('Application, needs assessment, product application and verification were completed upstream. Verified there, by reference:', 'اكتملت مراحل الطلب وتقييم الاحتياجات وطلب المنتج والتحقق خارج سند. ما تم التحقق منه هناك، بالمرجع:')}
        </p>
        <ul className="flex list-none flex-wrap gap-1.5 p-0">
          {a.applicant.upstreamVerificationRefs.map((ref) => <li key={ref}><Id className="inline-flex rounded-[6px] bg-surface px-2 py-0.5 text-[12px] text-ink-quiet">{ref}</Id></li>)}
        </ul>
      </div>

      {/* -- Applicant and product -------------------------------------------------------------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title={t('Applicant', 'مقدم الطلب')} note={t('As handed over; owners by name and reference only — no identity number is held here.', 'كما استُلم؛ الملاك بالاسم والمرجع فقط — لا يُحفظ هنا أي رقم هوية.')}>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Business', 'المنشأة')}>
              <span className="flex flex-col"><span>{a.applicant.businessNameEn}</span>{a.applicant.businessNameAr === undefined ? null : <span lang="ar" dir="rtl" className="text-[13px] font-normal text-ink-quiet">{a.applicant.businessNameAr}</span>}</span>
            </Field>
            <Field label={t('Trade licence reference', 'مرجع الرخصة التجارية')}><Id>{a.applicant.registrationRef}</Id></Field>
            <Field label={t('Sector', 'القطاع')}>{label(SECTOR_LABELS, a.applicant.sector, f)}</Field>
            <Field label={t('Years in operation', 'سنوات التشغيل')}>{f.n(a.applicant.yearsInOperation)}</Field>
            <Field label={t('Owners', 'الملاك')}>
              <ul className="flex list-none flex-col gap-0.5 p-0">{a.applicant.owners.map((o) => <li key={o.ref}>{o.displayName}</li>)}</ul>
            </Field>
            <Field label={t('Offer notifications to', 'تُرسل الإشعارات إلى')}>
              <span className="flex flex-col text-[13px]">
                {view.contact.emailMasked === undefined ? null : <Id>{view.contact.emailMasked}</Id>}
                {view.contact.mobileMasked === undefined ? null : <Id>{view.contact.mobileMasked}</Id>}
                {view.contact.emailMasked === undefined && view.contact.mobileMasked === undefined ? <span className="text-ink-quiet">{t('No channel recorded', 'لا توجد قناة مسجلة')}</span> : null}
              </span>
            </Field>
          </dl>
        </SectionCard>

        <SectionCard title={t('Product', 'المنتج')} note={t('Conventional SME term finance', 'تمويل تقليدي لأجل للمنشآت')}>
          <dl className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Variant', 'الفئة')}>{variant === undefined ? a.variantCode : t(variant.nameEn, variant.nameAr)}</Field>
            <Field label={t('Purpose', 'الغرض')}>{purpose === undefined ? a.purpose : t(purpose.labelEn, purpose.labelAr)}</Field>
            <Field label={t('Requested amount', 'المبلغ المطلوب')}><bdi className="tabular-nums">{f.money(a.requested.minorUnits)}</bdi> <span className="text-[12px] font-normal text-ink-quiet">{f.cur}</span></Field>
            <Field label={t('Tenor', 'المدة')}>{t(`${f.n(a.tenorMonths)} months`, `${f.n(a.tenorMonths)} شهراً`)}</Field>
            <Field label={t('Grace', 'فترة السماح')}>{a.graceMonths === 0 ? t('None', 'لا يوجد') : t(`${f.n(a.graceMonths)} months`, `${f.n(a.graceMonths)} أشهر`)}</Field>
            <Field label={t('Own contribution', 'المساهمة الذاتية')}>{f.digits(formatPercent(BigInt(a.contributionPerTenThousand)))}</Field>
          </dl>
          {variant === undefined ? null : (
            <p className="mt-4 rounded-tile bg-sunken px-3 py-2.5 text-[12px] leading-relaxed text-ink-quiet">
              <span className="font-semibold text-heading">{t('Variant limits: ', 'حدود الفئة: ')}</span>
              {t(
                `up to ${f.money(variant.maxAmount.minorUnits)} ${f.cur}; ${f.n(variant.minMonths)}–${f.n(variant.maxMonths)} months; grace up to ${f.n(variant.maxGraceMonths)} months; contribution ${formatPercent(BigInt(variant.minContributionPerTenThousand))}–${formatPercent(BigInt(variant.maxContributionPerTenThousand))}${variant.minYearsInOperation > 0 ? `; at least ${f.n(variant.minYearsInOperation)} years in operation` : ''}. Collateral: ${variant.collateral.map((c) => c.labelEn).join(', ') || 'none'}.`,
                `حتى ${f.money(variant.maxAmount.minorUnits)} ${f.cur}؛ من ${f.n(variant.minMonths)} إلى ${f.n(variant.maxMonths)} شهراً؛ سماح حتى ${f.n(variant.maxGraceMonths)} أشهر؛ مساهمة من ${f.digits(formatPercent(BigInt(variant.minContributionPerTenThousand)))} إلى ${f.digits(formatPercent(BigInt(variant.maxContributionPerTenThousand)))}${variant.minYearsInOperation > 0 ? `؛ ${f.n(variant.minYearsInOperation)} سنوات تشغيل على الأقل` : ''}. الضمانات: ${variant.collateral.map((c) => c.labelAr).join('، ') || 'لا يوجد'}.`,
              )}
              {variant.note === undefined ? null : <span className="mt-1 block">{variantProvenanceNote(f)}</span>}
            </p>
          )}
        </SectionCard>
      </div>

      {/* -- Financial analysis ------------------------------------------------------------------- */}
      <SectionCard id="figures" title={t('Financial analysis', 'التحليل المالي')}
        note={f.arabic
          ? <>لا يُستخدم الرقم إلا بعد التحقق منه. يتحقق الموظف (<Id>{BUSINESS_ROLES.officer}</Id>) من الأرقام المقروءة، ويتحقق المراجِع (<Id>{BUSINESS_ROLES.checker}</Id>) من الرقم المُدخل يدوياً — لا من أدخله.</>
          : <>Each figure is used only once verified. Read figures are verified by the officer (<Id>{BUSINESS_ROLES.officer}</Id>); a keyed figure by the checker (<Id>{BUSINESS_ROLES.checker}</Id>) — never by whoever keyed it.</>}
        aside={<Chip tone={unverified.length === 0 && view.figures.length > 0 ? 'good' : 'warn'}>{unverified.length === 0 && view.figures.length > 0 ? t('All verified', 'تم التحقق من الكل') : t(`${f.n(unverified.length)} to verify`, `${f.n(unverified.length)} للتحقق`)}</Chip>}>
        <div className="relative -mx-5 overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr className="bg-sunken">
                <th scope="col" className={`${TH} ps-5`}>{t('Figure', 'البند')}</th>
                <th scope="col" className={`${TH} hidden md:table-cell`}>{t('Source', 'المصدر')}</th>
                <th scope="col" className={TH_END}>{t(`Value (${f.cur})`, `القيمة (${f.cur})`)}</th>
                <th scope="col" className={`${TH} pe-5`}>{t('Verification', 'التحقق')}</th>
              </tr>
            </thead>
            <tbody>
              {view.figures.map(({ figureId, figure }) => {
                const verified = figure.verification;
                const value = verified?.value ?? figure.proposedValue;
                return (
                  <tr key={figureId} className="border-t border-line align-top">
                    <td className="py-3 ps-5 pe-3">
                      <span className="flex flex-col">
                        <span className="font-semibold text-heading">{label(METRIC_LABELS, figure.metric, f)}</span>
                        <Id className="text-[12px] text-ink-quiet">{figure.periodLabel}</Id>
                      </span>
                    </td>
                    <td className="hidden py-3 pe-3 md:table-cell">
                      <span className="flex flex-col gap-0.5">
                        <span className="text-[13px] text-ink">{label(SOURCE, figure.sourceKind, f)}</span>
                        <bdi dir="ltr" className="identifier block max-w-[220px] truncate text-start text-[11px] text-ink-quiet" title={figure.sourceRef}>{figure.sourceRef}</bdi>
                      </span>
                    </td>
                    <td className="py-3 pe-3 text-end">
                      <span className="flex flex-col items-end">
                        <bdi className="font-semibold tabular-nums text-heading">{f.money(value.minorUnits)}</bdi>
                        {verified?.correctedFromProposal === true ? <span className="text-[11px] text-attention">{t('corrected from', 'صُحّح من')} <bdi>{f.money(figure.proposedValue.minorUnits)}</bdi></span> : null}
                      </span>
                    </td>
                    <td className="py-3 pe-5">
                      {verified !== undefined ? (
                        <span className="flex flex-col gap-0.5">
                          <Chip tone="good">{t('Verified', 'تم التحقق')}</Chip>
                          <Id className="text-[11px] text-ink-quiet">{verified.verifiedBy}</Id>
                        </span>
                      ) : open ? (
                        <form action={verifyFigureAction} className="flex flex-wrap items-center gap-2">
                          <FormContext segment={segment} applicationId={a.applicationId} />
                          <input type="hidden" name="figureId" value={figureId} />
                          <input type="hidden" name="sourceKind" value={figure.sourceKind} />
                          <label className="min-w-0 flex-1 basis-[120px]">
                            <span className="sr-only">{t('Corrected amount (optional)', 'المبلغ المصحح (اختياري)')}</span>
                            <input name="correctedAmount" inputMode="decimal" placeholder={t('Correct (optional)', 'تصحيح (اختياري)')} className={INPUT} />
                          </label>
                          <button type="submit" className={BTN_SMALL}>{figure.sourceKind === 'OFFICER_ENTRY' ? t('Verify as checker', 'تحقق كمراجِع') : t('Verify', 'تحقق')}</button>
                          {figure.sourceKind === 'OFFICER_ENTRY' ? <span className="w-full text-[11px] text-ink-quiet">{t('Keyed by', 'أدخله')} <Id>{figure.enteredBy ?? '—'}</Id>{t('; four eyes', '؛ مبدأ العيون الأربع')}</span> : null}
                        </form>
                      ) : <Chip tone="neutral">{t('Not verified', 'لم يُتحقق منه')}</Chip>}
                    </td>
                  </tr>
                );
              })}
              {view.figures.length === 0 ? <tr><td colSpan={4} className="px-5 py-8 text-center text-ink-quiet">{t('No figures read yet.', 'لم تُقرأ أي أرقام بعد.')}</td></tr> : null}
            </tbody>
          </table>
        </div>

        {open ? (
          <details className="mt-4 rounded-tile border border-line px-4 py-3">
            <summary className="cursor-pointer text-[13px] font-semibold text-brand">{t('Key or replace a figure', 'إدخال رقم أو استبداله')}</summary>
            <form action={proposeFigureAction} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <FormContext segment={segment} applicationId={a.applicationId} />
              <label className="text-[12px] text-ink-quiet">{t('Figure', 'البند')}
                <select name="metric" className={`${INPUT} mt-1`}>{Object.keys(METRIC_LABELS).map((m) => <option key={m} value={m}>{label(METRIC_LABELS, m, f)}</option>)}</select>
              </label>
              <label className="text-[12px] text-ink-quiet">{t('Period', 'الفترة')}<input name="periodLabel" required placeholder="FY2025" className={`${INPUT} mt-1`} /></label>
              <label className="text-[12px] text-ink-quiet">{t(`Amount (${f.cur})`, `المبلغ (${f.cur})`)}<input name="amount" required inputMode="decimal" placeholder="0.00" className={`${INPUT} mt-1`} /></label>
              <label className="text-[12px] text-ink-quiet">{t('Source document or rail reference', 'مرجع المستند أو الربط')}<input name="sourceRef" required className={`${INPUT} mt-1`} /></label>
              <div className="flex items-end gap-3">
                <input type="hidden" name="sourceKind" value="OFFICER_ENTRY" />
                <label className="flex items-center gap-1.5 pb-2 text-[12px] text-ink-quiet"><input type="checkbox" name="negative" value="true" />{t('Loss', 'خسارة')}</label>
                <button type="submit" className={BTN_SMALL}>{t('Record', 'تسجيل')}</button>
              </div>
            </form>
            <p className="mt-2 text-[11px] text-ink-quiet">{t('A keyed figure supersedes the current one for that line and is verified by the checker.', 'الرقم المُدخل يحل محل الرقم الحالي للبند، ويتحقق منه المراجِع.')}</p>
          </details>
        ) : null}

        {/* Ratio tiles */}
        <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet">{t('Calculated ratios', 'النسب المحسوبة')}</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {RATIO_TILES.map((tile) => {
            const r: Result<FinancialRatio> | undefined = readiness.ok ? readiness.value.ratios?.[tile.code] : undefined;
            const ko = knockoutOn(policy, tile.fact);
            const shown = r?.ok === true ? f.digits(formatFact(tile.fact ?? (tile.times ? 'dscrPerTenThousand' : 'netMarginPerTenThousand'), r.value.perTenThousand, f.arabic)) : '—';
            const threshold = ko === undefined ? undefined : f.digits(formatFact(ko.fact, ko.threshold, f.arabic));
            const passes = r?.ok === true && ko !== undefined && typeof ko.threshold !== 'boolean' && typeof ko.threshold !== 'string' ? (ko.operator === 'LTE' ? r.value.perTenThousand <= BigInt(ko.threshold) : r.value.perTenThousand >= BigInt(ko.threshold)) : undefined;
            return (
              <div key={tile.code} className="flex min-w-0 flex-col gap-1 rounded-tile border border-line bg-surface px-4 py-3">
                <span className="text-[12px] font-medium uppercase tracking-wide text-ink-quiet">{t(tile.en, tile.ar)}</span>
                <span className="text-[22px] font-bold tabular-nums text-heading"><bdi>{shown}</bdi></span>
                <span className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-quiet">
                  {threshold === undefined ? t('No minimum in the fund’s policy', 'لا حد أدنى في سياسة الصندوق') : t(`Minimum ${threshold}`, `الحد الأدنى ${threshold}`)}
                  {passes === undefined ? null : <Chip tone={passes ? 'good' : 'bad'}>{passes ? t('Pass', 'مستوفٍ') : t('Below minimum', 'دون الحد')}</Chip>}
                </span>
              </div>
            );
          })}
        </div>
        {readiness.ok && !readiness.value.spreadComplete ? <p className="mt-2 text-[12px] text-ink-quiet">{t('Ratios appear once every required figure is verified.', 'تظهر النسب بعد التحقق من جميع الأرقام المطلوبة.')}</p> : null}
        <p className="mt-2 text-[11px] text-ink-faint">{t('Minimums are the knock-outs in the fund’s SME assessment policy — ILLUSTRATIVE until the fund supplies its own.', 'الحدود الدنيا هي معايير الاستبعاد في سياسة تقييم المنشآت لدى الصندوق — توضيحية إلى أن يعتمد الصندوق سياسته.')}</p>

        <OwnerDbr view={view} readiness={readiness} policy={policy} f={f} />
      </SectionCard>

      {/* -- Documents -------------------------------------------------------------------------------- */}
      <SectionCard id="documents" title={t('Document checklist', 'قائمة المستندات')}
        note={!checklist.ok ? undefined : f.arabic
          ? <>قائمة فئة {variant?.nameAr ?? a.variantCode} (الإصدار <Id>{checklist.value.checklist.version}</Id>). تُسجَّل المستندات بمرجعها لا بمحتواها.</>
          : <>The {variant?.nameEn ?? a.variantCode} checklist (version <Id>{checklist.value.checklist.version}</Id>). Documents are recorded by reference, never by content.</>}
        aside={checklist.ok ? <Chip tone={checklist.value.complete ? 'good' : 'warn'}>{checklist.value.complete ? t('Mandatory documents complete', 'المستندات الإلزامية مكتملة') : t(`${f.n(missingDocs.length)} mandatory missing`, `${f.n(missingDocs.length)} إلزامي ناقص`)}</Chip> : undefined}>
        {!checklist.ok ? <p className="text-[13px] text-blocked">{checklist.error.detail}</p> : (
          <div className="flex flex-col gap-5">
            {GROUPS.map((group) => {
              const items = checklist.value.report.filter((r) => documentGroup(r.item.documentType) === group.id);
              if (items.length === 0) return null;
              return (
                <div key={group.id}>
                  <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet">{t(group.en, group.ar)}</h3>
                  <ul className="flex list-none flex-col divide-y divide-line rounded-tile border border-line p-0">
                    {items.map((r) => {
                      const st = ITEM_STATUS[r.status] ?? { en: r.status, ar: r.status, tone: 'neutral' as const };
                      const held = [...view.documents].reverse().find((d) => d.documentType === r.item.documentType);
                      return (
                        <li key={r.item.documentType} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                          <span className="flex min-w-0 flex-1 basis-[220px] flex-col">
                            <span className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-heading">
                              {t(r.item.titleEn, r.item.titleAr)}
                              {r.item.required ? <span className="rounded-full border border-blocked/30 px-2 text-[11px] font-semibold text-blocked">{t('Mandatory', 'إلزامي')}</span> : <span className="rounded-full border border-line-strong px-2 text-[11px] text-ink-quiet">{t('Optional', 'اختياري')}</span>}
                            </span>
                            {held === undefined ? null : <bdi dir="ltr" className="identifier block truncate text-start text-[11px] text-ink-quiet" title={held.documentRef}>{held.documentRef}</bdi>}
                          </span>
                          <Chip tone={st.tone}>{t(st.en, st.ar)}</Chip>
                          {open && r.status !== 'PRESENT' ? (
                            <form action={presentDocumentAction} className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                              <FormContext segment={segment} applicationId={a.applicationId} />
                              <input type="hidden" name="documentType" value={r.item.documentType} />
                              <label className="min-w-0 flex-1 sm:w-[220px] sm:flex-none">
                                <span className="sr-only">{t('Document reference', 'مرجع المستند')}</span>
                                <input name="documentRef" required placeholder={t('Document reference', 'مرجع المستند')} className={INPUT} />
                              </label>
                              <button type="submit" className={BTN_SMALL}>{t('Attach', 'إرفاق')}</button>
                            </form>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>

      {/* -- Submit ---------------------------------------------------------------------------------- */}
      <section className="flex flex-col gap-4 rounded-card border border-line bg-surface p-5 shadow-card sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-heading">{t('Submit to credit assessment', 'الإحالة إلى التقييم الائتماني')}</h2>
          <p className="mt-0.5 text-[13px] text-ink-quiet">
            {open
              ? <>{t('Acting as the officer', 'بصفة الموظف')} (<Id>{BUSINESS_ROLES.officer}</Id>). {t('Scoring runs on the verified figures and the bureau snapshot.', 'يجري التقييم على الأرقام المتحقق منها ونتيجة المكتب الائتماني.')}</>
              : a.submittedAtEpochSeconds === undefined
                ? t('This application is not open for submission.', 'هذا الطلب غير متاح للإحالة.')
                : <>{t(`Submitted on ${f.epochDate(a.submittedAtEpochSeconds)} by`, `أُحيل بتاريخ ${f.epochDate(a.submittedAtEpochSeconds)} بواسطة`)} <Id>{a.submittedBy ?? '—'}</Id>.</>}
          </p>
        </div>
        {open ? (
          ready ? (
            <form action={submitForAssessmentAction}>
              <FormContext segment={segment} applicationId={a.applicationId} screen="assessment" />
              <button type="submit" className={BTN_PRIMARY}>{t('Submit to Credit Assessment', 'إحالة إلى التقييم الائتماني')}</button>
            </form>
          ) : (
            <DisabledAction label={t('Submit to Credit Assessment', 'إحالة إلى التقييم الائتماني')}
              reason={[
                missingFigures.length > 0 ? t(`Verify first: ${missingFigures.map((m) => label(METRIC_LABELS, m, f)).join(', ')}.`, `تحقق أولاً من: ${missingFigures.map((m) => label(METRIC_LABELS, m, f)).join('، ')}.`) : '',
                missingDocs.length > 0 ? t(`Missing mandatory documents: ${missingDocs.map((d) => d.item.titleEn).join(', ')}.`, `مستندات إلزامية ناقصة: ${missingDocs.map((d) => d.item.titleAr).join('، ')}.`) : '',
              ].filter((s) => s !== '').join(' ')} />
          )
        ) : (
          <a href={`/${segment}/business/${encodeURIComponent(a.applicationId)}/assessment`} className={BTN_SECONDARY}>{t('Open credit assessment', 'فتح التقييم الائتماني')}</a>
        )}
      </section>

      {open || ['SUBMITTED', 'ASSESSED', 'IN_COMMITTEE', 'APPROVED', 'OFFER_SENT'].includes(a.status) ? (
        <details className="rounded-card border border-line bg-surface px-5 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold text-ink-quiet">{t('Withdraw this application', 'سحب هذا الطلب')}</summary>
          <form action={withdrawApplicationAction} className="mt-3 flex flex-wrap items-end gap-2">
            <FormContext segment={segment} applicationId={a.applicationId} />
            <label className="min-w-0 flex-1 text-[12px] text-ink-quiet">{t('Reason', 'السبب')}<input name="reason" required minLength={3} className={`${INPUT} mt-1`} /></label>
            <button type="submit" className="press inline-flex h-9 items-center rounded-tile border border-blocked/50 px-3 text-[13px] font-semibold text-blocked hover:bg-blocked-wash">{t('Withdraw', 'سحب')}</button>
          </form>
        </details>
      ) : null}
    </ApplicationShell>
  );
}

/** The owner's debt burden: monthly obligations ÷ monthly gross salary, against the policy's maximum. */
function OwnerDbr({ view, readiness, policy, f }: { readonly view: NonNullable<Awaited<ReturnType<typeof getApplication>>>; readonly readiness: Awaited<ReturnType<typeof figureReadiness>>; readonly policy: SmeAssessmentPolicy | undefined; readonly f: Formatters }): ReactElement {
  const { t } = f;
  const fig = (metric: string) => view.figures.find((x) => x.figure.metric === metric)?.figure;
  const obligations = fig('MONTHLY_DEBT_OBLIGATIONS');
  const salary = fig('MONTHLY_GROSS_SALARY');
  const value = (x: typeof salary) => (x === undefined ? undefined : (x.verification?.value ?? x.proposedValue).minorUnits);
  const ratio = readiness.ok ? readiness.value.ratios?.OWNER_DEBT_BURDEN : undefined;
  const ko = knockoutOn(policy, 'ownerDbrPerTenThousand');
  const max = ko === undefined || typeof ko.threshold !== 'bigint' ? undefined : ko.threshold;
  const within = ratio?.ok === true && max !== undefined ? ratio.value.perTenThousand <= max : undefined;
  return (
    <div className="mt-6 rounded-tile border border-line bg-sunken px-4 py-3">
      <h3 className="text-[13px] font-semibold text-heading">{t('Owner debt burden ratio (DBR)', 'نسبة عبء الدين على المالك')}</h3>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink">
        <span>{t('Monthly obligations', 'الالتزامات الشهرية')} <bdi className="font-semibold tabular-nums">{value(obligations) === undefined ? '—' : f.money(value(obligations) ?? 0n)}</bdi></span>
        <DividedBy f={f} />
        <span>{t('monthly gross salary', 'الراتب الشهري الإجمالي')} <bdi className="font-semibold tabular-nums">{value(salary) === undefined ? '—' : f.money(value(salary) ?? 0n)}</bdi></span>
        <span className="text-[14px] font-semibold text-ink">{t('equals', 'يساوي')}</span>
        <bdi className="text-[18px] font-bold tabular-nums text-heading">{ratio?.ok === true ? f.digits(formatPercent(ratio.value.perTenThousand)) : '—'}</bdi>
        {within === undefined ? null : <Chip tone={within ? 'good' : 'bad'}>{within ? t('Within maximum', 'ضمن الحد الأقصى') : t('Above maximum', 'فوق الحد الأقصى')}</Chip>}
      </p>
      <p className="mt-1 text-[12px] text-ink-quiet">
        {max === undefined ? t('No maximum in the fund’s policy.', 'لا حد أقصى في سياسة الصندوق.') : t(`Maximum ${formatPercent(max)} (knock-out). Rounded up — a burden is never understated.`, `الحد الأقصى ${f.digits(formatPercent(max))} (معيار استبعاد). يُقرّب للأعلى — لا يُقلَّل العبء أبداً.`)}
        {ratio?.ok === true ? null : ` ${t('Shown once both figures are verified.', 'يظهر بعد التحقق من الرقمين.')}`}
      </p>
    </div>
  );
}
