/**
 * One Murabaha transaction: where it stands in the sequence, the next step
 * and who may take it, its fixed figures (cost, profit, sale price — a profit
 * amount, never a rate), its structure and the board approval it runs under,
 * the trade it finances, the three gates as the sequencing engine evaluates
 * them, its evidence, its legs, and its event log. Another institution's
 * transaction is not found.
 *
 * The steps (Wasl W2) are offered only in the state each belongs to, and each
 * is refused by the service in any other: the screen is a courtesy, the
 * sequencing engine is the control. A gate's step is offered whether or not
 * the engine will pass it — pressing it asks the engine, which says why not.
 */
import type { ReactNode } from 'react';

import { notFound } from 'next/navigation';

import type { TenantCode } from '@sanad/config/loader.ts';
import { arabicIndic } from '@sanad/core/documents/offer-letter.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  FIELD_TEXTAREA,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { ummAlQura } from '../../../../server/hijri.ts';
import { POSSESSION_SOURCES, possessionEvidenceTypes, recorderOf } from '../../../../server/murabaha-sequencing.ts';
import { getTransaction } from '../../../../server/murabaha-transactions.ts';
import { pageStaff } from '../../../../server/session.ts';
import type { StaffPrincipal } from '../../../../server/staff.ts';
import {
  decideEvidenceAction,
  ownershipInvoiceAction,
  possessionEvidenceAction,
  sequenceStepAction,
  unwindAction,
} from '../../../../server/transaction-actions.ts';
import { Gate, authorityRefusal } from '../../Gate.tsx';
import {
  EVIDENCE_SOURCE_LABEL,
  EVIDENCE_STATUS_LABEL,
  EVIDENCE_TYPE_LABEL,
  GATE_LABEL,
  GATE_STATUS,
  NOTICE,
  REFUSAL,
  SEQUENCE,
  STATE_LABEL,
} from '../states.ts';

/** States an unwind may be taken from: an acquired position, before the sale executes (BR-D14). */
const UNWINDABLE = new Set([
  'WAAD_EXECUTED',
  'PURCHASE_EXECUTED',
  'OWNERSHIP_ACQUIRED',
  'POSSESSION_CONFIRMED',
  'OFFER_LAPSED',
]);

const instant = (epochSeconds: bigint): string =>
  new Date(Number(epochSeconds) * 1000).toISOString().slice(0, 16).replace('T', ' ');

function Row({ k, children }: { readonly k: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-b border-line py-2 last:border-b-0">
      <dt className="text-[13px] text-ink-quiet">{k}</dt>
      <dd className="text-[14px] font-medium text-heading">{children}</dd>
    </div>
  );
}

/** What every form on the page carries: the locale and the transaction. Who acts is the session's, never the form's. */
function Hidden({ segment, transactionRef }: { readonly segment: string; readonly transactionRef: string }) {
  return (
    <>
      <input type="hidden" name="locale" value={segment} />
      <input type="hidden" name="transactionRef" value={transactionRef} />
    </>
  );
}

/** A step that takes only the decision to take it. Drawn disabled, with the reason, for someone without the authority. */
function StepButton({
  staff,
  arabic,
  segment,
  transactionRef,
  step,
  children,
  quiet = false,
}: {
  readonly staff: StaffPrincipal;
  readonly arabic: boolean;
  readonly segment: string;
  readonly transactionRef: string;
  readonly step: string;
  readonly children: string;
  readonly quiet?: boolean;
}) {
  return (
    <Gate staff={staff} act="TRADE_OPERATIONS" arabic={arabic}>
      <form action={sequenceStepAction}>
        <Hidden segment={segment} transactionRef={transactionRef} />
        <input type="hidden" name="step" value={step} />
        <button type="submit" className={quiet ? BUTTON_SECONDARY : BUTTON_PRIMARY} data-step={step}>
          {children}
        </button>
      </form>
    </Gate>
  );
}

