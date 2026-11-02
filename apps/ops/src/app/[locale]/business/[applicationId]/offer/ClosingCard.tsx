/**
 * Closing (UAE M5a), between approval and disbursement: the signing through
 * the identity service, the conditions precedent from the approved pack with
 * their evidence, and the payee account the facility is paid into. Each is
 * recorded by one person and verified by another; disbursement is refused
 * until every condition precedent is verified and the payee confirmed. The
 * card computes nothing — every status is the server's.
 */
import type { ReactElement } from 'react';

import { maskIban } from '@sanad/core/kernel/iban.ts';

import {
  confirmPayeeAction,
  planTranchesAction,
  recordFixturePaymentResultAction,
  recordPayeeAction,
  satisfyConditionAction,
  verifyConditionAction,
} from '../../../../../server/business-actions.ts';
import { type getApplication, outstandingConditionsPrecedent } from '../../../../../server/business.ts';
import { permits } from '../../../../../server/authority.ts';
import type { StaffPrincipal } from '../../../../../server/staff.ts';
import { Gate } from '../../../Gate.tsx';
import { SourceBadge } from '../../intake/IntakeUi.tsx';
import { BTN_SMALL, Chip, Field, FormContext, type Formatters, INPUT, Id, SectionCard } from '../../ui.tsx';

type View = NonNullable<Awaited<ReturnType<typeof getApplication>>>;

const OPEN = new Set(['APPROVED', 'OFFER_SENT', 'SIGNED']);
const H3 = 'mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-quiet';

