/**
 * The money around a Wasl transaction, on its page (W4a): the seller's
 * payment — instructed with the purchase, and what the payments hub reported —
 * and, once the obligation is booked, the collections: each instalment, what
 * is paid and outstanding, and every bill presented to SADAD with its result.
 *
 * A courtesy view of what settlement.ts derives from the event log. The acts
 * (present, pay again) are refused by the service where they do not apply;
 * the Fixture result buttons exist only where a synthetic demonstration is
 * permitted, and record exactly what a signed webhook would.
 */
import type { ReactElement } from 'react';

import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { BUTTON_PRIMARY, BUTTON_SECONDARY } from '@sanad/design/primitives.tsx';
import type { TransactionView } from '@sanad/origination/wasl/book.ts';
import { obligationPosition, presentations, sellerPayments } from '@sanad/origination/wasl/settlement.ts';

import {
  fixtureCollectionAction,
  fixtureSellerPaymentAction,
  sequenceStepAction,
} from '../../../../server/transaction-actions.ts';
import type { StaffPrincipal } from '../../../../server/staff.ts';
import { Gate } from '../../Gate.tsx';

const PAYMENT_STATUS: Readonly<Record<string, readonly [string, string]>> = {
  INSTRUCTED: ['Instructed', 'وُجّهت'],
  ACCEPTED: ['Accepted by the hub', 'قبلها المحوّل'],
  SETTLED: ['Paid', 'دُفعت'],
  REJECTED: ['Rejected', 'رُفضت'],
  RETURNED: ['Returned', 'ارتجعت'],
};

const INSTALMENT_STATE: Readonly<Record<string, readonly [string, string]>> = {
  PAID: ['Paid', 'مدفوع'],
  PART_PAID: ['Partly paid', 'مدفوع جزئياً'],
  DUE: ['Due', 'مستحق'],
  OVERDUE: ['Overdue', 'متأخر'],
  FUTURE: ['Upcoming', 'قادم'],
};

