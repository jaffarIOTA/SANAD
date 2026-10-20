/**
 * The KYB workspace for one intake — stages 2 to 4. Every check is fetched
 * from its rail under the subject's recorded consent and shown with where it
 * came from (Fixture or Live); the officer records consents and declarations
 * and presses the checks, and keys none of their answers. What still stands
 * between the intake and credit assessment is listed, and the hand-over is
 * possible only when that list is empty.
 */
import { notFound } from 'next/navigation';
import type { ReactElement, ReactNode } from 'react';

import { loadBeneficialOwnership } from '@sanad/config/loader.ts';
import type { BusinessIntake, IntakeConsentType, ScreeningCheck } from '@sanad/core/origination/business-intake.ts';
import { hasConsent } from '@sanad/core/origination/business-intake.ts';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import {
  clearReferralAction,
  declareOwnersAction,
  handOverIntakeAction,
  identityCheckAction,
  intakeConsentAction,
  registryCheckAction,
  taxCheckAction,
  screeningAction,
  withdrawIntakeAction,
} from '../../../../../server/intake-actions.ts';
import { type IntakeView, getIntake } from '../../../../../server/intake.ts';
import { staffJurisdiction } from '../../../../../server/jurisdiction.ts';
import { pageStaff } from '../../../../../server/session.ts';
import type { StaffPrincipal } from '../../../../../server/staff.ts';
import { Gate } from '../../../Gate.tsx';
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_SMALL,
  Chip,
  type Formatters,
  INPUT,
  Id,
  SectionCard,
  formatters,
} from '../../ui.tsx';
import { PendingButton } from '../../PendingButton.tsx';
import { ResultBanners, SourceBadge, gapWords } from '../IntakeUi.tsx';

function Hidden({ segment, intakeId }: { readonly segment: string; readonly intakeId: string }): ReactElement {
  return (
    <>
      <input type="hidden" name="locale" value={segment} />
      <input type="hidden" name="intakeId" value={intakeId} />
    </>
  );
}

const CONSENT_WORDS: Readonly<Record<IntakeConsentType, { readonly en: string; readonly ar: string }>> = {
  IDENTITY_VERIFICATION: { en: 'Identity verification', ar: 'التحقق من الهوية' },
  SCREENING: { en: 'Screening', ar: 'الفحص الأمني' },
  CREDIT_BUREAU: { en: 'Credit bureau', ar: 'المكتب الائتماني' },
  ACCOUNT_INFORMATION: { en: 'Bank accounts (Open Finance)', ar: 'الحسابات المصرفية (التمويل المفتوح)' },
  DOCUMENT_VERIFICATION: { en: 'Document authenticity (Tahaqoq)', ar: 'التحقق من صحة المستندات (تحقق)' },
};

const TAX_WORDS = {
  VALID: { en: 'Registered', ar: 'مسجّلة' },
  EXPIRED: { en: 'Deregistered', ar: 'أُلغي تسجيلها' },
  NOT_FOUND: { en: 'Not registered', ar: 'غير مسجّلة' },
  SUSPENDED: { en: 'Suspended', ar: 'موقوفة' },
} as const;

