/**
 * SME business intake: stages 1–4 of direct lending, before the application
 * reaches credit assessment at stage 5 (business-application.ts).
 *
 * An officer opens an intake with the entity's trade licence and the request,
 * names the parties (owners and signatories, with ownership shares), captures
 * each party's consents, and records the KYB/KYC checks: the licence in the
 * registry, each party's identity, sanctions/PEP screening of the entity and
 * every party, and the beneficial-owner declaration. When every check passes,
 * the intake hands over into a stage-5 application through the same path an
 * upstream CIF uses, carrying the check references as its verification
 * references.
 *
 * Pure, and with no clock: every instant is passed in. The checks arrive as
 * results from the rails (or their labelled fixtures); this module records
 * outcomes and references only — never a copy of a registry file, an identity
 * record or a screening hit — and refuses an identity number anywhere.
 */

import type { CurrencyCode, Money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

import { REGISTRATION_FIELDS, containsIdentityNumber } from './business-application.ts';

export type IntakeStatus = 'DRAFT' | 'HANDED_OVER' | 'DECLINED' | 'WITHDRAWN';

export type PartyRole = 'OWNER' | 'SIGNATORY' | 'OWNER_SIGNATORY';

/** Where a check's answer came from. A fixture is labelled on every screen that shows it. */
export type CheckSource = 'LIVE' | 'FIXTURE';

export type RegistryStatus = 'ACTIVE' | 'EXPIRED' | 'SUSPENDED' | 'CANCELLED' | 'NOT_FOUND';

export interface RegistryCheck {
  readonly status: RegistryStatus;
  readonly lookupRef: string;
  readonly source: CheckSource;
  readonly atEpochSeconds: bigint;
}

export interface IdentityCheck {
  readonly verified: boolean;
  readonly verificationRef: string;
  readonly source: CheckSource;
  readonly atEpochSeconds: bigint;
}

export type ScreeningOutcome = 'CLEAR' | 'REFER' | 'REJECT' | 'PENDING_INVESTIGATION';

export interface ScreeningCheck {
  readonly outcome: ScreeningOutcome;
  readonly resultRef: string;
  readonly source: CheckSource;
  readonly atEpochSeconds: bigint;
  /** A REFER cleared by a second person, with the reason. */
  readonly clearance?: { readonly clearedBy: string; readonly reason: string; readonly atEpochSeconds: bigint };
}

export interface IntakeParty {
  readonly partyRef: string;
  readonly displayName: string;
  readonly role: PartyRole;
  /** Share of the entity, per ten thousand (2500 = 25%). Zero for a signatory who owns nothing. */
  readonly ownershipPerTenThousand: number;
  readonly identity?: IdentityCheck;
  readonly screening?: ScreeningCheck;
}

/** The consents an intake captures, by the platform's consent types. */
export type IntakeConsentType =
  | 'IDENTITY_VERIFICATION'
  | 'SCREENING'
  | 'CREDIT_BUREAU'
  | 'ACCOUNT_INFORMATION'
  /** Checking the authenticity of the national documents the business presents (document intelligence D3). */
  | 'DOCUMENT_VERIFICATION';

/** The tax authority's answer for the business's TRN. Informational: registration is mandatory only above a threshold. */
export interface TaxCheck {
  readonly status: 'VALID' | 'EXPIRED' | 'NOT_FOUND' | 'SUSPENDED';
  readonly reference: string;
  readonly source: CheckSource;
  readonly atEpochSeconds: bigint;
}

/** `ENTITY` for a consent given on the business's behalf by an authorised signatory. */
export type ConsentSubject = string;

export interface ConsentCapture {
  readonly consentId: string;
  readonly type: IntakeConsentType;
  readonly subject: ConsentSubject;
  readonly evidenceRef: string;
  readonly capturedBy: string;
  readonly atEpochSeconds: bigint;
}

export interface UboDeclaration {
  readonly declaredBy: string;
  readonly evidenceRef: string;
  readonly uboRefs: readonly string[];
  readonly atEpochSeconds: bigint;
}

export interface IntakeEntity {
  readonly tradeLicence: string;
  /**
   * The registration number: a UAE trade licence, or a Saudi commercial registration (CR).
   * The name is the UAE's; the value is whichever the jurisdiction issues.
   */
  /** The issuing authority's code (UAE: DED, DET, ADDED, a free zone; Saudi Arabia: MOC) — a code, not a name. */
  readonly issuingAuthority: string;
  readonly businessNameEn: string;
  readonly businessNameAr?: string;
  readonly sector: string;
  readonly yearsInOperation: number;
  /** The tax registration number, where the business has one (fifteen digits in the UAE). */
  readonly taxRegistrationNumber?: string;
}

export interface IntakeRequest {
  readonly productCode: string;
  readonly variantCode: string;
  readonly purpose: string;
  readonly requested: Money;
  readonly tenorMonths: number;
  readonly graceMonths: number;
  readonly contributionPerTenThousand: number;
}

export interface BusinessIntake {
  readonly intakeId: string;
  readonly tenantId: string;
  readonly status: IntakeStatus;
  readonly entity: IntakeEntity;
  readonly request: IntakeRequest;
  readonly parties: readonly IntakeParty[];
  readonly consents: readonly ConsentCapture[];
  readonly registry?: RegistryCheck;
  readonly entityScreening?: ScreeningCheck;
  readonly taxCheck?: TaxCheck;
  readonly ubo?: UboDeclaration;
  readonly openedBy: string;
  readonly openedAtEpochSeconds: bigint;
  readonly handedOver?: { readonly applicationId: string; readonly atEpochSeconds: bigint };
  readonly declined?: { readonly reason: string; readonly atEpochSeconds: bigint };
  readonly withdrawn?: { readonly reason: string; readonly atEpochSeconds: bigint };
}

export interface IntakeEvent {
  readonly eventType: string;
  readonly actor: string;
  readonly atEpochSeconds: bigint;
  readonly detail: Readonly<Record<string, string>>;
}

export interface IntakeTransition {
  readonly intake: BusinessIntake;
  readonly event: IntakeEvent;
}

const bad = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,39}$/;
/** The trade-licence shape the registry adapter accepts. */
const LICENCE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9/-]{2,29}$/;
const INTAKE_ID_SHAPE = /^INT-[0-9]{6,10}$/;
const nonEmpty = (s: string | undefined): s is string => s !== undefined && s.trim().length > 0;

