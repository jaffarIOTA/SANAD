/**
 * The Shariah approvals register (BR-F01, BR-F02, SH-17).
 *
 * An approval is the board's ruling, recorded: the approving body, its
 * reference, the members who approved it, when it takes effect and when it
 * lapses unless renewed, the products it covers and the template versions it
 * approves. Nothing in it is a default; every field is what the board said.
 *
 * The register is not stored as rows that change. It is folded from changes —
 * record, suspend, reinstate, withdraw, renew — each proposed by one person
 * and confirmed by another, in the order they were confirmed. So the history
 * of an approval is the register itself, and "what was in force on that date"
 * is answered by folding the changes confirmed by then.
 *
 * Standing is a date question: an approval is in force from its effective
 * date through its review or expiry date, while neither suspended nor
 * withdrawn. A lapse needs nobody to act on it (BR-F02): the date passes and
 * new origination on every product the approval covers is refused, by this
 * function, wherever origination starts.
 *
 * Product-agnostic: an approval covers product codes; which product an
 * origination is for is the caller's to say. Pure; no clock — the civil date
 * is the caller's, from an attested instant.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import { ISLAMIC_PRODUCT_CODES } from '../products/registry.ts';

export type ApprovalStatus = 'IN_FORCE' | 'SUSPENDED' | 'WITHDRAWN';

/** Where an approval stands on a civil date. */
export type ApprovalStanding = 'IN_FORCE' | 'NOT_YET_EFFECTIVE' | 'LAPSED' | 'SUSPENDED' | 'WITHDRAWN';

/** What the board ruled, as recorded. Dates are civil dates, yyyy-mm-dd, in the institution's time zone. */
export interface ApprovalTerms {
  readonly approvalRef: string;
  readonly approvingBody: string;
  readonly members: readonly string[];
  readonly effectiveFrom: string;
  /** The date through which the approval holds unless renewed. Absent where the board set none. */
  readonly reviewOrExpiry?: string;
  readonly productCodes: readonly string[];
  /** The document template versions the approval covers (`name@version`). */
  readonly templateVersionIds: readonly string[];
}

export type ApprovalChange =
  | { readonly kind: 'RECORD'; readonly terms: ApprovalTerms }
  | { readonly kind: 'SUSPEND' | 'REINSTATE' | 'WITHDRAW'; readonly approvalRef: string }
  | { readonly kind: 'RENEW'; readonly approvalRef: string; readonly reviewOrExpiry: string };

export type ApprovalChangeKind = ApprovalChange['kind'];

export type ApprovalChangeState = 'PROPOSED' | 'CONFIRMED' | 'REJECTED';

export interface ApprovalChangeEntry {
  readonly changeId: string;
  readonly change: ApprovalChange;
  /** Why: the board's minute, a letter, the reason for a suspension. */
  readonly reason: string;
  readonly state: ApprovalChangeState;
  readonly proposedBy: string;
  readonly proposedAtEpochSeconds: bigint;
  readonly decidedBy?: string;
  readonly decidedAtEpochSeconds?: bigint;
  readonly decisionNote?: string;
}

export interface ShariahApproval extends ApprovalTerms {
  readonly status: ApprovalStatus;
  /** Every confirmed change to this approval, in the order confirmed; the first is its recording. */
  readonly history: readonly ApprovalChangeEntry[];
}

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

export const approvalRefOf = (change: ApprovalChange): string =>
  change.kind === 'RECORD' ? change.terms.approvalRef : change.approvalRef;

// -- Folding ----------------------------------------------------------------------------

/** The register the confirmed changes make, folded in the order they were confirmed. */
export function registerFrom(entries: readonly ApprovalChangeEntry[]): readonly ShariahApproval[] {
  const confirmed = entries
    .filter((e) => e.state === 'CONFIRMED' && e.decidedAtEpochSeconds !== undefined)
    .map((e, i) => ({ e, i }))
    .sort((a, b) =>
      a.e.decidedAtEpochSeconds === b.e.decidedAtEpochSeconds
        ? a.i - b.i
        : (a.e.decidedAtEpochSeconds ?? 0n) < (b.e.decidedAtEpochSeconds ?? 0n)
          ? -1
          : 1,
    );
  const register = new Map<string, ShariahApproval>();
  for (const { e } of confirmed) {
    const c = e.change;
    if (c.kind === 'RECORD') {
      if (!register.has(c.terms.approvalRef))
        register.set(c.terms.approvalRef, { ...c.terms, status: 'IN_FORCE', history: [e] });
      continue;
    }
    const a = register.get(c.approvalRef);
    if (a === undefined || a.status === 'WITHDRAWN') continue;
    const history = [...a.history, e];
    if (c.kind === 'SUSPEND') register.set(a.approvalRef, { ...a, status: 'SUSPENDED', history });
    else if (c.kind === 'REINSTATE') register.set(a.approvalRef, { ...a, status: 'IN_FORCE', history });
    else if (c.kind === 'WITHDRAW') register.set(a.approvalRef, { ...a, status: 'WITHDRAWN', history });
    else if (c.kind === 'RENEW') register.set(a.approvalRef, { ...a, reviewOrExpiry: c.reviewOrExpiry, history });
  }
  return [...register.values()];
}

