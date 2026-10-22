/**
 * Concentration (Wasl W5a): which concentration rules the institution applies
 * to a trade before its cost is held — a cap on a single trade, a
 * distributor's share of its programme, an anchor's share of the book — and
 * their values. Each rule is chosen here; one not chosen refuses nothing. A
 * change is proposed by one administrator and takes effect, from its stated
 * moment, only when a different administrator approves it.
 */

import { notFound, redirect } from 'next/navigation';

import type { TenantCode } from '@sanad/config/loader.ts';
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  Card,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  PillLink,
  Status,
} from '@sanad/design/primitives.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { decideRevisionAction, proposeConcentrationAction } from '../../../server/actions.ts';
import { percentOf, resolveConcentrationWithSource } from '../../../server/concentration.ts';
import { listTenants, store } from '../../../server/credentials.ts';
import { listRevisions } from '../../../server/revisions.ts';
import { currentAdmin } from '../../../server/session.ts';
import { configurableTenants, displayedTenant } from '../../../server/tenant-scope.ts';

const NOTICE: Readonly<Record<string, { en: string; ar: string; tone: 'settled' | 'blocked' }>> = {
  PROPOSED: {
    en: 'Proposed. It takes effect only when a different administrator approves it.',
    ar: 'اقتُرح. لا يسري إلا بعد اعتماد مدير آخر.',
    tone: 'settled',
  },
  APPROVED: {
    en: 'Approved. Trades are checked against it from its effective moment.',
    ar: 'اعتُمد. تُفحص الصفقات وفقه من لحظة نفاذه.',
    tone: 'settled',
  },
  REJECTED: { en: 'Rejected, with the reason recorded.', ar: 'رُفض وسُجّل السبب.', tone: 'settled' },
  NO_DATABASE: {
    en: 'No database is configured; revisions live in the database.',
    ar: 'لا توجد قاعدة بيانات مهيأة.',
    tone: 'blocked',
  },
  PROPOSE_FAILED: { en: 'The database refused the proposal.', ar: 'رفضت قاعدة البيانات الاقتراح.', tone: 'blocked' },
  DECIDE_FAILED: { en: 'The database refused the decision.', ar: 'رفضت قاعدة البيانات القرار.', tone: 'blocked' },
  REJECTION_REASON_REQUIRED: { en: 'A rejection says why.', ar: 'الرفض يحتاج سبباً.', tone: 'blocked' },
  EFFECTIVE_FROM_MALFORMED: { en: 'The effective date is not a date.', ar: 'تاريخ النفاذ غير صالح.', tone: 'blocked' },
  'REFUSED:TRADE_CAP_REQUIRED': {
    en: 'A single-trade cap that applies needs its amount in riyals.',
    ar: 'الحد الأقصى للصفقة الواحدة المطبّق يحتاج مبلغه بالريال.',
    tone: 'blocked',
  },
  'REFUSED:DISTRIBUTOR_SHARE_MALFORMED': {
    en: 'The distributor share is a percentage from 0.01 to 100, with at most two decimals.',
    ar: 'نصيب الموزع نسبة من ٠٫٠١ إلى ١٠٠ بخانتين عشريتين على الأكثر.',
    tone: 'blocked',
  },
  'REFUSED:ANCHOR_SHARE_MALFORMED': {
    en: 'The anchor share is a percentage from 0.01 to 100, with at most two decimals.',
    ar: 'نصيب الجهة الراعية نسبة من ٠٫٠١ إلى ١٠٠ بخانتين عشريتين على الأكثر.',
    tone: 'blocked',
  },
  'REFUSED:FOUR_EYES_SELF_DECISION': {
    en: 'Four eyes: you proposed this revision, so you may not decide it.',
    ar: 'أربع أعين: أنت من اقترح هذه المراجعة فلا تقرر فيها.',
    tone: 'blocked',
  },
};

