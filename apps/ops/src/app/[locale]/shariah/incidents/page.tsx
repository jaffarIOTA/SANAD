/**
 * Shariah incidents (Wasl W6b-1; BR-F03, BR-F04, BR-F07): what the daily
 * Shariah review found on the live book, and what reviewers observed; each
 * incident triaged, planned, remediated and closed by the institution's
 * Shariah reviewers — closed by a different one from the reviewer who
 * remediated, with evidence. An open MATERIAL incident on a transaction not
 * yet sold stops its sale until it is closed.
 *
 * A courtesy view of what core/shariah/incidents.ts folds. The service and
 * the table refuse a step out of order or a reviewer closing their own
 * remediation, whatever is drawn here.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { TenantCode } from '@sanad/config/loader.ts';
import {
  INCIDENT_SEVERITIES,
  INCIDENT_STEPS,
  type IncidentSeverity,
  type IncidentStatus,
  type ShariahIncident,
  stopsTheSale,
} from '@sanad/core/shariah/incidents.ts';
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  FIELD_INPUT,
  FIELD_TEXTAREA,
  Status,
  type StatusTone,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { shariahIncidents } from '@sanad/origination/shariah/incidents.ts';

import { pageStaff } from '../../../../server/session.ts';
import {
  actOnIncidentAction,
  raiseObservationAction,
  runShariahReviewAction,
} from '../../../../server/shariah-actions.ts';
import { Gate } from '../../Gate.tsx';
import { NOTICE, REFUSAL } from '../../transactions/states.ts';

type Words = { readonly en: string; readonly ar: string };

/** What each finding means, in words a Shariah reviewer reads. */
const FINDING: Readonly<Record<string, Words>> = {
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

const SEVERITY: Readonly<Record<IncidentSeverity, Words & { readonly tone: StatusTone }>> = {
  LOW: { en: 'Low', ar: 'منخفضة', tone: 'progress' },
  MEDIUM: { en: 'Medium', ar: 'متوسطة', tone: 'progress' },
  HIGH: { en: 'High', ar: 'عالية', tone: 'blocked' },
  MATERIAL: { en: 'Material', ar: 'جوهرية', tone: 'blocked' },
};

const STATUS: Readonly<Record<IncidentStatus, Words>> = {
  RAISED: { en: 'Raised', ar: 'مُثارة' },
  TRIAGED: { en: 'Triaged', ar: 'مُصنّفة' },
  REMEDIATION_PLANNED: { en: 'Remediation planned', ar: 'خطة المعالجة معدّة' },
  REMEDIATED: { en: 'Remediated', ar: 'عولجت' },
  CLOSED: { en: 'Closed', ar: 'مغلقة' },
};

const CHECK: Readonly<Record<string, Words>> = {
  SEQUENCE_INTEGRITY: { en: 'Sequence integrity', ar: 'سلامة التسلسل' },
  EVIDENCE_COMPLETENESS: { en: 'Evidence completeness', ar: 'اكتمال البيّنات' },
  RISK_PERIOD: { en: 'Risk period', ar: 'مدة الضمان' },
  COUNTERPARTY_DISTINCTNESS: { en: 'Counterparty distinctness', ar: 'تمايز الأطراف' },
  GOODS_PERMISSIBILITY: { en: 'Goods permissibility', ar: 'إباحة البضاعة' },
  DISCLOSURE_ACCURACY: { en: 'Disclosure accuracy', ar: 'دقة الإفصاح' },
  TEMPLATE_DRIFT: { en: 'Template drift', ar: 'انحراف النماذج' },
  MANUAL: { en: 'Reviewer’s observation', ar: 'ملاحظة المراجع' },
};

/** The register's own refusals, in words; anything else falls back to the shared map. */
const INCIDENT_REFUSAL: Readonly<Record<string, Words>> = {
  INCIDENT_STEP_OUT_OF_ORDER: {
    en: 'Incidents are triaged, planned, remediated and closed, in that order. Someone may have taken this step meanwhile.',
    ar: 'تُصنَّف المخالفة ثم تُخطط معالجتها ثم تُعالج ثم تُغلق، بهذا الترتيب. ربما اتخذ أحدهم هذه الخطوة في الأثناء.',
  },
  INCIDENT_OWNER_REQUIRED: { en: 'Name who owns the remediation.', ar: 'اذكر المسؤول عن المعالجة.' },
  INCIDENT_RERATING_REASON_REQUIRED: {
    en: 'A severity other than the one raised says why.',
    ar: 'تغيير الخطورة عن المُثارة يحتاج سبباً.',
  },
  INCIDENT_PLAN_REQUIRED: { en: 'Say what will be done.', ar: 'اذكر ما سيُفعل.' },
  INCIDENT_REMEDIATION_REQUIRED: { en: 'Say what was done.', ar: 'اذكر ما فُعل.' },
  INCIDENT_CLOSURE_EVIDENCE_REQUIRED: {
    en: 'Closing an incident needs its evidence.',
    ar: 'إغلاق المخالفة يحتاج بيّنتها.',
  },
  INCIDENT_PURIFICATION_PENDING: {
    en: 'Income was affected, so the incident closes once that income is purified.',
    ar: 'تأثر الدخل، فلا تُغلق المخالفة حتى يُطهَّر ذلك الدخل.',
  },
  FOUR_EYES_SELF_APPROVAL: {
    en: 'A different Shariah reviewer from the one who remediated closes an incident.',
    ar: 'يغلق المخالفة مراجع شرعي غير الذي عالجها.',
  },
  INCIDENT_NOT_FOUND: { en: 'No such incident.', ar: 'لا توجد هذه المخالفة.' },
  OBSERVATION_REQUIRED: { en: 'Say what was observed.', ar: 'اذكر ما لوحظ.' },
  TRANSACTION_NOT_FOUND: { en: 'No transaction has that reference.', ar: 'لا توجد معاملة بهذا المرجع.' },
  PERSISTENCE_FAILED: { en: 'Nothing was written. Try again.', ar: 'لم يُحفظ شيء. حاول مرة أخرى.' },
};

export default async function IncidentsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly notice?: string; readonly reason?: string; readonly control?: string }>;
}): Promise<ReactElement> {
  const { locale: segment } = await params;
  const { notice, reason, control } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const w = (words: Words): string => (arabic ? words.ar : words.en);
  const staff = await pageStaff(segment);
  if (staff.tenantId === undefined) notFound();
  const tenant = staff.tenantId as TenantCode;

  const all = await shariahIncidents(tenant);
  const open = all.filter((i) => i.status !== 'CLOSED').reverse();
  const closed = all
    .filter((i) => i.status === 'CLOSED')
    .slice(-20)
    .reverse();
  const said = notice === undefined ? undefined : NOTICE[notice];
  const refused =
    reason === undefined ? undefined : (INCIDENT_REFUSAL[reason] ?? REFUSAL[reason] ?? { en: reason, ar: reason });

  const card = (i: ShariahIncident) => {
    const severity = SEVERITY[i.currentSeverity];
    const next = INCIDENT_STEPS[i.history.length];
    return (
      <article
        key={i.incidentRef}
        className="rounded-card border border-line bg-surface px-5 py-4 shadow-card"
        data-incident={i.incidentRef}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="identifier text-[15px] font-semibold text-heading">{i.incidentRef}</h3>
            <Link href={`/${segment}/transactions/${i.subjectRef}`} className="identifier text-[13px] text-brand-deep">
              {i.subjectRef}
            </Link>
            <span className="text-[13px] text-ink-quiet">
              {w(CHECK[i.checkCode] ?? { en: i.checkCode, ar: i.checkCode })}
            </span>
            <span className="identifier text-[12px] text-ink-quiet">{i.control}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Status tone={severity.tone} label={w(severity)} />
            <Status tone={i.status === 'CLOSED' ? 'settled' : 'progress'} label={w(STATUS[i.status])} />
          </div>
        </div>
        <p className="mt-2 text-[14px] text-ink">{w(FINDING[i.reason] ?? { en: i.reason, ar: i.reason })}</p>
        {i.observation === undefined ? null : <p className="mt-1 text-[13px] text-ink">“{i.observation}”</p>}
        {Object.keys(i.context).length === 0 ? null : (
          <p className="identifier mt-1 text-[12px] text-ink-quiet">
            {Object.entries(i.context)
              .map(([k, v]) => `${k}: ${v}`)
              .join(' · ')}
          </p>
        )}
        {stopsTheSale(i) ? (
          <p className="mt-2 text-[13px] text-blocked">
            {t(
              'The transaction does not proceed to its sale until this incident is closed.',
              'لا تمضي المعاملة إلى البيع حتى تُغلق هذه المخالفة.',
            )}
          </p>
        ) : null}
        <dl className="mt-3 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-ink-quiet">{t('Raised by', 'أثارها')}</dt>
            <dd>{i.raisedBy}</dd>
          </div>
          {i.owner === undefined ? null : (
            <div>
              <dt className="text-ink-quiet">{t('Owner', 'المسؤول')}</dt>
              <dd>{i.owner}</dd>
            </div>
          )}
          {i.plan === undefined ? null : (
            <div className="sm:col-span-2">
              <dt className="text-ink-quiet">{t('Remediation plan', 'خطة المعالجة')}</dt>
              <dd>{i.plan}</dd>
            </div>
          )}
          {i.remediation === undefined ? null : (
            <div className="sm:col-span-2">
              <dt className="text-ink-quiet">{t('What was done', 'ما عُولج')}</dt>
              <dd>
                {i.remediation} <span className="text-ink-quiet">— {i.remediatedBy}</span>
                {i.purificationRequired ? (
                  <span className="ms-2 text-blocked">
                    {t('Income affected: purification required', 'تأثر الدخل: يلزم التطهير')}
                  </span>
                ) : null}
              </dd>
            </div>
          )}
          {i.closureEvidence === undefined ? null : (
            <div className="sm:col-span-2">
              <dt className="text-ink-quiet">{t('Closure evidence', 'بيّنة الإغلاق')}</dt>
              <dd>
                {i.closureEvidence} <span className="text-ink-quiet">— {i.closedBy}</span>
              </dd>
            </div>
          )}
        </dl>
        {next === undefined ? null : (
          <Gate
            staff={staff}
            act="SHARIAH_INCIDENT_ACT"
            arabic={arabic}
            ownWork={next === 'CLOSE' && i.remediatedBy === staff.principalId}
          >
            <form action={actOnIncidentAction} className="mt-3 grid gap-2 sm:max-w-2xl" data-incident-step={next}>
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="incidentRef" value={i.incidentRef} />
              <input type="hidden" name="kind" value={next} />
              {next === 'TRIAGE' ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="grid gap-1 text-[13px]">
                      {t('Severity', 'الخطورة')}
                      <select name="severity" defaultValue={i.severity} className={FIELD_INPUT}>
                        {INCIDENT_SEVERITIES.map((s) => (
                          <option key={s} value={s}>
                            {w(SEVERITY[s])}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-[13px]">
                      {t('Owner', 'المسؤول')}
                      <input name="owner" defaultValue={staff.principalId} maxLength={200} className={FIELD_INPUT} />
                    </label>
                  </div>
                  <label className="grid gap-1 text-[13px]">
                    {t('Note (required when re-rating)', 'ملاحظة (مطلوبة عند تغيير الخطورة)')}
                    <input name="note" maxLength={2000} className={FIELD_INPUT} />
                  </label>
                </>
              ) : null}
              {next === 'PLAN' ? (
                <label className="grid gap-1 text-[13px]">
                  {t('What will be done', 'ما سيُفعل')}
                  <textarea name="plan" required minLength={3} rows={3} className={FIELD_TEXTAREA} />
                </label>
              ) : null}
              {next === 'REMEDIATE' ? (
                <>
                  <label className="grid gap-1 text-[13px]">
                    {t('What was done', 'ما فُعل')}
                    <textarea name="note" required minLength={3} rows={3} className={FIELD_TEXTAREA} />
                  </label>
                  <label className="flex items-center gap-2 text-[13px]">
                    <input type="checkbox" name="purificationRequired" />
                    {t('Income was affected and must be purified', 'تأثر الدخل ويلزم تطهيره')}
                  </label>
                </>
              ) : null}
              {next === 'CLOSE' ? (
                <label className="grid gap-1 text-[13px]">
                  {t(
                    'Closure evidence (the document, minute or record that shows it is resolved)',
                    'بيّنة الإغلاق (المستند أو المحضر أو السجل الذي يثبت المعالجة)',
                  )}
                  <textarea name="closureEvidence" required minLength={3} rows={2} className={FIELD_TEXTAREA} />
                </label>
              ) : null}
              <button type="submit" className={next === 'CLOSE' ? BUTTON_PRIMARY : BUTTON_SECONDARY}>
                {next === 'TRIAGE'
                  ? t('Triage', 'تصنيف')
                  : next === 'PLAN'
                    ? t('Record the plan', 'تسجيل الخطة')
                    : next === 'REMEDIATE'
                      ? t('Record the remediation', 'تسجيل المعالجة')
                      : t('Close', 'إغلاق')}
              </button>
            </form>
          </Gate>
        )}
      </article>
    );
  };

  return (
    <div className="flex flex-col gap-6" data-incidents>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-display font-bold tracking-tight text-heading">
            {t('Shariah incidents', 'المخالفات الشرعية')}
          </h1>
          <p className="mt-1 max-w-3xl text-[14px] text-ink-quiet">
            {t(
              'Each morning the Shariah review re-checks every live transaction from its own record: the sequence of its contracts, its evidence, the risk period, the parties, the goods, the disclosure, and each executed document against its approved template. What fails is raised here once. A material incident on a transaction not yet sold stops its sale until it is closed.',
              'تعيد المراجعة الشرعية كل صباح فحص كل معاملة قائمة من سجلها: تسلسل عقودها وبيّناتها ومدة الضمان والأطراف والبضاعة والإفصاح، وكل مستند منفّذ مقابل نموذجه المعتمد. وما يخفق يُقيَّد هنا مرة واحدة. والمخالفة الجوهرية على معاملة لم تُبع توقف بيعها حتى تُغلق.',
            )}
          </p>
        </div>
        <Gate staff={staff} act="SHARIAH_INCIDENT_ACT" arabic={arabic}>
          <form action={runShariahReviewAction}>
            <input type="hidden" name="locale" value={segment} />
            <button type="submit" className={BUTTON_SECONDARY} data-run-review>
              {t('Run the review now', 'تشغيل المراجعة الآن')}
            </button>
          </form>
        </Gate>
      </div>

      {said === undefined ? null : (
        <p className="rounded-card border border-positive/30 bg-positive-wash px-4 py-3 text-[14px] text-positive">
          {w(said)}
        </p>
      )}
      {refused === undefined ? null : (
        <p className="rounded-card border border-blocked/30 bg-blocked-wash px-4 py-3 text-[14px] text-blocked">
          {control === undefined ? null : <span className="identifier me-2 text-[12px]">{control}</span>}
          {w(refused)}
        </p>
      )}

      <section className="flex flex-col gap-4" data-incidents-open>
        <h2 className="text-[15px] font-semibold text-heading">
          {t('Open', 'المفتوحة')} <span className="text-ink-quiet">({String(open.length)})</span>
        </h2>
        {open.length === 0 ? (
          <p className="rounded-card border border-line bg-surface px-5 py-4 text-[13px] text-ink-quiet shadow-card">
            {t('No incident is open.', 'لا توجد مخالفة مفتوحة.')}
          </p>
        ) : (
          open.map(card)
        )}
      </section>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-observation>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Raise an observation', 'تقييد ملاحظة')}</h2>
        <Gate staff={staff} act="SHARIAH_INCIDENT_ACT" arabic={arabic}>
          <form action={raiseObservationAction} className="grid gap-3 sm:max-w-2xl">
            <input type="hidden" name="locale" value={segment} />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-[13px]">
                {t('Transaction', 'المعاملة')}
                <input name="transactionRef" required placeholder="WT-000001" className={FIELD_INPUT} dir="ltr" />
              </label>
              <label className="grid gap-1 text-[13px]">
                {t('Severity', 'الخطورة')}
                <select name="severity" defaultValue="MEDIUM" className={FIELD_INPUT}>
                  {INCIDENT_SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {w(SEVERITY[s])}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="grid gap-1 text-[13px]">
              {t('What was observed', 'ما لوحظ')}
              <textarea
                name="observation"
                required
                minLength={3}
                maxLength={2000}
                rows={3}
                className={FIELD_TEXTAREA}
              />
            </label>
            <button type="submit" className={BUTTON_PRIMARY} data-observation-submit>
              {t('Raise', 'تقييد')}
            </button>
          </form>
        </Gate>
      </section>

      {closed.length === 0 ? null : (
        <section className="flex flex-col gap-4" data-incidents-closed>
          <h2 className="text-[15px] font-semibold text-heading">{t('Recently closed', 'المغلقة مؤخراً')}</h2>
          {closed.map(card)}
        </section>
      )}
    </div>
  );
}
