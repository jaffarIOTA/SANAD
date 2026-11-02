/**
 * Goods register (Wasl W5b): the goods the Shariah board excludes from
 * financing, by HS heading, as its standing positions hold them (SR-025,
 * SH-11). An invoice line on the register refuses the trade when the
 * transaction opens. A heading is added or removed here as a BOARD_POSITIONS
 * revision — every other board position carried as it stood — and the change
 * binds new transactions from its moment only once a different administrator
 * approves it. The register is the board's ruling: the administrator records
 * it, the board decides it.
 */

import { notFound, redirect } from 'next/navigation';

import type { TenantCode } from '@sanad/config/loader.ts';
import {
  BUTTON_PRIMARY,
  Card,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  PillLink,
  Status,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { RevisionList } from '../RevisionList.tsx';
import { type NoticeWords, RevisionNotice } from '../RevisionNotice.tsx';
import { proposeGoodsChangeAction } from '../../../server/actions.ts';
import { listTenants, store } from '../../../server/credentials.ts';
import { listRevisions } from '../../../server/revisions.ts';
import { currentAdmin } from '../../../server/session.ts';
import { configurableTenants, displayedTenant } from '../../../server/tenant-scope.ts';
import { resolveBoard } from '../../../server/wasl-configuration.ts';

const NOTICE: NoticeWords = {
  APPROVED: {
    en: 'Approved. New transactions are screened against the register from its effective moment.',
    ar: 'اعتُمد. تُفحص المعاملات الجديدة وفق السجل من لحظة نفاذه.',
    tone: 'settled',
  },
  'REFUSED:GOODS_CODE_MALFORMED': {
    en: 'A goods code is an HS heading of four digits, or a subheading of six.',
    ar: 'رمز البضاعة بند من النظام المنسق من أربعة أرقام أو بند فرعي من ستة.',
    tone: 'blocked',
  },
  'REFUSED:GOODS_ALREADY_EXCLUDED': {
    en: 'That heading is already on the register.',
    ar: 'هذا البند مدرج في السجل بالفعل.',
    tone: 'blocked',
  },
  'REFUSED:GOODS_NOT_EXCLUDED': {
    en: 'That heading is not on the register.',
    ar: 'هذا البند غير مدرج في السجل.',
    tone: 'blocked',
  },
  'REFUSED:GOODS_DESCRIPTION_REQUIRED': {
    en: 'Describe the goods the heading covers.',
    ar: 'صف البضائع التي يشملها البند.',
    tone: 'blocked',
  },
};

export default async function GoodsRegisterAdminPage({
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
  const s = store();
  const tenants = s.kind === 'READY' ? configurableTenants(admin, await listTenants(s.pool)) : [];
  const tenantCode = displayedTenant(admin, tenantParam, 'bank-a');
  if (tenantCode === undefined) notFound();
  const resolved = await resolveBoard(tenantCode as TenantCode);
  const board = resolved.value.ok ? resolved.value.value : undefined;
  // Every BOARD_POSITIONS revision is listed: the register shares its revisions with the board's other positions.
  const revisions = s.kind === 'READY' ? await listRevisions(s.pool, tenantCode, 'BOARD_POSITIONS') : [];

  return (
    <div className="flex flex-col gap-6" data-admin-goods>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-heading">{arabic ? 'سجل البضائع المستبعدة' : 'Goods register'}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-3 text-[15px] text-ink-quiet">
            <span>
              {arabic ? 'مواقف الهيئة الشرعية السارية الآن لـ' : 'The Shariah board’s positions in force now for'}{' '}
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
              ? 'السجل قرار الهيئة الشرعية؛ يسجّله المسؤول ويعتمده مسؤول آخر. يُرفض أي سطر فاتورة مدرج في السجل عند فتح المعاملة.'
              : 'The register is the Shariah board’s ruling: one administrator records it and another approves. An invoice line on the register refuses the trade when the transaction opens.'}
          </p>
        </div>
        {tenants.length > 1 ? (
          <div className="flex items-center gap-2">
            {tenants.map((t) => (
              <PillLink
                key={t.code}
                href={`/${segment}/goods?tenant=${encodeURIComponent(t.code)}`}
                variant={t.code === tenantCode ? 'filled' : 'quiet'}
              >
                {t.code}
              </PillLink>
            ))}
          </div>
        ) : null}
      </div>

      <RevisionNotice notice={notice} words={NOTICE} arabic={arabic} />

      {board === undefined ? (
        <Card>
          <ControlRejection
            control="SH-17"
            explanation={resolved.value.ok ? '' : resolved.value.error.detail}
            controlLabel={arabic ? 'الضابط' : 'Control'}
          />
        </Card>
      ) : (
        <>
          <Card>
            <h3 className="text-[16px] font-semibold text-heading">
              {arabic ? 'البنود المستبعدة' : 'Excluded headings'}{' '}
              <span className="text-[13px] font-normal text-ink-quiet">· {board.shariahApprovalRef}</span>
            </h3>
            <ul className="mt-3 divide-y divide-line text-[15px]">
              {board.excludedGoods.map((g) => (
                <li key={g.code} className="flex flex-wrap gap-x-4 py-2">
                  <bdi dir="ltr" className="identifier w-20 text-heading">
                    {g.code}
                  </bdi>
                  <span>{g.description}</span>
                </li>
              ))}
            </ul>
          </Card>

          <RevisionList
            revisions={revisions}
            area="goods"
            segment={segment}
            locale={locale}
            tenantCode={tenantCode}
            principalId={admin.principalId}
            arabic={arabic}
          />

          <Card>
            <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'اقتراح تغيير' : 'Propose a change'}</h3>
            <form action={proposeGoodsChangeAction} className="mt-4 grid gap-4 md:grid-cols-2">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="tenant" value={tenantCode} />
              <label className={FIELD_LABEL}>
                {arabic ? 'رمز النظام المنسق' : 'HS code'}
                <input
                  name="code"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{4}([0-9]{2})?"
                  className={`${FIELD_INPUT} identifier`}
                  dir="ltr"
                />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'الوصف (عند الإضافة)' : 'Description (when adding)'}
                <input name="description" maxLength={200} className={FIELD_INPUT} />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'نافذ من' : 'Effective from'}
                <input name="effectiveFrom" type="datetime-local" className={FIELD_INPUT} />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'ملخص التغيير وقرار الهيئة' : 'Summary, citing the board’s ruling'}
                <input name="summary" required minLength={3} maxLength={400} className={FIELD_INPUT} />
              </label>
              <div className="flex flex-wrap justify-end gap-3 md:col-span-2">
                <button type="submit" name="action" value="REMOVE" className="text-[14px] text-blocked underline">
                  {arabic ? 'اقتراح الإزالة من السجل' : 'Propose removing from the register'}
                </button>
                <button type="submit" name="action" value="ADD" className={BUTTON_PRIMARY}>
                  {arabic ? 'اقتراح الإضافة إلى السجل' : 'Propose adding to the register'}
                </button>
              </div>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
