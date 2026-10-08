/**
 * Jurisdiction: whether the whole application behaves as the Kingdom of Saudi
 * Arabia (SAR) or the United Arab Emirates (AED). One administrator proposes,
 * a different one decides; a production deployment that has recorded business
 * cannot change. Each institution keeps the jurisdiction it was onboarded
 * under: the setting decides which institutions are active, never rewrites
 * one's currency (ADR 0005).
 */

import { notFound, redirect } from 'next/navigation';

import { loadJurisdictionProfiles, loadTenantOnboarding, TENANT_CODES } from '@sanad/config/loader.ts';
import type { JurisdictionCode } from '@sanad/core/jurisdiction/profile.ts';
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  Card,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  Status,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import {
  deploymentJurisdiction,
  deploymentJurisdictionLocked,
  listDeploymentJurisdictionRevisions,
} from '@sanad/origination/jurisdiction.ts';

import { decideJurisdictionAction, proposeJurisdictionAction } from '../../../server/actions.ts';
import { store } from '../../../server/credentials.ts';
import { currentAdmin } from '../../../server/session.ts';

const NOTICE: Readonly<Record<string, { en: string; ar: string; tone: 'settled' | 'blocked' | 'attention' }>> = {
  PROPOSED: {
    en: 'Proposed. The application changes only when a different administrator approves it.',
    ar: 'اقتُرح. لا يتغير التطبيق إلا بعد اعتماد مدير آخر.',
    tone: 'settled',
  },
  APPROVED: {
    en: 'Approved. The whole application now behaves as the chosen jurisdiction.',
    ar: 'اعتُمد. يعمل التطبيق كله الآن وفق الولاية المختارة.',
    tone: 'settled',
  },
  REJECTED: { en: 'Rejected, with the reason recorded.', ar: 'رُفض وسُجّل السبب.', tone: 'settled' },
  LOCKED: {
    en: 'This production deployment has recorded business; its jurisdiction does not change. Onboard a separate deployment instead.',
    ar: 'سجّل هذا النشر الإنتاجي معاملات؛ لا تتغير ولايته. أنشئ نشراً منفصلاً بدلاً من ذلك.',
    tone: 'blocked',
  },
  RESIDENCY: {
    en: 'Refused by the residency rule: production data must sit in the chosen jurisdiction behind a customer-managed HSM.',
    ar: 'رفضته قاعدة توطين البيانات: بيانات الإنتاج تُحفظ في الولاية المختارة وبمفاتيح يديرها العميل.',
    tone: 'blocked',
  },
  ALREADY_IN_FORCE: {
    en: 'The application already behaves as that jurisdiction.',
    ar: 'التطبيق يعمل بهذه الولاية أصلاً.',
    tone: 'attention',
  },
  'REFUSED:FOUR_EYES_SELF_DECISION': {
    en: 'Four eyes: you proposed this change, so you may not decide it. Sign in as the other administrator.',
    ar: 'أربع أعين: أنت من اقترح هذا التغيير فلا يجوز أن تقرر فيه. سجّل الدخول بالمدير الآخر.',
    tone: 'blocked',
  },
  REJECTION_REASON_REQUIRED: { en: 'A rejection says why.', ar: 'الرفض يحتاج سبباً.', tone: 'attention' },
  SUMMARY_REQUIRED: { en: 'Say why the jurisdiction should change.', ar: 'اذكر سبب تغيير الولاية.', tone: 'attention' },
  NO_DATABASE: {
    en: 'No database is configured; the jurisdiction is chosen in the database.',
    ar: 'لا توجد قاعدة بيانات مهيأة؛ تُختار الولاية في قاعدة البيانات.',
    tone: 'blocked',
  },
  PROPOSE_FAILED: { en: 'The database refused the proposal.', ar: 'رفضت قاعدة البيانات الاقتراح.', tone: 'blocked' },
  DECIDE_FAILED: { en: 'The database refused the decision.', ar: 'رفضت قاعدة البيانات القرار.', tone: 'blocked' },
};

