/**
 * Review a request.
 *
 * The checker's screen, and the place where the two-stage decision is visible:
 * what the servicing platform said, then what the institution decides with
 * that in front of it.
 *
 * Three things this screen deliberately does not offer. There is no button
 * that books anything — approving produces a transaction in `DRAFT`, with all
 * three gates ahead of it. There is no way to approve your own work; the
 * domain refuses it and the refusal surfaces here with its control code. And
 * approving against a servicing decline is possible but demands a written
 * justification, because a credit judgement the institution is entitled to
 * make is one it has to own.
 */

import { notFound } from 'next/navigation';

import { Card, ControlRejection, Status } from '@sanad/design/primitives.tsx';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';
import { CHANNEL_POLICIES } from '@sanad/core/origination/channel.ts';

import {
  approveAction,
  rejectAction,
  returnAction,
  servicingRespondAction,
} from '../../../../server/actions.ts';
import { findRequest, originationPolicy } from '../../../../server/store.ts';
import { CHECKER } from '../../../../server/session.ts';
import { Lifecycle } from './Lifecycle.tsx';
import { authorityCovers, requiredAuthority } from '@sanad/core/origination/policy.ts';
import { money } from '@sanad/core/kernel/money.ts';

const INPUT =
  'mt-1 block w-full min-h-tap rounded-card border border-line bg-surface px-3 text-base text-ink';
const BUTTON = 'min-h-tap rounded-card px-4 text-sm font-semibold';

