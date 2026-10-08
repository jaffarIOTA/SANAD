/**
 * One request, to the Figma Setting frame (applied 2026-09-28): a single
 * white card with a tab strip, two columns of labelled fields, the decision
 * as a form with the kit's inputs and a filled primary button.
 *
 * Nothing about what the screen *decides* changed: four eyes, approval
 * tiers, the servicing stage before the institution's stage, the lifecycle
 * controls — all as before, all refused by the domain regardless of what
 * the screen shows.
 */

import { notFound } from 'next/navigation';

import { CHANNEL_POLICIES } from '@sanad/core/origination/channel.ts';
import { authorityCovers, requiredAuthority } from '@sanad/core/origination/policy.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { defaultNumerals, formatMinorUnits } from '@sanad/design/Money.tsx';
import {
  BUTTON_DANGER,
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Card,
  ControlRejection,
  FIELD_INPUT,
  FIELD_LABEL,
  PILL_QUIET,
  Status,
  Tabs,
} from '@sanad/design/primitives.tsx';
import { localeFromSegment } from '@sanad/i18n/strings.ts';

import { approveAction, rejectAction, returnAction, servicingRespondAction } from '../../../../server/actions.ts';
import { canReview, pageStaff } from '../../../../server/session.ts';
import { requestPrincipal } from '../../../../server/staff.ts';
import { Gate, authorityRefusal } from '../../Gate.tsx';
import { findRequest, originationPolicy } from '../../../../server/store.ts';
import { Lifecycle } from './Lifecycle.tsx';

/** A read-only fact, drawn like the kit's input so the page reads as one form. */
function Field({
  label,
  children,
  mono = false,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div>
      <span className={FIELD_LABEL}>{label}</span>
      <div className={`${FIELD_INPUT} flex items-center ${mono ? 'identifier' : ''}`}>{children}</div>
    </div>
  );
}