const fmt = (iso: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export default async function JurisdictionPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string }>;
  readonly searchParams: Promise<{ readonly notice?: string }>;
}) {
  const { locale: segment } = await params;
  const { notice } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const admin = await currentAdmin();
  if (admin === undefined) redirect(`/${segment}`);
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);

  const current = await deploymentJurisdiction();
  const profiles = loadJurisdictionProfiles();
  const locked = await deploymentJurisdictionLocked();
  const revisions = store().kind === 'READY' ? await listDeploymentJurisdictionRevisions() : [];
  const pending = revisions.find((r) => r.status === 'PROPOSED');
  const other: JurisdictionCode = current.code === 'SA' ? 'AE' : 'SA';
  const n = notice === undefined ? undefined : NOTICE[notice];
  const tenants = TENANT_CODES.map((code) => ({ code, onboarding: loadTenantOnboarding(code) }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-h2 font-semibold text-heading">{t('Jurisdiction', 'الولاية')}</h2>
        <p className="mt-1 text-[15px] text-ink-quiet">
          {t(
            'Whether the whole application behaves as Saudi Arabia in riyals or the UAE in dirhams. Rules, currency, calendars and integrations all follow it.',
            'هل يعمل التطبيق كله وفق السعودية بالريال أم الإمارات بالدرهم. القواعد والعملة والتقاويم وقنوات التكامل كلها تتبعها.',
          )}
        </p>
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
            controlLabel={t('Control', 'الضابط')}
          />
        )
      ) : null}

      {profiles.ok ? (
        <div className="grid gap-4 md:grid-cols-2">
          {(['SA', 'AE'] as const).map((code) => {
            const p = profiles.value[code];
            const active = code === current.code;
            return (
              <Card key={code}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-[16px] font-semibold text-heading">{arabic ? p.nameAr : p.nameEn}</h3>
                  {active ? (
                    <Status tone="settled" label={t('in force', 'سارية')} />
                  ) : (
                    <Status tone="progress" label={t('available', 'متاحة')} />
                  )}
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[14px]">
                  <dt className="text-ink-quiet">{t('Currency', 'العملة')}</dt>
                  <dd className="identifier text-ink">{p.currency}</dd>
                  <dt className="text-ink-quiet">{t('Regulator', 'الجهة الرقابية')}</dt>
                  <dd className="text-ink">{arabic ? p.regulator.nameAr : p.regulator.nameEn}</dd>
                  <dt className="text-ink-quiet">{t('Contract dates', 'تواريخ العقود')}</dt>
                  <dd className="text-ink">
                    {p.contractualCalendars
                      .map((c) => (c === 'HIJRI' ? t('Hijri', 'هجري') : t('Gregorian', 'ميلادي')))
                      .join(' + ')}
                  </dd>
                  <dt className="text-ink-quiet">{t('Credit bureau', 'مكتب الائتمان')}</dt>
                  <dd className="identifier text-ink">{(p.railAdapters['CREDIT_BUREAU'] ?? []).join(', ')}</dd>
                  <dt className="text-ink-quiet">{t('Identity', 'الهوية')}</dt>
                  <dd className="identifier text-ink">
                    {(p.railAdapters['IDENTITY_AUTHENTICATION'] ?? []).join(', ')}
                  </dd>
                  <dt className="text-ink-quiet">{t('Institutions', 'المؤسسات')}</dt>
                  <dd className="identifier text-ink">
                    {tenants
                      .filter((x) => x.onboarding.ok && x.onboarding.value.jurisdiction === code)
                      .map((x) => x.code)
                      .join(', ') || '—'}
                  </dd>
                </dl>
              </Card>
            );
          })}
        </div>
      ) : (
        <ControlRejection
          control="OP-DETERMINACY"
          explanation={profiles.error.detail}
          controlLabel={t('Control', 'الضابط')}
        />
      )}

      <Card>
        <h3 className="text-[16px] font-semibold text-heading">{t('Change the jurisdiction', 'تغيير الولاية')}</h3>
        <p className="mt-1 text-[14px] text-ink-quiet">
          {t(
            'One administrator proposes, a different one approves. Institutions keep their own jurisdiction; the setting decides which are active. A production deployment that has recorded business is locked.',
            'يقترح مدير ويعتمد مدير آخر. تحتفظ كل مؤسسة بولايتها؛ الإعداد يحدد أيها نشطة. النشر الإنتاجي الذي سجّل معاملات مقفل.',
          )}
        </p>
        {locked ? (
          <p className="mt-4 text-[14px] text-blocked">
            {t('Locked: this production deployment has recorded business.', 'مقفل: سجّل هذا النشر الإنتاجي معاملات.')}
          </p>
        ) : pending !== undefined ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-tile border border-line p-4">
            <span className="flex flex-col gap-1">
              <span className="text-[15px] font-medium text-heading">
                {t('Proposed:', 'مقترح:')} <span className="identifier">{pending.jurisdiction}</span> —{' '}
                {pending.summary}
              </span>
              <span className="text-[13px] text-ink-quiet">
                {t('by', 'من')} <span className="identifier">{pending.proposedBy}</span> ·{' '}
                {fmt(pending.proposedAt, locale)}
              </span>
            </span>
            <form action={decideJurisdictionAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="revisionId" value={pending.id} />
              <input
                name="reason"
                placeholder={t('reason, if rejecting', 'سبب الرفض')}
                className={`${FIELD_INPUT} mt-0 h-[38px] w-[220px] text-[14px]`}
              />
              <button
                type="submit"
                name="decision"
                value="reject"
                disabled={pending.proposedBy === admin.principalId}
                className={`${BUTTON_DANGER} h-[38px] px-4 text-[14px] disabled:opacity-40`}
              >
                {t('Reject', 'رفض')}
              </button>
              <button
                type="submit"
                name="decision"
                value="approve"
                disabled={pending.proposedBy === admin.principalId}
                className={`${BUTTON_PRIMARY} h-[38px] min-w-0 px-4 text-[14px] disabled:opacity-40`}
              >
                {t('Approve', 'اعتماد')}
              </button>
            </form>
          </div>
        ) : (
          <form action={proposeJurisdictionAction} className="mt-5 grid gap-5 md:grid-cols-2">
            <input type="hidden" name="locale" value={segment} />
            <input type="hidden" name="jurisdiction" value={other} />
            <div className={FIELD_LABEL}>
              {t('Switch to', 'التحويل إلى')}
              <p className="mt-2 text-[16px] font-semibold text-heading">
                {profiles.ok ? (arabic ? profiles.value[other].nameAr : profiles.value[other].nameEn) : other}{' '}
                <span className="identifier text-ink-quiet">({profiles.ok ? profiles.value[other].currency : ''})</span>
              </p>
            </div>
            <label className={FIELD_LABEL}>
              {t('Why', 'السبب')}
              <input
                name="summary"
                required
                minLength={3}
                maxLength={400}
                placeholder={t('e.g. UAE pilot for the SME fund', 'مثال: تجربة الإمارات لصندوق المنشآت')}
                className={FIELD_INPUT}
              />
            </label>
            <div className="flex justify-end md:col-span-2">
              <button type="submit" className={BUTTON_PRIMARY}>
                {t('Propose', 'اقتراح')}
              </button>
            </div>
          </form>
        )}
      </Card>

      {revisions.length > 0 ? (
        <Card>
          <h3 className="text-[16px] font-semibold text-heading">{t('History', 'السجل')}</h3>
          <ul className="mt-3 flex list-none flex-col divide-y divide-line p-0">
            {revisions.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-[14px]">
                <span>
                  <span className="identifier font-semibold text-heading">{r.jurisdiction}</span> · {r.summary}
                </span>
                <span className="flex items-center gap-2 text-ink-quiet">
                  <Status
                    tone={r.status === 'APPROVED' ? 'settled' : r.status === 'REJECTED' ? 'blocked' : 'progress'}
                    label={r.status.toLowerCase()}
                  />
                  <span className="identifier">{r.proposedBy}</span>
                  {r.decidedBy !== null ? (
                    <>
                      → <span className="identifier">{r.decidedBy}</span>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
