/**
 * New business application — stage 1, intake. The officer keys what no rail
 * knows: the trade licence and its authority, the request, and who the parties
 * are and what they own. Everything the register, the identity authority and
 * screening know is fetched on the next screen, not typed here.
 */
import { notFound } from 'next/navigation';

import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { productVariants } from '../../../../../server/business.ts';
import { openIntakeAction } from '../../../../../server/intake-actions.ts';
import { staffJurisdiction } from '../../../../../server/jurisdiction.ts';
import { pageStaff } from '../../../../../server/session.ts';
import { Gate } from '../../../Gate.tsx';
import { BTN_PRIMARY, INPUT, SECTOR_LABELS, SectionCard, formatters } from '../../ui.tsx';
import { ResultBanners } from '../IntakeUi.tsx';

/** The same number of rows the action reads. */
const PARTY_ROWS = 5;

/** Licensing authorities by code; the register adapter is told which one issued the licence. */
const AUTHORITIES: readonly { readonly code: string; readonly en: string; readonly ar: string }[] = [
  { code: 'DET', en: 'Dubai — Department of Economy and Tourism', ar: 'دبي — دائرة الاقتصاد والسياحة' },
  { code: 'ADDED', en: 'Abu Dhabi — Department of Economic Development', ar: 'أبوظبي — دائرة التنمية الاقتصادية' },
  { code: 'SEDD', en: 'Sharjah — Economic Development Department', ar: 'الشارقة — دائرة التنمية الاقتصادية' },
  { code: 'FREE_ZONE', en: 'A free-zone authority', ar: 'سلطة منطقة حرة' },
];

/** Saudi Arabia: the commercial register is the Ministry of Commerce's. */
const SA_AUTHORITIES: readonly { readonly code: string; readonly en: string; readonly ar: string }[] = [
  { code: 'MOC', en: 'Ministry of Commerce — commercial register', ar: 'وزارة التجارة — السجل التجاري' },
];

