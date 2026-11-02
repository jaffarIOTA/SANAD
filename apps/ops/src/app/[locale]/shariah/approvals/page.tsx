/**
 * The Shariah approvals register (Wasl W6a; BR-F01, BR-F02, SH-17): every
 * approval the institution's board has issued, as recorded and confirmed by
 * two Shariah reviewers; where each Islamic product's new business stands on
 * it today; the changes awaiting a second reviewer; and the forms to propose
 * one.
 *
 * A courtesy view of what core/shariah/approvals.ts folds from the confirmed
 * changes. The acts are refused by the service where they do not apply: the
 * proposer confirming their own change, a record already held, a withdrawn
 * approval reinstated.
 */
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { TenantCode } from '@sanad/config/loader.ts';
import { ISLAMIC_PRODUCT_CODES } from '@sanad/core/products/registry.ts';
import {
  type ApprovalChange,
  type ApprovalChangeEntry,
  type ApprovalStanding,
  type ShariahApproval,
  approvalInForce,
  approvalRefOf,
  registerFrom,
  standingOn,
} from '@sanad/core/shariah/approvals.ts';
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  DualDate,
  FIELD_INPUT,
  FIELD_TEXTAREA,
  Status,
  type StatusTone,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { resolveProductCatalogue } from '@sanad/origination/catalogue.ts';
import { civilDateOf } from '@sanad/origination/civil-date.ts';
import { ummAlQura } from '@sanad/origination/hijri.ts';
import { hostClockInstant } from '@sanad/origination/host-clock.ts';
import { approvalChanges } from '@sanad/origination/shariah/approvals.ts';
import { structureOf } from '@sanad/origination/wasl/book.ts';

import { pageStaff } from '../../../../server/session.ts';
import {
  decideApprovalChangeAction,
  proposeApprovalRecordAction,
  proposeApprovalStatusAction,
} from '../../../../server/shariah-actions.ts';
import { Gate } from '../../Gate.tsx';
import { NOTICE, REFUSAL } from '../../transactions/states.ts';

type Words = { readonly en: string; readonly ar: string };