export function Settlement({
  view,
  segment,
  arabic,
  staff,
  fixtures,
  asOf,
}: {
  readonly view: TransactionView;
  readonly segment: string;
  readonly arabic: boolean;
  readonly staff: StaffPrincipal;
  /** Whether the Fixture stand-ins for the hub and SADAD may be offered here. */
  readonly fixtures: boolean;
  /** Today's civil date, from an attested instant, in the institution's time zone. */
  readonly asOf: string;
}): ReactElement | null {
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const words = (m: Readonly<Record<string, readonly [string, string]>>, k: string) => {
    const w = m[k];
    return w === undefined ? k : t(w[0], w[1]);
  };
  const numerals = defaultNumerals(arabic ? 'ar-SA' : 'en-SA');
  const payments = sellerPayments(view);
  const position = obligationPosition(view, asOf);
  const bills = presentations(view);
  if (payments.length === 0 && position === undefined) return null;
  const hidden = (
    <>
      <input type="hidden" name="locale" value={segment} />
      <input type="hidden" name="transactionRef" value={view.transactionRef} />
    </>
  );
  const last = payments.at(-1);
  const amount = (m: { minorUnits: bigint; currency: string }) => (
    <bdi className="tabular-nums">
      {formatMinorUnits(m as Parameters<typeof formatMinorUnits>[0], numerals)} {m.currency}
    </bdi>
  );

  return (
    <>
      {payments.length === 0 ? null : (
        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-seller-payment>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Paying the seller', 'الدفع للبائع')}</h2>
          <ul className="divide-y divide-line text-[13px]">
            {payments.map((p) => (
              <li key={p.idempotencyKey} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="identifier text-ink-quiet">{p.idempotencyKey.replace(/^wasl:/, '')}</span>
                <span className="font-medium text-heading">{amount(p.amount)}</span>
                <bdi className="identifier text-ink-quiet" dir="ltr">
                  …{p.beneficiaryIban.slice(-4)}
                </bdi>
                <span
                  className={`rounded-full px-2 py-0.5 text-[12px] ${
                    p.status === 'SETTLED'
                      ? 'bg-positive-wash text-positive'
                      : p.status === 'REJECTED' || p.status === 'RETURNED'
                        ? 'bg-blocked-wash text-blocked'
                        : 'border border-line text-ink-quiet'
                  }`}
                >
                  {words(PAYMENT_STATUS, p.status)}
                </span>
                {p.reasonCode === undefined ? null : <span className="identifier text-ink-quiet">{p.reasonCode}</span>}
                {fixtures && p === last && (p.status === 'INSTRUCTED' || p.status === 'ACCEPTED') ? (
                  <Gate staff={staff} act="SERVICING_STAND_IN" arabic={arabic}>
                    <span className="flex gap-2">
                      {(['SETTLED', 'REJECTED'] as const).map((s) => (
                        <form key={s} action={fixtureSellerPaymentAction}>
                          {hidden}
                          <input type="hidden" name="idempotencyKey" value={p.idempotencyKey} />
                          <input type="hidden" name="status" value={s} />
                          <button type="submit" className="text-[12px] text-brand underline" data-fixture-payment={s}>
                            {s === 'SETTLED'
                              ? t('Fixture: paid', 'تجريبي: دُفعت')
                              : t('Fixture: rejected', 'تجريبي: رُفضت')}
                          </button>
                        </form>
                      ))}
                    </span>
                  </Gate>
                ) : null}
              </li>
            ))}
          </ul>
          {last !== undefined && (last.status === 'REJECTED' || last.status === 'RETURNED') ? (
            <Gate staff={staff} act="TRADE_SETTLEMENT" arabic={arabic}>
              <form action={sequenceStepAction} className="mt-3">
                {hidden}
                <input type="hidden" name="step" value="PAY_SELLER_AGAIN" />
                <button type="submit" className={BUTTON_SECONDARY} data-step="PAY_SELLER_AGAIN">
                  {t('Pay the seller again', 'إعادة الدفع للبائع')}
                </button>
              </form>
            </Gate>
          ) : null}
          <p className="mt-2 text-[12px] text-ink-quiet">
            {t(
              'Instructed with the purchase, through the institution’s payments hub, at the cost. Results arrive from the hub by signed webhook.',
              'وُجّهت مع الشراء عبر محوّل المدفوعات بالتكلفة، وتصل النتائج من المحوّل عبر إشعار موقّع.',
            )}
          </p>
        </section>
      )}

      {position === undefined ? null : (
        <section className="rounded-card border border-line bg-surface px-5 py-4 shadow-card" data-collections>
          <h2 className="mb-2 text-[15px] font-semibold text-heading">{t('Collections', 'التحصيل')}</h2>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-start text-ink-quiet">
                <th className="py-1 text-start font-normal">{t('Due', 'الاستحقاق')}</th>
                <th className="py-1 text-end font-normal">{t('Amount', 'المبلغ')}</th>
                <th className="py-1 text-end font-normal">{t('Paid', 'المدفوع')}</th>
                <th className="py-1 text-end font-normal">{t('Outstanding', 'المتبقي')}</th>
                <th className="py-1 text-end font-normal">{t('State', 'الحالة')}</th>
              </tr>
            </thead>
            <tbody>
              {position.instalments.map((i) => (
                <tr key={i.number} className="border-t border-line">
                  <td className="py-1.5">
                    <bdi dir="ltr" className="identifier">
                      {i.dueDate}
                    </bdi>
                  </td>
                  <td className="py-1.5 text-end">{amount(i.amount)}</td>
                  <td className="py-1.5 text-end">{amount(i.paid)}</td>
                  <td className="py-1.5 text-end font-medium text-heading">{amount(i.outstanding)}</td>
                  <td className="py-1.5 text-end">{words(INSTALMENT_STATE, i.state)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {bills.length === 0 ? null : (
            <ul className="mt-3 divide-y divide-line text-[13px]" data-bills>
              {bills.map((b) => (
                <li key={b.idempotencyKey} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="identifier text-ink-quiet">{t('SADAD bill', 'فاتورة سداد')}</span>
                  <span className="identifier">{b.billNumber}</span>
                  <span className="identifier text-[11px] text-ink-faint">
                    {b.idempotencyKey.replace(/^wasl:/, '')}
                  </span>
                  <span className="font-medium text-heading">{amount(b.amount)}</span>
                  <span className="text-ink-quiet">
                    {b.result === undefined
                      ? t('Presented', 'معروضة')
                      : b.result === 'PAID'
                        ? t('Paid', 'مدفوعة')
                        : t('Returned', 'مرتجعة')}
                  </span>
                  {fixtures && b.result !== 'RETURNED' ? (
                    <Gate staff={staff} act="SERVICING_STAND_IN" arabic={arabic}>
                      <span className="flex gap-2">
                        {(b.result === undefined ? (['PAID', 'RETURNED'] as const) : (['RETURNED'] as const)).map(
                          (s) => (
                            <form key={s} action={fixtureCollectionAction}>
                              {hidden}
                              <input type="hidden" name="idempotencyKey" value={b.idempotencyKey} />
                              <input type="hidden" name="status" value={s} />
                              <input type="hidden" name="receivedOn" value={asOf} />
                              <button
                                type="submit"
                                className="text-[12px] text-brand underline"
                                data-fixture-collection={s}
                              >
                                {s === 'PAID'
                                  ? t('Fixture: paid', 'تجريبي: مدفوعة')
                                  : t('Fixture: returned', 'تجريبي: مرتجعة')}
                              </button>
                            </form>
                          ),
                        )}
                      </span>
                    </Gate>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {view.transaction.state === 'ACTIVE' ? (
            <Gate staff={staff} act="TRADE_OPERATIONS" arabic={arabic}>
              <form action={sequenceStepAction} className="mt-3">
                {hidden}
                <input type="hidden" name="step" value="PRESENT" />
                <button type="submit" className={BUTTON_PRIMARY} data-step="PRESENT">
                  {t('Present the instalments falling due', 'عرض الأقساط المستحقة')}
                </button>
              </form>
            </Gate>
          ) : null}
          <p className="mt-2 text-[12px] text-ink-quiet">
            {t(
              `As of ${asOf}. An instalment is presented to SADAD up to seven days before it falls due. A receipt reduces what is owed; the total never moves. A returned payment frees the instalment to be presented again.`,
              `حتى ${asOf}. يُعرض القسط على سداد قبل استحقاقه بسبعة أيام كحد أقصى. يخفض المبلغ المحصّل ما هو مستحق ولا يتغير الإجمالي أبداً. ويتيح الارتجاع عرض القسط من جديد.`,
            )}
          </p>
        </section>
      )}
    </>
  );
}
