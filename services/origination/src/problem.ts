/**
 * RFC 9457 problem details, bilingual.
 *
 * Two rules the rest of the service relies on.
 *
 * **Every problem carries Arabic.** Not as a localisation feature — as a
 * product requirement. A refusal that exists only in English cannot be shown
 * to a counterparty, and a compliance rejection that cannot be shown is a
 * generic decline by another route (§6, §8).
 *
 * **Nothing here interpolates input.** A problem body is logged, forwarded,
 * and rendered on screens. A national identifier, a credential or a CR-linked
 * personal datum reaching one of these is a §10 violation, so the context is
 * built from fixed keys rather than from whatever the caller sent.
 */

import type { ControlCode, Rejection } from '@sanad/core/kernel/result.ts';

const BASE = 'https://sanad.example/problems';

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly detailAr: string;
  readonly correlationId: string;
  readonly instance?: string;
  readonly control?: ControlCode;
  readonly reason?: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Arabic for the refusals the domain can produce.
 *
 * Keyed by the machine reason, so a new refusal in the domain shows up here as
 * a missing key rather than as an English string leaking to an Arabic reader —
 * `test/contract/service.test.ts` asserts the catalogue covers every reason the
 * origination domain can return.
 */
const ARABIC: Readonly<Record<string, string>> = {
  // Determinacy and identification
  IDENTIFICATION_NOT_ACCEPTABLE_FOR_CHANNEL:
    'لم يُعرَّف مُقدِّم الطلب بطريقة تقبلها هذه القناة.',
  MERCHANT_MANDATE_MISSING: 'تتطلب هذه القناة تفويضاً من الطرف الذي سيتحمل الالتزام.',
  MERCHANT_MANDATE_EMPTY:
    'يجوز للوسيط تعريف التاجر، ولا يجوز له الموافقة نيابة عنه.',
  PRINCIPAL_TENANT_MISMATCH: 'لا يجوز لمستخدم أن يتصرف في مؤسسة أخرى.',
  REQUESTED_AMOUNT_NOT_POSITIVE: 'يجب أن يحدد الطلب مبلغاً موجباً.',
  TENOR_NOT_DETERMINATE: 'يجب أن يحدد الطلب مدةً معلومة.',
  SERVICING_REFERENCE_MISSING: 'يجب أن يحمل رد نظام الخدمة مرجعه الخاص للمطابقة.',
  SERVICING_REASON_MISSING: 'يجب أن يوضح الرفض أو الإحالة سببه.',
  SERVICING_RESPONSE_NOT_RECEIVED: 'لم يُسجَّل بعد رد نظام الخدمة لهذه القناة.',
  FOUR_EYES_VIOLATED: 'لا يجوز لمن أدخل الطلب أن يعتمده.',
  CONTRARY_APPROVAL_UNJUSTIFIED: 'الاعتماد خلافاً لرد نظام الخدمة يتطلب تسبيباً مسجَّلاً.',
  CONTRARY_JUSTIFICATION_NOT_APPLICABLE: 'قُدِّم تسبيب دون أن يرفض نظام الخدمة الطلب.',
  RETURN_WITHOUT_REASON: 'إعادة الطلب إلى مُدخِله تتطلب بيان ما يلزم تعديله.',
  REJECTION_WITHOUT_REASON_CODE: 'يجب أن يحمل الرفض رمز سبب من الكتالوج.',
  TENANT_MISMATCH: 'يجب أن تنتمي المعاملة والطلب إلى مؤسسة واحدة.',
  COUNTERPARTY_MISMATCH: 'يجب أن تكون المعاملة للعميل الذي حدده الطلب.',
  TRADE_REFERENCE_SUBSTITUTED: 'الصفقة المرتبطة بالمعاملة ليست الصفقة المعتمدة.',
  REQUEST_NOT_IN_EXPECTED_STATE: 'حالة هذا الطلب تغيّرت منذ تحميل الصفحة.',

  // Transport-level refusals raised by this service
  MALFORMED_JSON: 'تعذّرت قراءة محتوى الطلب كبيانات JSON صحيحة.',
  UNKNOWN_PROPERTY:
    'حقل غير معروف. يُعبَّر عن العائد بمبلغ ربح يُضاف إلى تكلفة مُفصح عنها، لا بنسبة.',
  SCHEMA_VALIDATION_FAILED: 'محتوى الطلب لا يطابق العقد المنشور.',
  IDEMPOTENCY_KEY_MISSING: 'يتطلب كل طلب مُغيِّر للحالة ترويسة Idempotency-Key.',
  IDEMPOTENCY_KEY_REUSED: 'استُخدم هذا المفتاح سابقاً بمحتوى مختلف.',
  IDEMPOTENCY_KEY_IN_FLIGHT: 'ما زال طلب بهذا المفتاح قيد المعالجة.',
  CREDENTIAL_MISSING: 'لم تُقدَّم بيانات اعتماد صالحة.',
  CREDENTIAL_NOT_RECOGNISED: 'بيانات الاعتماد غير معروفة.',
  SCOPE_INSUFFICIENT: 'لا تمنح بيانات الاعتماد الصلاحية اللازمة لهذا الإجراء.',
  REQUEST_NOT_FOUND: 'لا يوجد طلب بهذا المعرّف ضمن نطاقك.',
  ROUTE_NOT_FOUND: 'لا يوجد مسار بهذا العنوان.',
  METHOD_NOT_ALLOWED: 'هذه الطريقة غير مسموح بها على هذا المسار.',
  NOT_WITHDRAWABLE: 'لا يمكن سحب طلب تم البت فيه.',
  PAYLOAD_TOO_LARGE: 'حجم محتوى الطلب يتجاوز الحد المسموح.',
  INTERNAL: 'حدث خطأ غير متوقع. يُرجى ذكر معرّف الارتباط.',
};