export default async function NewIntakePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly notice?: string; readonly control?: string; readonly reason?: string }>;
}) {
  const { locale: segment } = await params;
  const query = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const staff = await pageStaff(segment);
  const j = await staffJurisdiction(staff.tenantId);
  const f = formatters(locale === 'ar-SA', j.currency);
  const { t } = f;
  if (j.tenant === undefined) notFound();
  const variants = [...(await productVariants(j.tenant)).values()];
  // The registration and tax fields follow the jurisdiction: a trade licence and TRN in the UAE, a CR in Saudi Arabia.
  const saudi = j.code === 'SA';
  const authorities = saudi ? SA_AUTHORITIES : AUTHORITIES;

  const labelCls = 'flex flex-col gap-1.5 text-[13px] font-medium text-ink';
  return (
    <div className="flex flex-col gap-6">
      <div>
        <a href={`/${segment}/business`} className="text-[13px] font-medium text-brand hover:underline">
          {t('Business applications', 'طلبات المنشآت')}
        </a>
        <h1 className="mt-1 text-h1 font-bold tracking-tight text-heading">
          {t('New business application', 'طلب تمويل منشأة جديد')}
        </h1>
        <p className="mt-1 max-w-[70ch] text-[14px] text-ink-quiet">
          {t(
            'Stage 1, intake. Key only what no system knows. The register, identity and screening checks run on the next screen, each under the consent you record there.',
            'المرحلة الأولى، الاستلام. أدخل فقط ما لا يعرفه أي نظام. تُجرى فحوصات السجل والهوية والفحص الأمني في الشاشة التالية، كلٌّ بموافقة تسجّلها هناك.',
          )}
        </p>
      </div>
      <ResultBanners query={query} f={f} />

      <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
        <form action={openIntakeAction} className="flex flex-col gap-6">
          <input type="hidden" name="locale" value={segment} />

          <SectionCard title={t('The business', 'المنشأة')}>
            <div className="grid gap-5 px-5 py-5 sm:grid-cols-2">
              <label className={labelCls}>
                {saudi
                  ? t('Commercial registration (CR) number', 'رقم السجل التجاري')
                  : t('Trade licence number', 'رقم الرخصة التجارية')}
                <input name="tradeLicence" required dir="ltr" autoComplete="off" className={`${INPUT} identifier`} />
              </label>
              <label className={labelCls}>
                {t('Issuing authority', 'جهة الإصدار')}
                <select name="issuingAuthority" required className={INPUT}>
                  {authorities.map((a) => (
                    <option key={a.code} value={a.code}>
                      {t(a.en, a.ar)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelCls}>
                {t('Business name (English)', 'اسم المنشأة (بالإنجليزية)')}
                <input name="businessNameEn" required dir="ltr" className={INPUT} />
              </label>
              <label className={labelCls}>
                {t('Business name (Arabic)', 'اسم المنشأة (بالعربية)')}
                <input name="businessNameAr" dir="rtl" className={INPUT} />
              </label>
              <label className={labelCls}>
                {t('Sector', 'القطاع')}
                <select name="sector" required className={INPUT}>
                  {Object.entries(SECTOR_LABELS).map(([code, w]) => (
                    <option key={code} value={code}>
                      {t(w.en, w.ar)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelCls}>
                {t('Years in operation', 'سنوات التشغيل')}
                <input
                  name="yearsInOperation"
                  required
                  inputMode="numeric"
                  dir="ltr"
                  className={`${INPUT} tabular-nums`}
                />
              </label>
              {saudi ? (
                <p className="self-end text-[12px] text-ink-quiet" data-zakat-by-cr>
                  {t(
                    'The zakat certificate is checked with ZATCA by the CR on the next screen; no tax number is keyed.',
                    'تُتحقق شهادة الزكاة لدى هيئة الزكاة والضريبة والجمارك برقم السجل التجاري في الشاشة التالية؛ ولا يُدخل رقم ضريبي.',
                  )}
                </p>
              ) : (
              <label className={labelCls}>
                  {t('Tax registration number (TRN), if registered', 'رقم التسجيل الضريبي، إن وُجد')}
                  <input
                    name="taxRegistrationNumber"
                    inputMode="numeric"
                    dir="ltr"
                    autoComplete="off"
                    placeholder="100XXXXXXXXXXXX"
                    className={`${INPUT} identifier`}
                  />
                </label>
              )}
            </div>
          </SectionCard>

          <SectionCard title={t('The request', 'الطلب')}>
            <div className="grid gap-5 px-5 py-5 sm:grid-cols-2">
              <input type="hidden" name="productCode" value="sme-term-conventional" />
              <label className={labelCls}>
                {t('Product variant', 'فئة المنتج')}
                <select name="variantCode" required className={INPUT}>
                  {variants.map((v) => (
                    <option key={v.code} value={v.code}>
                      {t(v.nameEn, v.nameAr)}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelCls}>
                {t('Purpose', 'الغرض')}
                <select name="purpose" required className={INPUT}>
                  {variants.map((v) => (
                    <optgroup key={v.code} label={t(v.nameEn, v.nameAr)}>
                      {v.purposes.map((p) => (
                        <option key={`${v.code}-${p.code}`} value={p.code}>
                          {t(p.labelEn, p.labelAr)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label className={labelCls}>
                {t(`Amount requested (${f.cur})`, `المبلغ المطلوب (${f.cur})`)}
                <input
                  name="requestedAmount"
                  required
                  inputMode="decimal"
                  dir="ltr"
                  className={`${INPUT} tabular-nums`}
                />
              </label>
              <label className={labelCls}>
                {t('Tenor (months)', 'المدة (بالأشهر)')}
                <input name="tenorMonths" required inputMode="numeric" dir="ltr" className={`${INPUT} tabular-nums`} />
              </label>
              <label className={labelCls}>
                {t('Grace (months)', 'فترة السماح (بالأشهر)')}
                <input
                  name="graceMonths"
                  inputMode="numeric"
                  dir="ltr"
                  defaultValue="0"
                  className={`${INPUT} tabular-nums`}
                />
              </label>
              <label className={labelCls}>
                {t('Own contribution to the project (%)', 'المساهمة الذاتية في المشروع (٪)')}
                <input
                  name="contributionPercent"
                  required
                  inputMode="decimal"
                  dir="ltr"
                  className={`${INPUT} tabular-nums`}
                />
              </label>
            </div>
          </SectionCard>

          <SectionCard
            title={t('Owners and signatories', 'الملاك والمفوّضون بالتوقيع')}
            note={t(
              saudi
                ? 'By reference and display name only — never a national ID, iqama or passport number. At least one party signs; shares add up to at most 100%.'
                : 'By reference and display name only — never an Emirates ID or passport number. At least one party signs; shares add up to at most 100%.',
              'بالمرجع والاسم المعروض فقط — دون رقم الهوية أو جواز السفر. يوقّع طرف واحد على الأقل، ولا يتجاوز مجموع الحصص ١٠٠٪.',
            )}
          >
            <div className="flex flex-col gap-3 px-5 py-5">
              {Array.from({ length: PARTY_ROWS }, (_, i) => (
                <div key={i} className="grid gap-3 sm:grid-cols-[1fr_1.4fr_1fr_0.7fr]">
                  <input
                    name={`party_ref_${String(i)}`}
                    aria-label={t(`Party ${String(i + 1)} reference`, `مرجع الطرف ${f.n(i + 1)}`)}
                    placeholder={t('Reference', 'المرجع')}
                    dir="ltr"
                    autoComplete="off"
                    className={`${INPUT} identifier`}
                  />
                  <input
                    name={`party_name_${String(i)}`}
                    aria-label={t(`Party ${String(i + 1)} name`, `اسم الطرف ${f.n(i + 1)}`)}
                    placeholder={t('Display name', 'الاسم المعروض')}
                    className={INPUT}
                  />
                  <select
                    name={`party_role_${String(i)}`}
                    aria-label={t(`Party ${String(i + 1)} role`, `صفة الطرف ${f.n(i + 1)}`)}
                    className={INPUT}
                    defaultValue={i === 0 ? 'OWNER_SIGNATORY' : 'OWNER'}
                  >
                    <option value="OWNER_SIGNATORY">{t('Owner and signatory', 'مالك ومفوّض بالتوقيع')}</option>
                    <option value="OWNER">{t('Owner', 'مالك')}</option>
                    <option value="SIGNATORY">{t('Signatory', 'مفوّض بالتوقيع')}</option>
                  </select>
                  <input
                    name={`party_share_${String(i)}`}
                    aria-label={t(`Party ${String(i + 1)} share (%)`, `حصة الطرف ${f.n(i + 1)} (٪)`)}
                    placeholder={t('Share %', 'الحصة ٪')}
                    inputMode="decimal"
                    dir="ltr"
                    className={`${INPUT} tabular-nums`}
                  />
                </div>
              ))}
            </div>
          </SectionCard>

          <div>
            <button type="submit" className={BTN_PRIMARY}>
              {t('Open the application', 'فتح الطلب')}
            </button>
          </div>
        </form>
      </Gate>
    </div>
  );
}
