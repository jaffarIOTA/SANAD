/**
 * The security register on the loan application (UAE M3): what the variant
 * requires, the collateral and guarantees recorded, their lending value, cover
 * and loan-to-value. The officer records; a different person confirms; an
 * item counts only once confirmed. Every figure here is the server's — the
 * card computes nothing (CLAUDE.md §9).
 */
import type { ReactElement } from 'react';

import { COLLATERAL_KINDS, type CollateralItem, type Guarantee } from '@sanad/core/origination/security-register.ts';

import {
  confirmSecurityAction,
  recordCollateralAction,
  recordGuaranteeAction,
  withdrawSecurityAction,
} from '../../../../server/business-actions.ts';
import type { SecurityStatus, getApplication } from '../../../../server/business.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import { formatPercent } from '../../../../server/business-dashboard.ts';
import type { StaffPrincipal } from '../../../../server/staff.ts';
import { Gate } from '../../Gate.tsx';
import {
  BTN_PRIMARY,
  BTN_SMALL,
  Chip,
  Field,
  FormContext,
  type Formatters,
  INPUT,
  Id,
  SectionCard,
  TH,
  TH_END,
} from '../ui.tsx';

type View = NonNullable<Awaited<ReturnType<typeof getApplication>>>;

const KIND_LABEL: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  REAL_ESTATE: { en: 'Real estate', ar: 'عقار' },
  VEHICLE: { en: 'Vehicle', ar: 'مركبة' },
  EQUIPMENT: { en: 'Equipment', ar: 'معدات' },
  INVENTORY: { en: 'Inventory', ar: 'مخزون' },
  RECEIVABLES: { en: 'Receivables', ar: 'ذمم مدينة' },
  CASH_DEPOSIT: { en: 'Cash deposit under lien', ar: 'وديعة نقدية محجوزة' },
  FINANCED_ASSET: { en: 'Pledge of the financed asset', ar: 'رهن الأصل الممول' },
  PROMISSORY_NOTE: { en: 'Promissory note', ar: 'سند لأمر' },
  INSURANCE_ASSIGNMENT: { en: 'Assignment of insurance', ar: 'التنازل عن وثيقة التأمين' },
  OTHER: { en: 'Other', ar: 'أخرى' },
};

const CHARGE_LABEL: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  REGISTERED: { en: 'Charge registered', ar: 'الرهن مسجَّل' },
  PENDING: { en: 'Charge pending', ar: 'الرهن قيد التسجيل' },
  NOT_APPLICABLE: { en: 'No charge', ar: 'لا رهن' },
};

const SELECT = INPUT;

function ItemStatus({
  item,
  itemId,
  editable,
  segment,
  view,
  staff,
  f,
}: {
  readonly item: CollateralItem | Guarantee;
  readonly itemId: string;
  readonly editable: boolean;
  readonly segment: string;
  readonly view: View;
  readonly staff: StaffPrincipal;
  readonly f: Formatters;
}): ReactElement {
  const { t } = f;
  if (item.withdrawnBy !== undefined) return <Chip tone="neutral">{t('Withdrawn', 'مسحوب')}</Chip>;
  return (
    <span className="flex flex-wrap items-center justify-end gap-2">
      {item.confirmedBy === undefined ? (
        <Chip tone="warn">{t('Awaiting a checker', 'بانتظار المراجِع')}</Chip>
      ) : (
        <Chip tone="good">
          <span>
            {t('Confirmed by', 'أكّده')} <Id>{item.confirmedBy}</Id>
          </span>
        </Chip>
      )}
      {editable && item.confirmedBy === undefined ? (
        <Gate staff={staff} act="BUSINESS_VERIFY" arabic={f.arabic} ownWork={item.recordedBy === staff.principalId}>
          <form action={confirmSecurityAction}>
            <FormContext segment={segment} applicationId={view.application.applicationId} />
            <input type="hidden" name="itemId" value={itemId} />
            <button type="submit" className={BTN_SMALL}>
              {t('Confirm', 'تأكيد')}
            </button>
          </form>
        </Gate>
      ) : null}
      {editable ? (
        <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
          <form action={withdrawSecurityAction}>
            <FormContext segment={segment} applicationId={view.application.applicationId} />
            <input type="hidden" name="itemId" value={itemId} />
            <button type="submit" className="text-[12px] font-medium text-ink-quiet hover:text-blocked hover:underline">
              {t('Withdraw', 'سحب')}
            </button>
          </form>
        </Gate>
      ) : null}
    </span>
  );
}

