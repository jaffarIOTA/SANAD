/**
 * Programmes (Wasl W5b): each trade programme in force — its limit, and its
 * anchor with the account the institution pays the anchor at — and a change
 * to one of them: add, change or remove. A change is checked against what the
 * book and the facilities hold now (no removal while in use, no new anchor on
 * a programme that has traded, no limit below exposure or below a facility),
 * proposed here, and in force from its moment only when a different
 * administrator approves it, after the same check again.
 */

import { notFound, redirect } from 'next/navigation';

import type { TenantCode } from '@sanad/config/loader.ts';
import { maskIban } from '@sanad/core/kernel/iban.ts';
import {
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

import { RevisionList } from '../RevisionList.tsx';
import { type NoticeWords, RevisionNotice } from '../RevisionNotice.tsx';
import { proposeProgrammeChangeAction } from '../../../server/actions.ts';
import { listTenants, store } from '../../../server/credentials.ts';
import { listRevisions } from '../../../server/revisions.ts';
import { currentAdmin } from '../../../server/session.ts';
import { configurableTenants, displayedTenant } from '../../../server/tenant-scope.ts';
import { resolveProgrammes } from '../../../server/wasl-configuration.ts';

const NOTICE: NoticeWords = {
  APPROVED: {
    en: 'Approved. Trades and facilities use these programmes from the effective moment.',
    ar: 'اعتُمد. تعمل الصفقات والتسهيلات بهذه البرامج من لحظة النفاذ.',
    tone: 'settled',
  },
  'REFUSED:PROGRAMME_IN_USE': {
    en: 'A programme with transactions or facilities is not removed.',
    ar: 'لا يُحذف برنامج له معاملات أو تسهيلات.',
    tone: 'blocked',
  },
  'REFUSED:ANCHOR_IN_USE': {
    en: 'A programme that has traded keeps its anchor. Open a new programme for a new anchor.',
    ar: 'يحتفظ البرنامج الذي جرى التداول فيه بجهته الراعية. افتح برنامجاً جديداً لجهة راعية جديدة.',
    tone: 'blocked',
  },
  'REFUSED:PROGRAMME_LIMIT_BELOW_EXPOSURE': {
    en: 'The programme already holds more than this limit.',
    ar: 'يحتفظ البرنامج بالفعل بأكثر من هذا الحد.',
    tone: 'blocked',
  },
  'REFUSED:PROGRAMME_LIMIT_BELOW_FACILITY': {
    en: 'A distributor’s facility in this programme is larger than this limit. Lower the facility first.',
    ar: 'تسهيل أحد الموزعين في هذا البرنامج أكبر من هذا الحد. اخفض التسهيل أولاً.',
    tone: 'blocked',
  },
  'REFUSED:PROGRAMME_ID_MALFORMED': {
    en: 'A programme id is prg- and four digits.',
    ar: 'معرّف البرنامج هو prg- وأربعة أرقام.',
    tone: 'blocked',
  },
  'REFUSED:PROGRAMME_LIMIT_MALFORMED': {
    en: 'The limit is a whole number of riyals.',
    ar: 'الحد عدد صحيح بالريال.',
    tone: 'blocked',
  },
  'REFUSED:WASL_PROGRAMMES_INVALID': {
    en: 'The programme is incomplete: names, a ten-digit anchor registration, anchor names and a Saudi IBAN are all needed, and an anchor is named the same everywhere.',
    ar: 'البرنامج غير مكتمل: يلزم الاسمان وسجل تجاري من عشرة أرقام للجهة الراعية واسماها وآيبان سعودي، وتُسمّى الجهة الراعية بالاسم نفسه في كل مكان.',
    tone: 'blocked',
  },
};

export default async function ProgrammesAdminPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly tenant?: string; readonly notice?: string; readonly edit?: string }>;
}) {
  const { locale: segment } = await params;
  const { tenant: tenantParam, notice, edit } = await searchParams;
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
  const resolved = await resolveProgrammes(tenantCode as TenantCode);
  const programmes = resolved.value.ok ? resolved.value.value : undefined;
  const revisions = s.kind === 'READY' ? await listRevisions(s.pool, tenantCode, 'PROGRAMMES') : [];
  const editing = programmes?.find((p) => p.programmeId === edit);
  const nextId = `prg-${String((programmes?.length ?? 0) + 1).padStart(4, '0')}`;

  return (
    <div className="flex flex-col gap-6" data-admin-programmes>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-heading">
            {arabic ? 'البرامج والجهات الراعية' : 'Programmes and anchors'}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-3 text-[15px] text-ink-quiet">
            <span>
              {arabic ? 'البرامج السارية الآن لـ' : 'Programmes in force now for'}{' '}
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
              ? 'البرنامج الجديد يحتاج أيضاً شروطه في كتالوج المنتجات (المنتجات والوحدات) قبل أن تُفتح عليه معاملة، وتسهيلات للموزعين تُعتمد في منصة العمليات.'
              : 'A new programme also needs its terms in the product catalogue (Products & modules) before a transaction can open on it, and facilities for its distributors, approved in the workbench.'}
          </p>
        </div>
        {tenants.length > 1 ? (
          <div className="flex items-center gap-2">
            {tenants.map((t) => (
              <PillLink
                key={t.code}
                href={`/${segment}/programmes?tenant=${encodeURIComponent(t.code)}`}
                variant={t.code === tenantCode ? 'filled' : 'quiet'}
              >
                {t.code}
              </PillLink>
            ))}
          </div>
        ) : null}
      </div>

      <RevisionNotice notice={notice} words={NOTICE} arabic={arabic} />

      {programmes === undefined ? (
        <Card>
          <ControlRejection
            control="OP-DETERMINACY"
            explanation={resolved.value.ok ? '' : resolved.value.error.detail}
            controlLabel={arabic ? 'الضابط' : 'Control'}
          />
        </Card>
      ) : (
        <>
          <Card>
            <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'السارية الآن' : 'In force'}</h3>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-[15px]">
                <thead>
                  <tr className="border-b border-line text-ink-quiet">
                    <th scope="col" className="py-3 pe-3 text-start font-normal">
                      {arabic ? 'البرنامج' : 'Programme'}
                    </th>
                    <th scope="col" className="py-3 pe-3 text-end font-normal">
                      {arabic ? 'الحد' : 'Limit'}
                    </th>
                    <th scope="col" className="py-3 pe-3 text-start font-normal">
                      {arabic ? 'الجهة الراعية' : 'Anchor'}
                    </th>
                    <th scope="col" className="hidden py-3 pe-3 text-start font-normal lg:table-cell">
                      {arabic ? 'حساب التسوية' : 'Settlement account'}
                    </th>
                    <th scope="col" className="py-3 text-end font-normal">
                      {arabic ? 'إجراء' : 'Action'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {programmes.map((p) => (
                    <tr key={p.programmeId} className="border-b border-line last:border-b-0">
                      <td className="py-3 pe-3">
                        <span className="block font-medium text-heading">{arabic ? p.nameAr : p.nameEn}</span>
                        <span className="identifier text-[13px] text-ink-quiet">{p.programmeId}</span>
                      </td>
                      <td className="whitespace-nowrap py-3 pe-3 text-end tabular-nums">
                        <bdi>{sar(p.programmeLimitMinorUnits)}</bdi> <span className="text-xs text-ink-quiet">SAR</span>
                      </td>
                      <td className="py-3 pe-3">
                        <span className="block">{arabic ? p.anchor.nameAr : p.anchor.nameEn}</span>
                        <span className="identifier text-[13px] text-ink-quiet">{p.anchor.registrationNo}</span>
                      </td>
                      <td className="hidden py-3 pe-3 lg:table-cell">
                        <bdi dir="ltr" className="identifier text-ink-quiet">
                          {maskIban(p.anchor.settlementIban)}
                        </bdi>
                      </td>
                      <td className="py-3 text-end">
                        <a
                          href={`/${segment}/programmes?tenant=${encodeURIComponent(tenantCode)}&edit=${p.programmeId}#propose`}
                          className="text-[14px] text-brand underline"
                        >
                          {arabic ? 'تغيير' : 'Change'}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <RevisionList
            revisions={revisions}
            area="programmes"
            segment={segment}
            locale={locale}
            tenantCode={tenantCode}
            principalId={admin.principalId}
            arabic={arabic}
          />

          <Card>
            <h3 id="propose" className="text-[16px] font-semibold text-heading">
              {editing === undefined
                ? arabic
                  ? 'إضافة برنامج'
                  : 'Add a programme'
                : `${arabic ? 'تغيير' : 'Change'} ${editing.programmeId}`}
            </h3>
            <form action={proposeProgrammeChangeAction} className="mt-4 grid gap-4 md:grid-cols-2">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="tenant" value={tenantCode} />
              <label className={FIELD_LABEL}>
                {arabic ? 'معرّف البرنامج' : 'Programme id'}
                <input
                  name="programmeId"
                  required
                  defaultValue={editing?.programmeId ?? nextId}
                  readOnly={editing !== undefined}
                  className={`${FIELD_INPUT} identifier`}
                  dir="ltr"
                />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'الحد (ريال)' : 'Limit (riyals)'}
                <input
                  name="limitRiyals"
                  required
                  inputMode="numeric"
                  defaultValue={editing === undefined ? '' : (editing.programmeLimitMinorUnits / 100n).toString()}
                  className={`${FIELD_INPUT} tabular-nums`}
                  dir="ltr"
                />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'الاسم بالإنجليزية' : 'Name in English'}
                <input name="nameEn" required defaultValue={editing?.nameEn ?? ''} className={FIELD_INPUT} dir="ltr" />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'الاسم بالعربية' : 'Name in Arabic'}
                <input name="nameAr" required defaultValue={editing?.nameAr ?? ''} className={FIELD_INPUT} dir="rtl" />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'السجل التجاري للجهة الراعية' : 'Anchor’s commercial registration'}
                <input
                  name="anchorRegistrationNo"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{10}"
                  defaultValue={editing?.anchor.registrationNo ?? ''}
                  className={`${FIELD_INPUT} identifier`}
                  dir="ltr"
                />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'آيبان التسوية للجهة الراعية' : 'Anchor’s settlement IBAN'}
                <input
                  name="anchorSettlementIban"
                  required
                  defaultValue={editing?.anchor.settlementIban ?? ''}
                  className={`${FIELD_INPUT} identifier`}
                  dir="ltr"
                />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'اسم الجهة الراعية بالإنجليزية' : 'Anchor’s name in English'}
                <input
                  name="anchorNameEn"
                  required
                  defaultValue={editing?.anchor.nameEn ?? ''}
                  className={FIELD_INPUT}
                  dir="ltr"
                />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'اسم الجهة الراعية بالعربية' : 'Anchor’s name in Arabic'}
                <input
                  name="anchorNameAr"
                  required
                  defaultValue={editing?.anchor.nameAr ?? ''}
                  className={FIELD_INPUT}
                  dir="rtl"
                />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'نافذ من' : 'Effective from'}
                <input name="effectiveFrom" type="datetime-local" className={FIELD_INPUT} />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'ملخص التغيير' : 'Summary of the change'}
                <input name="summary" required minLength={3} maxLength={400} className={FIELD_INPUT} />
              </label>
              <div className="flex flex-wrap justify-end gap-3 md:col-span-2">
                {editing === undefined ? null : (
                  <button type="submit" name="action" value="REMOVE" className="text-[14px] text-blocked underline">
                    {arabic ? 'اقتراح حذف هذا البرنامج' : 'Propose removing this programme'}
                  </button>
                )}
                <button type="submit" name="action" value="SAVE" className={BUTTON_PRIMARY}>
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
