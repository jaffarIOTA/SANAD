/**
 * Late amounts on a Wasl transaction, and the charity they are held for, on
 * its page (W4b-2). A courtesy view of what late-amounts.ts derives from the
 * event log, with each act offered only where it applies and drawn disabled,
 * with the reason, for someone it is not for:
 *
 *   proposed (by the daily cycle) → assessed by an officer → confirmed by a
 *   second person (or sent back) → billed through SADAD on its own bill, or
 *   closed as hardship → collected, and raised to the charity liability →
 *   a recipient proposed by finance → approved by a second person, and paid.
 *
 * Never part of the sale price, never the institution's income: the screen
 * says so beside the figures. The Fixture buttons exist only where a
 * synthetic demonstration is permitted, and record what a signed webhook would.
 */
import type { ReactElement } from 'react';

import { maskIban } from '@sanad/core/kernel/iban.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, FIELD_INPUT, FIELD_TEXTAREA } from '@sanad/design/primitives.tsx';
import type { TransactionView } from '@sanad/origination/wasl/book.ts';
import { type LateAmount, lateAmounts } from '@sanad/origination/wasl/late-amounts.ts';
import type { LateAmountPositions } from '@sanad/products/murabaha-scf/structures/board-positions.ts';

import {
  assessLateAmountAction,
  decideDisbursementAction,
  decideLateAmountAction,
  fixtureCollectionAction,
  fixtureSadadFileAction,
  presentLateBillAgainAction,
  proposeDisbursementAction,
  proposeLateAmountsAction,
} from '../../../../server/transaction-actions.ts';
import type { StaffPrincipal } from '../../../../server/staff.ts';
import { Gate } from '../../Gate.tsx';

const STATUS: Readonly<Record<LateAmount['status'], readonly [string, string]>> = {
  PROPOSED: ['Proposed: awaiting the officer’s assessment', 'مقترح: بانتظار تقييم الموظف'],
  ASSESSED: ['Assessed: awaiting a second person', 'مقيَّم: بانتظار شخص ثانٍ'],
  HARDSHIP: ['Hardship: not billed', 'تعثّر: لا يُفوتر'],
  BILLED: ['Billed through SADAD', 'مفوتر عبر سداد'],
  COLLECTED: ['Collected: held for charity', 'محصّل: محتجز للتبرع'],
  DISBURSEMENT_PROPOSED: ['Recipient proposed: awaiting approval', 'اقتُرح المستفيد: بانتظار الاعتماد'],
  DISBURSED: ['Given to charity', 'صُرف للجهة الخيرية'],
};

