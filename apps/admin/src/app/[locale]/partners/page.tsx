/**
 * Partner entitlements: which partners and aggregators may originate for
 * the tenant, on which channel, for which programmes, up to what amount;
 * the agents and approval tiers alongside, since they share the policy. A
 * change is proposed here and decided by a different administrator; the
 * workbench acts under the revision in force on its next request.
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
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { decideRevisionAction, proposePartnerChangeAction } from '../../../server/actions.ts';
import { listTenants, store } from '../../../server/credentials.ts';
import { partnerOf, resolveOriginationPolicy } from '../../../server/partners.ts';
import { listRevisions } from '../../../server/revisions.ts';
import { currentAdmin } from '../../../server/session.ts';

const NOTICE: Readonly<Record<string, { en: string; ar: string; tone: 'settled' | 'blocked' }>> = {
  PROPOSED: {
    en: 'Proposed. It takes effect only when a different administrator approves it.',
    ar: 'اقتُرح. لا يسري إلا بعد اعتماد مدير آخر.',
    tone: 'settled',
  },
  APPROVED: {
    en: 'Approved. The workbench acts under it from its effective moment.',
    ar: 'اعتُمد. تعمل المنصة به من لحظة نفاذه.',
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
  POLICY_UNREADABLE: { en: 'The current policy does not load.', ar: 'السياسة الحالية لا تُحمَّل.', tone: 'blocked' },
  'REFUSED:FOUR_EYES_SELF_DECISION': {
    en: 'Four eyes: you proposed this revision, so you may not decide it.',
    ar: 'أربع أعين: أنت من اقترح هذه المراجعة فلا تقرر فيها.',
    tone: 'blocked',
  },
};

const fmt = (iso: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export default async function PartnersAdminPage({
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
  const tenants = s.kind === 'READY' ? await listTenants(s.pool) : [];
  const tenantCode: TenantCode = tenantParam !== undefined && isTenantCode(tenantParam) ? tenantParam : 'bank-a';
  const now = BigInt(Math.floor(Date.now() / 1000));
  const resolved = await resolveOriginationPolicy(tenantCode, now);
  const policy = resolved.policy.ok ? resolved.policy.value : undefined;
  const revisions = s.kind === 'READY' ? await listRevisions(s.pool, tenantCode, 'ORIGINATION_POLICY') : [];
  const editing = policy === undefined ? undefined : partnerOf(policy, edit);
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
          <h2 className="text-h2 font-semibold text-heading">{arabic ? 'صلاحيات الشركاء' : 'Partner entitlements'}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-3 text-[15px] text-ink-quiet">
            <span>
              {arabic ? 'سياسة الإنشاء السارية الآن لـ' : 'Origination policy in force now for'}{' '}
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
          </p>
        </div>
        {tenants.length > 1 ? (
          <div className="flex items-center gap-2">
            {tenants.map((t) => (
              <PillLink
                key={t.code}
                href={`/${segment}/partners?tenant=${encodeURIComponent(t.code)}`}
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

      {policy !== undefined ? (
        <>
          <Card>
            <h3 className="text-[16px] font-semibold text-heading">
              {arabic ? 'الشركاء والوسطاء' : 'Partners and aggregators'}
            </h3>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-[15px]">
                <thead>
                  <tr className="border-b border-line text-ink-quiet">
                    <th scope="col" className="py-3 pe-3 text-start font-normal">
                      {arabic ? 'الشريك' : 'Partner'}
                    </th>
                    <th scope="col" className="py-3 pe-3 text-start font-normal">
                      {arabic ? 'القناة' : 'Channel'}
                    </th>
                    <th scope="col" className="hidden py-3 pe-3 text-start font-normal lg:table-cell">
                      {arabic ? 'البرامج' : 'Programmes'}
                    </th>
                    <th scope="col" className="py-3 pe-3 text-end font-normal">
                      {arabic ? 'الحد لكل طلب' : 'Max per request'}
                    </th>
                    <th scope="col" className="py-3 pe-3 text-start font-normal">
                      {arabic ? 'الحالة' : 'Status'}
                    </th>
                    <th scope="col" className="py-3 text-end font-normal">
                      {arabic ? 'إجراء' : 'Action'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {policy.partners.map((p) => (
                    <tr key={p.partnerId} className="border-b border-line last:border-b-0">
                      <td className="py-3 pe-3">
                        <span className="identifier font-medium text-heading">{p.partnerId}</span>
                      </td>
                      <td className="whitespace-nowrap py-3 pe-3 text-ink-quiet">
                        {p.channel.replaceAll('_', ' ').toLowerCase()}
                      </td>
                      <td className="hidden py-3 pe-3 lg:table-cell">
                        <span className="identifier text-ink-quiet">
                          {p.programmes === 'ALL' ? 'ALL' : p.programmes.join(', ')}
                        </span>
                      </td>
                      <td className="whitespace-nowrap py-3 pe-3 text-end tabular-nums">
                        <bdi>{sar(p.maxRequestMinorUnits)}</bdi> <span className="text-xs text-ink-quiet">SAR</span>
                      </td>
                      <td className="py-3 pe-3">
                        <Status tone={p.status === 'ACTIVE' ? 'settled' : 'blocked'} label={p.status.toLowerCase()} />
                      </td>
                      <td className="py-3 text-end">
                        <PillLink
                          href={`/${segment}/partners?tenant=${encodeURIComponent(tenantCode)}&edit=${encodeURIComponent(p.partnerId)}#propose`}
                        >
                          {arabic ? 'اقتراح تغيير' : 'Propose a change'}
                        </PillLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="mt-8 text-[16px] font-semibold text-heading">{arabic ? 'الوكلاء' : 'Agents'}</h3>
            <ul className="mt-3 flex list-none flex-col divide-y divide-line p-0 text-[15px]">
              {policy.agents.map((a) => (
                <li key={a.agentId} className="flex flex-wrap items-center justify-between gap-3 py-2">
                  <span>
                    <span className="identifier">{a.agentId}</span>{' '}
                    <span className="text-ink-quiet">
                      · {a.branchCode} · {a.programmes === 'ALL' ? 'ALL' : a.programmes.join(', ')}
                    </span>
                  </span>
                  <span className="flex items-center gap-3 tabular-nums">
                    <bdi>{sar(a.maxRequestMinorUnits)}</bdi>{' '}
                    <Status tone={a.status === 'ACTIVE' ? 'settled' : 'blocked'} label={a.status.toLowerCase()} />
                  </span>
                </li>
              ))}
            </ul>
            <h3 className="mt-8 text-[16px] font-semibold text-heading">
              {arabic ? 'مستويات الاعتماد' : 'Approval tiers'}
            </h3>
            <ul className="mt-3 flex list-none flex-col divide-y divide-line p-0 text-[15px]">
              {policy.approvalTiers.map((t, i) => (
                <li key={i} className="flex items-center justify-between gap-3 py-2">
                  <span className="tabular-nums">
                    {t.upToMinorUnits === undefined ? (
                      arabic ? (
                        'بلا حد'
                      ) : (
                        'unbounded'
                      )
                    ) : (
                      <>
                        {arabic ? 'حتى' : 'up to'} <bdi>{sar(t.upToMinorUnits)}</bdi> SAR
                      </>
                    )}
                  </span>
                  <Status tone="progress" label={t.authority} />
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[13px] text-ink-quiet">
              {arabic
                ? 'الوكلاء والمستويات يُغيَّران بالآلية نفسها؛ الشاشة تقترح تغييرات الشركاء الآن، والباقي يأتي بعدها.'
                : 'Agents and tiers change through the same mechanism; this screen proposes partner changes now, the rest follow.'}
            </p>
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
                        <input type="hidden" name="area" value="partners" />
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
            <h3 id="propose" className="text-[16px] font-semibold text-heading">
              {editing === undefined
                ? arabic
                  ? 'إضافة شريك'
                  : 'Add a partner'
                : arabic
                  ? `اقتراح تغيير · ${editing.partnerId}`
                  : `Propose a change · ${editing.partnerId}`}
            </h3>
            <form action={proposePartnerChangeAction} className="mt-5 grid gap-5 md:grid-cols-2">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="tenant" value={tenantCode} />
              <label className={FIELD_LABEL}>
                {arabic ? 'معرّف الشريك' : 'Partner id'}
                <input
                  name="partnerId"
                  required
                  pattern="[a-z0-9][a-z0-9-]{2,60}"
                  defaultValue={editing?.partnerId ?? ''}
                  readOnly={editing !== undefined}
                  className={`${FIELD_INPUT} identifier`}
                />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'الحالة' : 'Status'}
                <select name="status" defaultValue={editing?.status ?? 'ACTIVE'} className={FIELD_INPUT}>
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="SUSPENDED">SUSPENDED</option>
                </select>
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'القناة' : 'Channel'}
                <select name="channel" defaultValue={editing?.channel ?? 'PARTNER_API'} className={FIELD_INPUT}>
                  <option value="PARTNER_API">PARTNER_API</option>
                  <option value="EMBEDDED_AGGREGATOR">EMBEDDED_AGGREGATOR</option>
                </select>
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'البرامج (مفصولة بفواصل، أو ALL)' : 'Programmes (comma-separated, or ALL)'}
                <input
                  name="programmes"
                  required
                  defaultValue={
                    editing === undefined ? 'ALL' : editing.programmes === 'ALL' ? 'ALL' : editing.programmes.join(', ')
                  }
                  className={`${FIELD_INPUT} identifier`}
                />
              </label>
              <label className={FIELD_LABEL}>
                {arabic ? 'الحد لكل طلب (هللات)' : 'Max per request (minor units)'}
                <input
                  name="maxRequestMinorUnits"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{1,18}"
                  defaultValue={editing === undefined ? '' : editing.maxRequestMinorUnits.toString()}
                  className={`${FIELD_INPUT} tabular-nums`}
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
                <a href={`/${segment}/partners?tenant=${encodeURIComponent(tenantCode)}`} className={BUTTON_SECONDARY}>
                  {arabic ? 'إلغاء' : 'Cancel'}
                </a>
                <button type="submit" className={BUTTON_PRIMARY}>
                  {arabic ? 'اقتراح' : 'Propose'}
                </button>
              </div>
            </form>
          </Card>
        </>
      ) : (
        <Card>
          <ControlRejection
            control="OP-DETERMINACY"
            explanation={resolved.policy.ok ? '' : resolved.policy.error.detail}
            controlLabel={arabic ? 'الضابط' : 'Control'}
          />
        </Card>
      )}
    </div>
  );
}
