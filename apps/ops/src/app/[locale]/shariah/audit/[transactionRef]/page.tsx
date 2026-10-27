/**
 * One transaction replayed for the Board (Wasl W6c; BR-F05, SH-18): each
 * contract in order with its time, its fingerprint and its link to the one
 * before; each step with the evidence behind it as the sale saw it; the risk
 * period required and held; the figures disclosed; the approval as it stood
 * that day; each Shariah check passed or failed; and the audit pack to take
 * away. In plain words — the Board verifies by itself, without technical
 * assistance. Read-only: the only act is raising an observation, which
 * becomes an incident for the reviewers.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactElement } from 'react';

import type { TenantCode } from '@sanad/config/loader.ts';
import { INCIDENT_SEVERITIES } from '@sanad/core/shariah/incidents.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { BUTTON_PRIMARY, DualDate, FIELD_INPUT, FIELD_TEXTAREA, Status } from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { civilDateOf } from '@sanad/origination/civil-date.ts';
import { ummAlQura } from '@sanad/origination/hijri.ts';
import { replayTransaction } from '@sanad/origination/wasl/audit.ts';

import { permits, refusalWording } from '../../../../../server/authority.ts';
import { pageStaff } from '../../../../../server/session.ts';
import { raiseAuditObservationAction } from '../../../../../server/shariah-actions.ts';
import { Gate } from '../../../Gate.tsx';
import { NOTICE, REFUSAL, STATE_LABEL } from '../../../transactions/states.ts';
import { CHECK, FINDING, SEVERITY, STATUS, type Words } from '../../words.ts';

const LEG: Readonly<Record<string, Words>> = {
  WAAD: { en: 'Promise to buy (wa’d)', ar: 'الوعد بالشراء' },
  PURCHASE: { en: 'Purchase of the goods by the institution', ar: 'شراء المؤسسة للبضاعة' },
  SALE_OFFER: { en: 'Murabaha sale offer', ar: 'عرض بيع المرابحة' },
  ACCEPTANCE: { en: 'Acceptance by the distributor', ar: 'قبول الموزع' },
};
const GATE: Readonly<Record<string, Words>> = {
  GATE_1_OWNERSHIP: { en: 'The institution owns the goods', ar: 'تملّك المؤسسة للبضاعة' },
  GATE_2_POSSESSION: { en: 'The institution holds the goods', ar: 'حيازة المؤسسة للبضاعة' },
  GATE_3_RISK_PERIOD: { en: 'The goods were held at the institution’s risk', ar: 'بقاء البضاعة في ضمان المؤسسة' },
};
const GATE_STATUS: Readonly<Record<string, Words>> = {
  SATISFIED: { en: 'Met', ar: 'مستوفاة' },
  PENDING: { en: 'Not met', ar: 'غير مستوفاة' },
  NOT_STARTED: { en: 'Not reached', ar: 'لم تُبلغ' },
};

export default async function ReplayPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly transactionRef: string }>;
  readonly searchParams: Promise<{ readonly notice?: string; readonly reason?: string; readonly control?: string }>;
}): Promise<ReactElement> {
  const { locale: segment, transactionRef } = await params;
  const { notice, reason, control } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const w = (words: Words): string => (arabic ? words.ar : words.en);
  const staff = await pageStaff(segment);
  if (staff.tenantId === undefined) notFound();
  const tenant = staff.tenantId as TenantCode;
  const allowed = permits(staff, 'SHARIAH_AUDIT_READ');
  if (!allowed.allowed) return <p className="text-[14px] text-ink-quiet">{refusalWording(allowed.needs, arabic)}</p>;
  const replay = await replayTransaction(tenant, decodeURIComponent(transactionRef));
  if (!replay.ok) notFound();
  const r = replay.value;
  const numerals = defaultNumerals(locale);
  const amount = (minorUnits: bigint) => (
    <bdi className="tabular-nums">
      {formatMinorUnits({ minorUnits, currency: r.figures.currency as 'SAR' }, numerals)} {r.figures.currency}
    </bdi>
  );
  const when = (epoch: bigint) => {
    const d = civilDateOf(tenant, { epochSeconds: epoch });
    const time = new Date(Number(epoch) * 1000).toISOString().slice(11, 19);
    return (
      <span className="inline-flex items-baseline gap-2">
        <DualDate gregorian={d} hijri={ummAlQura(d)} locale={locale} />
        <bdi className="identifier text-[12px] text-ink-quiet">{time} UTC</bdi>
      </span>
    );
  };
  const hours = (s: bigint | number) => {
    const n = BigInt(s);
    return t(
      `${String(n / 3600n)} h ${String((n % 3600n) / 60n)} min`,
      `${String(n / 3600n)} س ${String((n % 3600n) / 60n)} د`,
    );
  };
  const yes = (ok: boolean | undefined, label: Words) =>
    ok === undefined ? (
      <span className="text-ink-quiet">— {w(label)}</span>
    ) : (
      <span className={ok ? 'text-positive' : 'text-blocked'}>
        {ok ? '✓' : '✗'} {w(label)}
      </span>
    );
  const said = notice === undefined ? undefined : NOTICE[notice];
  const refused = reason === undefined ? undefined : (REFUSAL[reason] ?? { en: reason, ar: reason });
  const allPassed = r.chain.verified && r.checks.every((c) => c.passed) && r.financedOnce;

  return (
    <div className="flex flex-col gap-6" data-replay={r.listing.transactionRef}>
      <div>
        <Link href={`/${segment}/shariah/audit`} className="text-[13px] text-brand hover:underline">
          {t('Shariah audit workspace', 'مساحة التدقيق الشرعي')}
        </Link>
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="identifier text-display font-bold tracking-tight text-heading">{r.listing.transactionRef}</h1>
          <a
            href={`/${segment}/shariah/audit/${r.listing.transactionRef}/pack`}
            className={BUTTON_PRIMARY}
            data-audit-pack
            download
          >
            {t('Export the audit pack', 'تصدير ملف التدقيق')}
          </a>
        </div>
        <p className="mt-1 text-[14px] text-ink-quiet">
          {r.listing.counterpartyId} · {r.listing.programmeId} ·{' '}
          {w(STATE_LABEL[r.listing.state] ?? { en: r.listing.state, ar: r.listing.state })}
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
        className={`rounded-card border px-5 py-4 shadow-card ${allPassed ? 'border-positive/40 bg-positive-wash' : 'border-blocked/40 bg-blocked-wash'}`}
        data-replay-summary
      >
        <h2 className="text-[15px] font-semibold text-heading">{t('Summary', 'الخلاصة')}</h2>
        <ul className="mt-2 grid gap-1 text-[13px] sm:grid-cols-2">
          <li>
            {yes(r.chain.verified, {
              en: 'Every contract links to the one before it, in time order',
              ar: 'كل عقد مرتبط بالذي قبله وبترتيب زمني',
            })}
          </li>
          <li>{yes(r.financedOnce, { en: 'The invoice is financed once', ar: 'الفاتورة مموّلة مرة واحدة' })}</li>
          {r.checks.map((c) => (
            <li key={c.checkCode}>{yes(c.passed, CHECK[c.checkCode] ?? { en: c.checkCode, ar: c.checkCode })}</li>
          ))}
        </ul>
        {r.checks
          .flatMap((c) => c.findings)
          .map((f, i) => (
            <p key={`${f.reason}-${String(i)}`} className="mt-2 text-[13px] text-blocked">
              <span className="identifier me-2 text-[12px]">{f.control}</span>
              {w(FINDING[f.reason] ?? { en: f.reason, ar: f.reason })}
            </p>
          ))}
        <p className="mt-2 text-[12px] text-ink-quiet">
          {t('Verified just now, from the transaction’s own record.', 'تم التحقق للتو من سجل المعاملة نفسه.')}
        </p>
      </section>

      <section className="overflow-x-auto rounded-card border border-line bg-surface shadow-card" data-replay-contracts>
        <h2 className="px-5 pt-4 text-[15px] font-semibold text-heading">
          {t('The contracts, in order', 'العقود بترتيبها')}
        </h2>
        <ol className="divide-y divide-line px-5 py-2 text-[13px]">
          {r.legs.map((l) => (
            <li key={l.sequenceNo} className="grid gap-1 py-3" data-leg={l.legType}>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-semibold text-heading">
                  {String(l.sequenceNo)}. {w(LEG[l.legType] ?? { en: l.legType, ar: l.legType })}
                </span>
                {when(l.executedAtEpochSeconds)}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {yes(l.linkedToPrevious, { en: 'linked to the contract before', ar: 'مرتبط بالعقد السابق' })}
                {yes(l.timeAfterPrevious, { en: 'later than the contract before', ar: 'بعد العقد السابق زمنياً' })}
                {yes(l.templateApproved, {
                  en: `template ${l.templateVersionId} approved`,
                  ar: `النموذج ${l.templateVersionId} معتمد`,
                })}
                {yes(l.documentMatchesTemplate, {
                  en: 'document is what the template makes',
                  ar: 'المستند مطابق لما يُنتجه النموذج',
                })}
              </div>
              <div className="identifier text-[11px] text-ink-quiet">
                {t('fingerprint', 'البصمة')} {l.documentHash.slice(0, 16)}… · {t('time attested by', 'الوقت موثّق من')}{' '}
                {l.timestampAuthority} ·{' '}
                {l.counterpartyRole === 'SELLER' ? t('seller', 'البائع') : t('buyer', 'المشتري')}{' '}
                {l.counterpartyRegistration}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-replay-gates>
        <h2 className="text-[15px] font-semibold text-heading">
          {r.riskPeriod.measuredAt === 'SALE_OFFER'
            ? t('Each step, as it stood when the sale was offered', 'كل مرحلة كما كانت عند عرض البيع')
            : t('Each step, as it stands now', 'كل مرحلة كما هي الآن')}
        </h2>
        <ul className="mt-2 grid gap-3 text-[13px]">
          {r.gates.map((g) => (
            <li key={g.gateId}>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{w(GATE[g.gateId] ?? { en: g.gateId, ar: g.gateId })}</span>
                <Status
                  tone={g.status === 'SATISFIED' ? 'settled' : 'blocked'}
                  label={w(GATE_STATUS[g.status] ?? { en: g.status, ar: g.status })}
                />
              </div>
              {g.kind === 'ELAPSE' ? (
                <p className="mt-1">
                  {t('Required', 'المطلوب')} {hours(r.riskPeriod.requiredSeconds)} · {t('held', 'المُستوفى')}{' '}
                  {r.riskPeriod.heldSeconds === undefined ? '—' : hours(r.riskPeriod.heldSeconds)}
                </p>
              ) : (
                <ul className="mt-1 grid gap-1 ps-4">
                  {g.evidence.length === 0 ? (
                    <li className="text-ink-quiet">{t('No evidence recorded', 'لا بيّنة مسجّلة')}</li>
                  ) : (
                    g.evidence.map((e) => (
                      <li
                        key={e.artefactHash + String(e.capturedAtEpochSeconds) + e.status}
                        className={e.superseded ? 'text-ink-quiet line-through' : ''}
                      >
                        {e.evidenceType} · {e.source} · {e.status} · {when(e.capturedAtEpochSeconds)}
                      </li>
                    ))
                  )}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        <div
          className="rounded-card border border-line bg-surface px-5 py-4 shadow-card text-[13px]"
          data-replay-figures
        >
          <h2 className="mb-2 text-[15px] font-semibold text-heading">
            {t('The figures disclosed', 'الأرقام المُفصح عنها')}
          </h2>
          <dl className="grid grid-cols-2 gap-y-1">
            <dt className="text-ink-quiet">{t('Cost', 'التكلفة')}</dt>
            <dd className="text-end">{amount(r.figures.costMinor)}</dd>
            <dt className="text-ink-quiet">{t('Profit', 'الربح')}</dt>
            <dd className="text-end">{amount(r.figures.profitMinor)}</dd>
            <dt className="text-ink-quiet">{t('Sale price', 'ثمن البيع')}</dt>
            <dd className="text-end font-semibold">{amount(r.figures.salePriceMinor)}</dd>
          </dl>
          <p className="mt-2">
            {yes(r.figures.salePriceIsCostPlusProfit, {
              en: 'Sale price is cost plus profit',
              ar: 'ثمن البيع = التكلفة + الربح',
            })}
          </p>
          <p>
            {yes(r.figures.disclosedInOffer, {
              en: 'Stated in the offer the distributor accepted',
              ar: 'مذكورة في العرض الذي قبله الموزع',
            })}
          </p>
        </div>
        <div
          className="rounded-card border border-line bg-surface px-5 py-4 shadow-card text-[13px]"
          data-replay-approval
        >
          <h2 className="mb-2 text-[15px] font-semibold text-heading">
            {t('The approval it was made under', 'الاعتماد الذي تمت بموجبه')}
          </h2>
          <p className="identifier">{r.approval.approvalRef}</p>
          {r.approval.atOpening === undefined ? (
            <p className="mt-1 text-blocked">
              {t('Not in the approvals register on the day it opened.', 'لم يكن مقيّداً في سجل الاعتمادات يوم فتحها.')}
            </p>
          ) : (
            <>
              <p className="mt-1">{r.approval.atOpening.approvingBody}</p>
              <p className="text-ink-quiet">{r.approval.atOpening.members.join(arabic ? '، ' : ', ')}</p>
              <p className="mt-1">
                {t('On the day it opened:', 'يوم فتحها:')}{' '}
                {r.approval.standingAtOpening === 'IN_FORCE' ? (
                  <span className="text-positive">{t('in force', 'ساري')}</span>
                ) : (
                  <span className="text-blocked">{r.approval.standingAtOpening}</span>
                )}
              </p>
            </>
          )}
          <p className="mt-2 text-ink-quiet">
            {t('Goods financed (classification):', 'البضاعة المموّلة (التصنيف):')}{' '}
            <span className="identifier">
              {r.goods === undefined ? '—' : r.goods.map((g) => g.goodsClassificationCode).join(', ')}
            </span>
          </p>
        </div>
      </section>

      <section
        className="rounded-card border border-line bg-surface px-5 py-4 shadow-card text-[13px]"
        data-replay-incidents
      >
        <h2 className="mb-2 text-[15px] font-semibold text-heading">
          {t('Incidents and charity', 'المخالفات والتبرع')}
        </h2>
        {r.incidents.length === 0 ? (
          <p className="text-ink-quiet">{t('No incident on this transaction.', 'لا توجد مخالفة على هذه المعاملة.')}</p>
        ) : (
          <ul className="grid gap-1">
            {r.incidents.map((i) => (
              <li key={i.incidentRef} className="flex flex-wrap items-baseline gap-2">
                <span className="identifier">{i.incidentRef}</span>
                <Status tone={SEVERITY[i.currentSeverity].tone} label={w(SEVERITY[i.currentSeverity])} />
                <span>{w(STATUS[i.status])}</span>
                <span className="text-ink-quiet">{w(FINDING[i.reason] ?? { en: i.reason, ar: i.reason })}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2">
          {t('Late amounts held for charity', 'مبالغ التأخير المحتجزة للتبرع')}{' '}
          {amount(r.charity.lateAmountsCollectedMinor)} · {t('income purified', 'الدخل المطهَّر')}{' '}
          {amount(r.charity.purifiedRaisedMinor)} · {t('given', 'المصروف')} {amount(r.charity.disbursedMinor)}
        </p>
      </section>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-replay-observe>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Raise an observation', 'تقييد ملاحظة')}</h2>
        <Gate staff={staff} act="SHARIAH_OBSERVE" arabic={arabic}>
          <form action={raiseAuditObservationAction} className="grid gap-3 sm:max-w-2xl">
            <input type="hidden" name="locale" value={segment} />
            <input type="hidden" name="transactionRef" value={r.listing.transactionRef} />
            <label className="grid gap-1 text-[13px]">
              {t('How serious', 'درجة الخطورة')}
              <select name="severity" defaultValue="MEDIUM" className={FIELD_INPUT}>
                {INCIDENT_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {w(SEVERITY[s])}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-[13px]">
              {t('What you observed', 'ما لاحظته')}
              <textarea
                name="observation"
                required
                minLength={3}
                maxLength={2000}
                rows={3}
                className={FIELD_TEXTAREA}
              />
            </label>
            <button type="submit" className={BUTTON_PRIMARY} data-observe-submit>
              {t('Raise', 'تقييد')}
            </button>
          </form>
        </Gate>
        <p className="mt-2 text-[12px] text-ink-quiet">
          {t(
            'It becomes an incident for the institution’s Shariah reviewers to work, with a record of who raised it.',
            'تصبح مخالفة يعالجها المراجعون الشرعيون في المؤسسة، مع تسجيل من قيّدها.',
          )}
        </p>
      </section>

      <details className="rounded-card border border-line bg-surface px-5 py-4 text-[13px] shadow-card">
        <summary className="cursor-pointer font-semibold text-heading">
          {t('Everything that happened, in order', 'كل ما جرى بالترتيب')}
        </summary>
        <ol className="mt-2 grid gap-1">
          {r.events.map((e, i) => (
            <li key={`${e.eventType}-${String(i)}`} className="flex flex-wrap items-baseline gap-2">
              {when(e.atEpochSeconds)}
              <span className="identifier">{e.eventType}</span>
              <span className="text-ink-quiet">{e.actor}</span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
