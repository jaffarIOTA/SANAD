/**
 * What a revision screen says after a proposal or a decision: the outcomes
 * every configuration area shares, then the screen's own refusals. A refusal
 * code the screen has no words for is shown as code, never as a generic error.
 */
import type { ReactElement } from 'react';

import { ControlRejection } from '@sanad/design/primitives.tsx';

export type NoticeWords = Readonly<Record<string, { en: string; ar: string; tone: 'settled' | 'blocked' }>>;

const SHARED: NoticeWords = {
  PROPOSED: {
    en: 'Proposed. It takes effect only when a different administrator approves it.',
    ar: 'اقتُرح. لا يسري إلا بعد اعتماد مدير آخر.',
    tone: 'settled',
  },
  APPROVED: {
    en: 'Approved. The platform acts under it from its effective moment.',
    ar: 'اعتُمد. تعمل المنصة به من لحظة نفاذه.',
    tone: 'settled',
  },
  REJECTED: { en: 'Rejected, with the reason recorded.', ar: 'رُفض وسُجّل السبب.', tone: 'settled' },
  NO_DATABASE: {
    en: 'No database is configured; revisions live in the database.',
    ar: 'لا توجد قاعدة بيانات مهيأة.',
    tone: 'blocked',
  },
  PROPOSE_FAILED: { en: 'The database refused the proposal.', ar: 'رفضت قاعدة البيانات الاقتراح.', tone: 'blocked' },
  DECIDE_FAILED: { en: 'The database refused the decision.', ar: 'رفضت قاعدة البيانات القرار.', tone: 'blocked' },
  REJECTION_REASON_REQUIRED: { en: 'A rejection says why.', ar: 'الرفض يحتاج سبباً.', tone: 'blocked' },
  EFFECTIVE_FROM_MALFORMED: { en: 'The effective date is not a date.', ar: 'تاريخ النفاذ غير صالح.', tone: 'blocked' },
  'REFUSED:FOUR_EYES_SELF_DECISION': {
    en: 'Four eyes: you proposed this revision, so you may not decide it.',
    ar: 'أربع أعين: أنت من اقترح هذه المراجعة فلا تقرر فيها.',
    tone: 'blocked',
  },
};

export function RevisionNotice({
  notice,
  words,
  arabic,
}: {
  readonly notice: string | undefined;
  /** The screen's own outcomes and refusals, which take precedence over the shared ones. */
  readonly words?: NoticeWords;
  readonly arabic: boolean;
}): ReactElement | null {
  if (notice === undefined) return null;
  const n =
    words?.[notice] ??
    SHARED[notice] ??
    (notice.startsWith('REFUSED:')
      ? {
          en: `Refused before proposal: ${notice.slice(8)}`,
          ar: `رُفض قبل الاقتراح: ${notice.slice(8)}`,
          tone: 'blocked' as const,
        }
      : undefined);
  if (n === undefined) return null;
  return n.tone === 'settled' ? (
    <p role="status" className="rounded-tile bg-disc-teal px-5 py-4 text-[15px] text-positive">
      {arabic ? n.ar : n.en}
    </p>
  ) : (
    <ControlRejection
      control="OP-DETERMINACY"
      explanation={arabic ? n.ar : n.en}
      controlLabel={arabic ? 'الضابط' : 'Control'}
    />
  );
}