function open(intake: BusinessIntake, action: string): Result<true> {
  return intake.status === 'DRAFT'
    ? ok(true)
    : bad('INTAKE_NOT_OPEN', `${action} is not possible once the intake is ${intake.status}`, {
        status: intake.status,
        action,
      });
}

const emit = (
  intake: BusinessIntake,
  patch: Partial<BusinessIntake>,
  eventType: string,
  actor: string,
  at: bigint,
  detail: Readonly<Record<string, string>> = {},
): IntakeTransition => ({
  intake: { ...intake, ...patch },
  event: { eventType, actor, atEpochSeconds: at, detail },
});

// -- Open -------------------------------------------------------------------------

export interface OpenIntakeInput {
  readonly intakeId: string;
  readonly tenantId: string;
  readonly entity: IntakeEntity;
  readonly request: IntakeRequest;
  readonly parties: readonly Omit<IntakeParty, 'identity' | 'screening'>[];
}

/**
 * Open an intake. The amount is in the tenant's base currency (passed by the
 * caller from onboarding, never from the form); every party is a reference
 * with a display name; at least one party may sign; ownership adds up to at
 * most the whole.
 */
export function openIntake(
  input: OpenIntakeInput,
  tenantCurrency: CurrencyCode,
  actor: string,
  at: bigint,
): Result<IntakeTransition> {
  if (!INTAKE_ID_SHAPE.test(input.intakeId)) return bad('INTAKE_ID_MALFORMED', 'An intake id is INT- and digits');
  const e = input.entity;
  if (!LICENCE_SHAPE.test(e.tradeLicence))
    return bad('TRADE_LICENCE_MALFORMED', 'The trade licence number is letters, digits, slashes and dashes');
  if (!CODE_SHAPE.test(e.issuingAuthority))
    return bad('ISSUING_AUTHORITY_REQUIRED', 'The licensing authority is recorded by its code');
  if (!nonEmpty(e.businessNameEn)) return bad('BUSINESS_NAME_REQUIRED', 'The business name in English is required');
  if (!CODE_SHAPE.test(e.sector)) return bad('SECTOR_REQUIRED', 'The sector is recorded by its code');
  if (!Number.isInteger(e.yearsInOperation) || e.yearsInOperation < 0 || e.yearsInOperation > 200)
    return bad('YEARS_IN_OPERATION_INVALID', 'Years in operation is a whole number');
  if (e.taxRegistrationNumber !== undefined && !/^\d{15}$/.test(e.taxRegistrationNumber))
    return bad('TRN_MALFORMED', 'A tax registration number is fifteen digits');

  const r = input.request;
  if (r.requested.currency !== tenantCurrency)
    return bad('CURRENCY_NOT_TENANTS', 'The amount is in the tenant’s base currency', {
      expected: tenantCurrency,
      given: r.requested.currency,
    });
  if (r.requested.minorUnits <= 0n) return bad('AMOUNT_NOT_POSITIVE', 'The requested amount must be positive');
  if (!Number.isInteger(r.tenorMonths) || r.tenorMonths <= 0)
    return bad('TENOR_INVALID', 'tenorMonths is a positive whole number');
  if (!Number.isInteger(r.graceMonths) || r.graceMonths < 0 || r.graceMonths >= r.tenorMonths)
    return bad('GRACE_INVALID', 'graceMonths is a whole number below the tenor');
  if (
    !Number.isInteger(r.contributionPerTenThousand) ||
    r.contributionPerTenThousand < 0 ||
    r.contributionPerTenThousand > 10_000
  )
    return bad('CONTRIBUTION_INVALID', 'contributionPerTenThousand is in [0, 10000]');
  if (!CODE_SHAPE.test(r.productCode) && !/^[a-z][a-z0-9-]{1,39}$/.test(r.productCode))
    return bad('PRODUCT_REQUIRED', 'The product is recorded by its code');
  if (!CODE_SHAPE.test(r.variantCode) || !CODE_SHAPE.test(r.purpose))
    return bad('VARIANT_OR_PURPOSE_REQUIRED', 'The variant and purpose are recorded by their codes');

  if (input.parties.length === 0) return bad('PARTIES_REQUIRED', 'Name the owners and signatories');
  const refs = new Set<string>();
  let owned = 0;
  for (const p of input.parties) {
    if (!REF_SHAPE.test(p.partyRef))
      return bad('PARTY_REF_INVALID', 'A party is recorded by a reference', { partyRef: p.partyRef });
    if (p.partyRef === 'ENTITY') return bad('PARTY_REF_INVALID', 'ENTITY names the business, not a party');
    if (refs.has(p.partyRef)) return bad('PARTY_REF_DUPLICATE', 'Each party appears once', { partyRef: p.partyRef });
    refs.add(p.partyRef);
    if (!nonEmpty(p.displayName)) return bad('PARTY_NAME_REQUIRED', 'Each party has a display name');
    if (
      !Number.isInteger(p.ownershipPerTenThousand) ||
      p.ownershipPerTenThousand < 0 ||
      p.ownershipPerTenThousand > 10_000
    )
      return bad('OWNERSHIP_INVALID', 'Ownership is per ten thousand, in [0, 10000]', { partyRef: p.partyRef });
    if (p.role === 'SIGNATORY' && p.ownershipPerTenThousand > 0)
      return bad('OWNERSHIP_ROLE_MISMATCH', 'A party who owns a share is an owner', { partyRef: p.partyRef });
    if (p.role !== 'SIGNATORY' && p.ownershipPerTenThousand === 0)
      return bad('OWNERSHIP_ROLE_MISMATCH', 'An owner holds a share', { partyRef: p.partyRef });
    owned += p.ownershipPerTenThousand;
  }
  if (owned > 10_000) return bad('OWNERSHIP_ABOVE_WHOLE', 'Ownership adds up to at most 100%');
  if (!input.parties.some((p) => p.role !== 'OWNER'))
    return bad('SIGNATORY_REQUIRED', 'At least one party is authorised to sign for the business');
  if (containsIdentityNumber(input, REGISTRATION_FIELDS, input.entity.tradeLicence))
    return bad('IDENTITY_NUMBER_IN_PAYLOAD', 'An identity number does not belong in the intake; record a reference');

  const intake: BusinessIntake = {
    intakeId: input.intakeId,
    tenantId: input.tenantId,
    status: 'DRAFT',
    entity: input.entity,
    request: input.request,
    parties: input.parties.map((p) => ({ ...p })),
    consents: [],
    openedBy: actor,
    openedAtEpochSeconds: at,
  };
  return ok({
    intake,
    event: {
      eventType: 'INTAKE_OPENED',
      actor,
      atEpochSeconds: at,
      detail: { tradeLicence: e.tradeLicence, issuingAuthority: e.issuingAuthority },
    },
  });
}