/** The register's own refusals, in words; anything else falls back to the shared map. */
const APPROVAL_REFUSAL: Readonly<Record<string, Words>> = {
  APPROVAL_REF_MALFORMED: {
    en: 'The reference is the board’s own: 2 to 80 letters, digits and . _ / -.',
    ar: 'المرجع هو مرجع الهيئة نفسه: من حرفين إلى ٨٠ من الحروف والأرقام و . _ / -.',
  },
  APPROVING_BODY_REQUIRED: { en: 'Name the approving body.', ar: 'اذكر الجهة المعتمِدة.' },
  APPROVING_MEMBERS_REQUIRED: {
    en: 'Name the members who approved it, one to twenty.',
    ar: 'اذكر الأعضاء الذين اعتمدوه، من واحد إلى عشرين.',
  },
  APPROVING_MEMBER_TWICE: { en: 'Each member is named once.', ar: 'يُذكر كل عضو مرة واحدة.' },
  EFFECTIVE_FROM_MALFORMED: { en: 'The effective date is a calendar date.', ar: 'تاريخ السريان تاريخ تقويمي.' },
  REVIEW_DATE_MALFORMED: {
    en: 'The review or expiry date is a calendar date after the effective date.',
    ar: 'تاريخ المراجعة أو الانتهاء تاريخ تقويمي بعد تاريخ السريان.',
  },
  APPROVAL_PRODUCTS_INVALID: {
    en: 'Choose the Islamic products the approval covers.',
    ar: 'اختر المنتجات الإسلامية التي يشملها الاعتماد.',
  },
  APPROVAL_PRODUCT_TWICE: { en: 'Each product is named once.', ar: 'يُذكر كل منتج مرة واحدة.' },
  APPROVAL_TEMPLATES_MALFORMED: {
    en: 'Name each template version as name@version, at most fifty.',
    ar: 'اذكر كل إصدار نموذج بالصيغة name@version، بحد أقصى خمسين.',
  },
  APPROVAL_TEMPLATE_TWICE: { en: 'Each template version is named once.', ar: 'يُذكر كل إصدار نموذج مرة واحدة.' },
  APPROVAL_CHANGE_REASON_REQUIRED: {
    en: 'Say why, with the board’s minute or letter.',
    ar: 'اذكر السبب، مع محضر الهيئة أو خطابها.',
  },
  APPROVAL_CHANGE_OPEN: {
    en: 'A change to this approval already awaits a second reviewer.',
    ar: 'يوجد تغيير على هذا الاعتماد بانتظار مراجع ثانٍ.',
  },
  APPROVAL_ALREADY_RECORDED: {
    en: 'This reference is already in the register. Renew it instead.',
    ar: 'هذا المرجع مقيّد في السجل بالفعل؛ جدّده بدلاً من ذلك.',
  },
  APPROVAL_NOT_SUSPENDABLE: {
    en: 'Only an approval in force is suspended.',
    ar: 'لا يُوقف إلا اعتماد ساري.',
  },
  APPROVAL_NOT_SUSPENDED: { en: 'Only a suspended approval is reinstated.', ar: 'لا يُعاد إلا اعتماد موقوف.' },
  APPROVAL_NOT_WITHDRAWABLE: {
    en: 'This approval is already withdrawn.',
    ar: 'هذا الاعتماد مسحوب بالفعل.',
  },
  APPROVAL_NOT_RENEWABLE: {
    en: 'A withdrawn approval is not renewed. Record the board’s new approval instead.',
    ar: 'لا يُجدَّد اعتماد مسحوب؛ قيّد اعتماد الهيئة الجديد بدلاً من ذلك.',
  },
  APPROVAL_RENEWAL_UNCHANGED: {
    en: 'The renewal sets a different review or expiry date.',
    ar: 'يحدد التجديد تاريخ مراجعة أو انتهاء مختلفاً.',
  },
  APPROVAL_CHANGE_NOT_FOUND: { en: 'No such proposal.', ar: 'لا يوجد هذا الاقتراح.' },
  APPROVAL_CHANGE_ALREADY_DECIDED: {
    en: 'That proposal is already decided.',
    ar: 'تم البت في هذا الاقتراح بالفعل.',
  },
  FOUR_EYES_SELF_APPROVAL: {
    en: 'A second Shariah reviewer, not the proposer, confirms a change to the register.',
    ar: 'يؤكد التغيير في السجل مراجع شرعي ثانٍ غير مقترحه.',
  },
  PERSISTENCE_FAILED: { en: 'Nothing was written. Try again.', ar: 'لم يُحفظ شيء. حاول مرة أخرى.' },
};

const STANDING: Readonly<Record<ApprovalStanding, Words & { readonly tone: StatusTone }>> = {
  IN_FORCE: { en: 'In force', ar: 'ساري', tone: 'settled' },
  NOT_YET_EFFECTIVE: { en: 'Not yet effective', ar: 'لم يسرِ بعد', tone: 'progress' },
  LAPSED: { en: 'Lapsed', ar: 'منقضٍ', tone: 'blocked' },
  SUSPENDED: { en: 'Suspended', ar: 'موقوف', tone: 'blocked' },
  WITHDRAWN: { en: 'Withdrawn', ar: 'مسحوب', tone: 'blocked' },
};

const KIND: Readonly<Record<ApprovalChange['kind'], Words>> = {
  RECORD: { en: 'Record', ar: 'قيد' },
  SUSPEND: { en: 'Suspend', ar: 'إيقاف' },
  REINSTATE: { en: 'Reinstate', ar: 'إعادة' },
  WITHDRAW: { en: 'Withdraw', ar: 'سحب' },
  RENEW: { en: 'Renew', ar: 'تجديد' },
};

const PRODUCT: Readonly<Record<string, Words>> = {
  'murabaha-scf': { en: 'Wasl — Murabaha distributor finance', ar: 'وصل — تمويل الموزعين بالمرابحة' },
  'tawarruq-personal': { en: 'Personal finance (Tawarruq)', ar: 'التمويل الشخصي (تورّق)' },
  'sme-term-islamic': { en: 'SME term finance (Tawarruq)', ar: 'تمويل المنشآت لأجل (تورّق)' },
};

