/**
 * Step 2 — the terms.
 *
 * The programme and the tenor. Note what is not here: an amount, which was
 * settled by the trade, and a rate, which this module does not have. The
 * tenor must be determinate in days (SH-03); an open-ended term is gharar.
 */

import { notFound } from 'next/navigation';

import { BUTTON_PRIMARY, BUTTON_SECONDARY, Card, ControlRejection, FIELD_INPUT, FIELD_LABEL } from '@sanad/design/primitives.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { CHANNEL_POLICIES } from '@sanad/core/origination/channel.ts';

import { chooseTermsAction } from '../../../../../server/actions.ts';
import { findClearedInvoice } from '../../../../../server/invoices.ts';
import { findDraft, originationPolicy } from '../../../../../server/store.ts';
import { Steps } from '../../Steps.tsx';

const HINT = 'mt-2 block text-[13px] text-ink-quiet';

export default async function TermsPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly draftId: string }>;
  readonly searchParams: Promise<{ readonly control?: string; readonly message?: string }>;
}) {
  const { locale: segment, draftId } = await params;
  const { control, message } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();

  const draft = findDraft(draftId);
  const invoice = draft?.invoiceUuid === undefined ? undefined : findClearedInvoice(draft.invoiceUuid);
  if (draft === undefined || invoice === undefined) notFound();

  const arabic = locale === 'ar-SA';
  const numerals = defaultNumerals(locale);
  const needsMandate = CHANNEL_POLICIES[draft.channel].requiresMerchantMandate;
  const isAgent = draft.channel === 'AGENT_ASSISTED';
  // Every configured agent is offered, including suspended ones, so the
  // refusal is demonstrated rather than hidden behind a filtered list.
  const agents = originationPolicy().agents;
  const branches = [...new Set(agents.map((a) => a.branchCode))];

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <Card>
        <Steps current="terms" arabic={arabic} />
        <div className="mt-6">
          <h2 className="text-h2 font-semibold text-heading">{arabic ? 'الشروط' : 'The terms'}</h2>
          <p className="mt-1 text-[15px] text-ink-quiet">
            {arabic ? invoice.goodsDescriptionAr : invoice.goodsDescription} · <bdi className="tabular-nums">{formatMinorUnits(invoice.amount, numerals)}</bdi> SAR
          </p>
        </div>

        {control !== undefined ? (
          <div className="mt-4"><ControlRejection control={control} explanation={message ?? ''} controlLabel={arabic ? 'الضابط' : 'Control'} /></div>
        ) : null}

        <form action={chooseTermsAction} className="mt-6 flex flex-col gap-6">
          <input type="hidden" name="locale" value={segment} />
          <input type="hidden" name="draftId" value={draftId} />

          <div className="grid gap-6 md:grid-cols-2">
            <label className={FIELD_LABEL}>
              {arabic ? 'البرنامج' : 'Programme'}
              <select name="programmeId" defaultValue={draft.programmeId ?? 'prg-0001'} className={FIELD_INPUT}>
                <option value="prg-0001">{arabic ? 'وصل — تمويل الموزعين' : 'Wasl — distributor finance'}</option>
              </select>
            </label>

            <label className={FIELD_LABEL}>
              {arabic ? 'المدة بالأيام' : 'Tenor, in days'}
              <input name="tenorDays" type="number" inputMode="numeric" min={1} max={365} step={1} required defaultValue={draft.tenorDays ?? 90} className={`${FIELD_INPUT} tabular-nums`} />
              <span className={HINT}>{arabic ? 'مدة محددة. لا توجد مدة مفتوحة.' : 'A determinate term. There is no open-ended option.'}</span>
            </label>

            {isAgent ? (
              <>
                <label className={FIELD_LABEL}>
                  {arabic ? 'الوكيل' : 'Agent'}
                  <select name="agentId" required defaultValue={draft.agentId ?? ''} className={FIELD_INPUT}>
                    <option value="" disabled>{arabic ? 'اختر' : 'Choose'}</option>
                    {agents.map((a) => (
                      <option key={a.agentId} value={a.agentId}>
                        {a.agentId} · {a.branchCode}{a.status === 'SUSPENDED' ? (arabic ? ' · موقوف' : ' · suspended') : ''}
                      </option>
                    ))}
                  </select>
                  <span className={HINT}>{arabic ? 'حدود الوكيل من إعدادات المؤسسة، لا من هذه الشاشة.' : 'An agent’s limits come from the tenant’s policy, not from this screen.'}</span>
                </label>
                <label className={FIELD_LABEL}>
                  {arabic ? 'الفرع' : 'Branch'}
                  <select name="branchCode" required defaultValue={draft.branchCode ?? ''} className={FIELD_INPUT}>
                    <option value="" disabled>{arabic ? 'اختر' : 'Choose'}</option>
                    {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </label>
              </>
            ) : null}

            {needsMandate ? (
              <>
                <label className={FIELD_LABEL}>
                  {arabic ? 'معرّف الوسيط' : 'Aggregator'}
                  <input name="aggregatorId" required defaultValue={draft.aggregatorId ?? ''} className={`${FIELD_INPUT} identifier`} />
                </label>
                <label className={FIELD_LABEL}>
                  {arabic ? 'مرجع تفويض التاجر' : 'Merchant’s mandate reference'}
                  <input name="merchantMandateRef" required defaultValue={draft.merchantMandateRef ?? ''} className={`${FIELD_INPUT} identifier`} />
                  <span className={HINT}>{arabic ? 'تفويض من التاجر نفسه، لا من الوسيط.' : 'From the merchant, not from the aggregator.'}</span>
                </label>
              </>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <a href={`/${segment}/originate/${draftId}/trade`} className={BUTTON_SECONDARY}>{arabic ? 'رجوع' : 'Back'}</a>
            <button type="submit" className={BUTTON_PRIMARY}>{arabic ? 'التالي: المراجعة' : 'Next: review'}</button>
          </div>
        </form>
      </Card>
    </div>
  );
}