// -- Consent ----------------------------------------------------------------------

const isSubject = (intake: BusinessIntake, subject: string): boolean =>
  subject === 'ENTITY' || intake.parties.some((p) => p.partyRef === subject);

/** Whether a consent of `type` for `subject` is on the intake. */
export const hasConsent = (intake: BusinessIntake, subject: string, type: IntakeConsentType): boolean =>
  intake.consents.some((c) => c.subject === subject && c.type === type);

/** Record a consent the subject gave (its evidence by reference). A check that needs it is refused without it. */
export function recordConsent(
  intake: BusinessIntake,
  consent: {
    readonly consentId: string;
    readonly type: IntakeConsentType;
    readonly subject: string;
    readonly evidenceRef: string;
  },
  actor: string,
  at: bigint,
): Result<IntakeTransition> {
  const o = open(intake, 'Record a consent');
  if (!o.ok) return o;
  if (!isSubject(intake, consent.subject))
    return bad('CONSENT_SUBJECT_UNKNOWN', 'A consent is given by the business or one of its parties');
  if (!REF_SHAPE.test(consent.consentId) || !REF_SHAPE.test(consent.evidenceRef))
    return bad('CONSENT_REF_INVALID', 'A consent and its evidence are recorded by reference');
  if (containsIdentityNumber(consent))
    return bad('IDENTITY_NUMBER_IN_PAYLOAD', 'An identity number does not belong in a consent; record a reference');
  if (hasConsent(intake, consent.subject, consent.type))
    return bad('CONSENT_ALREADY_RECORDED', 'This consent is already on the intake', {
      subject: consent.subject,
      type: consent.type,
    });
  const capture: ConsentCapture = { ...consent, capturedBy: actor, atEpochSeconds: at };
  return ok(
    emit(intake, { consents: [...intake.consents, capture] }, 'CONSENT_RECORDED', actor, at, {
      consentId: consent.consentId,
      type: consent.type,
      subject: consent.subject,
    }),
  );
}