export default async function ReviewPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly requestId: string }>;
  readonly searchParams: Promise<{ readonly control?: string; readonly message?: string }>;
}) {
  const { locale: segment, requestId } = await params;
  const { control, message } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();

  const request = findRequest(requestId);
  if (request === undefined) notFound();

  const arabic = locale === 'ar-SA';
  const numerals = defaultNumerals(locale);
  const policy = CHANNEL_POLICIES[request.channel];

  const awaitingServicing = request.state === 'AWAITING_SERVICING_RESPONSE';
  const awaitingReview = request.state === 'AWAITING_REVIEW';
  const servicingDeclined = request.servicing?.decision === 'DECLINED';

  // The tenant's approval tiers, applied to this amount. Shown before the
  // button so a checker without the authority learns it here, not from a
  // refusal after writing a justification. The domain refuses regardless.
  const required = requiredAuthority(originationPolicy(), money(request.amountMinorUnits));
  const held = CHECKER.authority ?? 'CHECKER';
  const mayApprove = authorityCovers(held, required);

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <div>
        <a href={`/${segment}`} className="text-sm text-brand-deep underline">
          {arabic ? 'رجوع إلى لوحة العمليات' : 'Back to dashboard'}
        </a>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">
            <span className="identifier">{request.requestId}</span>
          </h1>
          <Status
            tone={
              request.state === 'APPROVED'
                ? 'settled'
                : request.state === 'REJECTED'
                  ? 'blocked'
                  : 'progress'
            }
            label={request.state.replaceAll('_', ' ').toLowerCase()}
          />
        </div>
      </div>

      {control !== undefined ? (
        <ControlRejection
          control={control}
          explanation={message ?? ''}
          controlLabel={arabic ? 'الضابط' : 'Control'}
        />
      ) : null}

      <Card>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-ink-quiet">{arabic ? 'العميل' : 'Counterparty'}</dt>
            <dd className="font-medium">{request.counterpartyId}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-quiet">{arabic ? 'الفاتورة' : 'Invoice'}</dt>
            <dd className="identifier">{request.invoiceNumber}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-quiet">{arabic ? 'المبلغ' : 'Amount'}</dt>
            <dd className="text-base font-semibold tabular-nums">
              <bdi>
                {formatMinorUnits(
                  { minorUnits: request.amountMinorUnits, currency: 'SAR' },
                  numerals,
                )}
              </bdi>{' '}
              <span className="text-xs text-ink-quiet">SAR</span>
            </dd>
          </div>
          <div>
            <dt className="text-sm text-ink-quiet">{arabic ? 'القناة' : 'Channel'}</dt>
            <dd>{request.channel.replaceAll('_', ' ').toLowerCase()}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-quiet">{arabic ? 'أدخله' : 'Keyed by'}</dt>
            <dd className="identifier">{request.makerPrincipalId ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-quiet">
              {arabic ? 'مراجعة من شخصين' : 'Four eyes'}
            </dt>
            <dd>{policy.requiresFourEyes ? (arabic ? 'مطلوبة' : 'Required') : '—'}</dd>
          </div>
        </dl>
      </Card>

      {/* -- Stage one: the servicing platform ------------------------------ */}
      {policy.requiresServicingDecision ? (
        <Card muted={!awaitingServicing}>
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium">
              {arabic ? '١ — رد نظام الخدمة' : '1 — Servicing platform response'}
            </h2>
            {request.servicing !== undefined ? (
              <Status
                tone={request.servicing.decision === 'APPROVED' ? 'settled' : 'blocked'}
                label={request.servicing.decision.toLowerCase()}
              />
            ) : (
              <Status tone="progress" label={arabic ? 'بانتظار الرد' : 'awaiting'} />
            )}
          </div>

          {request.servicing !== undefined ? (
            <p className="mt-2 text-sm text-ink-quiet">
              <span className="identifier">{request.servicing.reference}</span>
              {request.servicing.reasonCode !== undefined
                ? ` — ${request.servicing.reasonCode}`
                : ''}
            </p>
          ) : (
            <>
              <p className="mt-2 text-sm text-ink-quiet">
                {arabic
                  ? 'يصل هذا الرد من نظام الخدمة عبر المحوّل. الأزرار هنا للتجربة فقط.'
                  : 'In production this arrives from the servicing platform through the adapter. These buttons stand in for it.'}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <form action={servicingRespondAction} className="contents">
                  <input type="hidden" name="locale" value={segment} />
                  <input type="hidden" name="requestId" value={request.requestId} />
                  <input type="hidden" name="decision" value="APPROVED" />
                  <button className={`${BUTTON} border border-line`} type="submit">
                    Respond: approved
                  </button>
                </form>
                <form action={servicingRespondAction} className="contents">
                  <input type="hidden" name="locale" value={segment} />
                  <input type="hidden" name="requestId" value={request.requestId} />
                  <input type="hidden" name="decision" value="DECLINED" />
                  <input type="hidden" name="reasonCode" value="R_LIMIT_EXCEEDED" />
                  <button className={`${BUTTON} border border-line`} type="submit">
                    Respond: declined
                  </button>
                </form>
              </div>
            </>
          )}
        </Card>
      ) : null}

      {/* -- Stage two: the institution decides ----------------------------- */}
      <Lifecycle request={request} segment={segment} arabic={arabic} />

      <Card muted={!awaitingReview}>
        <h2 className="font-medium">
          {policy.requiresServicingDecision
            ? arabic
              ? '٢ — قرار المؤسسة'
              : '2 — The institution decides'
            : arabic
              ? 'قرار المؤسسة'
              : 'The institution decides'}
        </h2>

        {request.state === 'APPROVED' ? (
          <div className="mt-2">
            <p className="text-sm text-ink-quiet">
              {arabic
                ? 'اعتُمد الطلب. ينشأ عنه معاملة في حالة المسودة — وأمامها البوابات الثلاث كاملة.'
                : 'Approved. This opens a transaction in DRAFT — with all three gates still ahead of it.'}
            </p>
            {request.contraryJustification !== undefined ? (
              <p className="mt-3 rounded-card border border-attention/40 p-3 text-sm">
                {arabic ? 'اعتُمد خلافًا لرأي نظام الخدمة: ' : 'Approved against the servicing decline: '}
                {request.contraryJustification}
              </p>
            ) : null}
          </div>
        ) : null}

        {request.state === 'RETURNED_TO_MAKER' ? (
          <p className="mt-2 text-sm text-ink-quiet">
            {arabic ? 'أُعيد إلى المُدخِل: ' : 'Returned to maker: '}
            {request.note}
          </p>
        ) : null}

        {request.state === 'REJECTED' ? (
          <p className="mt-2 text-sm text-ink-quiet">
            {arabic ? 'مرفوض: ' : 'Rejected: '}
            <span className="identifier">{request.reasonCode}</span>
          </p>
        ) : null}

        {awaitingReview ? (
          <div className="mt-3 flex flex-col gap-4">
            <p className={`rounded-card px-3 py-2 text-xs ${mayApprove ? 'bg-sunken text-ink-quiet' : 'bg-blocked-wash text-blocked'}`}>
              {arabic ? 'صلاحية الاعتماد المطلوبة: ' : 'Approval authority required: '}
              <span className="identifier">{required}</span>
              {' · '}
              {arabic ? 'تحمل: ' : 'you hold: '}
              <span className="identifier">{held}</span>
              {mayApprove ? null : (arabic ? ' — يلزم معتمِد أعلى' : ' — a higher approver is needed')}
            </p>
            <form action={approveAction} className="flex flex-col gap-2">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="requestId" value={request.requestId} />
              {servicingDeclined ? (
                <div>
                  <label className="block text-sm font-medium" htmlFor="justification">
                    {arabic
                      ? 'مبرر الاعتماد خلافًا لرأي نظام الخدمة'
                      : 'Justification for approving against the decline'}
                  </label>
                  <input id="justification" name="justification" className={INPUT} required />
                </div>
              ) : null}
              <button
                className={`${BUTTON} bg-brand-strong text-on-brand hover:bg-brand-deep`}
                type="submit"
              >
                {arabic ? 'اعتماد' : 'Approve'}
              </button>
            </form>

            <form action={returnAction} className="flex flex-col gap-2">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="requestId" value={request.requestId} />
              <label className="block text-sm font-medium" htmlFor="note">
                {arabic ? 'إعادة إلى المُدخِل — ما الذي يحتاج تعديلًا؟' : 'Return to maker — what needs changing?'}
              </label>
              <input id="note" name="note" className={INPUT} />
              <button className={`${BUTTON} border border-line`} type="submit">
                {arabic ? 'إعادة' : 'Return'}
              </button>
            </form>

            <form action={rejectAction} className="flex flex-col gap-2">
              <input type="hidden" name="locale" value={segment} />
              <input type="hidden" name="requestId" value={request.requestId} />
              <label className="block text-sm font-medium" htmlFor="reasonCode">
                {arabic ? 'رفض — رمز السبب' : 'Reject — reason code'}
              </label>
              <input id="reasonCode" name="reasonCode" className={INPUT} placeholder="R_..." />
              <button className={`${BUTTON} border border-blocked/40 text-blocked`} type="submit">
                {arabic ? 'رفض' : 'Reject'}
              </button>
            </form>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