export function ClosingCard({
  segment,
  view,
  staff,
  f,
  fixtureResults,
}: {
  readonly segment: string;
  readonly view: View;
  readonly staff: StaffPrincipal;
  readonly f: Formatters;
  /** On the synthetic site, where no bank is connected, finance may record a bank result marked Fixture. */
  readonly fixtureResults: boolean;
}): ReactElement {
  const { t } = f;
  const a = view.application;
  const editable = OPEN.has(a.status);
  const cps = view.pack.conditions.filter((c) => c.kind === 'PRECEDENT' && c.withdrawnBy === undefined);
  const outstanding = outstandingConditionsPrecedent(view);
  const payee = view.closing.payee;
  const documents = view.documents;
  const ctx = <FormContext segment={segment} applicationId={a.applicationId} screen="offer" />;
  const evidenceSelect = (name: string) => (
    <select name={name} required className={INPUT} defaultValue="">
      <option value="" disabled>
        {t('A document on this application…', 'مستند على هذا الطلب…')}
      </option>
      {documents.map((d) => (
        <option key={d.documentRef} value={d.documentRef}>
          {d.documentType} · {d.documentRef.slice(0, 40)}
        </option>
      ))}
    </select>
  );
  const ready = outstanding.length === 0 && payee?.confirmedBy !== undefined;
  // The full IBAN reaches the page only for the person who may confirm it (a checker who did not record it).
  const mayConfirmPayee =
    payee !== undefined && permits(staff, 'BUSINESS_VERIFY').allowed && payee.recordedBy !== staff.principalId;

  return (
    <SectionCard
      id="closing"
      title={t('Closing', 'الإغلاق')}
      note={t(
        'Before money moves: the signature, every condition precedent evidenced and verified, and the payee account confirmed — each by two people.',
        'قبل الصرف: التوقيع، واستيفاء كل شرط مسبق والتحقق منه، وتأكيد حساب المستفيد — كلٌّ من شخصين.',
      )}
      aside={
        a.status === 'DISBURSED' ? undefined : (
          <Chip tone={ready ? 'good' : 'warn'}>
            {ready
              ? t('Ready to disburse once signed', 'جاهز للصرف بعد التوقيع')
              : t('Closing outstanding', 'الإغلاق غير مكتمل')}
          </Chip>
        )
      }
    >
      {/* -- Signature ------------------------------------------------------------------------- */}
      <h3 className={H3}>{t('Signature', 'التوقيع')}</h3>
      <div className="mb-5 flex flex-wrap items-center gap-2 text-[13px]" data-closing-signature>
        {view.closing.signer !== undefined ? (
          <>
            <Chip tone="good">{t('Signed through the identity service', 'وُقّع عبر خدمة الهوية')}</Chip>
            <SourceBadge source={view.closing.signer.source} f={f} />
            <span className="text-ink-quiet">
              {t('Signer reference', 'مرجع الموقّع')} <Id>{view.closing.signer.identityRef}</Id>
            </span>
          </>
        ) : view.closing.signing !== undefined ? (
          <>
            <Chip tone="warn">{t('Awaiting the signatory', 'بانتظار المفوّض بالتوقيع')}</Chip>
            <SourceBadge source={view.closing.signing.source} f={f} />
            <span className="text-ink-quiet">
              {t('Open until', 'مفتوح حتى')} {f.epochDate(view.closing.signing.expiresAtEpochSeconds)} ·{' '}
              {t('letter', 'الخطاب')} <Id>{view.closing.signing.letterVersion.slice(0, 12)}</Id>
            </span>
          </>
        ) : a.signature !== undefined ? (
          <Chip tone="good">{t('Signed', 'موقّع')}</Chip>
        ) : (
          <Chip tone="neutral">{t('Not yet opened', 'لم يبدأ بعد')}</Chip>
        )}
      </div>

      {/* -- Conditions precedent -------------------------------------------------------------- */}
      <h3 className={H3}>{t('Conditions precedent', 'الشروط المسبقة')}</h3>
      {cps.length === 0 ? (
        <p className="mb-5 text-[13px] text-ink-quiet">
          {t('The approved pack carries no conditions precedent.', 'لا تتضمن الحزمة المعتمدة شروطاً مسبقة.')}
        </p>
      ) : (
        <ul
          className="mb-5 flex list-none flex-col divide-y divide-line rounded-tile border border-line p-0"
          data-closing-cps
        >
          {cps.map((c) => {
            const ev = view.closing.cps[c.conditionId];
            return (
              <li key={c.conditionId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 basis-[240px] text-[14px] text-heading">{t(c.textEn, c.textAr)}</span>
                {ev === undefined ? (
                  <Chip tone="bad">{t('Not evidenced', 'لا دليل')}</Chip>
                ) : ev.verifiedBy === undefined ? (
                  <Chip tone="warn">{t('Awaiting a checker', 'بانتظار المراجِع')}</Chip>
                ) : (
                  <Chip tone="good">
                    <span>
                      {t('Verified by', 'تحقق منه')} <Id>{ev.verifiedBy}</Id>
                    </span>
                  </Chip>
                )}
                {ev === undefined ? null : (
                  <span className="text-[11px] text-ink-quiet">
                    <Id>{ev.evidenceRef.slice(0, 40)}</Id> · <Id>{ev.satisfiedBy}</Id>
                  </span>
                )}
                {editable && ev?.verifiedBy === undefined ? (
                  <span className="flex w-full flex-wrap gap-2">
                    {ev === undefined ? null : (
                      <Gate
                        staff={staff}
                        act="BUSINESS_VERIFY"
                        arabic={f.arabic}
                        ownWork={ev.satisfiedBy === staff.principalId}
                      >
                        <form action={verifyConditionAction}>
                          {ctx}
                          <input type="hidden" name="conditionId" value={c.conditionId} />
                          <button type="submit" className={BTN_SMALL}>
                            {t('Verify', 'تحقق')}
                          </button>
                        </form>
                      </Gate>
                    )}
                    <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
                      <form action={satisfyConditionAction} className="flex flex-wrap items-center gap-2">
                        {ctx}
                        <input type="hidden" name="conditionId" value={c.conditionId} />
                        {evidenceSelect('evidenceRef')}
                        <button type="submit" className={BTN_SMALL}>
                          {ev === undefined
                            ? t('Record evidence', 'تسجيل الدليل')
                            : t('Replace evidence', 'استبدال الدليل')}
                        </button>
                      </form>
                    </Gate>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/* -- Payee account --------------------------------------------------------------------- */}
      <h3 className={H3}>{t('Payee account', 'حساب المستفيد')}</h3>
      {payee === undefined ? (
        <p className="mb-3 text-[13px] text-ink-quiet">{t('Not recorded.', 'لم يُسجَّل.')}</p>
      ) : (
        <dl className="mb-3 grid gap-4 sm:grid-cols-3" data-closing-payee>
          <Field label={t('Account holder', 'صاحب الحساب')}>{payee.accountName}</Field>
          <Field label="IBAN">
            <bdi dir="ltr" className="identifier">
              {maskIban(payee.iban)}
            </bdi>
          </Field>
          <Field label={t('Status', 'الحالة')}>
            {payee.confirmedBy === undefined ? (
              <Chip tone="warn">{t('Awaiting a checker', 'بانتظار المراجِع')}</Chip>
            ) : (
              <Chip tone="good">
                <span>
                  {t('Confirmed by', 'أكّده')} <Id>{payee.confirmedBy}</Id>
                </span>
              </Chip>
            )}
          </Field>
        </dl>
      )}
      {editable && payee !== undefined && payee.confirmedBy === undefined ? (
        <Gate staff={staff} act="BUSINESS_VERIFY" arabic={f.arabic} ownWork={payee.recordedBy === staff.principalId}>
          <form
            action={confirmPayeeAction}
            className="mb-3 flex flex-wrap items-center gap-3 rounded-tile border border-line bg-sunken px-4 py-3"
          >
            {ctx}
            <span className="text-[13px] text-ink">
              {t(
                'Check the full IBAN against the evidence before confirming:',
                'طابق رقم الآيبان كاملاً مع المستند قبل التأكيد:',
              )}{' '}
              <bdi dir="ltr" className="identifier font-semibold">
                {mayConfirmPayee ? payee.iban.replace(/(.{4})/g, '$1 ').trim() : maskIban(payee.iban)}
              </bdi>{' '}
              · <Id>{payee.evidenceRef.slice(0, 40)}</Id>
            </span>
            <button type="submit" className={BTN_SMALL}>
              {t('Confirm payee', 'تأكيد المستفيد')}
            </button>
          </form>
        </Gate>
      ) : null}
      {editable && payee?.confirmedBy === undefined ? (
        <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
          <details className="rounded-tile border border-line p-4" data-record-payee>
            <summary className="cursor-pointer select-none text-[14px] font-semibold text-heading">
              {payee === undefined
                ? t('Record the payee account', 'تسجيل حساب المستفيد')
                : t('Replace the payee account', 'استبدال حساب المستفيد')}
            </summary>
            <form action={recordPayeeAction} className="mt-3 grid gap-3 sm:grid-cols-2">
              {ctx}
              <label className="grid gap-1 text-[13px]">
                IBAN
                <input name="iban" required dir="ltr" autoComplete="off" className={INPUT} />
              </label>
              <label className="grid gap-1 text-[13px]">
                {t('Account holder', 'صاحب الحساب')}
                <input name="accountName" required minLength={2} maxLength={140} className={INPUT} />
              </label>
              <label className="grid gap-1 text-[13px] sm:col-span-2">
                {t('Bank letter or statement proving the account', 'خطاب البنك أو كشف يثبت الحساب')}
                {evidenceSelect('evidenceRef')}
              </label>
              <button type="submit" className={`${BTN_SMALL} sm:col-span-2 sm:justify-self-start`}>
                {t('Record payee', 'تسجيل المستفيد')}
              </button>
            </form>
          </details>
        </Gate>
      ) : null}
      {/* -- Drawdown -------------------------------------------------------------------------- */}
      <h3 className={`${H3} mt-5`}>{t('Drawdown', 'السحب')}</h3>
      <DrawdownSection view={view} staff={staff} f={f} ctx={ctx} fixtureResults={fixtureResults} />
    </SectionCard>
  );
}

const TRANCHE_STATUS: Readonly<Record<string, { readonly en: string; readonly ar: string; readonly tone: 'good' | 'warn' | 'bad' | 'neutral' }>> = {
  PLANNED: { en: 'Planned', ar: 'مخطط', tone: 'neutral' },
  RELEASED: { en: 'Sent to the bank', ar: 'أُرسل إلى البنك', tone: 'warn' },
  SETTLED: { en: 'Settled', ar: 'تمت التسوية', tone: 'good' },
  FAILED: { en: 'Payment failed', ar: 'فشل الدفع', tone: 'bad' },
};

function DrawdownSection({
  view,
  staff,
  f,
  ctx,
  fixtureResults,
}: {
  readonly view: View;
  readonly staff: StaffPrincipal;
  readonly f: Formatters;
  readonly ctx: ReactElement;
  readonly fixtureResults: boolean;
}): ReactElement {
  const { t } = f;
  const a = view.application;
  const tranches = view.closing.tranches;
  const released = (tranches ?? []).some((x) => x.releases > 0);
  const awaiting = [...(tranches ?? [])].reverse().find((x) => x.status === 'RELEASED');
  return (
    <>
      {tranches === undefined ? (
        <p className="mb-3 text-[13px] text-ink-quiet">
          {t('One tranche of the whole facility, unless a plan is recorded.', 'دفعة واحدة بكامل التمويل ما لم تُسجَّل خطة.')}
        </p>
      ) : (
        <ul className="mb-3 flex list-none flex-col divide-y divide-line rounded-tile border border-line p-0" data-tranches>
          {tranches.map((x) => {
            const st = TRANCHE_STATUS[x.status] ?? { en: x.status, ar: x.status, tone: 'neutral' as const };
            return (
              <li key={x.trancheId} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
                <Id>{x.trancheId}</Id>
                <bdi className="tabular-nums font-medium text-heading">
                  {f.money(x.amount.minorUnits)} <span className="text-[12px] font-normal text-ink-quiet">{f.cur}</span>
                </bdi>
                <span className="text-ink-quiet">{x.plannedDate === undefined ? '' : f.isoDate(x.plannedDate)}</span>
                <Chip tone={st.tone}>{t(st.en, st.ar)}</Chip>
                {x.failureCode === undefined || x.status !== 'FAILED' ? null : (
                  <span className="text-[12px] text-blocked">
                    {t('Bank reason', 'سبب البنك')} <Id>{x.failureCode}</Id> —{' '}
                    {t('correct the payee account, then release it again', 'صحّح حساب المستفيد ثم أعد الصرف')}
                  </span>
                )}
                {x.instructionRef === undefined ? null : <Id className="text-[11px] text-ink-quiet">{x.instructionRef}</Id>}
              </li>
            );
          })}
        </ul>
      )}
      {fixtureResults && awaiting !== undefined ? (
        <Gate staff={staff} act="BUSINESS_DISBURSE" arabic={f.arabic}>
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-tile border border-attention/40 bg-attention-wash px-4 py-3" data-fixture-result>
            <span className="text-[13px] text-ink">
              {t(
                `No bank is connected here. Record ${awaiting.trancheId}’s result as a Fixture:`,
                `لا يوجد بنك متصل هنا. سجّل نتيجة ${awaiting.trancheId} كنتيجة تجريبية:`,
              )}
            </span>
            {(['SETTLED', 'REJECTED'] as const).map((st) => (
              <form key={st} action={recordFixturePaymentResultAction}>
                {ctx}
                <input type="hidden" name="status" value={st} />
                <button type="submit" className={BTN_SMALL}>
                  {st === 'SETTLED' ? t('Settled', 'تمت التسوية') : t('Rejected', 'مرفوض')}
                </button>
              </form>
            ))}
          </div>
        </Gate>
      ) : null}
      {!released && OPEN.has(a.status) ? (
        <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
          <details className="rounded-tile border border-line p-4" data-plan-tranches>
            <summary className="cursor-pointer select-none text-[14px] font-semibold text-heading">
              {t('Plan the drawdown in tranches', 'تقسيم السحب إلى دفعات')}
            </summary>
            <form action={planTranchesAction} className="mt-3 grid gap-3">
              {ctx}
              <label className="grid gap-1 text-[13px]">
                {t(
                  `One tranche per line: amount (${f.cur}), and optionally its date (yyyy-mm-dd). They must add up to the facility.`,
                  `دفعة في كل سطر: المبلغ (${f.cur})، واختيارياً تاريخها (yyyy-mm-dd). يجب أن يساوي مجموعها مبلغ التمويل.`,
                )}
                <textarea name="plan" required rows={4} dir="ltr" className={INPUT} placeholder={'500000, 2026-11-01\n300000, 2027-01-15'} />
              </label>
              <button type="submit" className={`${BTN_SMALL} justify-self-start`}>
                {t('Record plan', 'تسجيل الخطة')}
              </button>
            </form>
          </details>
        </Gate>
      ) : null}
    </>
  );
}
