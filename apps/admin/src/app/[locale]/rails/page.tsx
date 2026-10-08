/**
 * Rails & adapters: for each capability the engine consumes, which adapter
 * serves it, its fallback, environment, base address and whether it is
 * enabled; the revisions proposed against that; and a form to propose a
 * change to one rail. Decided by a different administrator, as everything
 * here is.
 */

import { notFound, redirect } from 'next/navigation';

import { type TenantCode, isTenantCode } from '@sanad/config/loader.ts';
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Card,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  PillLink,
  Status,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { decideRevisionAction, proposeRailChangeAction } from '../../../server/actions.ts';
import { listTenants, store } from '../../../server/credentials.ts';
import { ADAPTER_CATALOGUE, CAPABILITY_LABELS, resolveRailsConfiguration } from '../../../server/rails.ts';
import { listRevisions } from '../../../server/revisions.ts';
import { currentAdmin } from '../../../server/session.ts';

const NOTICE: Readonly<Record<string, { en: string; ar: string; tone: 'settled' | 'blocked' }>> = {
  PROPOSED: {
    en: 'Proposed. It takes effect only when a different administrator approves it.',
    ar: 'اقتُرح. لا يسري إلا بعد اعتماد مدير آخر.',
    tone: 'settled',
  },
  APPROVED: { en: 'Approved. In force from its effective moment.', ar: 'اعتُمد. يسري من لحظة نفاذه.', tone: 'settled' },
  REJECTED: { en: 'Rejected, with the reason recorded.', ar: 'رُفض وسُجّل السبب.', tone: 'settled' },
  NO_DATABASE: {
    en: 'No database is configured; revisions live in the database.',
    ar: 'لا توجد قاعدة بيانات مهيأة.',
    tone: 'blocked',
  },
  PROPOSE_FAILED: { en: 'The database refused the proposal.', ar: 'رفضت قاعدة البيانات الاقتراح.', tone: 'blocked' },
  DECIDE_FAILED: { en: 'The database refused the decision.', ar: 'رفضت قاعدة البيانات القرار.', tone: 'blocked' },
  REJECTION_REASON_REQUIRED: { en: 'A rejection says why.', ar: 'الرفض يحتاج سبباً.', tone: 'blocked' },
  RAILS_UNREADABLE: {
    en: 'The current rail configuration does not load.',
    ar: 'إعداد القنوات الحالي لا يُحمَّل.',
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

export default async function RailsAdminPage({
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
  const s = store();
  const tenants = s.kind === 'READY' ? await listTenants(s.pool) : [];
  const tenantCode: TenantCode = tenantParam !== undefined && isTenantCode(tenantParam) ? tenantParam : 'bank-a';
  const now = BigInt(Math.floor(Date.now() / 1000));
  const resolved = await resolveRailsConfiguration(tenantCode, now);
  const rails = resolved.rails.ok ? resolved.rails.value.rails : [];
  const revisions = s.kind === 'READY' ? await listRevisions(s.pool, tenantCode, 'RAILS') : [];
  const editing = rails.find((r) => r.capability === edit) ?? rails[0];
  const codesFor = (cap: string): readonly string[] =>
    (ADAPTER_CATALOGUE as Readonly<Record<string, readonly string[] | undefined>>)[cap] ?? [];
  const label = (cap: string): string => {
    const l = (CAPABILITY_LABELS as Readonly<Record<string, { en: string; ar: string } | undefined>>)[cap];
    return l === undefined ? cap : arabic ? l.ar : l.en;
  };
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-h2 font-semibold text-heading">
            {arabic ? 'قنوات التكامل والمحوّلات' : 'Rails & adapters'}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-3 text-[15px] text-ink-quiet">
            <span>
              {arabic ? 'الإعداد الساري الآن لـ' : 'Configuration in force now for'}{' '}
              <span className="identifier">{tenantCode}</span>
            </span>
            <Status
              tone={resolved.source === 'REVISION' ? 'settled' : 'progress'}
              label={
                resolved.source === 'REVISION'
                  ? arabic
                    ? `مراجعة معتمدة: ${resolved.revisionSummary ?? ''}`
                    : `approved revision: ${resolved.revisionSummary ?? ''}`
                  : arabic
                    ? 'من الملف المضمّن — لا مراجعة معتمدة بعد'
                    : 'from the checked-in file — no approved revision yet'
              }
            />
          </p>
        </div>
        {tenants.length > 1 ? (
          <div className="flex items-center gap-2">
            {tenants.map((t) => (
              <PillLink
                key={t.code}
                href={`/${segment}/rails?tenant=${encodeURIComponent(t.code)}`}
                variant={t.code === tenantCode ? 'filled' : 'quiet'}
              >
                {t.code}
              </PillLink>
            ))}
          </div>
        ) : null}
      </div>

      {n !== undefined ? (
        n.tone === 'settled' ? (
          <p role="status" className="rounded-tile bg-disc-teal px-5 py-4 text-[15px] text-positive">
            {arabic ? n.ar : n.en}
          </p>
        ) : (
          <ControlRejection
            control="OP-DETERMINACY"
            explanation={arabic ? n.ar : n.en}
            controlLabel={arabic ? 'الضابط' : 'Control'}
          />
        )
      ) : null}

      <Card>
        <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'القنوات' : 'Rails'}</h3>
        <p className="mt-1 text-[14px] text-ink-quiet">
          {arabic
            ? 'المحرك يعرف القدرات لا المورّدين؛ المحوّل المسموح لكل قدرة يأتي من كتالوج المحوّلات.'
            : 'The engine knows capabilities, not vendors; which adapter may serve each comes from the adapter catalogue.'}
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-[15px]">
            <thead>
              <tr className="border-b border-line text-ink-quiet">
                <th scope="col" className="py-3 pe-3 text-start font-normal">
                  {arabic ? 'القدرة' : 'Capability'}
                </th>
                <th scope="col" className="py-3 pe-3 text-start font-normal">
                  {arabic ? 'المحوّل' : 'Adapter'}
                </th>
                <th scope="col" className="hidden py-3 pe-3 text-start font-normal lg:table-cell">
                  {arabic ? 'الاحتياطي' : 'Fallback'}
                </th>
                <th scope="col" className="py-3 pe-3 text-start font-normal">
                  {arabic ? 'البيئة' : 'Environment'}
                </th>
                <th scope="col" className="hidden py-3 pe-3 text-start font-normal xl:table-cell">
                  {arabic ? 'العنوان' : 'Base URL'}
                </th>
                <th scope="col" className="py-3 pe-3 text-start font-normal">
                  {arabic ? 'الحالة' : 'State'}
                </th>
                <th scope="col" className="py-3 text-end font-normal">
                  {arabic ? 'إجراء' : 'Action'}
                </th>
              </tr>
            </thead>
            <tbody>
              {rails.map((r) => (
                <tr key={r.capability} className="border-b border-line last:border-b-0">
                  <td className="py-3 pe-3">
                    <span className="font-medium text-heading">{label(r.capability)}</span>
                    <br />
                    <span className="identifier text-xs text-ink-quiet">{r.capability}</span>
                    {r.note !== undefined ? (
                      <>
                        <br />
                        <span className="text-xs text-ink-quiet">{r.note}</span>
                      </>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap py-3 pe-3">
                    <span className="identifier">{r.adapter}</span>
                  </td>
                  <td className="hidden whitespace-nowrap py-3 pe-3 lg:table-cell">
                    <span className="identifier text-ink-quiet">{r.fallbackAdapter ?? '—'}</span>
                  </td>
                  <td className="whitespace-nowrap py-3 pe-3 text-ink-quiet">{r.environment}</td>
                  <td className="hidden py-3 pe-3 xl:table-cell">
                    <span className="identifier text-ink-quiet">{r.baseUrl ?? '—'}</span>
                  </td>
                  <td className="py-3 pe-3">
                    <Status
                      tone={r.enabled ? 'settled' : 'blocked'}
                      label={r.enabled ? (arabic ? 'مفعّل' : 'enabled') : arabic ? 'معطّل' : 'disabled'}
                    />
                  </td>
                  <td className="py-3 text-end">
                    <PillLink
                      href={`/${segment}/rails?tenant=${encodeURIComponent(tenantCode)}&edit=${encodeURIComponent(r.capability)}#propose`}
                    >
                      {arabic ? 'اقتراح تغيير' : 'Propose a change'}
                    </PillLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'المراجعات' : 'Revisions'}</h3>
        <p className="mt-1 text-[14px] text-ink-quiet">
          {arabic
            ? `أنت ${admin.principalId}. ما اقترحته لا تقرره.`
            : `You are ${admin.principalId}. What you proposed, another administrator decides.`}
        </p>
        {revisions.length === 0 ? (
          <p className="mt-3 text-[15px] text-ink-quiet">{arabic ? 'لا مراجعات بعد.' : 'No revisions yet.'}</p>
        ) : (
          <ul className="mt-4 flex list-none flex-col divide-y divide-line p-0">
            {revisions.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
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
                        {' '}
                        ·{' '}
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
                    <input type="hidden" name="area" value="rails" />
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

      {editing !== undefined ? (
        <Card>
          <h3 id="propose" className="text-[16px] font-semibold text-heading">
            {arabic ? 'اقتراح تغيير' : 'Propose a change'} · {label(editing.capability)}
          </h3>
          <form action={proposeRailChangeAction} className="mt-5 grid gap-5 md:grid-cols-2">
            <input type="hidden" name="locale" value={segment} />
            <input type="hidden" name="tenant" value={tenantCode} />
            <input type="hidden" name="capability" value={editing.capability} />
            <label className={FIELD_LABEL}>
              {arabic ? 'المحوّل' : 'Adapter'}
              <select name="adapter" defaultValue={editing.adapter} className={FIELD_INPUT}>
                {codesFor(editing.capability).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className={FIELD_LABEL}>
              {arabic ? 'الاحتياطي' : 'Fallback adapter'}
              <select name="fallbackAdapter" defaultValue={editing.fallbackAdapter ?? ''} className={FIELD_INPUT}>
                <option value="">{arabic ? 'بدون' : 'none'}</option>
                {codesFor(editing.capability).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className={FIELD_LABEL}>
              {arabic ? 'البيئة' : 'Environment'}
              <select name="environment" defaultValue={editing.environment} className={FIELD_INPUT}>
                {['sandbox', 'uat', 'production'].map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            <label className={FIELD_LABEL}>
              {arabic ? 'العنوان (المخطط والمضيف فقط)' : 'Base URL (scheme and host only)'}
              <input
                name="baseUrl"
                defaultValue={editing.baseUrl ?? ''}
                placeholder="https://"
                className={`${FIELD_INPUT} identifier`}
              />
            </label>
            <label className="flex items-center gap-3 text-[16px] text-ink md:col-span-2">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={editing.enabled}
                className="size-4 accent-brand-deep"
              />
              {arabic ? 'مفعّل لهذه المؤسسة' : 'Enabled for this tenant'}
            </label>
            <label className={FIELD_LABEL}>
              {arabic ? 'ملاحظة' : 'Note'}
              <input name="note" defaultValue={editing.note ?? ''} maxLength={400} className={FIELD_INPUT} />
            </label>
            <label className={FIELD_LABEL}>
              {arabic ? 'نافذ من' : 'Effective from'}
              <input name="effectiveFrom" type="datetime-local" className={FIELD_INPUT} />
            </label>
            <label className={`${FIELD_LABEL} md:col-span-2`}>
              {arabic ? 'ملخص التغيير' : 'Summary of the change'}
              <input
                name="summary"
                required
                minLength={3}
                maxLength={400}
                placeholder={
                  arabic ? 'مثال: تفعيل سمة في بيئة الاختبار' : 'e.g. enable the credit bureau in the sandbox'
                }
                className={FIELD_INPUT}
              />
            </label>
            <div className="flex flex-wrap justify-end gap-3 md:col-span-2">
              <a href={`/${segment}/rails?tenant=${encodeURIComponent(tenantCode)}`} className={BUTTON_SECONDARY}>
                {arabic ? 'إلغاء' : 'Cancel'}
              </a>
              <button type="submit" className={BUTTON_PRIMARY}>
                {arabic ? 'اقتراح' : 'Propose'}
              </button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
