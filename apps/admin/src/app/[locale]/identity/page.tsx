/**
 * Staff identity: the provider the institution authenticates staff through,
 * the mapping from its groups to the platform's authorities, and the session
 * rules. Proposed here, decided by a different administrator; the session
 * layer reads what is in force. The sign-in handshake itself (SAML or OIDC)
 * is not built until a provider exists to test it against, and the page
 * says so.
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
  FIELD_TEXTAREA,
  PillLink,
  Status,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { decideRevisionAction, proposeIdentityChangeAction } from '../../../server/actions.ts';
import { listTenants, store } from '../../../server/credentials.ts';
import {
  MAX_SESSION_LIFETIME_SECONDS,
  STAFF_AUTHORITIES,
  deploymentProfile,
  mappingsToText,
  resolveStaffIdentity,
} from '../../../server/identity.ts';
import { listRevisions } from '../../../server/revisions.ts';
import { currentAdmin } from '../../../server/session.ts';

const NOTICE: Readonly<Record<string, { en: string; ar: string; tone: 'settled' | 'blocked' }>> = {
  PROPOSED: {
    en: 'Proposed. It takes effect only when a different administrator approves it.',
    ar: 'اقتُرح. لا يسري إلا بعد اعتماد مدير آخر.',
    tone: 'settled',
  },
  APPROVED: {
    en: 'Approved. Sessions started from now follow it.',
    ar: 'اعتُمد. الجلسات الجديدة تتبعه.',
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
  'REFUSED:FOUR_EYES_SELF_DECISION': {
    en: 'Four eyes: you proposed this revision, so you may not decide it.',
    ar: 'أربع أعين: أنت من اقترح هذه المراجعة فلا تقرر فيها.',
    tone: 'blocked',
  },
};

const fmt = (iso: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export default async function IdentityAdminPage({
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
  const tenants = s.kind === 'READY' ? await listTenants(s.pool) : [];
  const tenantCode: TenantCode = tenantParam !== undefined && isTenantCode(tenantParam) ? tenantParam : 'bank-a';
  const now = BigInt(Math.floor(Date.now() / 1000));
  const resolved = await resolveStaffIdentity(tenantCode, now);
  const c = resolved.identity.ok ? resolved.identity.value : undefined;
  const revisions = s.kind === 'READY' ? await listRevisions(s.pool, tenantCode, 'STAFF_IDENTITY') : [];
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
            {arabic ? 'هوية الموظفين (الدخول الموحّد)' : 'Staff identity (SSO)'}
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
                    ? 'من الملف المضمّن'
                    : 'from the checked-in file'
              }
            />
            <Status
              tone={resolved.profile === 'DEPLOYED' ? 'settled' : 'progress'}
              label={
                resolved.profile === 'DEPLOYED'
                  ? arabic
                    ? 'ملف نشر'
                    : 'deployed profile'
                  : arabic
                    ? 'ملف تطوير'
                    : 'development profile'
              }
            />
          </p>
        </div>
        {tenants.length > 1 ? (
          <div className="flex items-center gap-2">
            {tenants.map((t) => (
              <PillLink
                key={t.code}
                href={`/${segment}/identity?tenant=${encodeURIComponent(t.code)}`}
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

      {c === undefined ? (
        <Card>
          <ControlRejection
            control="OP-DETERMINACY"
            explanation={
              resolved.identity.ok ? '' : `${resolved.identity.error.reason}: ${resolved.identity.error.detail}`
            }
            controlLabel={arabic ? 'الضابط' : 'Control'}
          />
        </Card>
      ) : (
        <Card>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <span className={FIELD_LABEL}>{arabic ? 'البروتوكول' : 'Protocol'}</span>
              <div className={`${FIELD_INPUT} flex items-center`}>
                {c.provider.protocol}
                {c.provider.protocol === 'DEVELOPMENT' ? (
                  <span className="ms-3 text-xs text-attention">
                    {arabic ? 'بديل تطويري — لا يُقبل في النشر' : 'development stand-in — refused when deployed'}
                  </span>
                ) : null}
              </div>
            </div>
            <div>
              <span className={FIELD_LABEL}>{arabic ? 'المُصدر' : 'Issuer'}</span>
              <div className={`${FIELD_INPUT} identifier flex items-center`}>{c.provider.issuer}</div>
            </div>
            <div>
              <span className={FIELD_LABEL}>{arabic ? 'رابط البيانات الوصفية' : 'Metadata / discovery URL'}</span>
              <div className={`${FIELD_INPUT} identifier flex items-center`}>{c.provider.metadataUrl ?? '—'}</div>
            </div>
            <div>
              <span className={FIELD_LABEL}>{arabic ? 'معرّف العميل' : 'Client id'}</span>
              <div className={`${FIELD_INPUT} identifier flex items-center`}>{c.provider.clientId ?? '—'}</div>
            </div>
            <div>
              <span className={FIELD_LABEL}>{arabic ? 'مدة الجلسة' : 'Session lifetime'}</span>
              <div className={`${FIELD_INPUT} flex items-center tabular-nums`}>{c.sessionLifetimeSeconds} s</div>
            </div>
            <div>
              <span className={FIELD_LABEL}>{arabic ? 'إعادة المصادقة للاعتماد' : 'Step-up for approval'}</span>
              <div className={`${FIELD_INPUT} flex items-center tabular-nums`}>
                {c.stepUpForApprovalSeconds === undefined ? '—' : `${c.stepUpForApprovalSeconds} s`}
              </div>
            </div>
          </div>
          <h3 className="mt-6 text-[16px] font-semibold text-heading">
            {arabic ? 'المجموعات والصلاحيات' : 'Groups and authorities'}
          </h3>
          <table className="mt-3 w-full border-collapse text-[15px]">
            <thead>
              <tr className="border-b border-line text-ink-quiet">
                <th scope="col" className="py-2 pe-3 text-start font-normal">
                  {arabic ? `المجموعة (${c.provider.groupsClaim})` : `Group (${c.provider.groupsClaim})`}
                </th>
                <th scope="col" className="py-2 text-start font-normal">
                  {arabic ? 'الصلاحية' : 'Authority'}
                </th>
              </tr>
            </thead>
            <tbody>
              {c.mappings.map((m) => (
                <tr key={m.group} className="border-b border-line last:border-b-0">
                  <td className="py-2 pe-3">
                    <span className="identifier">{m.group}</span>
                  </td>
                  <td className="py-2">
                    <Status tone={m.authority === 'PLATFORM_ADMIN' ? 'blocked' : 'settled'} label={m.authority} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-[13px] text-ink-quiet">
            {arabic
              ? 'مصافحة الدخول نفسها (SAML أو OIDC) لم تُبنَ بعد؛ تُبنى عند توفر موفّر هوية للاختبار عليه. الجلسات التطويرية تتبع مدة الجلسة أعلاه.'
              : 'The sign-in handshake itself (SAML or OIDC) is not built; it is built when a provider exists to test against. Development sessions already follow the session lifetime above.'}
          </p>
        </Card>
      )}

      <Card>
        <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'المراجعات' : 'Revisions'}</h3>
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
                    <input type="hidden" name="area" value="identity" />
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
        <h3 className="text-[16px] font-semibold text-heading">
          {arabic ? 'اقتراح إعداد' : 'Propose a configuration'}
        </h3>
        <p className="mt-1 text-[14px] text-ink-quiet">
          {arabic
            ? 'لا سرّ هنا: سرّ العميل أو شهادة التوقيع تُحفظ في الخزنة تحت بيانات الاعتماد.'
            : 'No secret here: the client secret or signing certificate is saved in the vault under Credentials.'}
        </p>
        <form action={proposeIdentityChangeAction} className="mt-5 grid gap-5 md:grid-cols-2">
          <input type="hidden" name="locale" value={segment} />
          <input type="hidden" name="tenant" value={tenantCode} />
          <label className={FIELD_LABEL}>
            {arabic ? 'البروتوكول' : 'Protocol'}
            <select name="protocol" defaultValue={c?.provider.protocol ?? 'OIDC'} className={FIELD_INPUT}>
              {['OIDC', 'SAML', 'DEVELOPMENT'].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className={FIELD_LABEL}>
            {arabic ? 'يُفحص لملف' : 'Check as'}
            <select name="profile" defaultValue={deploymentProfile()} className={FIELD_INPUT}>
              <option value="DEVELOPMENT">{arabic ? 'تطوير' : 'development'}</option>
              <option value="DEPLOYED">{arabic ? 'نشر (لا بديل تطويري)' : 'deployed (no development stand-in)'}</option>
            </select>
          </label>
          <label className={FIELD_LABEL}>
            {arabic ? 'المُصدر / معرّف الكيان' : 'Issuer / entity id'}
            <input
              name="issuer"
              required
              defaultValue={c?.provider.issuer ?? ''}
              className={`${FIELD_INPUT} identifier`}
            />
          </label>
          <label className={FIELD_LABEL}>
            {arabic ? 'رابط البيانات الوصفية (https)' : 'Metadata / discovery URL (https)'}
            <input
              name="metadataUrl"
              defaultValue={c?.provider.metadataUrl ?? ''}
              placeholder="https://"
              className={`${FIELD_INPUT} identifier`}
            />
          </label>
          <label className={FIELD_LABEL}>
            {arabic ? 'معرّف العميل (OIDC)' : 'Client id (OIDC)'}
            <input name="clientId" defaultValue={c?.provider.clientId ?? ''} className={`${FIELD_INPUT} identifier`} />
          </label>
          <label className={FIELD_LABEL}>
            {arabic ? 'اسم مطالبة المجموعات' : 'Groups claim / attribute'}
            <input
              name="groupsClaim"
              required
              defaultValue={c?.provider.groupsClaim ?? 'groups'}
              className={`${FIELD_INPUT} identifier`}
            />
          </label>
          <label className={FIELD_LABEL}>
            {arabic ? 'مدة الجلسة (ثوانٍ)' : 'Session lifetime (seconds)'}
            <input
              name="sessionLifetimeSeconds"
              type="number"
              min={60}
              max={MAX_SESSION_LIFETIME_SECONDS}
              required
              defaultValue={c?.sessionLifetimeSeconds ?? 1800}
              className={`${FIELD_INPUT} tabular-nums`}
            />
          </label>
          <label className={FIELD_LABEL}>
            {arabic ? 'إعادة المصادقة للاعتماد (ثوانٍ، اختياري)' : 'Step-up for approval (seconds, optional)'}
            <input
              name="stepUpForApprovalSeconds"
              type="number"
              min={30}
              defaultValue={c?.stepUpForApprovalSeconds ?? ''}
              className={`${FIELD_INPUT} tabular-nums`}
            />
          </label>
          <label className={`${FIELD_LABEL} md:col-span-2`}>
            {arabic ? 'المجموعات → الصلاحيات (سطر لكل مجموعة)' : 'Groups → authorities (one per line)'}
            <textarea
              name="mappings"
              rows={6}
              required
              spellCheck={false}
              defaultValue={c === undefined ? '' : mappingsToText(c)}
              className={`${FIELD_TEXTAREA} identifier text-[13px]`}
            />
            <span className="mt-2 block text-[13px] text-ink-quiet">
              {arabic ? 'الصلاحيات:' : 'Authorities:'} {STAFF_AUTHORITIES.join(' · ')}.{' '}
              {arabic
                ? 'يجب أن تصل مجموعة إلى MAKER وأخرى إلى CHECKER.'
                : 'Some group must reach MAKER and some group CHECKER.'}
            </span>
          </label>
          <label className={FIELD_LABEL}>
            {arabic ? 'الإصدار' : 'Version'}
            <input
              name="version"
              defaultValue=""
              placeholder={new Date().toISOString().slice(0, 10)}
              className={`${FIELD_INPUT} identifier`}
            />
          </label>
          <label className={FIELD_LABEL}>
            {arabic ? 'نافذ من' : 'Effective from'}
            <input name="effectiveFrom" type="datetime-local" className={FIELD_INPUT} />
          </label>
          <label className={`${FIELD_LABEL} md:col-span-2`}>
            {arabic ? 'ملخص التغيير' : 'Summary of the change'}
            <input name="summary" required minLength={3} maxLength={400} className={FIELD_INPUT} />
          </label>
          <div className="flex flex-wrap justify-end gap-3 md:col-span-2">
            <a href={`/${segment}/identity?tenant=${encodeURIComponent(tenantCode)}`} className={BUTTON_SECONDARY}>
              {arabic ? 'إلغاء' : 'Cancel'}
            </a>
            <button type="submit" className={BUTTON_PRIMARY}>
              {arabic ? 'اقتراح' : 'Propose'}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
