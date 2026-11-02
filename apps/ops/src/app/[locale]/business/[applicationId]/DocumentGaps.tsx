/**
 * What the application still needs from the applicant (document intelligence
 * D4), in the words the request will carry, both languages: and the officer's
 * one act on it — ask for them — with where the last request stands.
 */
import type { ReactElement } from 'react';

import { type DocumentGap, gapMessage } from '@sanad/core/documents/gaps.ts';

import { requestDocumentsAction } from '../../../../server/business-actions.ts';
import type { DocumentRequestState } from '../../../../server/business.ts';
import type { StaffPrincipal } from '../../../../server/staff.ts';
import { Gate } from '../../Gate.tsx';
import { BTN_SMALL, Chip, FormContext, type Formatters } from '../ui.tsx';

export function DocumentGaps({
  segment,
  applicationId,
  gaps,
  request,
  open,
  staff,
  f,
}: {
  readonly segment: string;
  readonly applicationId: string;
  readonly gaps: readonly DocumentGap[];
  readonly request: DocumentRequestState | undefined;
  readonly open: boolean;
  readonly staff: StaffPrincipal;
  readonly f: Formatters;
}): ReactElement | null {
  const { t } = f;
  if (gaps.length === 0 && request === undefined) return null;
  return (
    <div className="flex flex-col gap-2 rounded-tile border border-line bg-sunken/40 p-3" data-document-gaps>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-heading">
          {gaps.length === 0
            ? t('Nothing more is needed from the applicant', 'لا يلزم شيء آخر من مقدم الطلب')
            : t(
                `Still needed from the applicant: ${f.n(gaps.length)}`,
                `ما زال مطلوبًا من مقدم الطلب: ${f.n(gaps.length)}`,
              )}
        </span>
        {request === undefined ? null : request.status === 'AWAITING' ? (
          <Chip tone="warn">
            {t('Requested', 'طُلبت')} <bdi>{f.epochDate(request.requestedAtEpochSeconds)}</bdi> ·{' '}
            {t('awaiting the applicant', 'بانتظار مقدم الطلب')}
          </Chip>
        ) : (
          <Chip tone="good">{t('Documents received — ready', 'وصلت المستندات — جاهز')}</Chip>
        )}
      </div>
      {gaps.length === 0 ? null : (
        <ul className="flex list-disc flex-col gap-1 ps-5 text-[13px] text-ink">
          {gaps.map((g) => {
            const m = gapMessage(g);
            return (
              <li key={g.documentType} data-gap={g.kind}>
                {t(m.en, m.ar)}
              </li>
            );
          })}
        </ul>
      )}
      {open && gaps.length > 0 ? (
        <Gate staff={staff} act="BUSINESS_OFFICER" arabic={f.arabic}>
          <form action={requestDocumentsAction} className="flex flex-wrap items-center gap-2" data-request-documents>
            <FormContext segment={segment} applicationId={applicationId} />
            <button type="submit" className={BTN_SMALL}>
              {request?.status === 'AWAITING'
                ? t('Send the request again with this list', 'أعد إرسال الطلب بهذه القائمة')
                : t('Request these documents', 'اطلب هذه المستندات')}
            </button>
            <span className="text-[11px] text-ink-quiet">
              {t(
                'One message to the applicant’s contact, by email and SMS where on record. The same list is sent once.',
                'رسالة واحدة إلى جهة اتصال مقدم الطلب، بالبريد والرسائل النصية حيثما سُجّلت. القائمة نفسها تُرسل مرة واحدة.',
              )}
            </span>
          </form>
        </Gate>
      ) : null}
    </div>
  );
}
