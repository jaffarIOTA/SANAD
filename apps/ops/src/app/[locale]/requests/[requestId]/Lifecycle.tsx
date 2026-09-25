/**
 * The parts of a request's life the BRD asked for and the review card does
 * not cover: information requested from outside, the servicing attempt
 * ledger with controlled retry, the correction of a returned request with its
 * diff, and the document checklist.
 *
 * A server component. Every control is a plain form and a redirect.
 */

import type { ReactElement } from 'react';

import { Card, Status } from '@sanad/design/primitives.tsx';

import {
  attachDocumentAction,
  failServicingAction,
  provideInformationAction,
  requestInformationAction,
  retryServicingAction,
  reviseAction,
} from '../../../../server/actions.ts';
import { checklistFor, originationPolicy, type RequestRow } from '../../../../server/store.ts';

const INPUT = 'mt-1 block w-full min-h-tap rounded-card border border-line bg-surface px-3 text-base text-ink';
const BUTTON = 'inline-flex min-h-tap items-center rounded-card border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-sunken';
const LABEL = 'block text-sm font-medium text-ink';

export function Lifecycle({ request, segment, arabic }: { readonly request: RequestRow; readonly segment: string; readonly arabic: boolean }): ReactElement {
  const t = (en: string, ar: string): string => (arabic ? ar : en);
  const policy = originationPolicy();
  const hidden = (
    <>
      <input type="hidden" name="locale" value={segment} />
      <input type="hidden" name="requestId" value={request.requestId} />
    </>
  );
  const checklist = checklistFor(request);

  return (
    <>
      {request.changes !== undefined ? (
        <Card>
          <h2 className="text-sm font-medium text-ink">{t('Changed since it was returned', 'ما تغيّر منذ الإعادة')}</h2>
          <p className="mt-1 text-xs text-ink-quiet">{t('Returned with: ', 'أُعيد بملاحظة: ')}<span className="text-ink">{request.changes.returnedNote}</span></p>
          <ul className="mt-2 flex list-none flex-wrap gap-2 p-0">
            {request.changes.fields.length === 0 ? <li className="text-sm text-ink-quiet">{t('Nothing changed — resubmitted as it was.', 'لم يتغيّر شيء — أُعيد كما هو.')}</li> : null}
            {request.changes.fields.map((f) => <li key={f}><Status tone={request.changes?.material ? 'blocked' : 'progress'} label={f} /></li>)}
          </ul>
          <p className="mt-2 text-xs text-ink-quiet">
            {request.changes.material
              ? t('A material field changed: validation was re-run and any earlier servicing answer was discarded.', 'تغيّر حقل جوهري: أُعيد التحقق وأُلغي أي رد سابق من نظام الخدمة.')
              : t('No material field changed; the earlier checks stand.', 'لم يتغيّر حقل جوهري؛ الفحوص السابقة قائمة.')}
          </p>
        </Card>
      ) : null}

      {request.state === 'RETURNED_TO_MAKER' ? (
        <Card>
          <h2 className="text-sm font-medium text-ink">{t('Correct and resubmit', 'تصحيح وإعادة إرسال')}</h2>
          <p className="mt-1 text-xs text-ink-quiet">
            {t('The request keeps its identifier. What you change is shown to the checker beside the request.', 'يحتفظ الطلب بمعرّفه. وما تغيّره يظهر للمراجع إلى جانب الطلب.')}
            {' '}{t('Material fields for this institution:', 'الحقول الجوهرية لهذه المؤسسة:')} <span className="identifier">{policy.revalidateOn.join(', ')}</span>
          </p>
          <form action={reviseAction} className="mt-3 flex flex-col gap-3">
            {hidden}
            <label className={LABEL}>{t('Programme', 'البرنامج')}
              <select name="programmeId" className={INPUT} defaultValue="">
                <option value="">{t('(unchanged)', '(بدون تغيير)')}</option>
                <option value="prg-0001">Wasl — distributor finance</option>
                <option value="prg-0002">Wasl — anchor supplier finance</option>
              </select>
            </label>
            <label className={LABEL}>{t('Tenor, in days', 'المدة بالأيام')}
              <input name="tenorDays" type="number" min={1} max={365} className={INPUT} placeholder={t('(unchanged)', '(بدون تغيير)')} />
            </label>
            <button type="submit" className={BUTTON}>{t('Resubmit for review', 'إعادة الإرسال للمراجعة')}</button>
          </form>
        </Card>
      ) : null}

      {request.state === 'AWAITING_REVIEW' ? (
        <Card>
          <h2 className="text-sm font-medium text-ink">{t('Need something before deciding?', 'تحتاج شيئاً قبل القرار؟')}</h2>
          <form action={requestInformationAction} className="mt-3 flex flex-col gap-3">
            {hidden}
            <label className={LABEL}>{t('From', 'من')}
              <select name="from" className={INPUT} defaultValue="COUNTERPARTY">
                <option value="COUNTERPARTY">{t('the counterparty', 'العميل')}</option>
                <option value="PARTNER">{t('the partner', 'الشريك')}</option>
                <option value="DOCUMENTS">{t('documents', 'مستندات')}</option>
              </select>
            </label>
            <label className={LABEL}>{t('What, one per line', 'ماذا، عنصر في كل سطر')}
              <textarea name="items" rows={3} className={INPUT} required />
            </label>
            <button type="submit" className={BUTTON}>{t('Request information', 'طلب معلومات')}</button>
          </form>
        </Card>
      ) : null}

      {request.state === 'PENDING_INFORMATION' && request.pending !== undefined ? (
        <Card>
          <h2 className="text-sm font-medium text-ink">{t('Waiting on ', 'بانتظار ')}<span className="identifier">{request.pending.from.toLowerCase()}</span></h2>
          <ul className="mt-2 list-disc ps-5 text-sm text-ink">{request.pending.items.map((i) => <li key={i}>{i}</li>)}</ul>
          <form action={provideInformationAction} className="mt-3">
            {hidden}
            <button type="submit" className={BUTTON}>{t('Information received — back to review', 'وصلت المعلومات — عودة للمراجعة')}</button>
          </form>
        </Card>
      ) : null}

      {request.attempts !== undefined && request.attempts.length > 0 ? (
        <Card muted={request.state !== 'SERVICING_UNAVAILABLE'}>
          <h2 className="text-sm font-medium text-ink">{t('Servicing platform — attempt ledger', 'نظام الخدمة — سجل المحاولات')}</h2>
          <table className="mt-2 w-full text-sm">
            <tbody>
              {request.attempts.map((a, i) => (
                <tr key={i} className="border-b border-line last:border-b-0">
                  <td className="py-1 pe-3 text-ink-quiet tabular-nums">{i + 1}</td>
                  <td className="py-1 pe-3">{a.reason}</td>
                  <td className="py-1 text-xs text-ink-quiet">{a.manualBy !== undefined ? `${t('manual · ', 'يدوي · ')}${a.manualBy}: ${a.manualNote ?? ''}` : t('automatic', 'تلقائي')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {request.state === 'SERVICING_UNAVAILABLE' ? (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <form action={retryServicingAction}>{hidden}<input type="hidden" name="mode" value="auto" />
                <button type="submit" className={BUTTON}>{t('Retry (automatic)', 'إعادة المحاولة (تلقائي)')}</button>
              </form>
              <form action={retryServicingAction} className="flex items-end gap-2">{hidden}<input type="hidden" name="mode" value="manual" />
                <label className={LABEL}>{t('Manual resubmission — why', 'إعادة إرسال يدوية — السبب')}<input name="note" className={INPUT} required /></label>
                <button type="submit" className={BUTTON}>{t('Resubmit', 'إعادة الإرسال')}</button>
              </form>
              <p className="basis-full text-xs text-ink-quiet">{t(`Automatic retries: up to ${String(policy.servicingRetry.maxAttempts)}, ${String(policy.servicingRetry.backoffSeconds)}s apart. Beyond that a named person resubmits with a note, which is recorded.`, `المحاولات التلقائية: حتى ${String(policy.servicingRetry.maxAttempts)}، بفاصل ${String(policy.servicingRetry.backoffSeconds)} ثانية. بعدها يعيد الإرسال شخص مسمّى مع ملاحظة تُسجَّل.`)}</p>
            </div>
          ) : null}
        </Card>
      ) : null}

      {request.state === 'AWAITING_SERVICING_RESPONSE' ? (
        <form action={failServicingAction} className="text-end">
          {hidden}
          <button type="submit" className="text-xs text-ink-quiet underline">{t('dev: simulate the platform being unreachable', 'تطوير: محاكاة تعذّر الوصول إلى النظام')}</button>
        </form>
      ) : null}

      {checklist !== undefined ? (
        <Card>
          <h2 className="text-sm font-medium text-ink">{t('Documents', 'المستندات')} <span className="text-xs text-ink-quiet">· {checklist.checklist.programmeId} v{checklist.checklist.version}</span></h2>
          <ul className="mt-2 flex list-none flex-col gap-1 p-0">
            {checklist.report.map((r) => (
              <li key={r.item.documentType} className="flex flex-wrap items-center justify-between gap-2 rounded-card bg-sunken px-3 py-2 text-sm">
                <span className="flex flex-col">
                  <span>{arabic ? r.item.titleAr : r.item.titleEn}{r.item.required ? '' : <span className="ms-2 text-xs text-ink-quiet">{t('optional', 'اختياري')}</span>}</span>
                  <span className="identifier text-xs text-ink-quiet">{r.item.documentType}</span>
                </span>
                <span className="flex items-center gap-2">
                  <Status tone={r.status === 'PRESENT' ? 'settled' : r.status === 'MISSING' || r.status === 'EXPIRED' || r.status === 'INVALID' ? 'blocked' : 'progress'} label={r.status.toLowerCase()} />
                  {r.status !== 'PRESENT' ? (
                    <form action={attachDocumentAction}>{hidden}<input type="hidden" name="documentType" value={r.item.documentType} />
                      <button type="submit" className="text-xs text-ink-quiet underline">{t('dev: mark received', 'تطوير: تم الاستلام')}</button>
                    </form>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