// -- Checks -----------------------------------------------------------------------

const checkRef = (ref: string): Result<true> =>
  REF_SHAPE.test(ref) ? ok(true) : bad('CHECK_REF_INVALID', 'A check is recorded by the provider’s reference');

/** The registry's answer for the trade licence. Recorded whatever the status; only ACTIVE lets the intake hand over. */
export function recordRegistryCheck(
  intake: BusinessIntake,
  check: Omit<RegistryCheck, 'atEpochSeconds'>,
  actor: string,
  at: bigint,
): Result<IntakeTransition> {
  const o = open(intake, 'Record the registry check');
  if (!o.ok) return o;
  const r = checkRef(check.lookupRef);
  if (!r.ok) return r;
  return ok(
    emit(intake, { registry: { ...check, atEpochSeconds: at } }, 'REGISTRY_CHECKED', actor, at, {
      status: check.status,
      lookupRef: check.lookupRef,
      source: check.source,
    }),
  );
}

/** A party's identity verification. Refused without that party's identity-verification consent. */
export function recordIdentityCheck(
  intake: BusinessIntake,
  partyRef: string,
  check: Omit<IdentityCheck, 'atEpochSeconds'>,
  actor: string,
  at: bigint,
): Result<IntakeTransition> {
  const o = open(intake, 'Record an identity check');
  if (!o.ok) return o;
  if (!intake.parties.some((p) => p.partyRef === partyRef))
    return bad('PARTY_UNKNOWN', 'Identity is verified for a party of this intake', { partyRef });
  if (!hasConsent(intake, partyRef, 'IDENTITY_VERIFICATION'))
    return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'Identity is verified only with the party’s consent', {
      partyRef,
      type: 'IDENTITY_VERIFICATION',
    });
  const r = checkRef(check.verificationRef);
  if (!r.ok) return r;
  const identity: IdentityCheck = { ...check, atEpochSeconds: at };
  return ok(
    emit(
      intake,
      { parties: intake.parties.map((p) => (p.partyRef === partyRef ? { ...p, identity } : p)) },
      'IDENTITY_CHECKED',
      actor,
      at,
      { partyRef, verified: String(check.verified), verificationRef: check.verificationRef, source: check.source },
    ),
  );
}