export function SecurityCard({
  segment,
  view,
  status,
  editable,
  staff,
  f,
}: {
  readonly segment: string;
  readonly view: View;
  readonly status: Result<SecurityStatus>;
  readonly editable: boolean;
  readonly staff: StaffPrincipal;
  readonly f: Formatters;
}): ReactElement {
  const { t } = f;
  const amount = (minor: bigint) => (
    <>
      <bdi className="tabular-nums">{f.money(minor)}</bdi>{' '}
      <span className="text-[12px] font-normal text-ink-quiet">{f.cur}</span>
    </>
  );
  if (!status.ok)
    return (
      <SectionCard id="security" title={t('Security', 'الضمانات')}>
        <p className="text-[13px] text-blocked">{status.error.detail}</p>
      </SectionCard>
    );
  const s: SecurityStatus = status.value;
  const p = s.position;
  const owners = view.application.applicant.owners;
  const ownerName = (ref: string) => owners.find((o) => o.ref === ref)?.displayName ?? ref;
  const documents = view.documents;
  const { collateral, guarantees } = view.security;
  const stale = new Set(p.staleItemIds);

  return (
    <SectionCard
      id="security"
      title={t('Security', 'الضمانات')}
      note={t(
        'Collateral and guarantees count once a second person confirms them. Lending value is the market value less the institution’s haircut for the kind.',
        'تُحتسب الضمانات والكفالات بعد تأكيدها من شخص آخر. القيمة الإقراضية هي القيمة السوقية ناقصاً نسبة الاستقطاع التي تحددها المؤسسة لكل نوع.',
      )}
      aside={
        <Chip tone={p.complete ? 'good' : 'warn'}>
          {p.complete
            ? t('Required security in place', 'الضمانات المطلوبة مكتملة')
            : t(
                `${f.n(p.requirements.filter((r) => !r.met).length)} required outstanding`,
                `${f.n(p.requirements.filter((r) => !r.met).length)} مطلوب غير مكتمل`,
              )}
        </Chip>
      }
    >
      <dl className="mb-5 grid gap-4 sm:grid-cols-3" data-security-position>
        <Field label={t('Lending value (confirmed)', 'القيمة الإقراضية (المؤكدة)')}>
          {amount(p.lendingValue.minorUnits)}
        </Field>
        <Field label={t('Cover of the amount requested', 'تغطية المبلغ المطلوب')}>
          <bdi className="tabular-nums">{f.digits(formatPercent(p.coveragePerTenThousand))}</bdi>
        </Field>
        <Field label={t('Loan to value', 'نسبة التمويل إلى القيمة')}>
          {p.loanToValuePerTenThousand === undefined ? (
            '—'
          ) : (
            <bdi className="tabular-nums">{f.digits(formatPercent(p.loanToValuePerTenThousand))}</bdi>
          )}
        </Field>
      </dl>

      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet">
        {t('What this product requires', 'ما يتطلبه هذا المنتج')}
      </h3>
      <ul className="mb-5 flex list-none flex-col gap-1.5 p-0" data-security-requirements>
        {p.requirements.map((r) => {
          const label = s.labels[r.code];
          return (
            <li key={r.code} className="flex flex-wrap items-center gap-2 text-[14px]">
              <Chip tone={r.met ? 'good' : 'bad'}>
                {r.met ? t('In place', 'مكتمل') : t('Outstanding', 'غير مكتمل')}
              </Chip>
              <span className="text-heading">{label === undefined ? r.code : t(label.en, label.ar)}</span>
              {r.unmapped ? (
                <span className="text-[12px] text-blocked">
                  {t('Not in the institution’s security policy', 'غير مُدرَج في سياسة الضمانات لدى المؤسسة')}
                </span>
              ) : null}
              {r.missingOwners.length > 0 ? (
                <span className="text-[12px] text-ink-quiet">
                  {t('Still needed from', 'مطلوبة بعدُ من')} {r.missingOwners.map(ownerName).join(t(', ', '، '))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* -- Collateral ------------------------------------------------------------------------- */}
      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet">
        {t('Collateral', 'الضمانات العينية')}
      </h3>
      {collateral.length === 0 ? (
        <p className="mb-4 text-[13px] text-ink-quiet">{t('None recorded.', 'لم يُسجَّل شيء.')}</p>
      ) : (
        <div className="mb-4 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[13px]" data-collateral>
            <thead>
              <tr>
                <th className={TH}>{t('Item', 'البند')}</th>
                <th className={TH_END}>{t('Market value', 'القيمة السوقية')}</th>
                <th className={TH_END}>{t('Haircut', 'الاستقطاع')}</th>
                <th className={TH}>{t('Valued', 'تاريخ التقييم')}</th>
                <th className={TH_END}>{t('Status', 'الحالة')}</th>
              </tr>
            </thead>
            <tbody>
              {collateral.map((c) => (
                <tr
                  key={c.itemId}
                  className={`border-t border-line ${c.withdrawnBy === undefined ? '' : 'opacity-60'}`}
                >
                  <td className="py-2 pe-3 align-top">
                    <span className="block font-medium text-heading">
                      {t(KIND_LABEL[c.kind]?.en ?? c.kind, KIND_LABEL[c.kind]?.ar ?? c.kind)}
                    </span>
                    <span className="block text-ink">{c.description}</span>
                    <span className="block text-[11px] text-ink-quiet">
                      <Id>{c.itemId}</Id> · {t(CHARGE_LABEL[c.charge]?.en ?? '', CHARGE_LABEL[c.charge]?.ar ?? '')}
                      {c.chargeRef === undefined ? null : (
                        <>
                          {' '}
                          <Id>{c.chargeRef}</Id>
                        </>
                      )}
                      {' · '}
                      {t('Valuer', 'المقيِّم')} <Id>{c.valuerRef}</Id> · {t('Recorded by', 'سجّله')}{' '}
                      <Id>{c.recordedBy}</Id>
                    </span>
                  </td>
                  <td className="py-2 pe-3 text-end align-top">{amount(c.marketValue.minorUnits)}</td>
                  <td className="py-2 pe-3 text-end align-top tabular-nums">
                    {f.digits(formatPercent(BigInt(s.haircutsPerTenThousand[c.kind] ?? 10_000)))}
                  </td>
                  <td className="py-2 pe-3 align-top">
                    {f.epochDate(c.valuedAtEpochSeconds)}
                    {stale.has(c.itemId) ? (
                      <span className="block">
                        <Chip tone="bad">{t('Too old to count', 'أقدم من أن يُحتسب')}</Chip>
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 text-end align-top">
                    <ItemStatus
                      item={c}
                      itemId={c.itemId}
                      editable={editable}
                      segment={segment}
                      view={view}
                      staff={staff}
                      f={f}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* -- Guarantees ------------------------------------------------------------------------- */}
      <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet">
        {t('Guarantees', 'الكفالات')}
      </h3>
      {guarantees.length === 0 ? (
        <p className="mb-4 text-[13px] text-ink-quiet">{t('None recorded.', 'لم يُسجَّل شيء.')}</p>
      ) : (
        <ul
          className="mb-4 flex list-none flex-col divide-y divide-line rounded-tile border border-line p-0"
          data-guarantees
        >
          {guarantees.map((g) => (
            <li
              key={g.guaranteeId}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 ${g.withdrawnBy === undefined ? '' : 'opacity-60'}`}
            >
              <span className="flex min-w-0 flex-1 basis-[220px] flex-col">
                <span className="text-[14px] font-medium text-heading">
                  {g.guarantorName}{' '}
                  <span className="text-[12px] font-normal text-ink-quiet">
                    {g.guarantorKind === 'PERSONAL'
                      ? t('personal guarantee', 'كفالة شخصية')
                      : t('corporate guarantee', 'كفالة شركة')}
                  </span>
                </span>
                <span className="text-[12px] text-ink">
                  {g.limit.kind === 'UNLIMITED' ? (
                    t('Unlimited', 'غير محدودة')
                  ) : (
                    <>
                      {t('Limited to', 'بحد أقصى')} {amount(g.limit.amount.minorUnits)}
                    </>
                  )}
                </span>
                <span className="text-[11px] text-ink-quiet">
                  <Id>{g.guaranteeId}</Id> · {t('Recorded by', 'سجّلها')} <Id>{g.recordedBy}</Id>
                </span>
              </span>
              <ItemStatus
                item={g}
                itemId={g.guaranteeId}
                editable={editable}
                segment={segment}
                view={view}
                staff={staff}
                f={f}
              />
            </li>
          ))}
        </ul>
      )}

      {/* -- Record forms ----------------------------------------------------------------------- */}
      {editable ? (
        <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
          <div className="grid gap-4 lg:grid-cols-2">
            <details className="rounded-tile border border-line p-4" data-record-collateral>
              <summary className="cursor-pointer select-none text-[14px] font-semibold text-heading">
                {t('Record collateral', 'تسجيل ضمان عيني')}
              </summary>
              <form action={recordCollateralAction} className="mt-3 grid gap-3">
                <FormContext segment={segment} applicationId={view.application.applicationId} />
                <label className="grid gap-1 text-[13px]">
                  {t('Kind', 'النوع')}
                  <select name="kind" required className={SELECT} defaultValue="">
                    <option value="" disabled>
                      {t('Choose…', 'اختر…')}
                    </option>
                    {COLLATERAL_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {t(KIND_LABEL[k]?.en ?? k, KIND_LABEL[k]?.ar ?? k)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-[13px]">
                  {t('Description of the asset', 'وصف الأصل')}
                  <input name="description" required minLength={3} maxLength={120} className={INPUT} />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-[13px]">
                    {t(`Market value (${f.cur})`, `القيمة السوقية (${f.cur})`)}
                    <input name="marketValue" required inputMode="decimal" dir="ltr" className={INPUT} />
                  </label>
                  <label className="grid gap-1 text-[13px]">
                    {t('Valuation date', 'تاريخ التقييم')}
                    <input name="valuedOn" type="date" required dir="ltr" className={INPUT} />
                  </label>
                </div>
                <label className="grid gap-1 text-[13px]">
                  {t('Valuer reference', 'مرجع المقيِّم')}
                  <input name="valuerRef" required dir="ltr" className={INPUT} />
                </label>
                <label className="grid gap-1 text-[13px]">
                  {t(
                    'Valuation report or instrument (a document on this application)',
                    'تقرير التقييم أو السند (مستند على هذا الطلب)',
                  )}
                  <select name="evidenceRef" className={SELECT} defaultValue="">
                    <option value="">{t('None yet', 'لا يوجد بعد')}</option>
                    {documents.map((d) => (
                      <option key={d.documentRef} value={d.documentRef}>
                        {d.documentType} · {d.documentRef.slice(0, 40)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-[13px]">
                    {t('Charge', 'الرهن')}
                    <select name="charge" required className={SELECT} defaultValue="NOT_APPLICABLE">
                      {(['REGISTERED', 'PENDING', 'NOT_APPLICABLE'] as const).map((c) => (
                        <option key={c} value={c}>
                          {t(CHARGE_LABEL[c]?.en ?? c, CHARGE_LABEL[c]?.ar ?? c)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-[13px]">
                    {t('Registry reference (if registered)', 'مرجع التسجيل (إن كان مسجَّلاً)')}
                    <input name="chargeRef" dir="ltr" className={INPUT} />
                  </label>
                </div>
                <button type="submit" className={BTN_PRIMARY}>
                  {t('Record collateral', 'تسجيل الضمان')}
                </button>
              </form>
            </details>

            <details className="rounded-tile border border-line p-4" data-record-guarantee>
              <summary className="cursor-pointer select-none text-[14px] font-semibold text-heading">
                {t('Record a guarantee', 'تسجيل كفالة')}
              </summary>
              <form action={recordGuaranteeAction} className="mt-3 grid gap-3">
                <FormContext segment={segment} applicationId={view.application.applicationId} />
                <fieldset className="grid gap-2 text-[13px]">
                  <legend className="mb-1">{t('Guarantor', 'الكفيل')}</legend>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="guarantorKind" value="PERSONAL" defaultChecked />
                    {t('An owner (personal guarantee)', 'أحد الملّاك (كفالة شخصية)')}
                  </label>
                  <select name="ownerRef" className={SELECT} defaultValue={owners[0]?.ref ?? ''}>
                    {owners.map((o) => (
                      <option key={o.ref} value={o.ref}>
                        {o.displayName}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2">
                    <input type="radio" name="guarantorKind" value="CORPORATE" />
                    {t('A company (corporate guarantee)', 'شركة (كفالة شركة)')}
                  </label>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input name="companyName" placeholder={t('Company name', 'اسم الشركة')} className={INPUT} />
                    <input
                      name="companyRef"
                      placeholder={t('Registration reference', 'مرجع السجل')}
                      dir="ltr"
                      className={INPUT}
                    />
                  </div>
                </fieldset>
                <label className="grid gap-1 text-[13px]">
                  {t(
                    `Limit (${f.cur}) — leave empty for unlimited`,
                    `الحد الأقصى (${f.cur}) — اتركه فارغاً لكفالة غير محدودة`,
                  )}
                  <input name="limit" inputMode="decimal" dir="ltr" className={INPUT} />
                </label>
                <label className="grid gap-1 text-[13px]">
                  {t('Signed deed (a document on this application)', 'سند الكفالة الموقّع (مستند على هذا الطلب)')}
                  <select name="deedRef" className={SELECT} defaultValue="">
                    <option value="">{t('None yet', 'لا يوجد بعد')}</option>
                    {documents.map((d) => (
                      <option key={d.documentRef} value={d.documentRef}>
                        {d.documentType} · {d.documentRef.slice(0, 40)}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className={BTN_PRIMARY}>
                  {t('Record guarantee', 'تسجيل الكفالة')}
                </button>
              </form>
            </details>
          </div>
        </Gate>
      ) : null}
      <p className="mt-4 text-[11px] text-ink-quiet">
        {t(
          `Haircuts and the ${f.n(s.maxValuationAgeDays)}-day valuation limit are the institution’s policy.`,
          `نسب الاستقطاع وحدّ عمر التقييم البالغ ${f.n(s.maxValuationAgeDays)} يوماً من سياسة المؤسسة.`,
        )}
      </p>
    </SectionCard>
  );
}
