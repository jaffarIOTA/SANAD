/**
 * Licence: the installation's licence (ADR 0006). Its state and how long it
 * has, what it entitles, the full history with each supersession chain (so a
 * POC's whole length is visible), the request file to send the issuer, and
 * installing a new licence — one administrator uploads, a different one
 * approves, as with the jurisdiction.
 *
 * Nothing here decides anything: the state is `licenceState`, the decision
 * is `assertNewBusinessPermitted`, both in core/licensing. Installing a
 * licence is never itself gated on the licence.
 */

import { notFound, redirect } from 'next/navigation';

import { formatInstant } from '@sanad/core/licensing/dates.ts';
import { STATE_REASON, STATUS_LABEL, type StatusTone } from '@sanad/core/licensing/explain.ts';
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  Card,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  Status,
  type StatusTone as DesignTone,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { deploymentJurisdiction } from '@sanad/origination/jurisdiction.ts';
import { currentLicence, licenceProposals } from '@sanad/origination/licensing.ts';

import { decideLicenceAction, proposeLicenceAction } from '../../../server/actions.ts';
import { store } from '../../../server/credentials.ts';
import { licenceChains, revocationRows } from '../../../server/licence.ts';
import { currentAdmin } from '../../../server/session.ts';

export const dynamic = 'force-dynamic';

type Words = { readonly en: string; readonly ar: string };

const NOTICE: Readonly<Record<string, Words & { readonly tone: 'settled' | 'blocked' | 'attention' }>> = {
  PROPOSED: {
    en: 'Verified and proposed. It is installed only when a different administrator approves it.',
    ar: 'تم التحقق منه واقتراحه. لا يُثبَّت إلا بعد اعتماد مدير آخر.',
    tone: 'settled',
  },
  INSTALLED: {
    en: 'Approved and installed. The licence state below already reflects it.',
    ar: 'اعتُمد وثُبّت. حالة الترخيص أدناه تعكسه.',
    tone: 'settled',
  },
  REJECTED: { en: 'Rejected, with the reason recorded.', ar: 'رُفض وسُجّل السبب.', tone: 'settled' },
  FILE_REQUIRED: { en: 'Choose the licence file to upload.', ar: 'اختر ملف الترخيص لرفعه.', tone: 'attention' },
  REJECTION_REASON_REQUIRED: { en: 'A rejection says why.', ar: 'الرفض يحتاج سبباً.', tone: 'attention' },
  'REFUSED:MALFORMED': {
    en: 'That file is not a licence file: it must be the signed JSON the issuer sent, unchanged.',
    ar: 'هذا الملف ليس ملف ترخيص: يجب أن يكون ملف JSON الموقّع كما أرسلته جهة الإصدار دون تعديل.',
    tone: 'blocked',
  },
  'REFUSED:UNKNOWN_KEY': {
    en: 'The file carries a field a licence does not have, so it is refused. Ask the issuer for the original file.',
    ar: 'يحتوي الملف على حقل ليس من حقول الترخيص فرُفض. اطلب الملف الأصلي من جهة الإصدار.',
    tone: 'blocked',
  },
  'REFUSED:KEY_UNKNOWN': {
    en: 'The file is signed with a key this build does not hold. Ask the issuer which key signed it.',
    ar: 'الملف موقّع بمفتاح لا يحمله هذا الإصدار. اسأل جهة الإصدار عن المفتاح الذي وقّعه.',
    tone: 'blocked',
  },
  'REFUSED:SIGNATURE_INVALID': {
    en: 'The signature does not verify: the file has been altered or was not issued for this product.',
    ar: 'التوقيع غير صحيح: عُدّل الملف أو لم يصدر لهذا المنتج.',
    tone: 'blocked',
  },
  'REFUSED:TERM_NOT_POSITIVE': {
    en: 'The licence ends on or before the day it starts.',
    ar: 'ينتهي الترخيص في يوم بدئه أو قبله.',
    tone: 'blocked',
  },
  'REFUSED:TERM_TOO_LONG': {
    en: 'The term is longer than its kind allows: one calendar month for a POC, twelve months and a day for an annual licence.',
    ar: 'المدة أطول مما يسمح به نوعه: شهر ميلادي واحد للتجربة، واثنا عشر شهراً ويوم للترخيص السنوي.',
    tone: 'blocked',
  },
  'REFUSED:GRACE_DAYS_MISMATCH': {
    en: 'The grace period does not match the licence kind (30 days annual, 7 days POC).',
    ar: 'المهلة لا تطابق نوع الترخيص (٣٠ يوماً للسنوي و٧ أيام للتجربة).',
    tone: 'blocked',
  },
  'REFUSED:INSTALLATION_MISMATCH': {
    en: 'This licence was issued for a different installation. Send the issuer this installation’s request file.',
    ar: 'صدر هذا الترخيص لنظام آخر. أرسل إلى جهة الإصدار ملف الطلب الخاص بهذا النظام.',
    tone: 'blocked',
  },
  'REFUSED:FOUR_EYES_SELF_DECISION': {
    en: 'Four eyes: you proposed this licence, so you may not decide it. Sign in as the other administrator.',
    ar: 'أربع أعين: أنت من اقترح هذا الترخيص فلا يجوز أن تقرر فيه. سجّل الدخول بالمدير الآخر.',
    tone: 'blocked',
  },
  'REFUSED:PROPOSAL_PENDING': {
    en: 'Another licence is awaiting a decision. Decide that one first.',
    ar: 'هناك ترخيص آخر بانتظار القرار. قرّر فيه أولاً.',
    tone: 'attention',
  },
  'REFUSED:ALREADY_INSTALLED': {
    en: 'That licence is already installed.',
    ar: 'هذا الترخيص مثبّت أصلاً.',
    tone: 'attention',
  },
  'REFUSED:PROPOSAL_NOT_FOUND': { en: 'No such proposal.', ar: 'لا يوجد اقتراح بهذا المعرّف.', tone: 'blocked' },
  'REFUSED:PROPOSAL_ALREADY_DECIDED': {
    en: 'That proposal has already been decided.',
    ar: 'سبق البت في هذا الاقتراح.',
    tone: 'attention',
  },
};

