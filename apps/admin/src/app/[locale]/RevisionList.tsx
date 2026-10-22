/**
 * A configuration area's revisions with their status, and for one still
 * proposed, the decision: approve, or reject with a reason. Drawn disabled for
 * the administrator who proposed it; the database refuses it regardless
 * (config.revision_four_eyes).
 */
import type { ReactElement } from 'react';

import { BUTTON_DANGER, BUTTON_PRIMARY, Card, FIELD_INPUT, Status } from '@sanad/design/primitives.tsx';

import { decideRevisionAction } from '../../server/actions.ts';
import type { RevisionRow } from '../../server/revisions.ts';

const fmt = (iso: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export function RevisionList({
  revisions,
  area,
  segment,
  locale,
  tenantCode,
  principalId,
  arabic,
}: {
  readonly revisions: readonly RevisionRow[];
  /** The screen's area name, as decideRevisionAction reads it. */
  readonly area: string;
  readonly segment: string;
  readonly locale: string;
  readonly tenantCode: string;
  readonly principalId: string;
  readonly arabic: boolean;
}): ReactElement {
  return (
    <Card>
      <h3 className="text-[16px] font-semibold text-heading">{arabic ? 'المراجعات' : 'Revisions'}</h3>
      {revisions.length === 0 ? (
        <p className="mt-3 text-[15px] text-ink-quiet">{arabic ? 'لا مراجعات بعد.' : 'No revisions yet.'}</p>
      ) : (
        <ul className="mt-4 flex list-none flex-col divide-y divide-line p-0">
          {revisions.map((r) => {
            const tone = r.status === 'APPROVED' ? 'settled' : r.status === 'REJECTED' ? 'blocked' : 'progress';
            const decidedWord =
              r.status === 'APPROVED' ? (arabic ? 'اعتمدها' : 'approved by') : arabic ? 'رفضها' : 'rejected by';
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-medium text-heading">{r.summary}</span>
                    <Status tone={tone} label={r.status.toLowerCase()} />
                  </span>
                  <span className="text-[13px] text-ink-quiet">
                    {arabic ? 'نافذة من' : 'effective'} {fmt(r.effectiveFrom, locale)} ·{' '}
                    {arabic ? 'اقترحها' : 'proposed by'} <span className="identifier">{r.proposedBy}</span>
                    {r.decidedBy !== null && r.decidedAt !== null ? (
                      <>
                        {' · '}
                        {decidedWord} <span className="identifier">{r.decidedBy}</span> {fmt(r.decidedAt, locale)}
                        {r.rejectionReason !== null ? ` — ${r.rejectionReason}` : ''}
                      </>
                    ) : null}
                  </span>
                </span>
                {r.status === 'PROPOSED' ? (
                  <form action={decideRevisionAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="locale" value={segment} />
                    <input type="hidden" name="tenant" value={tenantCode} />
                    <input type="hidden" name="area" value={area} />
                    <input type="hidden" name="revisionId" value={r.id} />
                    <input
                      name="reason"
                      placeholder={arabic ? 'سبب الرفض' : 'reason, if rejecting'}
                      className={`${FIELD_INPUT} mt-0 h-[38px] w-[220px] text-[14px]`}
                    />
                    <button
                      type="submit"
                      name="decision"
                      value="reject"
                      disabled={r.proposedBy === principalId}
                      className={`${BUTTON_DANGER} h-[38px] px-4 text-[14px] disabled:opacity-40`}
                    >
                      {arabic ? 'رفض' : 'Reject'}
                    </button>
                    <button
                      type="submit"
                      name="decision"
                      value="approve"
                      disabled={r.proposedBy === principalId}
                      className={`${BUTTON_PRIMARY} h-[38px] min-w-0 px-4 text-[14px] disabled:opacity-40`}
                    >
                      {arabic ? 'اعتماد' : 'Approve'}
                    </button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