export function LateAmounts({
  view,
  segment,
  arabic,
  staff,
  fixtures,
  asOf,
  ruling,
}: {
  readonly view: TransactionView;
  readonly segment: string;
  readonly arabic: boolean;
  readonly staff: StaffPrincipal;
  readonly fixtures: boolean;
  readonly asOf: string;
  /** The board's ruling on late amounts, or undefined where it has ruled none. */
  readonly ruling: LateAmountPositions | undefined;
}): ReactElement | null {
  const booked = view.events.some((e) => e.eventType === 'OBLIGATION_BOOKED');
  if (!booked) return null;
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const numerals = defaultNumerals(arabic ? 'ar-SA' : 'en-SA');
  const amount = (m: { minorUnits: bigint; currency: string }) => (
    <bdi className="tabular-nums">
      {formatMinorUnits(m as Parameters<typeof formatMinorUnits>[0], numerals)} {m.currency}
    </bdi>
  );
  const late = lateAmounts(view);
  const recipientName = (id: string) => {
    const r = ruling?.approvedRecipients.find((x) => x.recipientId === id);
    return r === undefined ? id : t(r.nameEn, r.nameAr);
  };
  const hidden = (sequenceNumber?: number) => (
    <>
      <input type="hidden" name="locale" value={segment} />
      <input type="hidden" name="transactionRef" value={view.transactionRef} />
      {sequenceNumber === undefined ? null : (
        <input type="hidden" name="sequenceNumber" value={String(sequenceNumber)} />
      )}
    </>
  );
  const me = staff.principalId;

  return (
    <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-late-amounts>
      <h2 className="mb-1 text-[15px] font-semibold text-heading">
        {t('Late amounts and charity', 'مبالغ التأخير والتبرع')}
      </h2>
      <p className="mb-3 text-[12px] text-ink-quiet">
        {ruling === undefined
          ? t(
              'The board has ruled no late amounts for this institution. None is proposed.',
              'لم تقرّ الهيئة الشرعية مبالغ تأخير لهذه المؤسسة، فلا يُقترح شيء.',
            )
          : t(
              `Under the board’s ruling ${ruling.computationBasisKey}: an instalment unpaid more than ${String(ruling.graceDays)} days after it fell due attracts one late amount. It is the distributor’s undertaking to give to charity — never part of the sale price, never the institution’s income — and is not billed where the distributor is unable to pay.`,
              `وفق قرار الهيئة ${ruling.computationBasisKey}: القسط غير المدفوع بعد ${String(ruling.graceDays)} أيام من استحقاقه يترتب عليه مبلغ تأخير واحد. وهو التزام من الموزع بالتبرع، ليس جزءاً من ثمن البيع ولا دخلاً للمؤسسة، ولا يُفوتر إذا كان الموزع عاجزاً عن السداد.`,
            )}
      </p>

      {late.length === 0 ? (
        <p className="text-[13px] text-ink-quiet">
          {t('No late amount on this transaction.', 'لا مبالغ تأخير على هذه المعاملة.')}
        </p>
      ) : (
        <ul className="divide-y divide-line text-[13px]">
          {late.map((a) => (
            <li key={a.sequenceNumber} className="space-y-2 py-3" data-late-amount={a.sequenceNumber}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium text-heading">
                  {t(`Instalment ${String(a.sequenceNumber)}`, `القسط ${String(a.sequenceNumber)}`)}
                </span>
                <bdi dir="ltr" className="identifier text-ink-quiet">
                  {a.dueDate}
                </bdi>
                <span className="text-ink-quiet">
                  {t(`${String(a.daysPastDue)} days past due`, `متأخر ${String(a.daysPastDue)} يوماً`)}
                </span>
                <span className="font-medium text-heading">{amount(a.amount)}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[12px] ${
                    a.status === 'DISBURSED'
                      ? 'bg-positive-wash text-positive'
                      : a.status === 'HARDSHIP'
                        ? 'border border-line text-ink-quiet'
                        : 'bg-attention-wash text-attention'
                  }`}
                  data-late-status={a.status}
                >
                  {t(STATUS[a.status][0], STATUS[a.status][1])}
                </span>
              </div>

              {a.assessment === undefined ? null : (
                <p className="text-ink-quiet">
                  {a.assessment === 'UNABLE'
                    ? t('Assessed unable to pay (hardship)', 'قُيّم عاجزاً عن السداد (تعثّر)')
                    : t('Assessed able but unwilling to pay', 'قُيّم قادراً غير راغب في السداد')}
                  {a.assessedBy === undefined ? '' : ` · ${a.assessedBy}`}
                  {a.confirmedBy === undefined ? '' : ` · ${t('confirmed by', 'أكّده')} ${a.confirmedBy}`}
                  {a.assessmentNote === undefined || a.assessmentNote === '' ? null : (
                    <span className="block text-ink">“{a.assessmentNote}”</span>
                  )}
                </p>
              )}
              {a.status === 'PROPOSED' && a.sentBack !== undefined ? (
                <p className="text-attention">
                  {t('Sent back by', 'أعاده')} {a.sentBack.by}: “{a.sentBack.note}”
                </p>
              ) : null}

              {a.status === 'PROPOSED' ? (
                <Gate staff={staff} act="TRADE_LATE_ASSESS" arabic={arabic}>
                  <form action={assessLateAmountAction} className="grid gap-2 sm:max-w-xl">
                    {hidden(a.sequenceNumber)}
                    <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
                      <label className="flex items-center gap-2">
                        <input type="radio" name="assessment" value="ABLE_BUT_UNWILLING" required />
                        {t('Able but unwilling to pay', 'قادر غير راغب في السداد')}
                      </label>
                      <label className="flex items-center gap-2">
                        <input type="radio" name="assessment" value="UNABLE" />
                        {t('Unable to pay (hardship)', 'عاجز عن السداد (تعثّر)')}
                      </label>
                    </fieldset>
                    <textarea
                      name="note"
                      required
                      maxLength={500}
                      rows={2}
                      className={FIELD_TEXTAREA}
                      placeholder={t('What the assessment rests on', 'ما يستند إليه التقييم')}
                    />
                    <button type="submit" className={BUTTON_PRIMARY} data-late-assess>
                      {t('Record the assessment', 'تسجيل التقييم')}
                    </button>
                  </form>
                </Gate>
              ) : null}

              {a.status === 'ASSESSED' ? (
                <Gate staff={staff} act="TRADE_LATE_CONFIRM" arabic={arabic} ownWork={a.assessedBy === me}>
                  <div className="flex flex-wrap items-start gap-3">
                    <form action={decideLateAmountAction}>
                      {hidden(a.sequenceNumber)}
                      <input type="hidden" name="decision" value="CONFIRM" />
                      <button type="submit" className={BUTTON_PRIMARY} data-late-confirm>
                        {a.assessment === 'UNABLE'
                          ? t('Confirm: hardship, not billed', 'تأكيد: تعثّر، لا يُفوتر')
                          : t('Confirm and bill through SADAD', 'تأكيد وفوترة عبر سداد')}
                      </button>
                    </form>
                    <form action={decideLateAmountAction} className="flex flex-wrap items-start gap-2">
                      {hidden(a.sequenceNumber)}
                      <input type="hidden" name="decision" value="SEND_BACK" />
                      <input
                        name="note"
                        required
                        maxLength={500}
                        className={FIELD_INPUT}
                        placeholder={t('Why it goes back', 'سبب الإعادة')}
                      />
                      <button type="submit" className={BUTTON_SECONDARY} data-late-send-back>
                        {t('Send back', 'إعادة')}
                      </button>
                    </form>
                  </div>
                </Gate>
              ) : null}

              {a.bills.length === 0 ? null : (
                <ul className="space-y-1" data-late-bills>
                  {a.bills.map((b) => (
                    <li key={b.idempotencyKey} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="identifier text-ink-quiet">{t('SADAD bill', 'فاتورة سداد')}</span>
                      <span className="identifier">{b.billNumber}</span>
                      <span className="identifier text-[11px] text-ink-faint">
                        {b.idempotencyKey.replace(/^wasl:/, '')}
                      </span>
                      <span className="text-ink-quiet">
                        {b.result === undefined
                          ? t('Presented', 'معروضة')
                          : b.result === 'PAID'
                            ? t('Paid', 'مدفوعة')
                            : t('Returned', 'مرتجعة')}
                      </span>
                      {fixtures && b.result === undefined ? (
                        <Gate staff={staff} act="SERVICING_STAND_IN" arabic={arabic}>
                          <span className="flex gap-2">
                            {(['PAID', 'RETURNED'] as const).map((s) => (
                              <form key={s} action={fixtureCollectionAction}>
                                {hidden()}
                                <input type="hidden" name="idempotencyKey" value={b.idempotencyKey} />
                                <input type="hidden" name="status" value={s} />
                                <input type="hidden" name="receivedOn" value={asOf} />
                                <button
                                  type="submit"
                                  className="text-[12px] text-brand underline"
                                  data-fixture-late-collection={s}
                                >
                                  {s === 'PAID'
                                    ? t('Fixture: paid', 'تجريبي: مدفوعة')
                                    : t('Fixture: returned', 'تجريبي: مرتجعة')}
                                </button>
                              </form>
                            ))}
                            <form action={fixtureSadadFileAction}>
                              {hidden()}
                              <input type="hidden" name="idempotencyKey" value={b.idempotencyKey} />
                              <button type="submit" className="text-[12px] text-brand underline">
                                {t("Fixture: paid in SADAD's file", 'تجريبي: مدفوعة في ملف سداد')}
                              </button>
                            </form>
                          </span>
                        </Gate>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {a.status === 'BILLED' && a.bills.at(-1)?.result === 'RETURNED' ? (
                <Gate staff={staff} act="TRADE_LATE_ASSESS" arabic={arabic}>
                  <form action={presentLateBillAgainAction}>
                    {hidden(a.sequenceNumber)}
                    <button type="submit" className={BUTTON_SECONDARY}>
                      {t('Present the late amount again', 'عرض مبلغ التأخير من جديد')}
                    </button>
                  </form>
                </Gate>
              ) : null}

              {a.charity === undefined ? null : (
                <p className="text-ink-quiet" data-charity-entry>
                  {t('Raised to the charity liability on', 'قُيّد في التزام التبرع في')}{' '}
                  <bdi dir="ltr" className="identifier">
                    {a.charity.collectedOn}
                  </bdi>{' '}
                  · {t('core posting', 'قيد النظام الأساسي')}{' '}
                  <span className="identifier">{a.charity.corePostingRef}</span>
                  {a.charity.source === 'FIXTURE' ? ` · ${t('Fixture', 'تجريبي')}` : ''}
                </p>
              )}

              {a.status === 'COLLECTED' ? (
                <Gate staff={staff} act="CHARITY_DISBURSE_PROPOSE" arabic={arabic}>
                  <form action={proposeDisbursementAction} className="flex flex-wrap items-center gap-2">
                    {hidden(a.sequenceNumber)}
                    <select name="recipientId" className={FIELD_INPUT} required>
                      {(ruling?.approvedRecipients ?? []).map((r) => (
                        <option key={r.recipientId} value={r.recipientId}>
                          {t(r.nameEn, r.nameAr)} · {maskIban(r.iban)}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className={BUTTON_PRIMARY} data-charity-propose>
                      {t('Propose this recipient', 'اقتراح هذا المستفيد')}
                    </button>
                  </form>
                </Gate>
              ) : null}

              {a.disbursement === undefined ? null : (
                <p className="text-ink-quiet">
                  {t('Recipient', 'المستفيد')}:{' '}
                  <span className="text-ink">{recipientName(a.disbursement.recipientId)}</span>
                  {` · ${t('proposed by', 'اقترحه')} ${a.disbursement.proposedBy}`}
                  {a.disbursement.approvedBy === undefined
                    ? ''
                    : ` · ${t('approved by', 'اعتمده')} ${a.disbursement.approvedBy}`}
                </p>
              )}

              {a.status === 'DISBURSEMENT_PROPOSED' ? (
                <Gate
                  staff={staff}
                  act="CHARITY_DISBURSE_APPROVE"
                  arabic={arabic}
                  ownWork={a.disbursement?.proposedBy === me}
                >
                  <div className="flex flex-wrap gap-3">
                    {(['APPROVE', 'DECLINE'] as const).map((d) => (
                      <form key={d} action={decideDisbursementAction}>
                        {hidden(a.sequenceNumber)}
                        <input type="hidden" name="decision" value={d} />
                        <button
                          type="submit"
                          className={d === 'APPROVE' ? BUTTON_PRIMARY : BUTTON_SECONDARY}
                          data-charity-decide={d}
                        >
                          {d === 'APPROVE'
                            ? t('Approve and pay the recipient', 'اعتماد والدفع للمستفيد')
                            : t('Decline', 'رفض')}
                        </button>
                      </form>
                    ))}
                  </div>
                </Gate>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {ruling !== undefined && view.transaction.state === 'ACTIVE' ? (
        <Gate staff={staff} act="TRADE_LATE_ASSESS" arabic={arabic}>
          <form action={proposeLateAmountsAction} className="mt-3">
            {hidden()}
            <button type="submit" className={BUTTON_SECONDARY} data-late-propose>
              {t('Propose late amounts now', 'اقتراح مبالغ التأخير الآن')}
            </button>
          </form>
        </Gate>
      ) : null}
      <p className="mt-2 text-[12px] text-ink-quiet">
        {t(
          `As of ${asOf}. The daily cycle proposes; an officer assesses and a second person confirms before anything is billed. A late amount reaches the charity liability only when SADAD reports it paid, and leaves it only to a board-approved recipient, approved by a second person.`,
          `حتى ${asOf}. تقترح الدورة اليومية، ويقيّم الموظف ويؤكد شخص ثانٍ قبل أي فوترة. لا يُقيّد مبلغ التأخير في التزام التبرع إلا عند إبلاغ سداد بدفعه، ولا يُصرف إلا لجهة اعتمدتها الهيئة وبموافقة شخص ثانٍ.`,
        )}
      </p>
    </section>
  );
}