const fmt = (iso: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export default async function ConcentrationAdminPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly tenant?: string; readonly notice?: string }>;
}) {
  const { locale: segment } = await params;
  const { tenant: tenantParam, notice } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${segment}`);
  const arabic = locale === 'ar-SA';
  const numerals = defaultNumerals(locale);
  const sar = (minor: bigint): string => formatMinorUnits({ minorUnits: minor, currency: 'SAR' }, numerals);
  const s = store();
  const tenants = s.kind === 'READY' ? configurableTenants(admin, await listTenants(s.pool)) : [];
  const tenantCode = displayedTenant(admin, tenantParam, 'bank-a');
  if (tenantCode === undefined) notFound();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const resolved = await resolveConcentrationWithSource(
    s.kind === 'READY' ? s.pool : undefined,
    tenantCode as TenantCode,
    now,
  );
  const policy = resolved.policy.ok ? resolved.policy.value : undefined;
  const revisions = s.kind === 'READY' ? await listRevisions(s.pool, tenantCode, 'CONCENTRATION') : [];
  const n =
    notice === undefined
      ? undefined
      : (NOTICE[notice] ??
        (notice.startsWith('REFUSED:')
          ? {
              en: `Refused before proposal: ${notice.slice(8)}`,
              ar: `رُفض قبل الاقتراح: ${notice.slice(8)}`,
              tone: 'blocked' as const,
            }
          : undefined));
  const applied = (on: boolean, value: string) => (on ? value : arabic ? 'غير مطبّق' : 'not applied');

  return (
    <div className="flex flex-col gap-6" data-admin-concentration>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-heading">{arabic ? 'قواعد التركّز' : 'Concentration'}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-3 text-[15px] text-ink-quiet">
            <span>
              {arabic ? 'القواعد السارية الآن لـ' : 'Rules in force now for'}{' '}
              <span className="identifier">{tenantCode}</span>
            </span>
            <Status
              tone={resolved.source === 'REVISION' ? 'settled' : 'progress'}
              label={
                resolved.source === 'REVISION'
                  ? `${arabic ? 'مراجعة معتمدة' : 'approved revision'}: ${resolved.revisionSummary ?? ''}`
                  : arabic
                    ? 'من الملف المضمّن'
                    : 'from the checked-in file'
              }
            />
          </p>
          <p className="mt-2 max-w-3xl text-[14px] text-ink-quiet">
            {arabic
              ? 'تُفحص تكلفة كل صفقة وصل مقابل تسهيل الموزع ثم حد البرنامج ثم القواعد المختارة هنا. القاعدة غير المختارة لا ترفض شيئاً. تُقاس الأنصبة مقابل الحدود لا الاستخدام الحالي.'
              : 'Every Wasl trade’s cost is checked against the distributor’s facility, then the programme’s limit, then the rules chosen here. A rule not chosen refuses nothing. Shares are measured against limits, not current utilisation.'}
          </p>
        </div>
        {tenants.length > 1 ? (
          <div className="flex items-center gap-2">
            {tenants.map((t) => (
              <PillLink
                key={t.code}
                href={`/${segment}/concentration?tenant=${encodeURIComponent(t.code)}`}
                variant={t.code === tenantCode ? 'filled' : 'quiet'}
              >
                {t.code}
              </PillLink>
            ))}
          </div>
        ) : null}
      </div>

      {n === undefined ? null : n.tone === 'settled' ? (
        <p role="status" className="rounded-tile bg-disc-teal px-5 py-4 text-[15px] text-positive">
          {arabic ? n.ar : n.en}
        </p>
      ) : (
        <ControlRejection
          control="OP-DETERMINACY"
          explanation={arabic ? n.ar : n.en}
          controlLabel={arabic ? 'الضابط' : 'Control'}
        />
      )}

      {policy === undefined ? (
        <Card>
          <ControlRejection
            control="OP-DETERMINACY"
            explanation={resolved.policy.ok ? '' : resolved.policy.error.detail}
            controlLabel={arabic ? 'الضابط' : 'Control'}
          />
        </Card>
      ) : (
        <>
          <Card>
            <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'السارية الآن' : 'In force'}</h3>
            <dl className="mt-3 grid gap-2 text-[15px] sm:grid-cols-[max-content_1fr] sm:gap-x-6">
              <dt className="text-ink-quiet">{arabic ? 'الحد الأقصى للصفقة الواحدة' : 'Single-trade cap'}</dt>
              <dd className="tabular-nums">
                {applied(policy.singleTradeCap.enabled, `${sar(policy.singleTradeCap.maxCostMinorUnits)} SAR`)}
              </dd>
              <dt className="text-ink-quiet">
                {arabic ? 'نصيب الموزع من برنامجه' : 'Distributor’s share of its programme'}
              </dt>
              <dd className="tabular-nums">
                {applied(
                  policy.distributorShareOfProgramme.enabled,
                  `${percentOf(policy.distributorShareOfProgramme.maxSharePerTenThousand)}%`,
                )}
              </dd>
              <dt className="text-ink-quiet">
                {arabic ? 'نصيب الجهة الراعية من المحفظة' : 'Anchor’s share of the book'}
              </dt>
              <dd className="tabular-nums">
                {applied(
                  policy.anchorShareOfBook.enabled,
                  `${percentOf(policy.anchorShareOfBook.maxSharePerTenThousand)}%`,
                )}
              </dd>
              <dt className="text-ink-quiet">{arabic ? 'مرجع السياسة' : 'Policy reference'}</dt>
              <dd className="identifier">{policy.policyRef}</dd>
            </dl>
          </Card>

          <Card>
            <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'المراجعات' : 'Revisions'}</h3>
            {revisions.length === 0 ? (
              <p className="mt-3 text-[15px] text-ink-quiet">{arabic ? 'لا مراجعات بعد.' : 'No revisions yet.'}</p>
            ) : (
              <ul className="mt-4 flex list-none flex-col divide-y divide-line p-0">
                {revisions.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0"
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[15px] font-medium text-heading">{r.summary}</span>
                        <Status
                          tone={r.status === 'APPROVED' ? 'settled' : r.status === 'REJECTED' ? 'blocked' : 'progress'}
                          label={r.status.toLowerCase()}
                        />
                      </span>
                      <span className="text-[13px] text-ink-quiet">
                        {arabic ? 'نافذة من' : 'effective'} {fmt(r.effectiveFrom, locale)} ·{' '}
                        {arabic ? 'اقترحها' : 'proposed by'} <span className="identifier">{r.proposedBy}</span>
                        {r.decidedBy !== null && r.decidedAt !== null ? (
                          <>
                            {' · '}
                            {r.status === 'APPROVED'
                              ? arabic
                                ? 'اعتمدها'
                                : 'approved by'
                              : arabic
                                ? 'رفضها'
                                : 'rejected by'}{' '}
                            <span className="identifier">{r.decidedBy}</span> {fmt(r.decidedAt, locale)}
                            {r.rejectionReason !== null ? ` — ${r.rejectionReason}` : ''}
                          </>
                        ) : null}
                      </span>
                    </span>
                    {r.status === 'PROPOSED' ? (
                      <form action={decideRevisionAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="locale" value={segment} />
                        <input type="hidden" name="tenant" value={tenantCode} />
                        <input type="hidden" name="area" value="concentration" />
                        <input type="hidden" name="revisionId" value={r.id} />
                        <input
                          name="reason"
                          placeholder={arabic ? 'سبب الرفض' : 'reason, if rejecting'}
                          className={`${FIELD_INPUT} mt-0 h-[38px] w-[220px] text-[14px]`}
                        />
                        <button
                          type="submit"
                          name="decision"
                          value="reject"
                          disabled={r.proposedBy === admin.principalId}
                          className={`${BUTTON_DANGER} h-[38px] px-4 text-[14px] disabled:opacity-40`}
                        >
                          {arabic ? 'رفض' : 'Reject'}
                        </button>
                        <button
                          type="submit"
                          name="decision"
                          value="approve"
                          disabled={r.proposedBy === admin.principalId}
                          className={`${BUTTON_PRIMARY} h-[38px] min-w-0 px-4 text-[14px] disabled:opacity-40`}
                        >
                          {arabic ? 'اعتماد' : 'Approve'}
                        </button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'اقتراح تغيير' : 'Propose a change'}</h3>
            <form action={proposeConcentrationAction} className="mt-4 grid gap-4 md:grid-cols-2">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="tenant" value={tenantCode} />
              <label className={`${FIELD_LABEL} md:col-span-2`}>
                {arabic ? 'مرجع السياسة' : 'Policy reference'}
                <input
                  name="policyRef"
                  required
                  defaultValue={policy.policyRef}
                  className={`${FIELD_INPUT} identifier`}
                />
              </label>
              <fieldset className="grid gap-2 md:col-span-2">
                <label className="flex items-center gap-2 text-[15px]">
                  <input type="checkbox" name="tradeCapEnabled" defaultChecked={policy.singleTradeCap.enabled} />
                  {arabic ? 'تطبيق حد أقصى للصفقة الواحدة' : 'Apply a single-trade cap'}
                </label>
                <label className={FIELD_LABEL}>
                  {arabic ? 'الحد الأقصى لتكلفة الصفقة (ريال)' : 'Maximum cost of one trade (riyals)'}
                  <input
                    name="tradeCapRiyals"
                    inputMode="numeric"
                    pattern="[0-9]{1,13}"
                    defaultValue={(policy.singleTradeCap.maxCostMinorUnits / 100n).toString()}
                    className={`${FIELD_INPUT} tabular-nums`}
                    dir="ltr"
                  />
                </label>
              </fieldset>
              <fieldset className="grid gap-2">
                <label className="flex items-center gap-2 text-[15px]">
                  <input
                    type="checkbox"
                    name="distributorShareEnabled"
                    defaultChecked={policy.distributorShareOfProgramme.enabled}
                  />
                  {arabic ? 'تطبيق نصيب الموزع من برنامجه' : 'Apply a distributor’s share of its programme'}
                </label>
                <label className={FIELD_LABEL}>
                  {arabic ? 'النسبة القصوى (%)' : 'Maximum share (%)'}
                  <input
                    name="distributorSharePercent"
                    inputMode="decimal"
                    defaultValue={percentOf(policy.distributorShareOfProgramme.maxSharePerTenThousand)}
                    className={`${FIELD_INPUT} tabular-nums`}
                    dir="ltr"
                  />
                </label>
              </fieldset>
              <fieldset className="grid gap-2">
                <label className="flex items-center gap-2 text-[15px]">
                  <input type="checkbox" name="anchorShareEnabled" defaultChecked={policy.anchorShareOfBook.enabled} />
                  {arabic ? 'تطبيق نصيب الجهة الراعية من المحفظة' : 'Apply an anchor’s share of the book'}
                </label>
                <label className={FIELD_LABEL}>
                  {arabic ? 'النسبة القصوى (%)' : 'Maximum share (%)'}
                  <input
                    name="anchorSharePercent"
                    inputMode="decimal"
                    defaultValue={percentOf(policy.anchorShareOfBook.maxSharePerTenThousand)}
                    className={`${FIELD_INPUT} tabular-nums`}
                    dir="ltr"
                  />
                </label>
              </fieldset>
              <label className={FIELD_LABEL}>
                {arabic ? 'نافذ من' : 'Effective from'}
                <input name="effectiveFrom" type="datetime-local" className={FIELD_INPUT} />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'ملخص التغيير' : 'Summary of the change'}
                <input name="summary" required minLength={3} maxLength={400} className={FIELD_INPUT} />
              </label>
              <div className="flex justify-end md:col-span-2">
                <button type="submit" className={BUTTON_PRIMARY}>
                  {arabic ? 'اقتراح' : 'Propose'}
                </button>
              </div>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