export default async function ReviewPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly locale: string; readonly requestId: string }>;
  readonly searchParams: Promise<{
    readonly control?: string;
    readonly message?: string;
    readonly tab?: string;
    readonly reason?: string;
    readonly needs?: string;
  }>;
}) {
  const { locale: segment, requestId } = await params;
  const { control, message, tab, reason, needs } = await searchParams;
  const locale = localeFromSegment(segment);
  if (locale === undefined) notFound();
  // Another institution's request is not found, not forbidden: its existence is not disclosed (SEC-TM08, SEC-TM12).
  const signedIn = await pageStaff(segment);
  const request = findRequest(requestId);
  if (request === undefined || request.tenantId !== signedIn.tenantId) notFound();
  const arabic = locale === 'ar-SA';
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const numerals = defaultNumerals(locale);
  const policy = CHANNEL_POLICIES[request.channel];
  const awaitingServicing = request.state === 'AWAITING_SERVICING_RESPONSE';
  const awaitingReview = request.state === 'AWAITING_REVIEW';
  const servicingDeclined = request.servicing?.decision === 'DECLINED';
  const required = requiredAuthority(originationPolicy(), money(request.amountMinorUnits));
  // The signed-in person: their approval tier decides which requests they may approve; their id, whether it is their own work.
  const staff = signedIn;
  const reviewer = requestPrincipal(staff);
  const held = reviewer.authority;
  const ownWork = !canReview(reviewer, request.makerPrincipalId).allowed;
  const mayApprove = held !== undefined && authorityCovers(held, required) && !ownWork;
  const current = tab === 'lifecycle' || tab === 'decision' || tab === 'servicing' ? tab : 'request';
  const base = `/${segment}/requests/${request.requestId}`;
  const tabs = [
    { id: 'request', label: t('Request', 'الطلب'), href: `${base}?tab=request` },
    ...(policy.requiresServicingDecision
      ? [{ id: 'servicing', label: t('Servicing platform', 'نظام الخدمة'), href: `${base}?tab=servicing` }]
      : []),
    { id: 'decision', label: t('Decision', 'القرار'), href: `${base}?tab=decision` },
    { id: 'lifecycle', label: t('Lifecycle & documents', 'مسار الطلب والمستندات'), href: `${base}?tab=lifecycle` },
  ];

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <a href={`/${segment}/queue`} className={PILL_QUIET}>
            {t('Back to the queue', 'رجوع إلى القائمة')}
          </a>
          <h2 className="text-h2 font-semibold text-heading">
            <span className="identifier">{request.requestId}</span>
          </h2>
          <Status
            tone={request.state === 'APPROVED' ? 'settled' : request.state === 'REJECTED' ? 'blocked' : 'progress'}
            label={request.state.replaceAll('_', ' ').toLowerCase()}
          />
        </div>
      </div>
      {control !== undefined ? (
        <ControlRejection
          control={control}
          explanation={authorityRefusal(reason, needs, arabic) ?? message ?? ''}
          controlLabel={t('Control', 'الضابط')}
        />
      ) : null}

      <div className="rounded-card bg-surface px-[30px] pb-[30px] pt-6">
        <Tabs ariaLabel={t('Request sections', 'أقسام الطلب')} current={current} items={tabs} />

        {current === 'request' ? (
          <div className="mt-8 grid gap-x-8 gap-y-6 md:grid-cols-[132px_1fr_1fr]">
            <div className="hidden md:block">
              <span
                aria-hidden
                className="inline-flex size-[130px] items-center justify-center rounded-full bg-brand-wash text-[28px] font-semibold text-brand-deep"
              >
                {request.counterpartyId.slice(0, 1)}
              </span>
            </div>
            <Field label={t('Counterparty', 'العميل')}>{request.counterpartyId}</Field>
            <Field label={t('Invoice', 'الفاتورة')} mono>
              {request.invoiceNumber}
            </Field>
            <div className="hidden md:block" />
            <Field label={t('Amount', 'المبلغ')}>
              <bdi className="font-semibold tabular-nums">
                {formatMinorUnits({ minorUnits: request.amountMinorUnits, currency: 'SAR' }, numerals)}
              </bdi>
              <span className="ms-2 text-xs text-ink-quiet">SAR</span>
            </Field>
            <Field label={t('Channel', 'القناة')}>{request.channel.replaceAll('_', ' ').toLowerCase()}</Field>
            <div className="hidden md:block" />
            <Field label={t('Keyed by', 'أدخله')} mono>
              {request.makerPrincipalId ?? '—'}
            </Field>
            <Field label={t('Four eyes', 'مراجعة من شخصين')}>
              {policy.requiresFourEyes ? t('Required', 'مطلوبة') : '—'}
            </Field>
            <div className="hidden md:block" />
            <Field label={t('Approval authority required', 'صلاحية الاعتماد المطلوبة')} mono>
              {required}
            </Field>
            <Field label={t('State', 'الحالة')} mono>
              {request.state}
            </Field>
          </div>
        ) : null}

        {current === 'servicing' && policy.requiresServicingDecision ? (
          <div className="mt-8 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-[16px] font-medium text-ink">
                {t('1 — Servicing platform response', '١ — رد نظام الخدمة')}
              </h3>
              {request.servicing !== undefined ? (
                <Status
                  tone={request.servicing.decision === 'APPROVED' ? 'settled' : 'blocked'}
                  label={request.servicing.decision.toLowerCase()}
                />
              ) : (
                <Status tone="progress" label={t('awaiting', 'بانتظار الرد')} />
              )}
            </div>
            {request.servicing !== undefined ? (
              <div className="grid gap-6 md:grid-cols-2">
                <Field label={t('Reference', 'المرجع')} mono>
                  {request.servicing.reference}
                </Field>
                <Field label={t('Reason code', 'رمز السبب')} mono>
                  {request.servicing.reasonCode ?? '—'}
                </Field>
              </div>
            ) : (
              <>
                <p className="text-[15px] text-ink-quiet">
                  {t(
                    'In production this arrives from the servicing platform through the adapter. These buttons stand in for it.',
                    'يصل هذا الرد من نظام الخدمة عبر المحوّل. الأزرار هنا للتجربة فقط.',
                  )}
                </p>
                <Gate staff={staff} act="SERVICING_STAND_IN" arabic={arabic}>
                  <div className="flex flex-wrap gap-3">
                    <form action={servicingRespondAction} className="contents">
                      <input type="hidden" name="locale" value={segment} />
                      <input type="hidden" name="requestId" value={request.requestId} />
                      <input type="hidden" name="decision" value="APPROVED" />
                      <button className={BUTTON_SECONDARY} type="submit">
                        Respond: approved
                      </button>
                    </form>
                    <form action={servicingRespondAction} className="contents">
                      <input type="hidden" name="locale" value={segment} />
                      <input type="hidden" name="requestId" value={request.requestId} />
                      <input type="hidden" name="decision" value="DECLINED" />
                      <input type="hidden" name="reasonCode" value="R_LIMIT_EXCEEDED" />
                      <button className={BUTTON_SECONDARY} type="submit">
                        Respond: declined
                      </button>
                    </form>
                  </div>
                </Gate>
              </>
            )}
            {awaitingServicing ? null : (
              <p className="text-xs text-ink-quiet">{t('This stage is complete.', 'اكتملت هذه المرحلة.')}</p>
            )}
          </div>
        ) : null}

        {current === 'decision' ? (
          <div className="mt-8 flex flex-col gap-6">
            <h3 className="text-[16px] font-medium text-ink">
              {policy.requiresServicingDecision
                ? t('2 — The institution decides', '٢ — قرار المؤسسة')
                : t('The institution decides', 'قرار المؤسسة')}
            </h3>
            {request.state === 'APPROVED' ? (
              <div className="grid gap-6 md:grid-cols-2">
                <Field label={t('Outcome', 'النتيجة')}>
                  {t(
                    'Approved — a transaction opens in DRAFT with all three gates ahead of it.',
                    'اعتُمد — تنشأ معاملة في حالة المسودة وأمامها البوابات الثلاث.',
                  )}
                </Field>
                {request.contraryJustification !== undefined ? (
                  <Field label={t('Approved against the servicing decline', 'اعتُمد خلافًا لرأي نظام الخدمة')}>
                    {request.contraryJustification}
                  </Field>
                ) : null}
              </div>
            ) : null}
            {request.state === 'RETURNED_TO_MAKER' ? (
              <Field label={t('Returned to maker', 'أُعيد إلى المُدخِل')}>{request.note}</Field>
            ) : null}
            {request.state === 'REJECTED' ? (
              <Field label={t('Rejected — reason code', 'مرفوض — رمز السبب')} mono>
                {request.reasonCode}
              </Field>
            ) : null}
            {awaitingReview ? (
              <>
                <p
                  className={`rounded-tile px-4 py-3 text-[15px] ${mayApprove ? 'bg-sunken text-ink-quiet' : 'bg-blocked-wash text-blocked'}`}
                >
                  {t('Approval authority required: ', 'صلاحية الاعتماد المطلوبة: ')}
                  <span className="identifier">{required}</span>
                  {' · '}
                  {t('you hold: ', 'تحمل: ')}
                  <span className="identifier">{held ?? '—'}</span>
                  {ownWork
                    ? t(' — this is your own work; another person decides it', ' — هذا من عملك؛ يبتّ فيه شخص آخر')
                    : mayApprove
                      ? null
                      : t(' — a higher approver is needed', ' — يلزم معتمِد أعلى')}
                </p>
                <Gate staff={staff} act="REVIEW" arabic={arabic}>
                  <div className="grid gap-8 md:grid-cols-2">
                    <form action={approveAction} className="flex flex-col gap-4">
                      <input type="hidden" name="locale" value={segment} />
                      <input type="hidden" name="requestId" value={request.requestId} />
                      {servicingDeclined ? (
                        <div>
                          <label className={FIELD_LABEL} htmlFor="justification">
                            {t(
                              'Justification for approving against the decline',
                              'مبرر الاعتماد خلافًا لرأي نظام الخدمة',
                            )}
                          </label>
                          <input id="justification" name="justification" className={FIELD_INPUT} required />
                        </div>
                      ) : (
                        <p className="text-[15px] text-ink-quiet">
                          {t(
                            'Approving opens the transaction at the start of its sequence. Nothing later.',
                            'الاعتماد يفتح المعاملة في بداية تسلسلها. لا شيء بعد ذلك.',
                          )}
                        </p>
                      )}
                      <button className={BUTTON_PRIMARY} type="submit">
                        {t('Approve', 'اعتماد')}
                      </button>
                    </form>
                    <div className="flex flex-col gap-6">
                      <form action={returnAction} className="flex flex-col gap-4">
                        <input type="hidden" name="locale" value={segment} />
                        <input type="hidden" name="requestId" value={request.requestId} />
                        <div>
                          <label className={FIELD_LABEL} htmlFor="note">
                            {t('Return to maker — what needs changing?', 'إعادة إلى المُدخِل — ما الذي يحتاج تعديلًا؟')}
                          </label>
                          <input id="note" name="note" className={FIELD_INPUT} />
                        </div>
                        <button className={BUTTON_SECONDARY} type="submit">
                          {t('Return', 'إعادة')}
                        </button>
                      </form>
                      <form action={rejectAction} className="flex flex-col gap-4">
                        <input type="hidden" name="locale" value={segment} />
                        <input type="hidden" name="requestId" value={request.requestId} />
                        <div>
                          <label className={FIELD_LABEL} htmlFor="reasonCode">
                            {t('Reject — reason code', 'رفض — رمز السبب')}
                          </label>
                          <input
                            id="reasonCode"
                            name="reasonCode"
                            className={`${FIELD_INPUT} identifier`}
                            placeholder="R_..."
                          />
                        </div>
                        <button className={BUTTON_DANGER} type="submit">
                          {t('Reject', 'رفض')}
                        </button>
                      </form>
                    </div>
                  </div>
                </Gate>
              </>
            ) : null}
          </div>
        ) : null}

        {current === 'lifecycle' ? (
          <div className="mt-8 flex flex-col gap-5">
            <Lifecycle request={request} segment={segment} arabic={arabic} staff={staff} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
