/**
 * Merchants: the stores the institution settles to. Onboarding is begun by
 * the maker and verified by the checker, on a store contract, a registry
 * lookup and a screening result; after that a merchant is active, suspended
 * or closed, each by a named person with a reason. The checkout API reads
 * the same rows, so what is decided here applies at the next checkout call.
 */

import { notFound } from 'next/navigation';

import type { Merchant } from '@sanad/core/merchants/merchant.ts';
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Card,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  Status,
  Tile,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { changeMerchantAction, onboardMerchantAction, verifyMerchantAction } from '../../../server/merchant-actions.ts';
import { listMerchantViews, merchantsAvailable } from '../../../server/merchants.ts';
import { pageStaff } from '../../../server/session.ts';
import { Gate, authorityRefusal } from '../Gate.tsx';

const DONE: Readonly<Record<string, { readonly en: string; readonly ar: string }>> = {
  ONBOARDING_BEGUN: {
    en: 'Onboarding begun. The merchant cannot transact until a second person verifies it.',
    ar: 'بدأ التسجيل. لا يتعامل التاجر حتى يتحقق منه شخص ثانٍ.',
  },
  VERIFIED: {
    en: 'Verified. The merchant is active and may open checkout sessions.',
    ar: 'تم التحقق. التاجر مفعّل ويستطيع فتح جلسات الدفع.',
  },
  SUSPEND: { en: 'Suspended. Its next checkout call is refused.', ar: 'أُوقف. يُرفض طلب الدفع التالي منه.' },
  REINSTATE: { en: 'Reinstated.', ar: 'أُعيد تفعيله.' },
  CLOSE: {
    en: 'Closed. A closed merchant does not reopen; onboard it again if needed.',
    ar: 'أُغلق. التاجر المغلق لا يُعاد فتحه؛ يُسجَّل من جديد عند الحاجة.',
  },
};

const TONE: Readonly<Record<Merchant['status'], 'settled' | 'blocked' | 'progress'>> = {
  ACTIVE: 'settled',
  PENDING_VERIFICATION: 'progress',
  SUSPENDED: 'blocked',
  CLOSED: 'blocked',
};
const STATUS_LABEL: Readonly<Record<Merchant['status'], { readonly en: string; readonly ar: string }>> = {
  ACTIVE: { en: 'active', ar: 'مفعّل' },
  PENDING_VERIFICATION: { en: 'awaiting verification', ar: 'بانتظار التحقق' },
  SUSPENDED: { en: 'suspended', ar: 'موقوف' },
  CLOSED: { en: 'closed', ar: 'مغلق' },
};