/**
 * Screening of the business (`ENTITY`) or a party. Refused without the
 * subject's screening consent. A REJECT declines the intake: nothing more is
 * done for an applicant the screening rejected.
 */
export function recordScreening(
  intake: BusinessIntake,
  subject: string,
  check: Omit<ScreeningCheck, 'atEpochSeconds' | 'clearance'>,
  actor: string,
  at: bigint,
): Result<IntakeTransition> {
  const o = open(intake, 'Record a screening result');
  if (!o.ok) return o;
  if (!isSubject(intake, subject)) return bad('SCREENING_SUBJECT_UNKNOWN', 'Screen the business or one of its parties');
  if (!hasConsent(intake, subject, 'SCREENING'))
    return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'Screening runs only with the subject’s consent', {
      subject,
      type: 'SCREENING',
    });
  const r = checkRef(check.resultRef);
  if (!r.ok) return r;
  const screening: ScreeningCheck = { ...check, atEpochSeconds: at };
  const patch: Partial<BusinessIntake> =
    subject === 'ENTITY'
      ? { entityScreening: screening }
      : { parties: intake.parties.map((p) => (p.partyRef === subject ? { ...p, screening } : p)) };
  const detail = { subject, outcome: check.outcome, resultRef: check.resultRef, source: check.source };
  if (check.outcome === 'REJECT')
    return ok(
      emit(
        intake,
        { ...patch, status: 'DECLINED', declined: { reason: 'SCREENING_REJECT', atEpochSeconds: at } },
        'DECLINED_BY_SCREENING',
        actor,
        at,
        detail,
      ),
    );
  return ok(emit(intake, patch, 'SCREENED', actor, at, detail));
}

/** A second person clears a REFER, with the reason. The officer who opened the intake does not clear its referrals. */
export function clearScreeningReferral(
  intake: BusinessIntake,
  subject: string,
  clearance: { readonly clearedBy: string; readonly reason: string },
  at: bigint,
): Result<IntakeTransition> {
  const o = open(intake, 'Clear a screening referral');
  if (!o.ok) return o;
  const current =
    subject === 'ENTITY' ? intake.entityScreening : intake.parties.find((p) => p.partyRef === subject)?.screening;
  if (current?.outcome !== 'REFER' || current.clearance !== undefined)
    return bad('NOTHING_TO_CLEAR', 'Only an uncleared referral is cleared', { subject });
  if (clearance.clearedBy === intake.openedBy)
    return reject(
      'OP-DETERMINACY',
      'FOUR_EYES_SELF_CLEARANCE',
      'The officer who opened the intake does not clear its referrals',
    );
  if (clearance.reason.trim().length < 3) return bad('CLEARANCE_REASON_REQUIRED', 'A clearance records its reason');
  if (containsIdentityNumber(clearance.reason))
    return bad('IDENTITY_NUMBER_IN_PAYLOAD', 'An identity number does not belong in a clearance reason');
  const cleared: ScreeningCheck = {
    ...current,
    clearance: { clearedBy: clearance.clearedBy, reason: clearance.reason.trim(), atEpochSeconds: at },
  };
  const patch: Partial<BusinessIntake> =
    subject === 'ENTITY'
      ? { entityScreening: cleared }
      : { parties: intake.parties.map((p) => (p.partyRef === subject ? { ...p, screening: cleared } : p)) };
  return ok(
    emit(intake, patch, 'SCREENING_REFERRAL_CLEARED', clearance.clearedBy, at, {
      subject,
      reason: clearance.reason.trim(),
    }),
  );
}

