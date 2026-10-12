/**
 * What the intake screens share: the result banners (words from the business
 * notice and refusal maps only — the query string never carries words), the
 * FIXTURE badge every demonstration answer wears, and the words for a KYB gap.
 */
import type { ReactElement } from 'react';

import { Icon } from '@sanad/design/icons.tsx';
import type { CheckSource, KybGap } from '@sanad/core/origination/business-intake.ts';

import { NOTICES, type ShellQuery, refusalFromQuery } from '../../../../server/business-dashboard.ts';
import type { Formatters } from '../ui.tsx';

export function ResultBanners({ query, f }: { readonly query: ShellQuery; readonly f: Formatters }): ReactElement {
  const notice = query.notice === undefined ? undefined : NOTICES[query.notice];
  const refusal = refusalFromQuery(query, f.arabic);
  return (
    <>
      {notice === undefined ? null : (
        <div
          role="status"
          className="flex items-center gap-2 rounded-card border border-positive/30 bg-positive-wash px-4 py-3 text-[14px] text-positive"
        >
          <Icon name="check-circle" size={18} />
          {f.t(notice.en, notice.ar)}
        </div>
      )}
      {refusal === undefined ? null : (
        <div role="alert" className="rounded-card border border-blocked/30 bg-blocked-wash px-4 py-3">
          <p className="text-[14px] text-ink">{refusal.explanation}</p>
          <p className="mt-1 text-[12px] text-ink-quiet">
            {f.t('Control', 'الضابط')} <span className="identifier">{refusal.control}</span>
          </p>
        </div>
      )}
    </>
  );
}

/** A check's source, shown wherever its answer is: a fixture is never mistaken for a live answer. */
export function SourceBadge({ source, f }: { readonly source: CheckSource; readonly f: Formatters }): ReactElement {
  return source === 'FIXTURE' ? (
    <span
      className="inline-flex items-center rounded-pill border border-attention/40 bg-attention-wash px-2 py-0.5 text-[11px] font-semibold text-attention"
      title={f.t(
        'Answered by the demonstration transport, not the live service',
        'أجابت عنه بيئة العرض التجريبي لا الخدمة الفعلية',
      )}
    >
      {f.t('Fixture', 'تجريبي')}
    </span>
  ) : (
    <span className="inline-flex items-center rounded-pill border border-positive/40 bg-positive-wash px-2 py-0.5 text-[11px] font-semibold text-positive">
      {f.t('Live', 'فعلي')}
    </span>
  );
}

const GAP_WORDS: Readonly<Record<KybGap['code'], { readonly en: string; readonly ar: string }>> = {
  REGISTRY_NOT_CHECKED: {
    en: 'Trade licence not checked in the register',
    ar: 'لم يُتحقق من الرخصة التجارية في السجل',
  },
  REGISTRY_NOT_ACTIVE: { en: 'Trade licence is not active', ar: 'الرخصة التجارية غير سارية' },
  IDENTITY_NOT_VERIFIED: { en: 'Identity not verified', ar: 'لم يُتحقق من الهوية' },
  SCREENING_NOT_RUN: { en: 'Screening not run', ar: 'لم يُجرَ الفحص' },
  SCREENING_NOT_CLEAR: { en: 'Screening referral not cleared', ar: 'إحالة الفحص لم تُعالج' },
  UBO_NOT_DECLARED: { en: 'Beneficial owners not declared', ar: 'لم يُصرَّح بالمستفيدين الحقيقيين' },
  BUREAU_CONSENT_MISSING: { en: 'Credit bureau consent missing', ar: 'موافقة المكتب الائتماني غير مسجلة' },
};

export const gapWords = (gap: KybGap, f: Formatters, nameOf: (ref: string) => string): string => {
  const w = GAP_WORDS[gap.code];
  const who =
    gap.subject === undefined
      ? ''
      : ` — ${gap.subject === 'ENTITY' ? f.t('the business', 'المنشأة') : nameOf(gap.subject)}`;
  return `${f.t(w.en, w.ar)}${who}`;
};