/** The register as it stood at an instant: the changes confirmed by then. */
export function registerAt(entries: readonly ApprovalChangeEntry[], epochSeconds: bigint): readonly ShariahApproval[] {
  return registerFrom(entries.filter((e) => (e.decidedAtEpochSeconds ?? epochSeconds + 1n) <= epochSeconds));
}

// -- Standing ---------------------------------------------------------------------------

export function standingOn(approval: ShariahApproval, civilDate: string): ApprovalStanding {
  if (approval.status === 'WITHDRAWN') return 'WITHDRAWN';
  if (approval.status === 'SUSPENDED') return 'SUSPENDED';
  if (civilDate < approval.effectiveFrom) return 'NOT_YET_EFFECTIVE';
  if (approval.reviewOrExpiry !== undefined && civilDate > approval.reviewOrExpiry) return 'LAPSED';
  return 'IN_FORCE';
}

const NOT_IN_FORCE: Readonly<Record<Exclude<ApprovalStanding, 'IN_FORCE'>, string>> = {
  NOT_YET_EFFECTIVE: 'SHARIAH_APPROVAL_NOT_YET_EFFECTIVE',
  LAPSED: 'SHARIAH_APPROVAL_LAPSED',
  SUSPENDED: 'SHARIAH_APPROVAL_SUSPENDED',
  WITHDRAWN: 'SHARIAH_APPROVAL_WITHDRAWN',
};

/**
 * The approval a new origination of `productCode` rests on, in force on
 * `civilDate` and covering the product — or the SH-17 refusal saying which of
 * those it is not. `approvalRef` is what the product's configuration cites.
 */
export function approvalInForce(
  register: readonly ShariahApproval[],
  approvalRef: string | undefined,
  productCode: string,
  civilDate: string,
): Result<ShariahApproval> {
  if (approvalRef === undefined || approvalRef.trim().length === 0)
    return reject('SH-17', 'SHARIAH_APPROVAL_NOT_CITED', 'The product’s configuration cites no Shariah approval', {
      productCode,
    });
  const approval = register.find((a) => a.approvalRef === approvalRef);
  if (approval === undefined)
    return reject('SH-17', 'SHARIAH_APPROVAL_NOT_RECORDED', 'The approval the product cites is not in the register', {
      approvalRef,
      productCode,
    });
  const standing = standingOn(approval, civilDate);
  if (standing !== 'IN_FORCE')
    return reject('SH-17', NOT_IN_FORCE[standing], 'The Shariah approval is not in force; new origination stops', {
      approvalRef,
      productCode,
      ...(approval.reviewOrExpiry === undefined ? {} : { reviewOrExpiry: approval.reviewOrExpiry }),
    });
  if (!approval.productCodes.includes(productCode))
    return reject('SH-17', 'SHARIAH_APPROVAL_DOES_NOT_COVER_PRODUCT', 'The approval does not cover this product', {
      approvalRef,
      productCode,
    });
  return ok(approval);
}

/** Every template version the product will execute under is one the approval covers (BR-F01: a product and its template set). */
export function coversTemplates(approval: ShariahApproval, templateVersionIds: readonly string[]): Result<void> {
  const outside = templateVersionIds.filter((t) => !approval.templateVersionIds.includes(t));
  return outside.length === 0
    ? ok(undefined)
    : reject('SH-17', 'SHARIAH_APPROVAL_DOES_NOT_COVER_TEMPLATES', 'A template in use is not one the approval covers', {
        approvalRef: approval.approvalRef,
        templates: outside.join(','),
      });
}

// -- Validating a change ----------------------------------------------------------------

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{1,79}$/;
const TEMPLATE = /^[a-z][a-z0-9_]{1,63}@\d{1,6}$/;

/** A real Gregorian date: the day exists in its month, leap years included. Integer arithmetic only. */
function validDate(s: string): boolean {
  if (!DATE.test(s)) return false;
  const [y = 0, m = 0, d = 0] = s.split('-').map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
  return d <= days;
}
const named = (s: string, min: number, max: number): boolean => s.trim().length >= min && s.trim().length <= max;