/**
 * The beneficial-owner declaration: every party at or above the regulatory
 * threshold must be declared, and only parties of the intake can be. The
 * threshold comes from the jurisdiction's configuration, with its citation.
 */
export function declareBeneficialOwners(
  intake: BusinessIntake,
  declaration: { readonly declaredBy: string; readonly evidenceRef: string; readonly uboRefs: readonly string[] },
  thresholdPerTenThousand: number,
  actor: string,
  at: bigint,
): Result<IntakeTransition> {
  const o = open(intake, 'Declare the beneficial owners');
  if (!o.ok) return o;
  if (!intake.parties.some((p) => p.partyRef === declaration.declaredBy && p.role !== 'OWNER'))
    return bad('UBO_DECLARANT_NOT_SIGNATORY', 'The declaration is made by a party authorised to sign');
  if (!REF_SHAPE.test(declaration.evidenceRef))
    return bad('CHECK_REF_INVALID', 'The declaration’s evidence is a reference');
  const unknown = declaration.uboRefs.filter((r) => !intake.parties.some((p) => p.partyRef === r));
  if (unknown.length > 0)
    return bad('UBO_NOT_A_PARTY', 'A declared beneficial owner is a party of the intake', {
      unknown: unknown.join(','),
    });
  const undeclared = intake.parties
    .filter((p) => p.ownershipPerTenThousand >= thresholdPerTenThousand && !declaration.uboRefs.includes(p.partyRef))
    .map((p) => p.partyRef);
  if (undeclared.length > 0)
    return reject('OP-LIMIT', 'UBO_OWNER_UNDECLARED', 'Every owner at or above the threshold is a beneficial owner', {
      undeclared: undeclared.join(','),
      thresholdPerTenThousand: String(thresholdPerTenThousand),
    });
  return ok(
    emit(
      intake,
      { ubo: { ...declaration, uboRefs: [...declaration.uboRefs], atEpochSeconds: at } },
      'BENEFICIAL_OWNERS_DECLARED',
      actor,
      at,
      {
        declaredBy: declaration.declaredBy,
        uboRefs: declaration.uboRefs.join(','),
        evidenceRef: declaration.evidenceRef,
      },
    ),
  );
}

/**
 * The tax authority's answer for the business's TRN. Recorded whatever the
 * status and never a KYB gap: VAT registration is mandatory only above a
 * turnover threshold, so an unregistered business is not an ineligible one.
 * The credit assessment reads it as information.
 */
export function recordTaxCheck(
  intake: BusinessIntake,
  check: Omit<TaxCheck, 'atEpochSeconds'>,
  actor: string,
  at: bigint,
  /** Saudi Arabia: the zakat certificate is checked by the commercial registration, so no tax number is needed. */
  byRegistration = false,
): Result<IntakeTransition> {
  const o = open(intake, 'Record the tax registration check');
  if (!o.ok) return o;
  if (!byRegistration && intake.entity.taxRegistrationNumber === undefined)
    return bad('TRN_NOT_RECORDED', 'The tax registration is checked by the TRN recorded at intake');
  const r = checkRef(check.reference);
  if (!r.ok) return r;
  return ok(
    emit(intake, { taxCheck: { ...check, atEpochSeconds: at } }, 'TAX_REGISTRATION_CHECKED', actor, at, {
      status: check.status,
      reference: check.reference,
      source: check.source,
    }),
  );
}

// -- Readiness and hand-over -------------------------------------------------------

/** One thing still standing between the intake and credit assessment. */
export interface KybGap {
  readonly code:
    | 'REGISTRY_NOT_CHECKED'
    | 'REGISTRY_NOT_ACTIVE'
    | 'IDENTITY_NOT_VERIFIED'
    | 'SCREENING_NOT_RUN'
    | 'SCREENING_NOT_CLEAR'
    | 'UBO_NOT_DECLARED'
    | 'BUREAU_CONSENT_MISSING';
  readonly subject?: string;
}

const screeningPasses = (s: ScreeningCheck | undefined): boolean =>
  s !== undefined && (s.outcome === 'CLEAR' || (s.outcome === 'REFER' && s.clearance !== undefined));

