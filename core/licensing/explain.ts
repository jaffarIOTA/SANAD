/**
 * The licence, in words a person can read — Arabic and English.
 *
 * Presentation only. Nothing here permits or refuses anything: the decision
 * is `assertNewBusinessPermitted` (gate.ts). These are the words a screen or
 * an API problem shows once the gate has decided, and the banner text staff
 * see while a licence is expiring, in grace, or blocking new business.
 *
 * A refusal is never a generic decline. It says what is refused (new
 * business only), what is not (everything owed to existing customers and the
 * regulator), and who can fix it (the institution's administrators, with the
 * issuer).
 */

import { type LicenceGateReason, blockedReasonOf } from './gate.ts';
import type { LicenceState, LicenceStatus } from './state.ts';

export interface Bilingual {
  readonly en: string;
  readonly ar: string;
}

const SERVICING_CONTINUES: Bilingual = {
  en: 'Existing contracts, repayments, collections and regulatory reporting continue as normal.',
  ar: 'تستمر العقود القائمة والسداد والتحصيل والتقارير الرقابية كالمعتاد.',
};

const REFUSAL: Readonly<Record<LicenceGateReason, Bilingual>> = {
  NO_LICENCE: {
    en: 'New business cannot start: this installation has no licence. Your administrators can install one in Admin → Licence.',
    ar: 'لا يمكن بدء أعمال جديدة: لا يوجد ترخيص مثبّت لهذا النظام. يمكن لمديري النظام لديكم تثبيته من الإدارة ← الترخيص.',
  },
  NO_VALID_LICENCE: {
    en: 'New business cannot start: the installed licence could not be verified. Your administrators can install a valid one in Admin → Licence.',
    ar: 'لا يمكن بدء أعمال جديدة: تعذّر التحقق من الترخيص المثبّت. يمكن لمديري النظام تثبيت ترخيص صالح من الإدارة ← الترخيص.',
  },
  NOT_YET_VALID: {
    en: 'New business cannot start yet: the installed licence has not reached its start date.',
    ar: 'لا يمكن بدء أعمال جديدة بعد: لم يحن تاريخ بدء الترخيص المثبّت.',
  },
  GRACE_ENDED: {
    en: 'New business is paused: the licence has expired and its grace period has ended. Your administrators can renew it in Admin → Licence.',
    ar: 'الأعمال الجديدة متوقفة مؤقتاً: انتهى الترخيص وانقضت مهلته. يمكن لمديري النظام تجديده من الإدارة ← الترخيص.',
  },
  CLOCK_ROLLBACK: {
    en: 'New business is paused: the server clock is behind the latest time this installation has recorded. It resumes once the clock is corrected.',
    ar: 'الأعمال الجديدة متوقفة مؤقتاً: ساعة الخادم متأخرة عن آخر وقت سجّله النظام، وتُستأنف عند تصحيحها.',
  },
  PRODUCT_NOT_LICENSED: {
    en: 'This product is not included in the installation’s licence, so it cannot be offered. Your administrators can request it from the issuer.',
    ar: 'هذا المنتج غير مشمول في ترخيص النظام، فلا يمكن تقديمه. يمكن لمديري النظام طلب إضافته من جهة الإصدار.',
  },
  JURISDICTION_NOT_LICENSED: {
    en: 'The installation’s licence does not cover the jurisdiction it is operating in, so new business cannot start.',
    ar: 'ترخيص النظام لا يشمل الولاية التي يعمل فيها، فلا يمكن بدء أعمال جديدة.',
  },
  TENANT_LIMIT_EXCEEDED: {
    en: 'More institutions are active on this installation than its licence allows, so new business cannot start.',
    ar: 'عدد المؤسسات النشطة على هذا النظام يتجاوز ما يسمح به الترخيص، فلا يمكن بدء أعمال جديدة.',
  },
};

/** The respectful explanation of a `LICENCE_NOT_ACTIVE` refusal, with the reassurance that servicing continues. */
export function licenceRefusalText(reason: LicenceGateReason): Bilingual {
  const r = REFUSAL[reason];
  return { en: `${r.en} ${SERVICING_CONTINUES.en}`, ar: `${r.ar} ${SERVICING_CONTINUES.ar}` };
}

/** Every reason the gate can give, for a screen that renders a reason from a query string. */
export const LICENCE_GATE_REASONS: readonly LicenceGateReason[] = Object.keys(REFUSAL) as LicenceGateReason[];

export const STATUS_LABEL: Readonly<Record<LicenceStatus, Bilingual>> = {
  VALID: { en: 'valid', ar: 'سارٍ' },
  EXPIRING: { en: 'expiring', ar: 'قارب على الانتهاء' },
  GRACE: { en: 'in grace', ar: 'في المهلة' },
  NEW_BUSINESS_BLOCKED: { en: 'new business blocked', ar: 'الأعمال الجديدة موقوفة' },
  DEVELOPMENT_UNLICENSED: { en: 'development, unlicensed', ar: 'تطوير، دون ترخيص' },
};

export type BannerTone = 'attention' | 'blocked';

export interface LicenceBanner extends Bilingual {
  readonly tone: BannerTone;
}

/** The staff banner (ADR 0006 §4): shown in EXPIRING, GRACE and NEW_BUSINESS_BLOCKED; nothing otherwise. */
export function licenceBanner(state: LicenceState): LicenceBanner | undefined {
  const days = String(state.daysRemaining ?? 0);
  switch (state.status) {
    case 'EXPIRING':
      return {
        tone: 'attention',
        en: `The licence ends in ${days} day(s). Ask your administrators to renew it in Admin → Licence.`,
        ar: `ينتهي الترخيص خلال ${days} يوم. اطلب من مديري النظام تجديده من الإدارة ← الترخيص.`,
      };
    case 'GRACE':
      return {
        tone: 'attention',
        en: `The licence has ended; new business continues for ${days} more day(s) of grace. Ask your administrators to renew it in Admin → Licence.`,
        ar: `انتهى الترخيص؛ تستمر الأعمال الجديدة لمدة ${days} يوم ضمن المهلة. اطلب من مديري النظام تجديده من الإدارة ← الترخيص.`,
      };
    case 'NEW_BUSINESS_BLOCKED':
      return { tone: 'blocked', ...licenceRefusalText(blockedReasonOf(state)) };
    default:
      return undefined;
  }
}