/** An answer from the demonstration transport: never mistaken for the live authority's. */
function FixtureBadge({ arabic }: { readonly arabic: boolean }) {
  return (
    <span
      className="inline-flex items-center rounded-pill border border-attention/40 bg-attention-wash px-2 py-0.5 text-[11px] font-semibold text-attention"
      title={
        arabic
          ? 'أجابت عنه بيئة العرض التجريبي لا الخدمة الفعلية'
          : 'Answered by the demonstration transport, not the live service'
      }
    >
      {arabic ? 'تجريبي' : 'Fixture'}
    </span>
  );
}

export default async function TransactionPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly transactionRef: string }>;
  readonly searchParams: Promise<{
    readonly control?: string;
    readonly reason?: string;
    readonly needs?: string;
    readonly notice?: string;
  }>;
}) {
  const { locale: segment, transactionRef } = await params;
  const { control, reason, needs, notice } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const n = (s: string): string => (arabic ? arabicIndic(s) : s);
  const numerals = defaultNumerals(locale);
  const staff = await pageStaff(segment);
  if (staff.tenantId === undefined || !/^WT-\d{6,10}$/.test(transactionRef)) notFound();
  const tenant = staff.tenantId as TenantCode;
  const v = await getTransaction(tenant, transactionRef);
  if (v === undefined) notFound();
  const tx = v.transaction;
  const core = tx.core;
  const p = core.pricing;
  const at = SEQUENCE.indexOf(tx.state);
  const label = (s: string) => {
    const l = STATE_LABEL[s];
    return l === undefined ? s : t(l.en, l.ar);
  };
  const words = (map: Readonly<Record<string, { en: string; ar: string }>>, key: string) => {
    const w = map[key];
    return w === undefined ? key : t(w.en, w.ar);
  };
  const duration = (seconds: bigint): string => {
    const s = seconds < 0n ? 0n : seconds;
    const h = String(s / 3600n);
    const m = String((s % 3600n) / 60n);
    return t(`${h} h ${m} min`, `${n(h)} س ${n(m)} د`);
  };
  const required = BigInt(core.riskPeriodRequiredSeconds);
  const legs = 'legs' in tx ? tx.legs : [];
  const live = v.evidence.filter((e) => e.supersededBy === undefined);
  const pendingPossession = live.filter(
    (e) => e.gateSatisfied === 'GATE_2_POSSESSION' && e.validationStatus === 'PENDING',
  );

  const refusal =
    control === undefined
      ? undefined
      : (authorityRefusal(reason, needs, arabic) ??
        (reason !== undefined && REFUSAL[reason] !== undefined
          ? words(REFUSAL, reason)
          : t('The sequence refused this step.', 'رفض التسلسل هذه الخطوة.')));
  const said = notice === undefined ? undefined : NOTICE[notice];

  const hidden = <Hidden segment={segment} transactionRef={v.transactionRef} />;
  const stepProps = { staff, arabic, segment, transactionRef: v.transactionRef };

  /** The next step, as the state says it is. */
  const next = (() => {
    switch (tx.state) {
      case 'DRAFT':
        return (
          <>
            <p className="text-[13px] text-ink-quiet">
              {t(
                'Validate the trade — the party the institution buys from and the party it sells to must be different legal entities — and hold the cost against the programme’s limit.',
                'تحقّق من التجارة — يجب أن يكون البائع للمؤسسة والمشتري منها كيانين مختلفين — واحجز التكلفة من حد البرنامج.',
              )}
            </p>
            <StepButton {...stepProps} step="RESERVE">
              {t('Validate and hold the limit', 'التحقق وحجز الحد')}
            </StepButton>
          </>
        );
      case 'LIMIT_RESERVED':
        return (
          <>
            <p className="text-[13px] text-ink-quiet">
              {t(
                'The distributor’s wa’d: a binding promise to buy the goods once the institution owns them. Its own instrument, from the board-approved template.',
                'وعد الموزع: التزام بشراء البضاعة بعد تملّك المؤسسة لها، في مستند مستقل من النموذج المعتمد من الهيئة.',
              )}
            </p>
            <StepButton {...stepProps} step="WAAD">
              {t('Execute the wa’d', 'تنفيذ الوعد')}
            </StepButton>
          </>
        );
      case 'WAAD_EXECUTED':
        return (
          <>
            <p className="text-[13px] text-ink-quiet">
              {t(
                'The institution buys the goods from the anchor, at cost. Its own instrument, chained to the wa’d.',
                'تشتري المؤسسة البضاعة من المورّد الرئيسي بالتكلفة، في مستند مستقل متسلسل مع الوعد.',
              )}
            </p>
            <StepButton {...stepProps} step="PURCHASE">
              {t('Execute the purchase', 'تنفيذ الشراء')}
            </StepButton>
          </>
        );
      case 'PURCHASE_EXECUTED':
        return (
          <>
            <p className="text-[13px] text-ink-quiet">
              {t(
                'Gate 1. Name the anchor’s invoice to the institution; the e-invoicing authority says whether it is cleared, who issued it, to whom, and for how much.',
                'البوابة ١. اذكر فاتورة المورّد الرئيسي للمؤسسة؛ تبيّن هيئة الفوترة الإلكترونية إن كانت معتمدة ومن أصدرها ولمن وبكم.',
              )}
            </p>
            <Gate staff={staff} act="TRADE_OPERATIONS" arabic={arabic}>
              <form action={ownershipInvoiceAction} className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
                {hidden}
                <label>
                  <span className={FIELD_LABEL}>{t('Invoice UUID', 'المعرّف الفريد للفاتورة')}</span>
                  <input name="invoiceUuid" required dir="ltr" className={`${FIELD_INPUT} identifier`} />
                </label>
                <label>
                  <span className={FIELD_LABEL}>{t('Invoice hash', 'بصمة الفاتورة')}</span>
                  <input name="invoiceHash" required dir="ltr" className={`${FIELD_INPUT} identifier`} />
                </label>
                <button type="submit" className={BUTTON_SECONDARY}>
                  {t('Ask the authority', 'الاستعلام من الهيئة')}
                </button>
              </form>
            </Gate>
            <StepButton {...stepProps} step="OWNERSHIP">
              {t('Pass gate 1: acquire ownership', 'اجتياز البوابة ١: انتقال الملكية')}
            </StepButton>
          </>
        );
      case 'OWNERSHIP_ACQUIRED':
        return (
          <>
            <p className="text-[13px] text-ink-quiet">
              {t(
                'Gate 2. Upload the possession document. A checker — not you — validates it before it counts. The risk-holding interval runs from when it was recorded.',
                'البوابة ٢. ارفع مستند القبض. يتحقق منه مراجِع غيرك قبل أن يُعتدّ به. وتبدأ مدة تحمّل المخاطر من وقت تسجيله.',
              )}
            </p>
            <Gate staff={staff} act="TRADE_OPERATIONS" arabic={arabic}>
              <form
                action={possessionEvidenceAction}
                encType="multipart/form-data"
                className="grid gap-3 md:grid-cols-3 md:items-end"
              >
                {hidden}
                <label>
                  <span className={FIELD_LABEL}>{t('Evidence', 'الدليل')}</span>
                  <select name="evidenceType" className={FIELD_INPUT}>
                    {possessionEvidenceTypes(tenant).map((e) => (
                      <option key={e} value={e}>
                        {words(EVIDENCE_TYPE_LABEL, e)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className={FIELD_LABEL}>{t('From', 'المصدر')}</span>
                  <select name="source" className={FIELD_INPUT}>
                    {POSSESSION_SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {words(EVIDENCE_SOURCE_LABEL, s)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className={FIELD_LABEL}>{t('File (PDF, PNG, JPEG)', 'الملف (PDF أو PNG أو JPEG)')}</span>
                  <input
                    type="file"
                    name="file"
                    required
                    accept="application/pdf,image/png,image/jpeg"
                    className="mt-2 block text-[14px]"
                  />
                </label>
                <button type="submit" className={`${BUTTON_SECONDARY} md:col-span-3 md:justify-self-start`}>
                  {t('Record the evidence', 'تسجيل الدليل')}
                </button>
              </form>
            </Gate>
            {pendingPossession.map((e) => (
              <div
                key={e.evidenceId}
                className="flex flex-wrap items-center gap-3 rounded-tile border border-line px-4 py-3"
                data-pending-evidence
              >
                <span className="text-[14px] text-heading">
                  {words(EVIDENCE_TYPE_LABEL, e.evidenceType)} · {words(EVIDENCE_SOURCE_LABEL, e.source)}
                </span>
                <Gate
                  staff={staff}
                  act="TRADE_EVIDENCE_VERIFY"
                  arabic={arabic}
                  ownWork={recorderOf(v, e.evidenceId) === staff.principalId}
                >
                  <div className="flex gap-2">
                    {(['VALID', 'INVALID'] as const).map((d) => (
                      <form key={d} action={decideEvidenceAction}>
                        {hidden}
                        <input type="hidden" name="evidenceId" value={e.evidenceId} />
                        <input type="hidden" name="decision" value={d} />
                        <button type="submit" className={d === 'VALID' ? BUTTON_SECONDARY : BUTTON_DANGER}>
                          {d === 'VALID' ? t('Validate', 'اعتماد') : t('Refuse', 'رفض')}
                        </button>
                      </form>
                    ))}
                  </div>
                </Gate>
              </div>
            ))}
            <StepButton {...stepProps} step="POSSESSION">
              {t('Pass gate 2: confirm possession', 'اجتياز البوابة ٢: تأكيد القبض')}
            </StepButton>
          </>
        );
      case 'POSSESSION_CONFIRMED': {
        const held = v.gates.riskPeriodHeldSeconds ?? 0n;
        return (
          <>
            <dl data-risk-period>
              <Row k={t('Held at the institution’s risk', 'مدة تحمّل المخاطر حتى الآن')}>{duration(held)}</Row>
              <Row k={t('Required by the board', 'المدة التي حددتها الهيئة')}>{duration(required)}</Row>
              <Row k={t('Offer possible from', 'يمكن العرض ابتداءً من')}>
                <bdi dir="ltr" className="identifier">
                  {n(instant(tx.riskPeriodStartAt.epochSeconds + required))}
                </bdi>
              </Row>
            </dl>
            <p className="text-[13px] text-ink-quiet">
              {t(
                'Gate 3. The sale is offered only once the interval has passed, measured between attested instants. The offer states cost, profit and sale price.',
                'البوابة ٣. لا يُعرض البيع إلا بعد انقضاء المدة، مقيسة بين لحظتين موثّقتين. ويبيّن العرض التكلفة والربح وثمن البيع.',
              )}
            </p>
            <StepButton {...stepProps} step="OFFER">
              {t('Pass gate 3: offer the sale', 'اجتياز البوابة ٣: عرض البيع')}
            </StepButton>
          </>
        );
      }
      case 'SALE_OFFERED':
        return (
          <>
            <dl>
              <Row k={t('Offered', 'عُرض في')}>
                <bdi dir="ltr" className="identifier">
                  {n(instant(tx.saleOfferedAt.epochSeconds))}
                </bdi>
              </Row>
              <Row k={t('Lapses', 'ينقضي في')}>
                <bdi dir="ltr" className="identifier">
                  {n(instant(tx.offerExpiresAtEpochSeconds))}
                </bdi>
              </Row>
            </dl>
            <p className="text-[13px] text-ink-quiet">
              {t(
                'Awaiting the distributor’s acceptance — their act, in the SME portal, never taken here. An offer not accepted in time lapses.',
                'بانتظار قبول الموزع — وهو تصرفه في بوابة المنشآت ولا يُتخذ من هنا. وينقضي العرض إن لم يُقبل في وقته.',
              )}
            </p>
            <StepButton {...stepProps} step="LAPSE" quiet>
              {t('Record the lapse', 'تسجيل انقضاء العرض')}
            </StepButton>
          </>
        );
      case 'REJECTED':
        return (
          <ul className="flex flex-col gap-1 text-[14px] text-heading">
            {tx.reasons.map((r) => (
              <li key={r.reason}>
                <span className="identifier text-ink-quiet">{r.control}</span> {words(REFUSAL, r.reason)}
              </li>
            ))}
          </ul>
        );
      case 'UNWIND':
        return <p className="text-[14px] text-heading">{tx.goodsDisposition}</p>;
      case 'OFFER_LAPSED':
        return (
          <p className="text-[13px] text-ink-quiet">
            {t(
              'The offer lapsed. The institution still holds the goods: unwind with their disposition below.',
              'انقضى العرض. ولا تزال المؤسسة تملك البضاعة: افكك المعاملة مع بيان مآلها أدناه.',
            )}
          </p>
        );
      default:
        return (
          <p className="text-[13px] text-ink-quiet">
            {t('The sale is executed. Booking the obligation follows.', 'نُفّذ البيع، ويليه قيد الالتزام.')}
          </p>
        );
    }
  })();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[13px] text-ink-quiet">
            <a href={`/${segment}/transactions`} className="hover:underline">
              {t('Transactions', 'المعاملات')}
            </a>{' '}
            /
          </p>
          <h1 className="identifier text-display font-bold tracking-tight text-heading">{v.transactionRef}</h1>
          <p className="mt-1 text-[14px] text-ink-quiet">
            {core.counterpartyId} · {t('opened from request ', 'فُتحت من الطلب ')}
            <a href={`/${segment}/requests/${v.requestRef}`} className="identifier text-brand hover:underline">
              {v.requestRef}
            </a>
          </p>
        </div>
        <span className="rounded-full border border-brand/40 bg-brand-wash px-3 py-1 text-[13px] font-semibold text-brand">
          {label(tx.state)}
        </span>
      </div>

      {said === undefined ? null : (
        <div
          role="status"
          className="rounded-card border border-positive/30 bg-positive-wash px-4 py-3 text-[14px] text-positive"
        >
          {t(said.en, said.ar)}
        </div>
      )}
      {control === undefined || refusal === undefined ? null : (
        <ControlRejection control={control} explanation={refusal} controlLabel={t('Control', 'الضابط')} />
      )}

      {/* The sequence, in order: nothing reaches the sale without passing every step before it. */}
      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-sequence>
        <h2 className="mb-3 text-[15px] font-semibold text-heading">{t('Sequence', 'التسلسل')}</h2>
        <ol className="flex flex-wrap gap-2">
          {SEQUENCE.map((s, i) => (
            <li
              key={s}
              aria-current={i === at ? 'step' : undefined}
              className={`rounded-full border px-3 py-1 text-[12px] ${
                i === at
                  ? 'border-brand bg-brand text-on-brand'
                  : i < at
                    ? 'border-line-strong text-heading'
                    : 'border-line text-ink-faint'
              }`}
            >
              {n(String(i + 1))}. {label(s)}
            </li>
          ))}
        </ol>
      </section>

      <section
        className="flex flex-col gap-4 rounded-card border border-line bg-surface px-5 py-4 shadow-card"
        data-next-step
      >
        <h2 className="text-[15px] font-semibold text-heading">
          {tx.state === 'REJECTED'
            ? t('Why the trade was rejected', 'سبب رفض التجارة')
            : tx.state === 'UNWIND'
              ? t('Goods’ disposition', 'مآل البضاعة')
              : t('Next step', 'الخطوة التالية')}
        </h2>
        {next}
        {UNWINDABLE.has(tx.state) ? (
          <details className="rounded-tile border border-line px-4 py-3">
            <summary className="cursor-pointer text-[13px] font-semibold text-blocked">
              {t('Unwind this transaction', 'فك هذه المعاملة')}
            </summary>
            <Gate staff={staff} act="TRADE_UNWIND" arabic={arabic}>
              <form action={unwindAction} className="mt-3 flex flex-col gap-3">
                {hidden}
                <label>
                  <span className={FIELD_LABEL}>
                    {t('What happens to the goods the institution holds', 'مآل البضاعة التي تملكها المؤسسة')}
                  </span>
                  <textarea name="goodsDisposition" required maxLength={500} rows={3} className={FIELD_TEXTAREA} />
                </label>
                <button type="submit" className={`${BUTTON_DANGER} self-start`}>
                  {t('Unwind', 'فك المعاملة')}
                </button>
              </form>
            </Gate>
          </details>
        ) : null}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-figures>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Figures', 'الأرقام')}</h2>
          <dl>
            <Row k={t('Cost of goods', 'تكلفة البضاعة')}>{formatMinorUnits(p.costAmount, numerals)}</Row>
            <Row k={t('Profit', 'الربح')}>{formatMinorUnits(p.profitAmount, numerals)}</Row>
            <Row k={t('Sale price (fixed)', 'ثمن البيع (ثابت)')}>{formatMinorUnits(p.salePriceAmount, numerals)}</Row>
            <Row k={t('Tenor', 'المدة')}>{t(`${core.tenorDays} days`, `${n(String(core.tenorDays))} يوماً`)}</Row>
            <Row k={t('Maturity', 'الاستحقاق')}>
              <bdi>{n(core.maturityDateGregorian)}</bdi> · <bdi>{ummAlQura(core.maturityDateGregorian)}</bdi>
            </Row>
          </dl>
          <p className="mt-2 text-[12px] text-ink-quiet">
            {t(
              'A profit amount fixed at opening: the sale price never increases, and late amounts go to charity, never income.',
              'ربح بمبلغ ثابت عند الفتح: لا يزيد ثمن البيع أبداً، وتذهب مبالغ التأخير إلى الخير لا إلى الدخل.',
            )}
          </p>
        </section>

        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-structure>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Structure and board', 'الهيكل والهيئة')}</h2>
          <dl>
            <Row k={t('Structure', 'الهيكل')}>
              <span className="identifier">
                {core.structureDefinitionId} v{core.structureVersion}
              </span>
            </Row>
            <Row k={t('Board approval', 'موافقة الهيئة')}>
              <span className="identifier">{core.shariahApprovalId}</span>
            </Row>
            <Row k={t('Risk-holding interval (snapshotted)', 'مدة تحمّل المخاطر (مثبّتة)')}>{duration(required)}</Row>
            <Row k={t('Programme', 'البرنامج')}>
              <span className="identifier">{core.programmeId}</span>
            </Row>
            <Row k={t('Credit policy', 'سياسة الائتمان')}>
              <span className="identifier">{core.creditPolicyVersion}</span>
            </Row>
          </dl>
        </section>
      </div>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-gates>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Gates', 'البوابات')}</h2>
        <ul className="divide-y divide-line">
          {v.gates.gates.map((g) => {
            const gl = GATE_LABEL[g.gateId];
            const gs = GATE_STATUS[g.status];
            return (
              <li key={g.gateId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-[14px] text-heading">{gl === undefined ? g.gateId : t(gl.en, gl.ar)}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[12px] ${
                    g.status === 'SATISFIED' ? 'bg-positive-wash text-positive' : 'border border-line text-ink-quiet'
                  }`}
                >
                  {gs === undefined ? g.status : t(gs.en, gs.ar)}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[12px] text-ink-quiet">
          {t(
            'Evaluated by the sequencing engine from the transaction’s legs and evidence. No role can pass a gate that is not satisfied.',
            'يقيّمها محرك التسلسل من أطراف العقد والأدلة. لا يملك أي دور تجاوز بوابة غير مستوفاة.',
          )}
        </p>
      </section>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-evidence>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Evidence', 'الأدلة')}</h2>
        {v.evidence.length === 0 ? (
          <p className="text-[13px] text-ink-quiet">
            {t(
              'None yet. Ownership is evidenced by the authority’s answer on the anchor’s invoice; possession by a document a checker validates.',
              'لا يوجد بعد. تثبت الملكية بإجابة الهيئة عن فاتورة المورّد الرئيسي، والقبض بمستند يعتمده مراجِع.',
            )}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {v.evidence.map((e) => (
              <li
                key={e.evidenceId}
                className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px] ${e.supersededBy === undefined ? '' : 'opacity-60'}`}
              >
                <span className="font-medium text-heading">{words(EVIDENCE_TYPE_LABEL, e.evidenceType)}</span>
                <span className="text-ink-quiet">{words(EVIDENCE_SOURCE_LABEL, e.source)}</span>
                {e.validationDetail?.['rail'] === 'FIXTURE' ? <FixtureBadge arabic={arabic} /> : null}
                <span
                  className={`rounded-full px-2 py-0.5 text-[12px] ${
                    e.validationStatus === 'VALID'
                      ? 'bg-positive-wash text-positive'
                      : e.validationStatus === 'INVALID'
                        ? 'bg-blocked-wash text-blocked'
                        : 'border border-line text-ink-quiet'
                  }`}
                >
                  {words(EVIDENCE_STATUS_LABEL, e.validationStatus)}
                </span>
                {e.supersededBy === undefined ? null : (
                  <span className="text-ink-quiet">{t('superseded', 'حلّ محله غيره')}</span>
                )}
                <bdi dir="ltr" className="identifier text-ink-quiet">
                  {n(instant(e.capturedAt.epochSeconds))}
                </bdi>
                <span className="identifier text-[11px] text-ink-faint" dir="ltr">
                  {e.artefactHash.slice(0, 16)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-trade>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Trade financed', 'التجارة الممولة')}</h2>
          <dl>
            <Row k={t('Cleared invoice', 'الفاتورة المعتمدة')}>
              <span className="identifier text-[12px]">{core.tradeReference.invoiceUuid ?? '—'}</span>
            </Row>
            <Row k={t('Issuer CR', 'سجل المُصدِر')}>
              <span className="identifier">{core.tradeReference.issuerCr}</span>
            </Row>
            <Row k={t('Recipient CR', 'سجل المستلم')}>
              <span className="identifier">{core.tradeReference.recipientCr}</span>
            </Row>
          </dl>
        </section>
        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-legs>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Contract legs', 'أطراف العقد')}</h2>
          {legs.length === 0 ? (
            <p className="text-[13px] text-ink-quiet">
              {t(
                'None yet. Each leg — the wa’d, the purchase, the sale offer, the acceptance — is its own document, timestamped and chained to the one before.',
                'لا يوجد بعد. كل طرف — الوعد والشراء وعرض البيع والقبول — مستند مستقل مختوم زمنياً ومتسلسل مع ما قبله.',
              )}
            </p>
          ) : (
            <ol className="flex flex-col gap-2 text-[13px]">
              {legs.map((l) => (
                <li key={l.legId} className="flex flex-col gap-0.5">
                  <span className="identifier font-medium text-heading">
                    {n(String(l.sequenceNo))}. {l.legType} ·{' '}
                    <span className="text-ink-quiet">{l.templateVersionId}</span>
                  </span>
                  <span className="identifier text-ink-quiet">
                    <bdi dir="ltr">{n(instant(l.executedAt.epochSeconds))}</bdi> · {l.counterpartyRole}{' '}
                    {l.counterpartyCr}
                  </span>
                  <span className="identifier text-[11px] text-ink-faint" dir="ltr">
                    {l.contentHash.slice(0, 16)}
                    {l.prevLegHash === undefined ? '' : ` ← ${l.prevLegHash.slice(0, 16)}`}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-events>
        <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Event log', 'سجل الأحداث')}</h2>
        <ol className="flex flex-col gap-1 text-[13px]">
          {v.events.map((e, i) => (
            <li key={`${e.eventType}-${String(i)}`} className="flex flex-wrap gap-x-3">
              <bdi dir="ltr" className="identifier text-ink-quiet">
                {n(instant(e.occurredAtEpochSeconds))}
              </bdi>
              <span className="font-medium text-heading">{e.eventType}</span>
              {e.toState === null ? null : <span className="text-ink-quiet">→ {label(e.toState)}</span>}
              <span className="identifier text-ink-quiet">{e.actor}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
