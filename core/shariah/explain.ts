/**
 * An SH-17 refusal in words a person can read — Arabic and English.
 *
 * Presentation only; the decision is `approvalInForce` (approvals.ts). Each
 * refusal says what stopped (new business on this product), what did not
 * (what is owed on existing contracts), and who can act (the institution's
 * Shariah reviewers, with the board).
 */

import type { Bilingual } from '../licensing/explain.ts';

const CONTINUES: Bilingual = {
  en: 'Existing contracts, collections and reporting continue.',
  ar: 'تستمر العقود القائمة والتحصيل والتقارير.',
};

const REFUSAL: Readonly<Record<string, Bilingual>> = {
  SHARIAH_APPROVAL_NOT_CITED: {
    en: 'New business on this product cannot start: its configuration cites no Shariah board approval.',
    ar: 'لا يمكن بدء أعمال جديدة على هذا المنتج: لا تُشير إعداداته إلى اعتماد من الهيئة الشرعية.',
  },
  SHARIAH_APPROVAL_NOT_RECORDED: {
    en: 'New business on this product cannot start: the Shariah board approval it cites is not recorded in the approvals register. A Shariah reviewer records it, and a second confirms.',
    ar: 'لا يمكن بدء أعمال جديدة على هذا المنتج: اعتماد الهيئة الشرعية الذي يُشير إليه غير مقيّد في سجل الاعتمادات. يقيّده مراجع شرعي ويؤكده مراجع آخر.',
  },
  SHARIAH_APPROVAL_NOT_YET_EFFECTIVE: {
    en: 'New business on this product cannot start yet: the Shariah board approval has not reached its effective date.',
    ar: 'لا يمكن بدء أعمال جديدة على هذا المنتج بعد: لم يحن تاريخ سريان اعتماد الهيئة الشرعية.',
  },
  SHARIAH_APPROVAL_LAPSED: {
    en: 'New business on this product has stopped: the Shariah board approval passed its review or expiry date without renewal.',
    ar: 'توقفت الأعمال الجديدة على هذا المنتج: انقضى تاريخ مراجعة اعتماد الهيئة الشرعية أو انتهاؤه دون تجديد.',
  },
  SHARIAH_APPROVAL_SUSPENDED: {
    en: 'New business on this product has stopped: the Shariah board approval is suspended.',
    ar: 'توقفت الأعمال الجديدة على هذا المنتج: اعتماد الهيئة الشرعية موقوف.',
  },
  SHARIAH_APPROVAL_WITHDRAWN: {
    en: 'New business on this product has stopped: the Shariah board approval was withdrawn.',
    ar: 'توقفت الأعمال الجديدة على هذا المنتج: سُحب اعتماد الهيئة الشرعية.',
  },
  SHARIAH_APPROVAL_DOES_NOT_COVER_PRODUCT: {
    en: 'New business on this product cannot start: the Shariah board approval it cites does not cover it.',
    ar: 'لا يمكن بدء أعمال جديدة على هذا المنتج: اعتماد الهيئة الشرعية الذي يُشير إليه لا يشمله.',
  },
  SHARIAH_APPROVAL_DOES_NOT_COVER_TEMPLATES: {
    en: 'New business on this product cannot start: a contract template in use is not one the Shariah board approval covers.',
    ar: 'لا يمكن بدء أعمال جديدة على هذا المنتج: أحد نماذج العقود المستخدمة لا يشمله اعتماد الهيئة الشرعية.',
  },
};

export const APPROVAL_REFUSAL_REASONS: readonly string[] = Object.keys(REFUSAL);

/** The words for an SH-17 refusal reason, or undefined for any other reason. */
export function approvalRefusalText(reason: string): Bilingual | undefined {
  const r = REFUSAL[reason];
  return r === undefined ? undefined : { en: `${r.en} ${CONTINUES.en}`, ar: `${r.ar} ${CONTINUES.ar}` };
}
