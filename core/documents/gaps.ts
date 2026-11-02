/**
 * Document gaps (document intelligence D4): what an application still needs
 * from the applicant, in words they can act on, in Arabic and English.
 *
 * A gap is a required checklist item that is missing, expired or refused by
 * the checker, or whose latest document the findings say is the wrong
 * document, not confirmed by its issuer, or failing a declared check. A check
 * that could not be made is never a gap: the applicant is not asked to fix
 * what the engine could not read; a person reads it. An optional item is never
 * a gap.
 *
 * Pure: the checklist report and the findings in, the gaps out. Asking for
 * them is an officer's act (a notification on the outbox); nothing here sends,
 * accepts or refuses anything.
 */
import type { ItemReport } from './checklist.ts';
import type { CheckResult } from './understanding.ts';

export type GapKind = 'MISSING' | 'EXPIRED' | 'REJECTED' | 'WRONG_TYPE' | 'NOT_AUTHENTIC' | 'CHECK_FAILED';

export interface DocumentGap {
  readonly documentType: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly kind: GapKind;
  /** For CHECK_FAILED: the declared checks that failed, by code. */
  readonly failedChecks?: readonly string[];
}

/** The checks on a document's latest reading: the slice of its findings a gap needs. */
export type FindingChecks = readonly Pick<CheckResult, 'check' | 'outcome'>[];

/**
 * The gaps on an application. `checksFor` gives the checks on the latest
 * reading of the document an item stands on, if it was read.
 */
export function gapsOf(
  report: readonly ItemReport[],
  checksFor: (documentType: string) => FindingChecks | undefined,
): readonly DocumentGap[] {
  const gaps: DocumentGap[] = [];
  for (const r of report) {
    if (!r.item.required) continue;
    const base = { documentType: r.item.documentType, titleEn: r.item.titleEn, titleAr: r.item.titleAr };
    if (r.status === 'MISSING') gaps.push({ ...base, kind: 'MISSING' });
    else if (r.status === 'EXPIRED') gaps.push({ ...base, kind: 'EXPIRED' });
    else if (r.status === 'INVALID') gaps.push({ ...base, kind: 'REJECTED' });
    else if (r.status === 'PENDING') {
      // Accepted by the checker (PRESENT), a document is never a gap whatever its checks said: the checker decided.
      const failed = (checksFor(r.item.documentType) ?? []).filter((c) => c.outcome === 'FAIL').map((c) => c.check);
      if (failed.includes('TYPE_MATCHES_DECLARED')) gaps.push({ ...base, kind: 'WRONG_TYPE' });
      else if (failed.includes('AUTHENTIC')) gaps.push({ ...base, kind: 'NOT_AUTHENTIC' });
      else if (failed.length > 0) gaps.push({ ...base, kind: 'CHECK_FAILED', failedChecks: failed });
    }
  }
  return gaps;
}

/** The gap set as a stable key: one request per distinct set, so asking twice for the same set sends once. */
export const gapSetKey = (gaps: readonly DocumentGap[]): string =>
  gaps
    .map(
      (g) =>
        `${g.documentType}:${g.kind}${g.failedChecks === undefined ? '' : `:${[...g.failedChecks].sort().join('+')}`}`,
    )
    .sort()
    .join(',');

const REASON: Readonly<Record<string, readonly [string, string]>> = {
  NOT_EXPIRED: ['has expired or is about to expire', 'منتهي الصلاحية أو على وشك الانتهاء'],
  ISSUED_WITHIN: ['is older than we can accept', 'أقدم مما يمكننا قبوله'],
  PERIOD_COVERS: ['does not cover the full period we need', 'لا يغطي كامل الفترة المطلوبة'],
  PERIOD_ENDS_WITHIN: ['does not run recently enough', 'لا يمتد إلى تاريخ حديث بما يكفي'],
  REGISTRATION_MATCHES: [
    'carries a different registration number from your application',
    'يحمل رقم سجل مختلفًا عن طلبك',
  ],
};

/** What to tell the applicant about one gap: a sentence they can act on, in each language. */
export function gapMessage(g: DocumentGap): { readonly en: string; readonly ar: string } {
  const en = g.titleEn;
  const ar = g.titleAr;
  switch (g.kind) {
    case 'MISSING':
      return { en: `Please send your ${en}.`, ar: `يرجى إرسال ${ar}.` };
    case 'EXPIRED':
      return {
        en: `Your ${en} has expired. Please send a current one.`,
        ar: `انتهت صلاحية ${ar}. يرجى إرسال نسخة سارية.`,
      };
    case 'REJECTED':
      return {
        en: `The ${en} you sent could not be accepted. Please send it again.`,
        ar: `تعذّر قبول ${ar} المرسل. يرجى إرساله مرة أخرى.`,
      };
    case 'WRONG_TYPE':
      return {
        en: `What we received as your ${en} appears to be a different document. Please send the ${en}.`,
        ar: `يبدو أن ما استلمناه على أنه ${ar} مستند مختلف. يرجى إرسال ${ar}.`,
      };
    case 'NOT_AUTHENTIC':
      return {
        en: `We could not confirm your ${en} with its issuer. Please send a current copy issued by them.`,
        ar: `تعذّر علينا التحقق من ${ar} لدى الجهة المصدرة. يرجى إرسال نسخة حديثة صادرة عنها.`,
      };
    case 'CHECK_FAILED': {
      const reasons = (g.failedChecks ?? []).map((c) => REASON[c]).filter((r) => r !== undefined);
      if (reasons.length === 0) return { en: `Please send an updated ${en}.`, ar: `يرجى إرسال نسخة محدّثة من ${ar}.` };
      return {
        en: `Your ${en} ${reasons.map((r) => r[0]).join(', and ')}. Please send an updated one.`,
        ar: `${ar} ${reasons.map((r) => r[1]).join('، و')}. يرجى إرسال نسخة محدّثة.`,
      };
    }
  }
}