/** A consent: recorded (with its reference), or a one-field form to record it. */
function ConsentCell({
  segment,
  intake,
  subject,
  type,
  open,
  justRecorded,
  compact,
  f,
}: {
  readonly segment: string;
  readonly intake: BusinessIntake;
  readonly subject: string;
  readonly type: IntakeConsentType;
  readonly open: boolean;
  readonly justRecorded: boolean;
  /** In a narrow column: the name over the action, on two lines, rather than side by side. */
  readonly compact: boolean;
  readonly f: Formatters;
}): ReactElement {
  const words = f.t(CONSENT_WORDS[type].en, CONSENT_WORDS[type].ar);
  const given = intake.consents.find((c) => c.subject === subject && c.type === type);
  // One row per consent, always the same height, its action pinned to the end in a slot of fixed width: recording
  // a consent swaps what is in the slot and nothing around it moves (the list pattern of Klaviyo's review checklist
  // and Airwallex's verification rows, Mobbin).
  return (
    <li
      className={`grid grid-cols-1 content-center items-center gap-x-3 gap-y-1.5 px-3 py-2 ${
        // Pinned heights: a row is exactly as tall recorded as it was with its form, so the list never changes size.
        compact ? 'h-[4.75rem]' : 'min-h-[4.75rem] sm:h-14 sm:min-h-0 sm:grid-cols-[minmax(0,1fr)_19rem]'
      } ${justRecorded ? 'settle' : ''}`}
      data-consent={type}
      data-given={given === undefined ? 'no' : 'yes'}
    >
      <span className="flex min-w-0 items-center gap-2 text-[13px]">
        <span
          aria-hidden
          className={`size-2 flex-none rounded-full ${given === undefined ? 'border border-line-strong' : 'bg-positive-mark'}`}
        />
        <span className={given === undefined ? 'text-heading' : 'text-ink'}>{words}</span>
      </span>
      <span className={`flex h-9 min-w-0 items-center gap-2 ${compact ? '' : 'sm:justify-end'}`}>
        {given !== undefined ? (
          <>
            <Chip tone="good">{f.t('Recorded', 'مسجّلة')}</Chip>
            <Id className="truncate text-[12px] text-ink-quiet">{given.evidenceRef}</Id>
          </>
        ) : !open ? (
          <span className="text-[12px] text-ink-quiet">{f.t('Not given', 'لم تُمنح')}</span>
        ) : (
          <form
            action={intakeConsentAction}
            className={`flex w-full items-center gap-1.5 ${compact ? '' : 'sm:justify-end'}`}
          >
            <Hidden segment={segment} intakeId={intake.intakeId} />
            <input type="hidden" name="type" value={type} />
            <input type="hidden" name="subject" value={subject} />
            <input
              name="evidenceRef"
              required
              dir="ltr"
              autoComplete="off"
              placeholder={f.t('Consent form ref', 'مرجع نموذج الموافقة')}
              aria-label={f.t(
                `${CONSENT_WORDS[type].en} consent — evidence reference`,
                `موافقة ${CONSENT_WORDS[type].ar} — مرجع الإثبات`,
              )}
              className={`${INPUT} identifier flex-1 text-[12px] ${compact ? '' : 'sm:w-44 sm:flex-none'}`}
            />
            <PendingButton className={`${BTN_SMALL} gap-1.5`}>{f.t('Record', 'تسجيل')}</PendingButton>
          </form>
        )}
      </span>
    </li>
  );
}

/** The consents a subject gives, as one bordered list. */
function ConsentList({
  segment,
  intake,
  subject,
  types,
  open,
  lastRecorded,
  compact = false,
  f,
}: {
  readonly segment: string;
  readonly intake: BusinessIntake;
  readonly subject: string;
  readonly types: readonly IntakeConsentType[];
  readonly open: boolean;
  /** The consent the latest event recorded, so its row can settle in: `subject|type`. */
  readonly lastRecorded: string | undefined;
  readonly compact?: boolean;
  readonly f: Formatters;
}): ReactElement {
  return (
    <ul className="w-full divide-y divide-line overflow-hidden rounded-tile border border-line" data-consent-list>
      {types.map((type) => (
        <ConsentCell
          key={type}
          segment={segment}
          intake={intake}
          subject={subject}
          type={type}
          open={open}
          justRecorded={lastRecorded === `${subject}|${type}`}
          compact={compact}
          f={f}
        />
      ))}
    </ul>
  );
}