export default async function ApprovalsRegisterPage({
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

  const now = hostClockInstant();
  const today = civilDateOf(tenant, now);
  const entries = await approvalChanges(tenant);
  const register = registerFrom(entries);
  const pending = entries.filter((e) => e.state === 'PROPOSED');
  const rejected = entries
    .filter((e) => e.state === 'REJECTED')
    .slice(-5)
    .reverse();

  // What each Islamic product's new business rests on today: the approval its catalogue entry cites, and for Wasl
  // the structure's, which every transaction carries.
  const catalogue = (await resolveProductCatalogue(tenant, now.epochSeconds)).catalogue;
  const cited: { readonly productCode: string; readonly approvalRef?: string; readonly enabled: boolean }[] = [];
  if (catalogue.ok)
    for (const e of catalogue.value.entries)
      if (ISLAMIC_PRODUCT_CODES.has(e.productCode))
        cited.push({
          productCode: e.productCode,
          enabled: e.enabled,
          ...(e.boardRulingRef === undefined ? {} : { approvalRef: e.boardRulingRef }),
        });
  const wasl = structureOf(tenant);
  if (
    wasl.ok &&
    !cited.some((c) => c.productCode === 'murabaha-scf' && c.approvalRef === wasl.value.shariahApprovalRef)
  )
    cited.push({ productCode: 'murabaha-scf', approvalRef: wasl.value.shariahApprovalRef, enabled: true });

  const said = notice === undefined ? undefined : NOTICE[notice];
  const refused =
    reason === undefined ? undefined : (APPROVAL_REFUSAL[reason] ?? REFUSAL[reason] ?? { en: reason, ar: reason });
  const date = (iso: string) => <DualDate gregorian={iso} hijri={ummAlQura(iso)} locale={locale} />;
  const describe = (c: ApprovalChange): string =>
    c.kind === 'RENEW' ? `${w(KIND.RENEW)} → ${c.reviewOrExpiry}` : w(KIND[c.kind]);
  const when = (e: ApprovalChangeEntry) =>
    new Date(Number(e.decidedAtEpochSeconds ?? e.proposedAtEpochSeconds) * 1000)
      .toISOString()
      .slice(0, 16)
      .replace('T', ' ');

  return (
    <div className="flex flex-col gap-6" data-approvals-register>
      <div>
        <h1 className="text-display font-bold tracking-tight text-heading">
          {t('Shariah approvals register', 'سجل اعتمادات الهيئة الشرعية')}
        </h1>
        <p className="mt-1 max-w-3xl text-[14px] text-ink-quiet">
          {t(
            'Each approval the board has issued, recorded by a Shariah reviewer and confirmed by a second. An Islamic product originates only while the approval its configuration cites is in force that day and covers it. When an approval passes its review date, or is suspended or withdrawn, new business on every product it covers stops on its own. Contracts already executed keep the approval they were executed under.',
            'كل اعتماد أصدرته الهيئة، يقيّده مراجع شرعي ويؤكده مراجع ثانٍ. لا يُنشأ تمويل على منتج إسلامي إلا والاعتماد الذي تُشير إليه إعداداته ساري في ذلك اليوم ويشمله. وإذا انقضى تاريخ مراجعته أو أُوقف أو سُحب، توقفت الأعمال الجديدة على كل منتج يشمله تلقائياً. أما العقود المنفّذة فتبقى على الاعتماد الذي نُفّذت بموجبه.',
          )}
        </p>
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

      <section
        className="overflow-x-auto rounded-card border border-line bg-surface shadow-card"
        data-origination-standing
      >
        <h2 className="px-5 pt-4 text-[15px] font-semibold text-heading">
          {t('New business today', 'الأعمال الجديدة اليوم')}
        </h2>
        <table className="mt-2 w-full text-[13px]">
          <thead>
            <tr className="text-ink-quiet">
              <th className="px-5 py-2 text-start font-normal">{t('Product', 'المنتج')}</th>
              <th className="px-3 py-2 text-start font-normal">{t('Approval cited', 'الاعتماد المُشار إليه')}</th>
              <th className="px-5 py-2 text-start font-normal">{t('New business', 'الأعمال الجديدة')}</th>
            </tr>
          </thead>
          <tbody>
            {cited.map((c) => {
              const r = approvalInForce(register, c.approvalRef, c.productCode, today);
              const words = r.ok ? undefined : (REFUSAL[r.error.reason] ?? { en: r.error.reason, ar: r.error.reason });
              return (
                <tr
                  key={`${c.productCode}|${c.approvalRef ?? ''}`}
                  className="border-t border-line"
                  data-product={c.productCode}
                >
                  <td className="px-5 py-2">{w(PRODUCT[c.productCode] ?? { en: c.productCode, ar: c.productCode })}</td>
                  <td className="identifier px-3 py-2">{c.approvalRef ?? '—'}</td>
                  <td className="px-5 py-2">
                    {!c.enabled ? (
                      <span className="text-ink-quiet">
                        {t('Not enabled in the catalogue', 'غير مفعّل في الكتالوج')}
                      </span>
                    ) : r.ok ? (
                      <Status tone="settled" label={t('Originating', 'متاحة')} />
                    ) : (
                      <span className="flex flex-col gap-1">
                        <Status tone="blocked" label={t('Stopped', 'متوقفة')} />
                        <span className="max-w-[60ch] text-[12px] text-ink-quiet">
                          {words === undefined ? null : w(words)}
                        </span>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="flex flex-col gap-4" data-register>
        <h2 className="text-[15px] font-semibold text-heading">{t('The register', 'السجل')}</h2>
        {register.length === 0 ? (
          <p className="rounded-card border border-line bg-surface px-5 py-4 text-[13px] text-ink-quiet shadow-card">
            {t(
              'No approval is recorded. Until one is, no Islamic product originates.',
              'لا يوجد اعتماد مقيّد. ولن يُنشأ تمويل على أي منتج إسلامي حتى يُقيَّد.',
            )}
          </p>
        ) : (
          register.map((a: ShariahApproval) => {
            const standing = STANDING[standingOn(a, today)];
            return (
              <article
                key={a.approvalRef}
                className="rounded-card border border-line bg-surface px-5 py-4 shadow-card"
                data-approval={a.approvalRef}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="identifier text-[15px] font-semibold text-heading">{a.approvalRef}</h3>
                  <Status tone={standing.tone} label={w(standing)} />
                </div>
                <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
                  <div>
                    <dt className="text-ink-quiet">{t('Approving body', 'الجهة المعتمِدة')}</dt>
                    <dd>{a.approvingBody}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-quiet">{t('Members', 'الأعضاء')}</dt>
                    <dd>{a.members.join(arabic ? '، ' : ', ')}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-quiet">{t('Effective from', 'يسري من')}</dt>
                    <dd>{date(a.effectiveFrom)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-quiet">{t('Review or expiry', 'المراجعة أو الانتهاء')}</dt>
                    <dd>
                      {a.reviewOrExpiry === undefined
                        ? t('None set by the board', 'لم تحدده الهيئة')
                        : date(a.reviewOrExpiry)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-quiet">{t('Products covered', 'المنتجات المشمولة')}</dt>
                    <dd>{a.productCodes.map((p) => w(PRODUCT[p] ?? { en: p, ar: p })).join(arabic ? '، ' : ', ')}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-quiet">{t('Template versions', 'إصدارات النماذج')}</dt>
                    <dd className="identifier text-[12px]">
                      {a.templateVersionIds.length === 0 ? '—' : a.templateVersionIds.join(' · ')}
                    </dd>
                  </div>
                </dl>
                <details className="mt-3 text-[13px]">
                  <summary className="cursor-pointer text-ink-quiet">{t('History', 'السجل التاريخي')}</summary>
                  <ol className="mt-2 divide-y divide-line">
                    {a.history.map((e) => (
                      <li key={e.changeId} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
                        <span className="font-medium text-heading">{describe(e.change)}</span>
                        <bdi className="tabular-nums text-ink-quiet">{when(e)}</bdi>
                        <span className="text-ink-quiet">
                          {e.proposedBy} → {e.decidedBy}
                        </span>
                        <span>“{e.reason}”</span>
                      </li>
                    ))}
                  </ol>
                </details>
                {a.status === 'WITHDRAWN' ? null : (
                  <Gate staff={staff} act="SHARIAH_APPROVAL_PROPOSE" arabic={arabic}>
                    <form action={proposeApprovalStatusAction} className="mt-3 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="locale" value={segment} />
                      <input type="hidden" name="approvalRef" value={a.approvalRef} />
                      <label className="grid gap-1 text-[13px]">
                        {t('Change', 'التغيير')}
                        <select name="kind" className={FIELD_INPUT} required>
                          {a.status === 'SUSPENDED' ? (
                            <option value="REINSTATE">{w(KIND.REINSTATE)}</option>
                          ) : (
                            <option value="SUSPEND">{w(KIND.SUSPEND)}</option>
                          )}
                          <option value="RENEW">{w(KIND.RENEW)}</option>
                          <option value="WITHDRAW">{w(KIND.WITHDRAW)}</option>
                        </select>
                      </label>
                      <label className="grid gap-1 text-[13px]">
                        {t('New review date (renewal)', 'تاريخ المراجعة الجديد (للتجديد)')}
                        <input type="date" name="reviewOrExpiry" className={FIELD_INPUT} dir="ltr" />
                      </label>
                      <label className="grid min-w-[16rem] flex-1 gap-1 text-[13px]">
                        {t('The board’s minute or letter', 'محضر الهيئة أو خطابها')}
                        <input name="reason" required minLength={3} maxLength={1000} className={FIELD_INPUT} />
                      </label>
                      <button type="submit" className={BUTTON_SECONDARY} data-approval-change>
                        {t('Propose', 'اقتراح')}
                      </button>
                    </form>
                  </Gate>
                )}
              </article>
            );
          })
        )}
      </section>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-approval-pending>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">
          {t('Awaiting a second reviewer', 'بانتظار مراجع ثانٍ')}
        </h2>
        {pending.length === 0 ? (
          <p className="text-[13px] text-ink-quiet">{t('Nothing awaits confirmation.', 'لا شيء بانتظار التأكيد.')}</p>
        ) : (
          <ul className="divide-y divide-line text-[13px]">
            {pending.map((e) => (
              <li key={e.changeId} className="space-y-2 py-3">
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  <span className="identifier font-medium text-heading">{approvalRefOf(e.change)}</span>
                  <span className="font-medium">{describe(e.change)}</span>
                  <span className="text-ink-quiet">
                    {t('proposed by', 'اقترحه')} {e.proposedBy}
                  </span>
                </div>
                {e.change.kind === 'RECORD' ? (
                  <p className="text-ink">
                    {e.change.terms.approvingBody} · {e.change.terms.members.join(arabic ? '، ' : ', ')} ·{' '}
                    <bdi>{e.change.terms.effectiveFrom}</bdi> → <bdi>{e.change.terms.reviewOrExpiry ?? '—'}</bdi> ·{' '}
                    {e.change.terms.productCodes.join(', ')} ·{' '}
                    <span className="identifier text-[12px]">{e.change.terms.templateVersionIds.join(' · ')}</span>
                  </p>
                ) : null}
                <p className="text-ink">“{e.reason}”</p>
                <Gate
                  staff={staff}
                  act="SHARIAH_APPROVAL_CONFIRM"
                  arabic={arabic}
                  ownWork={e.proposedBy === staff.principalId}
                >
                  <div className="flex flex-wrap items-start gap-3">
                    <form action={decideApprovalChangeAction}>
                      <input type="hidden" name="locale" value={segment} />
                      <input type="hidden" name="changeId" value={e.changeId} />
                      <input type="hidden" name="decision" value="CONFIRM" />
                      <button type="submit" className={BUTTON_PRIMARY} data-approval-confirm>
                        {t('Confirm', 'تأكيد')}
                      </button>
                    </form>
                    <form action={decideApprovalChangeAction} className="flex flex-wrap items-start gap-2">
                      <input type="hidden" name="locale" value={segment} />
                      <input type="hidden" name="changeId" value={e.changeId} />
                      <input type="hidden" name="decision" value="REJECT" />
                      <input
                        name="note"
                        required
                        minLength={3}
                        maxLength={1000}
                        className={FIELD_INPUT}
                        placeholder={t('Why it is rejected', 'سبب الرفض')}
                      />
                      <button type="submit" className={BUTTON_SECONDARY} data-approval-reject>
                        {t('Reject', 'رفض')}
                      </button>
                    </form>
                  </div>
                </Gate>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-approval-record>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Record an approval', 'قيد اعتماد')}</h2>
        <Gate staff={staff} act="SHARIAH_APPROVAL_PROPOSE" arabic={arabic}>
          <form action={proposeApprovalRecordAction} className="grid gap-3 sm:max-w-2xl">
            <input type="hidden" name="locale" value={segment} />
            <label className="grid gap-1 text-[13px]">
              {t('The board’s reference', 'مرجع الهيئة')}
              <input name="approvalRef" required maxLength={80} className={FIELD_INPUT} dir="ltr" />
            </label>
            <label className="grid gap-1 text-[13px]">
              {t('Approving body', 'الجهة المعتمِدة')}
              <input name="approvingBody" required maxLength={200} className={FIELD_INPUT} />
            </label>
            <label className="grid gap-1 text-[13px]">
              {t('Members who approved it, one per line', 'الأعضاء الذين اعتمدوه، عضو في كل سطر')}
              <textarea name="members" required rows={3} className={FIELD_TEXTAREA} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-[13px]">
                {t('Effective from', 'يسري من')}
                <input type="date" name="effectiveFrom" required className={FIELD_INPUT} dir="ltr" />
              </label>
              <label className="grid gap-1 text-[13px]">
                {t('Review or expiry date, if the board set one', 'تاريخ المراجعة أو الانتهاء إن حددته الهيئة')}
                <input type="date" name="reviewOrExpiry" className={FIELD_INPUT} dir="ltr" />
              </label>
            </div>
            <fieldset className="grid gap-1 text-[13px]">
              <legend className="mb-1">{t('Products it covers', 'المنتجات التي يشملها')}</legend>
              {[...ISLAMIC_PRODUCT_CODES].map((p) => (
                <label key={p} className="flex items-center gap-2">
                  <input type="checkbox" name="productCodes" value={p} />
                  {w(PRODUCT[p] ?? { en: p, ar: p })}
                </label>
              ))}
            </fieldset>
            <label className="grid gap-1 text-[13px]">
              {t(
                'Template versions it approves (name@version), one per line',
                'إصدارات النماذج التي يعتمدها (name@version)، إصدار في كل سطر',
              )}
              <textarea name="templateVersionIds" rows={4} className={FIELD_TEXTAREA} dir="ltr" />
            </label>
            <label className="grid gap-1 text-[13px]">
              {t('The board’s minute or letter', 'محضر الهيئة أو خطابها')}
              <input name="reason" required minLength={3} maxLength={1000} className={FIELD_INPUT} />
            </label>
            <button type="submit" className={BUTTON_PRIMARY} data-approval-submit>
              {t('Propose', 'اقتراح')}
            </button>
          </form>
        </Gate>
        <p className="mt-2 text-[12px] text-ink-quiet">
          {t(
            'Nothing here is in force until a second Shariah reviewer confirms it. A recorded approval is never edited: it is renewed, suspended, reinstated or withdrawn, each by two reviewers, and its history stays.',
            'لا يسري شيء هنا حتى يؤكده مراجع شرعي ثانٍ. ولا يُعدَّل الاعتماد المقيّد أبداً؛ بل يُجدَّد أو يُوقف أو يُعاد أو يُسحب، كلٌّ بمراجعَين، ويبقى سجله التاريخي.',
          )}
        </p>
      </section>

      {rejected.length === 0 ? null : (
        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-approval-rejected>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Recently rejected', 'المرفوض مؤخراً')}</h2>
          <ul className="divide-y divide-line text-[13px]">
            {rejected.map((e) => (
              <li key={e.changeId} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
                <span className="identifier font-medium text-heading">{approvalRefOf(e.change)}</span>
                <span>{describe(e.change)}</span>
                <span className="text-ink-quiet">
                  {e.proposedBy} → {e.decidedBy}
                </span>
                {e.decisionNote === undefined ? null : <span className="text-ink-quiet">“{e.decisionNote}”</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
