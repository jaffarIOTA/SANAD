/**
 * What each workbench act requires of the person performing it.
 *
 * One table, read by the server actions (which refuse) and by the screens
 * (which draw the button disabled with the reason, rather than hiding it, so a
 * person sees what exists and why it is not theirs to do). The screens are a
 * courtesy; the actions are the control, and four eyes between people is the
 * domain's, applied per record by principal id.
 *
 * The requirements are the platform's authorities (core/config/staff-identity.ts);
 * which person holds which is the tenant's staff identity configuration.
 */

import type { StaffAuthority } from '@sanad/core/config/staff-identity.ts';

import type { StaffPrincipal } from './staff.ts';

const APPROVERS: readonly StaffAuthority[] = ['CHECKER', 'SENIOR_CHECKER', 'CREDIT_COMMITTEE'];

export const ACT_REQUIREMENTS = {
  /** Key, draft, revise and submit a financing request; answer an information request; attach a document. */
  ORIGINATE: ['MAKER'],
  /** Approve, return, decline, request information, retry servicing manually, expire overdue work. */
  REVIEW: APPROVERS,
  /** Development stand-ins for the servicing platform answering; any approver may press them. */
  SERVICING_STAND_IN: APPROVERS,
  MERCHANT_ONBOARD: ['MAKER'],
  MERCHANT_VERIFY: ['CHECKER', 'SENIOR_CHECKER'],
  MERCHANT_CHANGE: ['CHECKER', 'SENIOR_CHECKER'],
  /** The SME officer: key figures, present documents, record inputs, submit, generate and send offers, record signature and portfolio status, withdraw. */
  BUSINESS_OFFICER: ['MAKER'],
  /** Verify a keyed or read figure; validate a presented document. */
  BUSINESS_VERIFY: ['CHECKER'],
  BUSINESS_ASSESS: ['CHECKER'],
  /** Clear a screening referral on an intake: a checker, never the officer who opened it (the domain refuses the same person). */
  BUSINESS_KYB_CLEAR: ['CHECKER'],
  /** Write the credit report notes the committee reads: the analyst, who is a checker. */
  BUSINESS_CREDIT_NOTES: ['CHECKER'],
  BUSINESS_APPROVE: ['CHECKER', 'SENIOR_CHECKER'],
  BUSINESS_COMMITTEE: ['CREDIT_COMMITTEE'],
  BUSINESS_DISBURSE: ['FINANCE'],
  /**
   * Wasl trade operations: hold the limit, execute the wa'd and the purchase, record evidence, take a gate the
   * sequencing engine says is satisfied, make the sale offer, record a lapse. No authority passes a gate that is not.
   */
  TRADE_OPERATIONS: ['MAKER'],
  /** Validate or refuse possession evidence: a checker, never the person who recorded it (the service refuses the same person). */
  TRADE_EVIDENCE_VERIFY: ['CHECKER', 'SENIOR_CHECKER'],
  /** Unwind an acquired position before the sale, with the goods' disposition. */
  TRADE_UNWIND: ['CHECKER', 'SENIOR_CHECKER'],
  /** Instruct the seller's payment again after the payments hub rejected or returned it: money out, finance's act. */
  TRADE_SETTLEMENT: ['FINANCE'],
  /**
   * Late amounts (W4b-2): the officer records whether the distributor was able but unwilling to pay, or unable;
   * presents a late amount's bill again after a return.
   */
  TRADE_LATE_ASSESS: ['MAKER'],
  /** Confirm the assessment or send it back: a checker, never the officer who assessed (the service refuses the same person). */
  TRADE_LATE_CONFIRM: ['CHECKER', 'SENIOR_CHECKER'],
  /** Propose which board-approved charity a collected late amount goes to: money out, finance's act. */
  CHARITY_DISBURSE_PROPOSE: ['FINANCE'],
  /** Approve or decline the disbursement: a checker, never the person who proposed it. */
  CHARITY_DISBURSE_APPROVE: ['CHECKER', 'SENIOR_CHECKER'],
  /** Propose a distributor's facility in a programme, with what it rests on (W5a). */
  FACILITY_PROPOSE: ['MAKER'],
  /** Approve or reject a proposed facility: an approver, never the person who proposed it (the service refuses the same person). */
  FACILITY_APPROVE: APPROVERS,
} as const satisfies Readonly<Record<string, readonly StaffAuthority[]>>;

export type WorkbenchAct = keyof typeof ACT_REQUIREMENTS;

export type Permission =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'AUTHORITY_REQUIRED'; readonly needs: readonly StaffAuthority[] };

export function permits(principal: StaffPrincipal | undefined, act: WorkbenchAct): Permission {
  const needs: readonly StaffAuthority[] = ACT_REQUIREMENTS[act];
  if (principal !== undefined && needs.some((a) => principal.authorities.includes(a))) return { allowed: true };
  return { allowed: false, reason: 'AUTHORITY_REQUIRED', needs };
}

const AUTHORITY_AR: Readonly<Record<StaffAuthority, string>> = {
  MAKER: 'مُدخِل',
  CHECKER: 'مُراجِع',
  SENIOR_CHECKER: 'مُراجِع أول',
  CREDIT_COMMITTEE: 'لجنة الائتمان',
  FINANCE: 'المالية',
  PLATFORM_ADMIN: 'مسؤول المنصة',
};
const AUTHORITY_EN: Readonly<Record<StaffAuthority, string>> = {
  MAKER: 'maker',
  CHECKER: 'checker',
  SENIOR_CHECKER: 'senior checker',
  CREDIT_COMMITTEE: 'credit committee',
  FINANCE: 'finance',
  PLATFORM_ADMIN: 'platform administrator',
};

export const authorityLabel = (a: StaffAuthority, arabic: boolean): string =>
  arabic ? AUTHORITY_AR[a] : AUTHORITY_EN[a];

/** The reason a refused act is refused, in the screen's language. */
export function refusalWording(needs: readonly StaffAuthority[], arabic: boolean): string {
  const list = needs.map((a) => authorityLabel(a, arabic)).join(arabic ? ' أو ' : ' or ');
  return arabic
    ? `يتطلب هذا الإجراء صلاحية: ${list}. لا تحمل جلستك هذه الصلاحية.`
    : `This needs the ${list} authority, which your session does not hold.`;
}