const SCREENING_TONE = {
  CLEAR: 'good',
  REFER: 'warn',
  REJECT: 'bad',
  PENDING_INVESTIGATION: 'warn',
} as const;
const SCREENING_WORDS = {
  CLEAR: { en: 'Clear', ar: 'سليم' },
  REFER: { en: 'Referred', ar: 'محال' },
  REJECT: { en: 'Rejected', ar: 'مرفوض' },
  PENDING_INVESTIGATION: { en: 'Under investigation', ar: 'قيد التحقيق' },
} as const;

/** A screening result with its source, and the clearance form a second person uses on a referral. */
function ScreeningCell({
  segment,
  intake,
  subject,
  result,
  staff,
  open,
  f,
}: {
  readonly segment: string;
  readonly intake: BusinessIntake;
  readonly subject: string;
  readonly result: ScreeningCheck | undefined;
  readonly staff: StaffPrincipal;
  readonly open: boolean;
  readonly f: Formatters;
}): ReactElement {
  const run = open ? (
    <form action={screeningAction}>
      <Hidden segment={segment} intakeId={intake.intakeId} />
      <input type="hidden" name="subject" value={subject} />
      <PendingButton className={BTN_SMALL} disabled={!hasConsent(intake, subject, 'SCREENING')}>
        {result === undefined ? f.t('Screen', 'إجراء الفحص') : f.t('Screen again', 'إعادة الفحص')}
      </PendingButton>
    </form>
  ) : null;
  if (result === undefined) return run ?? <span className="text-[12px] text-ink-quiet">—</span>;
  const w = SCREENING_WORDS[result.outcome];
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="flex flex-wrap items-center gap-1.5">
        <Chip tone={SCREENING_TONE[result.outcome]}>{f.t(w.en, w.ar)}</Chip>
        <SourceBadge source={result.source} f={f} />
        <Id>{result.resultRef}</Id>
      </span>
      {result.clearance === undefined ? null : (
        <span className="text-[12px] text-ink-quiet">
          {f.t('Cleared by', 'عالجها')} <Id>{result.clearance.clearedBy}</Id>: {result.clearance.reason}
        </span>
      )}
      {result.outcome === 'REFER' && result.clearance === undefined && open ? (
        <Gate staff={staff} act="BUSINESS_KYB_CLEAR" arabic={f.arabic} ownWork={intake.openedBy === staff.principalId}>
          <form action={clearReferralAction} className="flex flex-wrap items-center gap-1.5">
            <Hidden segment={segment} intakeId={intake.intakeId} />
            <input type="hidden" name="subject" value={subject} />
            <input
              name="reason"
              required
              minLength={3}
              placeholder={f.t('Why it is cleared', 'سبب المعالجة')}
              aria-label={f.t('Clearance reason', 'سبب معالجة الإحالة')}
              className={`${INPUT} h-8 w-56 text-[12px]`}
            />
            <PendingButton className={BTN_SMALL}>{f.t('Clear referral', 'معالجة الإحالة')}</PendingButton>
          </form>
        </Gate>
      ) : null}
      {result.outcome === 'CLEAR' ? null : run}
    </div>
  );
}

const INTAKE_STATUS = {
  DRAFT: { tone: 'brand', en: 'Know your business', ar: 'اعرف عميلك' },
  HANDED_OVER: { tone: 'good', en: 'Handed to credit assessment', ar: 'أُحيل إلى التقييم الائتماني' },
  DECLINED: { tone: 'bad', en: 'Declined by screening', ar: 'رُفض في الفحص الأمني' },
  WITHDRAWN: { tone: 'neutral', en: 'Withdrawn', ar: 'مسحوب' },
} as const;

const REGISTRY_WORDS = {
  ACTIVE: { en: 'Active', ar: 'سارية' },
  EXPIRED: { en: 'Expired', ar: 'منتهية' },
  SUSPENDED: { en: 'Suspended', ar: 'موقوفة' },
  CANCELLED: { en: 'Cancelled', ar: 'ملغاة' },
  NOT_FOUND: { en: 'Not on the register', ar: 'غير مسجلة' },
} as const;