/** Arabic for a reason we have not written wording for yet. */
function arabicFor(reason: string, control: ControlCode | undefined): string {
  const known = ARABIC[reason];
  if (known !== undefined) return known;
  // Still names the control, so the reader is never given a bare decline.
  return control === undefined
    ? 'تعذّر إتمام الطلب.'
    : `رُفض الطلب بموجب الضابط ${control}.`;
}

export function problem(params: {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly correlationId: string;
  readonly reason: string;
  readonly control?: ControlCode;
  readonly instance?: string;
  readonly context?: Readonly<Record<string, string | number | boolean>>;
  readonly kind?: 'malformed-request' | 'control-rejection' | 'conflict' | 'error';
}): Problem {
  const kind = params.kind ?? 'error';
  return {
    type: `${BASE}/${kind}`,
    title: params.title,
    status: params.status,
    detail: params.detail,
    detailAr: arabicFor(params.reason, params.control),
    correlationId: params.correlationId,
    reason: params.reason,
    ...(params.control === undefined ? {} : { control: params.control }),
    ...(params.instance === undefined ? {} : { instance: params.instance }),
    ...(params.context === undefined ? {} : { context: params.context }),
  };
}

/**
 * A domain refusal, as a problem.
 *
 * `422`, not `400`: the body was understood and a control refused it, so
 * retrying it unchanged will be refused again. The control code travels
 * intact, because it is what the counterparty surface renders into a specific
 * explanation and what the Board's audit workspace indexes on.
 */
export function fromRejection(
  rejection: Rejection,
  correlationId: string,
  instance?: string,
): Problem {
  return problem({
    status: 422,
    kind: 'control-rejection',
    title: rejection.control.startsWith('SH-') ? 'Refused by a Shariah control' : 'Refused',
    detail: rejection.detail,
    reason: rejection.reason,
    control: rejection.control,
    correlationId,
    ...(instance === undefined ? {} : { instance }),
    // The domain's own context is structured and carries no personal data by
    // construction — see `Rejection` in core/kernel/result.ts.
    ...(rejection.context === undefined ? {} : { context: rejection.context }),
  });
}

/** Reasons this service can raise itself, with their English wording. */
export const REASONS = ARABIC;