function validateTerms(t: ApprovalTerms): Result<void> {
  if (!REF.test(t.approvalRef))
    return fail('APPROVAL_REF_MALFORMED', 'The reference is the board’s, 2 to 80 letters, digits and . _ / -');
  if (!named(t.approvingBody, 2, 200)) return fail('APPROVING_BODY_REQUIRED', 'Name the approving body');
  if (t.members.length === 0 || t.members.length > 20 || !t.members.every((m) => named(m, 2, 200)))
    return fail('APPROVING_MEMBERS_REQUIRED', 'Name the members who approved it, one to twenty');
  if (new Set(t.members.map((m) => m.trim())).size !== t.members.length)
    return fail('APPROVING_MEMBER_TWICE', 'Each member is named once');
  if (!validDate(t.effectiveFrom)) return fail('EFFECTIVE_FROM_MALFORMED', 'The effective date is a calendar date');
  if (t.reviewOrExpiry !== undefined && (!validDate(t.reviewOrExpiry) || t.reviewOrExpiry <= t.effectiveFrom))
    return fail('REVIEW_DATE_MALFORMED', 'The review or expiry date is a calendar date after the effective date');
  if (t.productCodes.length === 0 || !t.productCodes.every((p) => ISLAMIC_PRODUCT_CODES.has(p)))
    return fail('APPROVAL_PRODUCTS_INVALID', 'An approval covers one or more of the platform’s Islamic products', {
      allowed: [...ISLAMIC_PRODUCT_CODES].join(','),
    });
  if (new Set(t.productCodes).size !== t.productCodes.length)
    return fail('APPROVAL_PRODUCT_TWICE', 'Each product is named once');
  if (t.templateVersionIds.length > 50 || !t.templateVersionIds.every((x) => TEMPLATE.test(x)))
    return fail('APPROVAL_TEMPLATES_MALFORMED', 'Templates are named as name@version, at most fifty');
  if (new Set(t.templateVersionIds).size !== t.templateVersionIds.length)
    return fail('APPROVAL_TEMPLATE_TWICE', 'Each template version is named once');
  return ok(undefined);
}

/**
 * Whether a change may be made to the register as it stands: checked when it
 * is proposed and again when it is confirmed, since the register may have
 * moved in between. One open proposal per approval at a time.
 */
export function checkChange(
  entries: readonly ApprovalChangeEntry[],
  change: ApprovalChange,
  reason: string,
  pendingChangeId?: string,
): Result<void> {
  if (!named(reason, 3, 1000)) return fail('APPROVAL_CHANGE_REASON_REQUIRED', 'Say why, with the board’s reference');
  const ref = approvalRefOf(change);
  if (entries.some((e) => e.state === 'PROPOSED' && e.changeId !== pendingChangeId && approvalRefOf(e.change) === ref))
    return fail('APPROVAL_CHANGE_OPEN', 'A change to this approval awaits a second person', { approvalRef: ref });
  const existing = registerFrom(entries).find((a) => a.approvalRef === ref);
  switch (change.kind) {
    case 'RECORD':
      if (existing !== undefined)
        return fail('APPROVAL_ALREADY_RECORDED', 'This reference is already in the register; renew it instead', {
          approvalRef: ref,
        });
      return validateTerms(change.terms);
    case 'SUSPEND':
      if (existing?.status !== 'IN_FORCE')
        return fail('APPROVAL_NOT_SUSPENDABLE', 'Only an approval that is not suspended or withdrawn is suspended');
      return ok(undefined);
    case 'REINSTATE':
      if (existing?.status !== 'SUSPENDED')
        return fail('APPROVAL_NOT_SUSPENDED', 'Only a suspended approval is reinstated');
      return ok(undefined);
    case 'WITHDRAW':
      if (existing === undefined || existing.status === 'WITHDRAWN')
        return fail('APPROVAL_NOT_WITHDRAWABLE', 'Only a recorded approval not already withdrawn is withdrawn');
      return ok(undefined);
    case 'RENEW':
      if (existing === undefined || existing.status === 'WITHDRAWN')
        return fail('APPROVAL_NOT_RENEWABLE', 'A withdrawn approval is not renewed; record a new one');
      if (!validDate(change.reviewOrExpiry) || change.reviewOrExpiry <= existing.effectiveFrom)
        return fail('REVIEW_DATE_MALFORMED', 'The review or expiry date is a calendar date after the effective date');
      if (change.reviewOrExpiry === existing.reviewOrExpiry)
        return fail('APPROVAL_RENEWAL_UNCHANGED', 'The renewal sets a different review or expiry date');
      return ok(undefined);
  }
}