const TONE: Readonly<Record<StatusTone, DesignTone>> = {
  ok: 'settled',
  attention: 'progress',
  blocked: 'blocked',
  neutral: 'available',
};

const fmt = (epochSeconds: bigint | undefined): string =>
  epochSeconds === undefined ? '—' : formatInstant(epochSeconds).slice(0, 10);

export default async function LicencePage({
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
  const w = (words: Words): string => (arabic ? words.ar : words.en);

  const [current, deployment, proposals] = await Promise.all([
    currentLicence(),
    deploymentJurisdiction(),
    licenceProposals(),
  ]);
  const { state } = current;
  const label = STATUS_LABEL[state.status];
  const licence = state.effective;
  const pending = proposals.find((p) => p.status === 'PROPOSED');
  const pendingLicence = pending === undefined ? undefined : safeParse(pending.document);
  const chains = licenceChains(state, current.history);
  const revocations = revocationRows(current.history);
  const n = notice === undefined ? undefined : NOTICE[notice];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-h2 font-semibold text-heading">{t('Licence', 'الترخيص')}</h2>
        <p className="mt-1 text-[15px] text-ink-quiet">
          {t(
            'This installation’s licence: annual, or a one-month POC extended a month at a time. When it lapses, new business pauses after a grace period; servicing, collections, repayments, reporting and regulator access never do.',
            'ترخيص هذا النظام: سنوي، أو تجريبي لشهر واحد يُمدَّد شهراً بشهر. عند انتهائه تتوقف الأعمال الجديدة بعد مهلة؛ أما الخدمة والتحصيل والسداد والتقارير ووصول الجهة الرقابية فلا تتوقف أبداً.',
          )}
        </p>
      </div>

      {n !== undefined ? (
        n.tone === 'settled' ? (
          <p role="status" className="rounded-tile bg-disc-teal px-5 py-4 text-[15px] text-positive">
            {w(n)}
          </p>
        ) : (
          <ControlRejection control="OP-LICENCE" explanation={w(n)} controlLabel={t('Control', 'الضابط')} />
        )
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-[16px] font-semibold text-heading">{t('This installation', 'هذا النظام')}</h3>
            <Status tone={TONE[label.tone]} label={w(label)} />
          </div>
          <p className="mt-2 text-[14px] text-ink-quiet">{w(STATE_REASON[state.reason])}</p>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[14px]">
            <dt className="text-ink-quiet">{t('Installation', 'معرّف النظام')}</dt>
            <dd className="identifier break-all text-ink">{current.installationId}</dd>
            <dt className="text-ink-quiet">{t('Kind', 'النوع')}</dt>
            <dd className="text-ink">
              {licence === undefined
                ? '—'
                : licence.kind === 'POC'
                  ? t('POC (monthly)', 'تجريبي (شهري)')
                  : t('Annual', 'سنوي')}
            </dd>
            <dt className="text-ink-quiet">{t('Licensee', 'المرخَّص له')}</dt>
            <dd className="text-ink">{licence?.licensee ?? '—'}</dd>
            <dt className="text-ink-quiet">{t('In force', 'السريان')}</dt>
            <dd className="identifier text-ink">
              {licence === undefined ? '—' : `${licence.notBefore} → ${fmt(state.coverageEndsAtEpochSeconds)}`}
            </dd>
            <dt className="text-ink-quiet">{t('Grace ends', 'نهاية المهلة')}</dt>
            <dd className="identifier text-ink">{fmt(state.graceEndsAtEpochSeconds)}</dd>
            <dt className="text-ink-quiet">{t('Days remaining', 'الأيام المتبقية')}</dt>
            <dd className="identifier text-ink">{state.daysRemaining ?? '—'}</dd>
          </dl>
        </Card>

        <Card>
          <h3 className="text-[16px] font-semibold text-heading">{t('Entitlements', 'الاستحقاقات')}</h3>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[14px]">
            <dt className="text-ink-quiet">{t('Products', 'المنتجات')}</dt>
            <dd className="identifier text-ink">{licence?.products.join(', ') ?? '—'}</dd>
            <dt className="text-ink-quiet">{t('Jurisdictions', 'الولايات')}</dt>
            <dd className="identifier text-ink">{licence?.jurisdictions.join(', ') ?? '—'}</dd>
            <dt className="text-ink-quiet">{t('Operating as', 'يعمل وفق')}</dt>
            <dd className="identifier text-ink">{deployment.code}</dd>
            <dt className="text-ink-quiet">{t('Active institutions', 'المؤسسات النشطة')}</dt>
            <dd className="identifier text-ink">
              {deployment.activeTenants.length} / {licence?.maxActiveTenants ?? '—'}
            </dd>
          </dl>
        </Card>
      </div>

      <Card>
        <h3 className="text-[16px] font-semibold text-heading">
          {t('Request a licence or an extension', 'طلب ترخيص أو تمديد')}
        </h3>
        <p className="mt-1 text-[14px] text-ink-quiet">
          {t(
            'Download the request file and send it to the issuer. It carries this installation’s id, the licence in force, the jurisdiction and the product version — no customer data. A POC is extended a month at a time, as often as needed.',
            'نزّل ملف الطلب وأرسله إلى جهة الإصدار. يحمل معرّف هذا النظام والترخيص الساري والولاية وإصدار المنتج — دون أي بيانات عملاء. يُمدَّد الترخيص التجريبي شهراً بشهر كلما لزم.',
          )}
        </p>
        <a
          href={`/${segment}/licence/request`}
          download
          className={`${BUTTON_PRIMARY} mt-4 inline-flex h-[42px] items-center px-5 text-[14px]`}
        >
          {t('Download the request file', 'تنزيل ملف الطلب')}
        </a>
      </Card>

      <Card>
        <h3 className="text-[16px] font-semibold text-heading">{t('Install a licence', 'تثبيت ترخيص')}</h3>
        <p className="mt-1 text-[14px] text-ink-quiet">
          {t(
            'One administrator uploads the signed file the issuer sent; it is verified at once. A different administrator approves it, and only then is it installed.',
            'يرفع مدير ملف الترخيص الموقّع الذي أرسلته جهة الإصدار ويُتحقق منه فوراً. ثم يعتمده مدير آخر، وعندها فقط يُثبَّت.',
          )}
        </p>
        {store().kind !== 'READY' ? (
          <p className="mt-3 text-[13px] text-attention">
            {t(
              'No database is configured: licences installed here are held by this process only.',
              'لا توجد قاعدة بيانات مهيأة: التراخيص المثبتة هنا محفوظة في هذه العملية فقط.',
            )}
          </p>
        ) : null}
        {pending !== undefined ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-tile border border-line p-4">
            <span className="flex flex-col gap-1">
              <span className="text-[15px] font-medium text-heading">
                {t('Proposed:', 'مقترح:')}{' '}
                <span className="identifier">
                  {pendingLicence === undefined
                    ? pending.subjectId
                    : `${pendingLicence.kind} · ${pendingLicence.notBefore} → ${pendingLicence.notAfter}`}
                </span>
              </span>
              <span className="text-[13px] text-ink-quiet">
                {t('by', 'من')} <span className="identifier">{pending.proposedBy}</span> ·{' '}
                <span className="identifier">{fmt(pending.proposedAtEpochSeconds)}</span>
                {pendingLicence?.supersedes != null ? (
                  <>
                    {' '}
                    · {t('supersedes', 'يحل محل')} <span className="identifier">{pendingLicence.supersedes}</span>
                  </>
                ) : null}
              </span>
            </span>
            <form action={decideLicenceAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="proposalId" value={pending.proposalId} />
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
                {t('Approve and install', 'اعتماد وتثبيت')}
              </button>
            </form>
          </div>
        ) : (
          <form action={proposeLicenceAction} className="mt-5 flex flex-wrap items-end gap-4">
            <input type="hidden" name="locale" value={segment} />
            <label className={`${FIELD_LABEL} min-w-0 flex-1`}>
              {t('Licence file (.json)', 'ملف الترخيص (.json)')}
              <input
                type="file"
                name="licenceFile"
                accept="application/json,.json"
                required
                className={`${FIELD_INPUT} py-2`}
              />
            </label>
            <button type="submit" className={BUTTON_PRIMARY}>
              {t('Verify and propose', 'تحقّق واقترح')}
            </button>
          </form>
        )}
      </Card>

      <Card>
        <h3 className="text-[16px] font-semibold text-heading">{t('History', 'السجل')}</h3>
        {chains.length === 0 ? (
          <p className="mt-3 text-[14px] text-ink-quiet">
            {t('No licence installed yet.', 'لم يُثبَّت أي ترخيص بعد.')}
          </p>
        ) : (
          <ul className="mt-3 flex list-none flex-col gap-4 p-0">
            {chains.map((chain) => (
              <li key={chain.rows[0]?.licence.licenceId} className="rounded-tile border border-line p-4">
                <p className="text-[14px] font-medium text-heading">
                  <span className="identifier">
                    {chain.from} → {chain.to}
                  </span>{' '}
                  · {chain.months} {t('month(s)', 'شهر')}
                  {chain.pocMonths > 0 ? (
                    <>
                      {' '}
                      · {chain.pocMonths} {t('POC month(s)', 'شهر تجريبي')}
                    </>
                  ) : null}
                </p>
                <ol className="mt-3 flex list-none flex-col divide-y divide-line p-0">
                  {chain.rows.map((r) => (
                    <li
                      key={r.licence.licenceId}
                      className="flex flex-wrap items-center justify-between gap-3 py-2 text-[13px]"
                    >
                      <span>
                        <span className="identifier font-semibold text-heading">{r.licence.kind}</span> ·{' '}
                        <span className="identifier">
                          {r.licence.notBefore} → {r.licence.notAfter}
                        </span>{' '}
                        · <span className="identifier text-ink-quiet">{r.licence.licenceId}</span>
                      </span>
                      <span className="flex items-center gap-2 text-ink-quiet">
                        {r.effective ? <Status tone="settled" label={t('in force', 'ساري')} /> : null}
                        {r.source === 'CHECK_IN' ? (
                          <span>{t('picked up by check-in', 'وصل عبر التحقق الإلكتروني')}</span>
                        ) : (
                          <>
                            <span className="identifier">{r.installedBy}</span> →{' '}
                            <span className="identifier">{r.approvedBy ?? '—'}</span>
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        )}
        {revocations.length > 0 ? (
          <ul className="mt-4 flex list-none flex-col gap-1 p-0 text-[13px] text-blocked">
            {revocations.map((r) => (
              <li key={r.revocationId}>
                {t('Revocation of', 'إلغاء الترخيص')} <span className="identifier">{r.licenceId}</span>{' '}
                {t('from', 'اعتباراً من')} <span className="identifier">{r.effectiveFrom}</span> —{' '}
                {t('the grace period starts there.', 'وتبدأ المهلة من حينها.')}
              </li>
            ))}
          </ul>
        ) : null}
        {state.refused.length > 0 ? (
          <p className="mt-4 text-[13px] text-attention">
            {t(
              `${String(state.refused.length)} installed document(s) no longer verify on this build and are not used.`,
              `${String(state.refused.length)} من المستندات المثبتة لم يعد التحقق منها ممكناً في هذا الإصدار ولا تُستخدم.`,
            )}
          </p>
        ) : null}
      </Card>
    </div>
  );
}

/** The proposed licence's fields for display. It was verified when proposed and is verified again on approval. */
function safeParse(
  document: string,
): { kind: string; notBefore: string; notAfter: string; supersedes: string | null } | undefined {
  try {
    const v = JSON.parse(document) as Record<string, unknown>;
    return {
      kind: String(v['kind']),
      notBefore: String(v['notBefore']),
      notAfter: String(v['notAfter']),
      supersedes: typeof v['supersedes'] === 'string' ? v['supersedes'] : null,
    };
  } catch {
    return undefined;
  }
}