/** The TRN's registration with the tax authority. Information for the assessment, never a gap. */
function TaxCell({
  segment,
  intake,
  open,
  f,
  saudi = false,
}: {
  readonly segment: string;
  readonly intake: BusinessIntake;
  readonly open: boolean;
  readonly f: Formatters;
  /** Saudi Arabia: the zakat certificate, checked with ZATCA by the commercial registration. */
  readonly saudi?: boolean;
}): ReactElement {
  const trn = saudi ? intake.entity.tradeLicence : intake.entity.taxRegistrationNumber;
  if (trn === undefined)
    return <span className="text-[13px] text-ink-quiet">{f.t('No TRN recorded', 'لم يُسجَّل رقم ضريبي')}</span>;
  const c = intake.taxCheck;
  return (
    <>
      <Id>{trn}</Id>
      {c === undefined ? null : (
        <>
          <Chip tone={c.status === 'VALID' ? 'good' : 'warn'}>
            {f.t(TAX_WORDS[c.status].en, TAX_WORDS[c.status].ar)}
          </Chip>
          <SourceBadge source={c.source} f={f} />
        </>
      )}
      {open ? (
        <form action={taxCheckAction}>
          <Hidden segment={segment} intakeId={intake.intakeId} />
          <PendingButton className={BTN_SMALL}>
            {c === undefined
              ? f.t('Check VAT registration', 'التحقق من التسجيل الضريبي')
              : f.t('Check again', 'إعادة التحقق')}
          </PendingButton>
        </form>
      ) : null}
    </>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[14rem_1fr] sm:items-center">
      <dt className="text-[13px] text-ink-quiet">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">{children}</dd>
    </div>
  );
}