export default async function MerchantsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{
    readonly control?: string;
    readonly message?: string;
    readonly done?: string;
    readonly merchant?: string;
    readonly reason?: string;
    readonly needs?: string;
  }>;
}) {
  const { locale: segment } = await params;
  const { control, message, done, merchant: touched, reason, needs } = await searchParams;
  // The signed-in person, and their institution's merchants only.
  const staff = await pageStaff(segment);
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const available = merchantsAvailable();
  const views = await listMerchantViews(staff.tenantId);
  const count = (status: Merchant['status']): number => views.filter((v) => v.merchant.status === status).length;
  const sessions = views.reduce((sum, v) => sum + v.activity.reduce((s, a) => s + a.sessions, 0), 0);
  const doneNote = done === undefined ? undefined : DONE[done];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-h2 font-semibold text-heading">{t('Merchants', 'التجار')}</h2>
        <p className="mt-1 text-[15px] text-ink-quiet">
          {t(
            'Stores the institution settles to. A store transacts only under an executed contract, verified by someone other than whoever onboarded it.',
            'المتاجر التي تسوّي معها المؤسسة. لا يتعامل المتجر إلا بعقد مُبرم، ويتحقق منه شخص غير من سجّله.',
          )}
        </p>
      </div>

      {control !== undefined ? (
        <ControlRejection
          control={control}
          explanation={authorityRefusal(reason, needs, arabic) ?? message ?? ''}
          controlLabel={t('Control', 'الضابط')}
        />
      ) : null}
      {doneNote !== undefined ? (
        <p role="status" className="rounded-tile bg-disc-teal px-5 py-4 text-[15px] text-positive">
          {arabic ? doneNote.ar : doneNote.en}
        </p>
      ) : null}

      {available ? null : (
        <Card>
          <p className="text-[15px] text-ink">
            {t(
              'Merchants are kept in the database, and none is configured.',
              'يُحفظ التجار في قاعدة البيانات، ولا توجد قاعدة مهيأة.',
            )}
          </p>
          <p className="mt-2 text-[14px] text-ink-quiet">
            {t('Set SANAD_DATABASE_URL and restart the workbench.', 'اضبط SANAD_DATABASE_URL ثم أعد تشغيل المنصة.')}
          </p>
        </Card>
      )}

      {available ? (
        <>
          <section className="grid gap-[30px] sm:grid-cols-2 2xl:grid-cols-4">
            <Tile icon="store" disc="blue" label={t('Active', 'مفعّلون')} value={count('ACTIVE')} />
            <Tile
              icon="shield-check"
              disc="yellow"
              label={t('Awaiting verification', 'بانتظار التحقق')}
              value={count('PENDING_VERIFICATION')}
            />
            <Tile
              icon="document"
              disc="pink"
              label={t('Suspended or closed', 'موقوفون أو مغلقون')}
              value={count('SUSPENDED') + count('CLOSED')}
            />
            <Tile icon="plug" disc="teal" label={t('Checkout sessions', 'جلسات الدفع')} value={sessions} />
          </section>

          {views.length === 0 ? (
            <Card>
              <p className="text-[15px] text-ink-quiet">
                {t(
                  'No merchants yet. The development merchant appears after the first checkout call.',
                  'لا تجار بعد. يظهر التاجر التجريبي بعد أول طلب دفع.',
                )}
              </p>
            </Card>
          ) : null}

          {views.map(({ merchant: m, activity }) => (
            <Card key={m.core.merchantId} className={touched === m.core.merchantId ? 'ring-2 ring-brand/30' : ''}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="text-[18px] font-semibold text-heading">
                    {arabic ? m.core.legalNameAr : m.core.legalNameEn}
                  </h3>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-ink-quiet">
                    <span className="identifier">{m.core.merchantId}</span>
                    <span>
                      {t('CR', 'س.ت')} <span className="identifier">{m.core.commercialRegistration}</span>
                    </span>
                    <span className="identifier">{m.core.categoryCode}</span>
                  </p>
                </div>
                <Status tone={TONE[m.status]} label={arabic ? STATUS_LABEL[m.status].ar : STATUS_LABEL[m.status].en} />
              </div>

              <dl className="mt-5 grid gap-x-8 gap-y-3 text-[14px] md:grid-cols-2">
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-quiet">{t('Settlement account (reference)', 'حساب التسوية (مرجع)')}</dt>
                  <dd className="identifier text-ink">{m.core.settlementAccountRef}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-quiet">{t('Onboarded by', 'سجّله')}</dt>
                  <dd className="identifier text-ink">{m.core.onboardedBy}</dd>
                </div>
                {m.status === 'ACTIVE' || m.status === 'SUSPENDED' ? (
                  <>
                    <div className="flex justify-between gap-4">
                      <dt className="text-ink-quiet">{t('Store contract', 'عقد المتجر')}</dt>
                      <dd className="identifier text-ink">{m.verification.agreementRef}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-ink-quiet">{t('Verified by', 'تحقق منه')}</dt>
                      <dd className="identifier text-ink">{m.verification.verifiedBy}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-ink-quiet">{t('Registry lookup', 'استعلام السجل')}</dt>
                      <dd className="identifier text-ink">{m.verification.registryLookupRef}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-ink-quiet">{t('Screening result', 'نتيجة الفحص')}</dt>
                      <dd className="identifier text-ink">{m.verification.screeningResultRef}</dd>
                    </div>
                  </>
                ) : null}
                {m.status === 'SUSPENDED' ? (
                  <div className="flex justify-between gap-4 md:col-span-2">
                    <dt className="text-ink-quiet">{t('Suspended', 'سبب الإيقاف')}</dt>
                    <dd className="text-blocked">
                      {m.reason} · <span className="identifier">{m.suspendedBy}</span>
                    </dd>
                  </div>
                ) : null}
                {m.status === 'CLOSED' ? (
                  <div className="flex justify-between gap-4 md:col-span-2">
                    <dt className="text-ink-quiet">{t('Closed', 'سبب الإغلاق')}</dt>
                    <dd className="text-blocked">
                      {m.reason} · <span className="identifier">{m.closedBy}</span>
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4 md:col-span-2">
                  <dt className="text-ink-quiet">{t('Checkout sessions', 'جلسات الدفع')}</dt>
                  <dd className="text-ink">
                    {activity.length === 0
                      ? t('none yet', 'لا شيء بعد')
                      : activity.map((a) => `${String(a.sessions)} ${a.state.toLowerCase()}`).join(' · ')}
                  </dd>
                </div>
              </dl>

              {m.status === 'PENDING_VERIFICATION' ? (
                <Gate staff={staff} act="MERCHANT_VERIFY" arabic={arabic}>
                  <form
                    action={verifyMerchantAction}
                    className="mt-6 grid gap-5 border-t border-line pt-5 md:grid-cols-2"
                  >
                    <input type="hidden" name="locale" value={segment} />
                    <input type="hidden" name="merchantId" value={m.core.merchantId} />
                    <p className="text-[13px] text-ink-quiet md:col-span-2">
                      {t(
                        `Verification is taken as ${staff.principalId}, who must not be the person who onboarded it. The registry and screening references are typed here only because those rails are not live; in production the adapters supply them.`,
                        `يُسجَّل التحقق باسم ${staff.principalId}، ولا يجوز أن يكون من سجّل التاجر. مرجعا السجل والفحص يُدخلان هنا لأن القناتين غير مفعّلتين بعد؛ في الإنتاج يوفّرهما المحوّل.`,
                      )}
                    </p>
                    <label className={FIELD_LABEL}>
                      {t('Store contract reference', 'مرجع عقد المتجر')}
                      <input
                        name="agreementRef"
                        required
                        className={`${FIELD_INPUT} identifier`}
                        placeholder="AGR-2026-0001"
                      />
                    </label>
                    <label className={FIELD_LABEL}>
                      {t('Registry lookup reference', 'مرجع استعلام السجل')}
                      <input name="registryLookupRef" required className={`${FIELD_INPUT} identifier`} />
                    </label>
                    <label className={FIELD_LABEL}>
                      {t('Registry status', 'حالة السجل')}
                      <select name="registryStatus" defaultValue="ACTIVE" className={FIELD_INPUT}>
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="SUSPENDED">SUSPENDED</option>
                        <option value="CLOSED">CLOSED</option>
                      </select>
                    </label>
                    <label className={FIELD_LABEL}>
                      {t('Screening result reference', 'مرجع نتيجة الفحص')}
                      <input name="screeningResultRef" required className={`${FIELD_INPUT} identifier`} />
                    </label>
                    <label className={FIELD_LABEL}>
                      {t('Screening outcome', 'نتيجة الفحص')}
                      <select name="screeningOutcome" defaultValue="CLEAR" className={FIELD_INPUT}>
                        <option value="CLEAR">CLEAR</option>
                        <option value="REFER">REFER</option>
                        <option value="REJECT">REJECT</option>
                        <option value="PENDING_INVESTIGATION">PENDING_INVESTIGATION</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-3 self-end pb-3 text-[15px] text-ink">
                      <input
                        type="checkbox"
                        name="activityPermitted"
                        defaultChecked
                        className="size-4 accent-brand-deep"
                      />
                      {t('Activity permitted under the tenant’s register', 'النشاط مسموح وفق سجل المؤسسة')}
                    </label>
                    <div className="flex justify-end md:col-span-2">
                      <button type="submit" className={BUTTON_PRIMARY}>
                        {t('Verify and activate', 'تحقق وتفعيل')}
                      </button>
                    </div>
                  </form>
                </Gate>
              ) : null}

              {m.status === 'ACTIVE' || m.status === 'SUSPENDED' ? (
                <Gate staff={staff} act="MERCHANT_CHANGE" arabic={arabic}>
                  <form
                    action={changeMerchantAction}
                    className="mt-6 flex flex-wrap items-end gap-3 border-t border-line pt-5"
                  >
                    <input type="hidden" name="locale" value={segment} />
                    <input type="hidden" name="merchantId" value={m.core.merchantId} />
                    <label className={`${FIELD_LABEL} min-w-[240px] flex-1`}>
                      {t('Reason', 'السبب')}
                      <input
                        name="reason"
                        className={FIELD_INPUT}
                        placeholder={t('required to suspend or close', 'مطلوب للإيقاف أو الإغلاق')}
                      />
                    </label>
                    {m.status === 'ACTIVE' ? (
                      <button type="submit" name="change" value="SUSPEND" className={BUTTON_SECONDARY}>
                        {t('Suspend', 'إيقاف')}
                      </button>
                    ) : (
                      <button type="submit" name="change" value="REINSTATE" className={BUTTON_SECONDARY}>
                        {t('Reinstate', 'إعادة تفعيل')}
                      </button>
                    )}
                    <button type="submit" name="change" value="CLOSE" className={BUTTON_DANGER}>
                      {t('Close', 'إغلاق')}
                    </button>
                  </form>
                </Gate>
              ) : null}
            </Card>
          ))}

          <Card>
            <h3 className="text-[16px] font-semibold text-heading">{t('Onboard a merchant', 'تسجيل تاجر')}</h3>
            <p className="mt-1 text-[14px] text-ink-quiet">
              {t(
                `Begun as ${staff.principalId}. The settlement account is a reference into the payments hub, never an account number.`,
                `يُسجَّل باسم ${staff.principalId}. حساب التسوية مرجع في مركز المدفوعات، لا رقم حساب.`,
              )}
            </p>
            <Gate staff={staff} act="MERCHANT_ONBOARD" arabic={arabic}>
              <form action={onboardMerchantAction} className="mt-5 grid gap-5 md:grid-cols-2">
                <input type="hidden" name="locale" value={segment} />
                <label className={FIELD_LABEL}>
                  {t('Commercial registration (10 digits)', 'السجل التجاري (١٠ أرقام)')}
                  <input
                    name="commercialRegistration"
                    required
                    inputMode="numeric"
                    pattern="[0-9]{10}"
                    className={`${FIELD_INPUT} identifier`}
                  />
                </label>
                <label className={FIELD_LABEL}>
                  {t('Category', 'النشاط')}
                  <input
                    name="categoryCode"
                    required
                    className={`${FIELD_INPUT} identifier`}
                    placeholder="RETAIL_ELECTRONICS"
                  />
                </label>
                <label className={FIELD_LABEL}>
                  {t('Legal name (Arabic)', 'الاسم النظامي (عربي)')}
                  <input name="legalNameAr" required dir="rtl" className={FIELD_INPUT} />
                </label>
                <label className={FIELD_LABEL}>
                  {t('Legal name (English)', 'الاسم النظامي (إنجليزي)')}
                  <input name="legalNameEn" required dir="ltr" className={FIELD_INPUT} />
                </label>
                <label className={FIELD_LABEL}>
                  {t('Settlement account reference', 'مرجع حساب التسوية')}
                  <input
                    name="settlementAccountRef"
                    required
                    className={`${FIELD_INPUT} identifier`}
                    placeholder="hub-acct-ref-…"
                  />
                </label>
                <label className={FIELD_LABEL}>
                  {t('Introduced by partner (optional)', 'عرّفه شريك (اختياري)')}
                  <input name="introducedByPartnerRef" className={`${FIELD_INPUT} identifier`} />
                </label>
                <div className="flex justify-end md:col-span-2">
                  <button type="submit" className={BUTTON_PRIMARY}>
                    {t('Begin onboarding', 'بدء التسجيل')}
                  </button>
                </div>
              </form>
            </Gate>
          </Card>
        </>
      ) : null}
    </div>
  );
}