/** What KYB still lacks, in a fixed order. Empty means the intake may hand over. */
export function kybGaps(intake: BusinessIntake): readonly KybGap[] {
  const gaps: KybGap[] = [];
  if (intake.registry === undefined) gaps.push({ code: 'REGISTRY_NOT_CHECKED' });
  else if (intake.registry.status !== 'ACTIVE') gaps.push({ code: 'REGISTRY_NOT_ACTIVE' });
  if (intake.entityScreening === undefined) gaps.push({ code: 'SCREENING_NOT_RUN', subject: 'ENTITY' });
  else if (!screeningPasses(intake.entityScreening)) gaps.push({ code: 'SCREENING_NOT_CLEAR', subject: 'ENTITY' });
  for (const p of intake.parties) {
    if (p.identity?.verified !== true) gaps.push({ code: 'IDENTITY_NOT_VERIFIED', subject: p.partyRef });
    if (p.screening === undefined) gaps.push({ code: 'SCREENING_NOT_RUN', subject: p.partyRef });
    else if (!screeningPasses(p.screening)) gaps.push({ code: 'SCREENING_NOT_CLEAR', subject: p.partyRef });
  }
  if (intake.ubo === undefined) gaps.push({ code: 'UBO_NOT_DECLARED' });
  if (!hasConsent(intake, 'ENTITY', 'CREDIT_BUREAU')) gaps.push({ code: 'BUREAU_CONSENT_MISSING', subject: 'ENTITY' });
  return gaps;
}

/**
 * The references the stage-5 application carries as its upstream
 * verification: the registry lookup, every identity verification, every
 * screening result, and every consent id (the assessment's bureau entry must
 * cite a consent recorded here).
 */
export function verificationRefsOf(intake: BusinessIntake): readonly string[] {
  const refs: string[] = [];
  if (intake.registry !== undefined) refs.push(intake.registry.lookupRef);
  if (intake.entityScreening !== undefined) refs.push(intake.entityScreening.resultRef);
  if (intake.taxCheck !== undefined) refs.push(intake.taxCheck.reference);
  for (const p of intake.parties) {
    if (p.identity !== undefined) refs.push(p.identity.verificationRef);
    if (p.screening !== undefined) refs.push(p.screening.resultRef);
  }
  for (const c of intake.consents) refs.push(c.consentId);
  return [...new Set(refs)];
}

/** Hand the intake over to credit assessment as `applicationId`. Refused while any KYB gap remains. */
export function markHandedOver(
  intake: BusinessIntake,
  applicationId: string,
  actor: string,
  at: bigint,
): Result<IntakeTransition> {
  const o = open(intake, 'Hand over to credit assessment');
  if (!o.ok) return o;
  const gaps = kybGaps(intake);
  if (gaps.length > 0)
    return reject('OP-DETERMINACY', 'KYB_INCOMPLETE', 'Every KYB check passes before credit assessment', {
      gaps: gaps.map((g) => (g.subject === undefined ? g.code : `${g.code}:${g.subject}`)).join(','),
    });
  return ok(
    emit(
      intake,
      { status: 'HANDED_OVER', handedOver: { applicationId, atEpochSeconds: at } },
      'HANDED_TO_ASSESSMENT',
      actor,
      at,
      {
        applicationId,
      },
    ),
  );
}

/** Withdraw the intake at the applicant's request, with the reason. */
export function withdrawIntake(
  intake: BusinessIntake,
  reason: string,
  actor: string,
  at: bigint,
): Result<IntakeTransition> {
  const o = open(intake, 'Withdraw the intake');
  if (!o.ok) return o;
  if (reason.trim().length < 3) return bad('WITHDRAWAL_REASON_REQUIRED', 'A withdrawal records its reason');
  if (containsIdentityNumber(reason))
    return bad('IDENTITY_NUMBER_IN_PAYLOAD', 'An identity number does not belong in a withdrawal reason');
  return ok(
    emit(
      intake,
      { status: 'WITHDRAWN', withdrawn: { reason: reason.trim(), atEpochSeconds: at } },
      'INTAKE_WITHDRAWN',
      actor,
      at,
      {
        reason: reason.trim(),
      },
    ),
  );
}