export default async function IntakePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly intakeId: string }>;
  readonly searchParams: Promise<{ readonly notice?: string; readonly control?: string; readonly reason?: string }>;
}) {
  const { locale: segment, intakeId } = await params;
  const query = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const staff = await pageStaff(segment);
  const j = await staffJurisdiction(staff.tenantId);
  if (j.tenant === undefined) notFound();
  const view: IntakeView | undefined = await getIntake(j.tenant, intakeId);
  if (view === undefined) notFound();
  const f = formatters(locale === 'ar-SA', j.currency);
  const { t } = f;
  const i = view.intake;
  // The consent the latest event recorded, if that is what just happened: its row settles in.
  const latest = view.events.at(-1);
  const lastRecorded =
    latest?.eventType === 'CONSENT_RECORDED'
      ? `${latest.detail['subject'] ?? ''}|${latest.detail['type'] ?? ''}`
      : undefined;
  const open = i.status === 'DRAFT';
  const nameOf = (ref: string) => i.parties.find((p) => p.partyRef === ref)?.displayName ?? ref;
  const rule = loadBeneficialOwnership(j.tenant);
  const threshold = rule.ok ? rule.value.ownershipThresholdPerTenThousand : undefined;
  const pct = (perTenThousand: number) =>
    f.digits(`${(perTenThousand / 100).toFixed(perTenThousand % 100 === 0 ? 0 : 2)}%`);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <a href={`/${segment}/business`} className="text-[13px] font-medium text-brand hover:underline">
            {t('Business applications', 'طلبات المنشآت')}
          </a>
          <h1 className="mt-1 text-h1 font-bold tracking-tight text-heading">
            {f.arabic ? (i.entity.businessNameAr ?? i.entity.businessNameEn) : i.entity.businessNameEn}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] text-ink-quiet">
            <Id>{i.intakeId}</Id>
            <span aria-hidden>·</span>
            {t('Trade licence', 'الرخصة التجارية')} <Id>{i.entity.tradeLicence}</Id>
            <span aria-hidden>·</span>
            <Chip tone={INTAKE_STATUS[i.status].tone}>{t(INTAKE_STATUS[i.status].en, INTAKE_STATUS[i.status].ar)}</Chip>
          </p>
        </div>
      </div>

      <ResultBanners query={query} f={f} />

      {!view.railsAvailable ? (
        <p
          role="note"
          className="rounded-card border border-attention/30 bg-attention-wash px-4 py-3 text-[14px] text-ink"
        >
          {t(
            'The registry, identity and screening services are not connected in this environment yet, so no check can run and the intake cannot complete. Nothing is assumed in their place.',
            'خدمات السجل والهوية والفحص الأمني غير متصلة في هذه البيئة بعد، فلا يمكن إجراء أي فحص ولا إكمال الطلب. ولا يُفترض شيء مكانها.',
          )}
        </p>
      ) : view.railsSource === 'FIXTURE' ? (
        <p role="note" className="rounded-card border border-line bg-sunken px-4 py-3 text-[13px] text-ink-quiet">
          {t(
            'Synthetic environment: checks are answered by the demonstration transport and marked Fixture. A licence starting EXP- is expired, UNK- is not registered; a reference containing “mismatch” fails identity, “refer” or “reject” changes screening.',
            'بيئة بيانات اصطناعية: تجيب عن الفحوصات بيئة العرض التجريبي وتُوسم "تجريبي". الرخصة التي تبدأ بـ EXP- منتهية، وUNK- غير مسجلة؛ والمرجع الذي يحوي "mismatch" يفشل في الهوية، و"refer" أو "reject" يغيّر نتيجة الفحص.',
          )}
        </p>
      ) : null}

      <SectionCard title={t('The business', 'المنشأة')}>
        <dl className="divide-y divide-line px-5">
          <Row label={t('Register', 'السجل التجاري')}>
            {i.registry === undefined ? (
              <span className="text-[13px] text-ink-quiet">{t('Not checked', 'لم يُتحقق')}</span>
            ) : (
              <>
                <Chip tone={i.registry.status === 'ACTIVE' ? 'good' : 'bad'}>
                  {t(REGISTRY_WORDS[i.registry.status].en, REGISTRY_WORDS[i.registry.status].ar)}
                </Chip>
                <SourceBadge source={i.registry.source} f={f} />
                <Id>{i.registry.lookupRef}</Id>
              </>
            )}
            {open ? (
              <form action={registryCheckAction}>
                <Hidden segment={segment} intakeId={i.intakeId} />
                <PendingButton className={BTN_SMALL}>
                  {i.registry === undefined
                    ? t('Check the licence', 'التحقق من الرخصة')
                    : t('Check again', 'إعادة التحقق')}
                </PendingButton>
              </form>
            ) : null}
          </Row>
          <Row label={t('Consents given for the business', 'موافقات المنشأة')}>
            <ConsentList
              segment={segment}
              intake={i}
              subject="ENTITY"
              // The national-document authenticity rail is Saudi (Tahaqoq); the UAE has none configured.
              types={[
                'SCREENING',
                'CREDIT_BUREAU',
                'ACCOUNT_INFORMATION',
                ...(j.code === 'SA' ? (['DOCUMENT_VERIFICATION'] as const) : []),
              ]}
              open={open}
              lastRecorded={lastRecorded}
              f={f}
            />
          </Row>
          <Row label={t('Screening', 'الفحص الأمني')}>
            <ScreeningCell
              segment={segment}
              intake={i}
              subject="ENTITY"
              result={i.entityScreening}
              staff={staff}
              open={open}
              f={f}
            />
          </Row>
          <Row
            label={
              j.code === 'SA'
                ? t('Zakat certificate (ZATCA)', 'شهادة الزكاة (هيئة الزكاة والضريبة والجمارك)')
                : t('VAT registration', 'التسجيل الضريبي')
            }
          >
            <TaxCell saudi={j.code === 'SA'} segment={segment} intake={i} open={open} f={f} />
          </Row>
        </dl>
      </SectionCard>

      <SectionCard
        title={t('Owners and signatories', 'الملاك والمفوّضون بالتوقيع')}
        note={t(
          'Each check runs under that person’s own recorded consent.',
          'يجري كل فحص بموافقة الشخص نفسه المسجّلة.',
        )}
      >
        <div className="divide-y divide-line">
          {i.parties.map((p) => (
            <div key={p.partyRef} className="flex flex-col gap-3 px-5 py-4">
              <p className="flex flex-wrap items-center gap-2 text-[14px]">
                <span className="font-semibold text-heading">{p.displayName}</span>
                <Id>{p.partyRef}</Id>
                <span className="text-ink-quiet">
                  {p.role === 'OWNER'
                    ? t('Owner', 'مالك')
                    : p.role === 'SIGNATORY'
                      ? t('Signatory', 'مفوّض بالتوقيع')
                      : t('Owner and signatory', 'مالك ومفوّض')}
                  {p.ownershipPerTenThousand > 0 ? ` · ${pct(p.ownershipPerTenThousand)}` : ''}
                </span>
              </p>
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <dt className="text-[12px] text-ink-quiet">{t('Consents', 'الموافقات')}</dt>
                  <dd className="flex flex-col items-start gap-1.5">
                    <ConsentList
                      segment={segment}
                      intake={i}
                      subject={p.partyRef}
                      types={['IDENTITY_VERIFICATION', 'SCREENING']}
                      open={open}
                      lastRecorded={lastRecorded}
                      compact
                      f={f}
                    />
                  </dd>
                </div>
                <div className="flex flex-col gap-1.5">
                  <dt className="text-[12px] text-ink-quiet">{t('Identity', 'الهوية')}</dt>
                  <dd className="flex flex-wrap items-center gap-1.5">
                    {p.identity === undefined ? null : (
                      <>
                        <Chip tone={p.identity.verified ? 'good' : 'bad'}>
                          {p.identity.verified ? t('Verified', 'متحقق منها') : t('Did not match', 'لم تتطابق')}
                        </Chip>
                        <SourceBadge source={p.identity.source} f={f} />
                      </>
                    )}
                    {open && p.identity?.verified !== true ? (
                      <form action={identityCheckAction}>
                        <Hidden segment={segment} intakeId={i.intakeId} />
                        <input type="hidden" name="partyRef" value={p.partyRef} />
                        <PendingButton
                          className={BTN_SMALL}
                          disabled={!hasConsent(i, p.partyRef, 'IDENTITY_VERIFICATION')}
                        >
                          {t('Verify identity', 'التحقق من الهوية')}
                        </PendingButton>
                      </form>
                    ) : null}
                  </dd>
                </div>
                <div className="flex flex-col gap-1.5">
                  <dt className="text-[12px] text-ink-quiet">{t('Screening', 'الفحص الأمني')}</dt>
                  <dd>
                    <ScreeningCell
                      segment={segment}
                      intake={i}
                      subject={p.partyRef}
                      result={p.screening}
                      staff={staff}
                      open={open}
                      f={f}
                    />
                  </dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title={t('Beneficial owners', 'المستفيدون الحقيقيون')}
        note={
          threshold === undefined
            ? t(
                'No cited beneficial-owner rule is configured for this jurisdiction.',
                'لا توجد قاعدة موثّقة للمستفيد الحقيقي في هذه الولاية.',
              )
            : t(
                `Everyone owning ${pct(threshold)} or more must be declared (${rule.ok ? rule.value.citation.split(':')[0] : ''}).`,
                `يجب التصريح بكل من يملك ${pct(threshold)} أو أكثر.`,
              )
        }
      >
        <div className="px-5 py-4">
          {i.ubo !== undefined ? (
            <p className="text-[14px] text-ink">
              {t('Declared by', 'صرّح بها')} {nameOf(i.ubo.declaredBy)}:{' '}
              {i.ubo.uboRefs.map(nameOf).join(f.arabic ? '، ' : ', ')} <Id>{i.ubo.evidenceRef}</Id>
            </p>
          ) : open ? (
            <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
              <form action={declareOwnersAction} className="flex flex-col gap-3">
                <Hidden segment={segment} intakeId={i.intakeId} />
                <fieldset className="flex flex-wrap gap-4">
                  <legend className="mb-1 text-[13px] text-ink-quiet">
                    {t('Beneficial owners', 'المستفيدون الحقيقيون')}
                  </legend>
                  {i.parties.map((p) => (
                    <label key={p.partyRef} className="flex items-center gap-2 text-[14px] text-ink">
                      <input
                        type="checkbox"
                        name="ubo"
                        value={p.partyRef}
                        defaultChecked={threshold !== undefined && p.ownershipPerTenThousand >= threshold}
                        className="size-4 accent-brand"
                      />
                      {p.displayName}
                    </label>
                  ))}
                </fieldset>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
                    {t('Declared by (a signatory)', 'المصرِّح (مفوّض بالتوقيع)')}
                    <select name="declaredBy" className={INPUT}>
                      {i.parties
                        .filter((p) => p.role !== 'OWNER')
                        .map((p) => (
                          <option key={p.partyRef} value={p.partyRef}>
                            {p.displayName}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-[12px] text-ink-quiet">
                    {t('Declaration form reference', 'مرجع نموذج التصريح')}
                    <input name="evidenceRef" required dir="ltr" autoComplete="off" className={`${INPUT} identifier`} />
                  </label>
                  <PendingButton className={BTN_SECONDARY}>{t('Record declaration', 'تسجيل التصريح')}</PendingButton>
                </div>
              </form>
            </Gate>
          ) : (
            <p className="text-[13px] text-ink-quiet">{t('Not declared', 'لم يُصرَّح')}</p>
          )}
        </div>
      </SectionCard>

      {open ? (
        <SectionCard title={t('Hand over to credit assessment', 'الإحالة إلى التقييم الائتماني')}>
          <div className="flex flex-col gap-4 px-5 py-4">
            {view.gaps.length === 0 ? (
              <p className="text-[14px] text-positive">{t('Every check passes.', 'اجتازت جميع الفحوصات.')}</p>
            ) : (
              <ul className="flex list-disc flex-col gap-1 ps-5 text-[14px] text-ink">
                {view.gaps.map((g) => (
                  <li key={`${g.code}:${g.subject ?? ''}`}>{gapWords(g, f, nameOf)}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
                <form action={handOverIntakeAction}>
                  <Hidden segment={segment} intakeId={i.intakeId} />
                  <PendingButton className={BTN_PRIMARY} disabled={view.gaps.length > 0}>
                    {t('Hand over to credit assessment', 'الإحالة إلى التقييم الائتماني')}
                  </PendingButton>
                </form>
              </Gate>
              <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
                <form action={withdrawIntakeAction} className="flex items-center gap-2">
                  <Hidden segment={segment} intakeId={i.intakeId} />
                  <input
                    name="reason"
                    required
                    minLength={3}
                    placeholder={t('Reason for withdrawal', 'سبب السحب')}
                    aria-label={t('Reason for withdrawal', 'سبب السحب')}
                    className={`${INPUT} w-60`}
                  />
                  <PendingButton className={BTN_SECONDARY}>{t('Withdraw', 'سحب الطلب')}</PendingButton>
                </form>
              </Gate>
            </div>
          </div>
        </SectionCard>
      ) : i.handedOver !== undefined ? (
        <p className="text-[14px] text-ink">
          {t('Continues as application', 'يستمر بوصفه الطلب')}{' '}
          <a
            className="font-semibold text-brand hover:underline"
            href={`/${segment}/business/${encodeURIComponent(i.handedOver.applicationId)}`}
          >
            <Id>{i.handedOver.applicationId}</Id>
          </a>
        </p>
      ) : null}
    </div>
  );
}
