/**
 * The SME intake service (stages 1–4): what the officer's intake and KYB
 * screens call. The domain is core/origination/business-intake.ts; this module
 * holds a tenant's working set, calls the KYB rails through their ports
 * (intake-rails.ts), records consents in the tenant's ledger, and hands a
 * completed intake over to credit assessment through the same hand-over an
 * upstream customer record uses (business.ts `handOver`).
 *
 * Persistence: with a database (migration 0025) each change is written in one
 * transaction before the screen that reports it is shown; without one the
 * working set is this process's memory, and says so.
 */
import { type TenantCode, loadBeneficialOwnership, loadTenantOnboarding } from '@sanad/config/loader.ts';
import { type ConsentRecord, grant } from '@sanad/core/consent/consent.ts';
import { consentLedger } from '@sanad/core/consent/ledger.ts';
import { type CurrencyCode, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import {
  type BusinessIntake,
  type IntakeConsentType,
  type IntakeEvent,
  type IntakeParty,
  type IntakeTransition,
  type KybGap,
  type PartyRole,
  clearScreeningReferral,
  declareBeneficialOwners,
  kybGaps,
  markHandedOver,
  openIntake,
  recordConsent,
  recordIdentityCheck,
  recordRegistryCheck,
  recordScreening,
  verificationRefsOf,
  withdrawIntake,
} from '@sanad/core/origination/business-intake.ts';

import { handOver, mutateBusiness } from './business.ts';
import { type IntakeVersion, loadIntakeBook, saveIntakeChanges } from './intake-persistence.ts';
import { kybRails } from './intake-rails.ts';
import { persistencePool } from './persistence.ts';
import { developmentAttestation } from './store.ts';

// =============================================================================
// Working set
// =============================================================================

interface IntakeBook {
  loaded: boolean;
  readonly intakes: Map<string, { intake: BusinessIntake; version?: IntakeVersion }>;
  readonly events: Map<string, (IntakeEvent & { readonly intakeId: string })[]>;
  consents: ConsentRecord[];
}

const KEY = Symbol.for('sanad.ops.intake');
type State = { readonly books: Map<string, IntakeBook>; readonly locks: Map<string, Promise<unknown>> };
const state: State = ((globalThis as Record<symbol, unknown>)[KEY] as State | undefined) ?? {
  books: new Map(),
  locks: new Map(),
};
(globalThis as Record<symbol, unknown>)[KEY] = state;

function bookOf(tenant: string): IntakeBook {
  let book = state.books.get(tenant);
  if (book === undefined) {
    book = { loaded: false, intakes: new Map(), events: new Map(), consents: [] };
    state.books.set(tenant, book);
  }
  return book;
}

async function hydrate(tenant: TenantCode): Promise<IntakeBook> {
  const book = bookOf(tenant);
  if (book.loaded) return book;
  const pool = persistencePool();
  if (pool !== undefined) {
    const stored = await loadIntakeBook(pool, tenant);
    for (const s of stored.intakes) book.intakes.set(s.intake.intakeId, { intake: s.intake, version: s.version });
    book.consents = [...stored.consents];
  }
  book.loaded = true;
  return book;
}

/** One change at a time per tenant in this process; the database's version check covers the rest. */
async function withLock<T>(tenant: string, fn: () => Promise<T>): Promise<T> {
  const previous = state.locks.get(tenant) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  state.locks.set(
    tenant,
    run.catch(() => undefined),
  );
  return run;
}

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

function currencyOf(tenant: TenantCode): Result<CurrencyCode> {
  const onboarding = loadTenantOnboarding(tenant);
  return onboarding.ok ? ok(onboarding.value.baseCurrency) : onboarding;
}

/**
 * Apply a transition (and any consents it created) and write it. A save that
 * finds the intake changed by someone else is refused as STALE_INTAKE and the
 * working set reloaded, so the officer sees the current state.
 */
async function commit(
  tenant: TenantCode,
  book: IntakeBook,
  t: IntakeTransition,
  consents: readonly ConsentRecord[] = [],
): Promise<Result<BusinessIntake>> {
  const entry = book.intakes.get(t.intake.intakeId);
  const event = { ...t.event, intakeId: t.intake.intakeId };
  const pool = persistencePool();
  if (pool !== undefined) {
    const saved = await saveIntakeChanges(pool, tenant, {
      intakes: [{ intake: t.intake, ...(entry?.version === undefined ? {} : { expected: entry.version }) }],
      events: [event],
      consents: consents.map((c) => ({ ...c, contextRef: t.intake.intakeId, createdBy: t.event.actor })),
    });
    if (saved.kind === 'STALE') {
      book.loaded = false;
      book.intakes.clear();
      return fail('STALE_INTAKE', 'Someone else changed this intake first; nothing was written');
    }
    const version = saved.versions.get(t.intake.intakeId);
    book.intakes.set(t.intake.intakeId, { intake: t.intake, ...(version === undefined ? {} : { version }) });
  } else {
    book.intakes.set(t.intake.intakeId, { intake: t.intake });
  }
  book.consents = [...book.consents, ...consents];
  book.events.set(t.intake.intakeId, [...(book.events.get(t.intake.intakeId) ?? []), event]);
  return ok(t.intake);
}

async function withIntake(
  tenant: TenantCode,
  intakeId: string,
  fn: (book: IntakeBook, intake: BusinessIntake) => Promise<Result<BusinessIntake>>,
): Promise<Result<BusinessIntake>> {
  return withLock(tenant, async () => {
    const book = await hydrate(tenant);
    const entry = book.intakes.get(intakeId);
    if (entry === undefined)
      return fail('INTAKE_NOT_FOUND', 'No intake with that id for this institution', { intakeId });
    return fn(book, entry.intake);
  });
}

const attest = () => Promise.resolve(developmentAttestation());
const nowSeconds = () => Number(developmentAttestation().epochSeconds);

// =============================================================================
// Reads
// =============================================================================

export interface IntakeView {
  readonly intake: BusinessIntake;
  readonly gaps: readonly KybGap[];
  /** Whether the KYB rails can be called here: false outside a permitted demonstration until they are live. */
  readonly railsAvailable: boolean;
  readonly railsSource?: 'LIVE' | 'FIXTURE';
  readonly events: readonly IntakeEvent[];
}

export async function listIntakes(tenant: TenantCode): Promise<readonly BusinessIntake[]> {
  const book = await hydrate(tenant);
  return [...book.intakes.values()].map((e) => e.intake).sort((a, b) => b.intakeId.localeCompare(a.intakeId));
}

export async function getIntake(tenant: TenantCode, intakeId: string): Promise<IntakeView | undefined> {
  const book = await hydrate(tenant);
  const entry = book.intakes.get(intakeId);
  if (entry === undefined) return undefined;
  const rails = await kybRails(
    tenant,
    consentLedger(() => book.consents, attest),
    attest,
    nowSeconds,
  );
  return {
    intake: entry.intake,
    gaps: kybGaps(entry.intake),
    railsAvailable: rails !== undefined,
    ...(rails === undefined ? {} : { railsSource: rails.source }),
    events: book.events.get(intakeId) ?? [],
  };
}

// =============================================================================
// Changes
// =============================================================================

export interface OpenIntakeForm {
  readonly tradeLicence: string;
  readonly issuingAuthority: string;
  readonly businessNameEn: string;
  readonly businessNameAr?: string;
  readonly sector: string;
  readonly yearsInOperation: number;
  readonly productCode: string;
  readonly variantCode: string;
  readonly purpose: string;
  readonly requestedMinorUnits: bigint;
  readonly tenorMonths: number;
  readonly graceMonths: number;
  readonly contributionPerTenThousand: number;
  readonly parties: readonly {
    readonly partyRef: string;
    readonly displayName: string;
    readonly role: PartyRole;
    readonly ownershipPerTenThousand: number;
  }[];
}

/** Open an intake under the next id. The amount is in the tenant's base currency, from onboarding. */
export async function openIntakeFor(
  tenant: TenantCode,
  form: OpenIntakeForm,
  actor: string,
): Promise<Result<BusinessIntake>> {
  const currency = currencyOf(tenant);
  if (!currency.ok) return currency;
  return withLock(tenant, async () => {
    const book = await hydrate(tenant);
    const next = Math.max(0, ...[...book.intakes.keys()].map((id) => Number(id.slice(4)))) + 1;
    const t = openIntake(
      {
        intakeId: `INT-${String(next).padStart(6, '0')}`,
        tenantId: tenant,
        entity: {
          tradeLicence: form.tradeLicence,
          issuingAuthority: form.issuingAuthority,
          businessNameEn: form.businessNameEn,
          ...(form.businessNameAr === undefined ? {} : { businessNameAr: form.businessNameAr }),
          sector: form.sector,
          yearsInOperation: form.yearsInOperation,
        },
        request: {
          productCode: form.productCode,
          variantCode: form.variantCode,
          purpose: form.purpose,
          requested: money(form.requestedMinorUnits, currency.value),
          tenorMonths: form.tenorMonths,
          graceMonths: form.graceMonths,
          contributionPerTenThousand: form.contributionPerTenThousand,
        },
        parties: form.parties,
      },
      currency.value,
      actor,
      developmentAttestation().epochSeconds,
    );
    if (!t.ok) return t;
    return commit(tenant, book, t.value);
  });
}

const PURPOSE: Readonly<Record<IntakeConsentType, string>> = {
  IDENTITY_VERIFICATION: 'Verify identity against the national identity authority for this financing application',
  SCREENING: 'Sanctions, PEP and adverse-media screening for this financing application',
  CREDIT_BUREAU: 'Credit bureau enquiry for this financing application',
};

/**
 * Record a consent the subject gave at the branch, with its evidence by
 * reference. It goes into the tenant's consent ledger, which the rail adapters
 * check before every consent-gated call.
 */
export async function recordIntakeConsent(
  tenant: TenantCode,
  intakeId: string,
  consent: { readonly type: IntakeConsentType; readonly subject: string; readonly evidenceRef: string },
  actor: string,
): Promise<Result<BusinessIntake>> {
  return withIntake(tenant, intakeId, async (book, intake) => {
    const at = developmentAttestation();
    const consentId = `${intakeId}:${consent.subject}:${consent.type}`.toLowerCase();
    const record = grant({
      consentId,
      tenantId: tenant,
      counterpartyId: consent.subject,
      type: consent.type,
      version: '1',
      purpose: PURPOSE[consent.type],
      channel: 'BRANCH',
      evidenceRef: consent.evidenceRef,
      grantedAt: at,
    });
    if (!record.ok) return record;
    const t = recordConsent(intake, { consentId, ...consent }, actor, at.epochSeconds);
    if (!t.ok) return t;
    return commit(tenant, book, t.value, [record.value]);
  });
}

const unavailable = (rail: string): Result<never> =>
  reject('OP-DETERMINACY', 'RAIL_UNAVAILABLE', 'The rail is not connected here; nothing was checked', { rail });

const consentFor = (intake: BusinessIntake, subject: string, type: IntakeConsentType): string | undefined =>
  intake.consents.find((c) => c.subject === subject && c.type === type)?.consentId;

/** Look the trade licence up in the business registry and record the answer. */
export async function runRegistryCheck(
  tenant: TenantCode,
  intakeId: string,
  actor: string,
): Promise<Result<BusinessIntake>> {
  return withIntake(tenant, intakeId, async (book, intake) => {
    const rails = await kybRails(
      tenant,
      consentLedger(() => book.consents, attest),
      attest,
      nowSeconds,
    );
    if (rails === undefined) return unavailable('BUSINESS_REGISTRY');
    const r = await rails.registry.lookup({
      tenantId: tenant,
      commercialRegistration: intake.entity.tradeLicence,
      correlationId: intakeId,
    });
    if (!r.ok) return r;
    const at = developmentAttestation().epochSeconds;
    let t: Result<IntakeTransition>;
    if (r.value.kind === 'ANSWERED')
      t = recordRegistryCheck(
        intake,
        { status: r.value.value.status, lookupRef: r.value.value.lookupRef, source: rails.source },
        actor,
        at,
      );
    else if (r.value.kind === 'REFUSED' && r.value.code === 'NOT_FOUND')
      t = recordRegistryCheck(
        intake,
        { status: 'NOT_FOUND', lookupRef: `not-found:${intake.entity.tradeLicence}`, source: rails.source },
        actor,
        at,
      );
    else return unavailable('BUSINESS_REGISTRY');
    if (!t.ok) return t;
    return commit(tenant, book, t.value);
  });
}

/** Verify a party's identity with the identity authority, under the party's consent. */
export async function runIdentityCheck(
  tenant: TenantCode,
  intakeId: string,
  partyRef: string,
  actor: string,
): Promise<Result<BusinessIntake>> {
  return withIntake(tenant, intakeId, async (book, intake) => {
    const consentId = consentFor(intake, partyRef, 'IDENTITY_VERIFICATION');
    if (consentId === undefined)
      return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'Identity is verified only with the party’s consent', {
        partyRef,
        type: 'IDENTITY_VERIFICATION',
      });
    const rails = await kybRails(
      tenant,
      consentLedger(() => book.consents, attest),
      attest,
      nowSeconds,
    );
    if (rails === undefined) return unavailable('IDENTITY_VERIFICATION');
    const r = await rails.identity.verify({
      tenantId: tenant,
      applicantRef: partyRef,
      consentId,
      correlationId: intakeId,
    });
    if (!r.ok) return r;
    if (r.value.kind !== 'ANSWERED') return unavailable('IDENTITY_VERIFICATION');
    const t = recordIdentityCheck(
      intake,
      partyRef,
      { verified: r.value.value.verified, verificationRef: r.value.value.verificationRef, source: rails.source },
      actor,
      developmentAttestation().epochSeconds,
    );
    if (!t.ok) return t;
    return commit(tenant, book, t.value);
  });
}

/** Screen the business (`ENTITY`) or a party for sanctions, PEP and adverse media, under the subject's consent. */
export async function runScreening(
  tenant: TenantCode,
  intakeId: string,
  subject: string,
  actor: string,
): Promise<Result<BusinessIntake>> {
  return withIntake(tenant, intakeId, async (book, intake) => {
    const consentId = consentFor(intake, subject, 'SCREENING');
    if (consentId === undefined)
      return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'Screening runs only with the subject’s consent', {
        subject,
        type: 'SCREENING',
      });
    const rails = await kybRails(
      tenant,
      consentLedger(() => book.consents, attest),
      attest,
      nowSeconds,
    );
    if (rails === undefined) return unavailable('SCREENING');
    const r = await rails.screening.screen({
      tenantId: tenant,
      counterpartyId: subject,
      commercialRegistration: intake.entity.tradeLicence,
      signatoryRefs: intake.parties.filter((p) => p.role !== 'OWNER').map((p) => p.partyRef),
      checks: ['SANCTIONS', 'PEP', 'ADVERSE_MEDIA'],
      consentId,
      correlationId: intakeId,
    });
    if (!r.ok) return r;
    if ('kind' in r.value) return unavailable('SCREENING');
    const t = recordScreening(
      intake,
      subject,
      { outcome: r.value.overall, resultRef: r.value.screeningReference, source: rails.source },
      actor,
      developmentAttestation().epochSeconds,
    );
    if (!t.ok) return t;
    return commit(tenant, book, t.value);
  });
}

/** A second person clears a screening referral, with the reason. */
export async function clearReferral(
  tenant: TenantCode,
  intakeId: string,
  subject: string,
  reason: string,
  actor: string,
): Promise<Result<BusinessIntake>> {
  return withIntake(tenant, intakeId, async (book, intake) => {
    const t = clearScreeningReferral(
      intake,
      subject,
      { clearedBy: actor, reason },
      developmentAttestation().epochSeconds,
    );
    if (!t.ok) return t;
    return commit(tenant, book, t.value);
  });
}

/** Record the beneficial-owner declaration against the jurisdiction's cited threshold. */
export async function declareOwners(
  tenant: TenantCode,
  intakeId: string,
  declaration: { readonly declaredBy: string; readonly evidenceRef: string; readonly uboRefs: readonly string[] },
  actor: string,
): Promise<Result<BusinessIntake>> {
  const rule = loadBeneficialOwnership(tenant);
  if (!rule.ok) return rule;
  return withIntake(tenant, intakeId, async (book, intake) => {
    const t = declareBeneficialOwners(
      intake,
      declaration,
      rule.value.ownershipThresholdPerTenThousand,
      actor,
      developmentAttestation().epochSeconds,
    );
    if (!t.ok) return t;
    return commit(tenant, book, t.value);
  });
}

export async function withdrawIntakeFor(
  tenant: TenantCode,
  intakeId: string,
  reason: string,
  actor: string,
): Promise<Result<BusinessIntake>> {
  return withIntake(tenant, intakeId, async (book, intake) => {
    const t = withdrawIntake(intake, reason, actor, developmentAttestation().epochSeconds);
    if (!t.ok) return t;
    return commit(tenant, book, t.value);
  });
}

/** The stage-5 application id an intake hands over as: SN- and the intake's own digits. */
export const applicationIdFor = (intakeId: string): string => `SN-${intakeId.slice(4)}`;

/**
 * Hand a completed intake over to credit assessment. The application is
 * created through the same hand-over an upstream customer record uses,
 * idempotent on `intake:<id>`, so a retry after a failed save finds the same
 * application rather than making a second one.
 */
export async function handOverIntake(
  tenant: TenantCode,
  intakeId: string,
  actor: string,
): Promise<Result<{ readonly intake: BusinessIntake; readonly applicationId: string }>> {
  const book = await hydrate(tenant);
  const entry = book.intakes.get(intakeId);
  if (entry === undefined) return fail('INTAKE_NOT_FOUND', 'No intake with that id for this institution', { intakeId });
  const intake = entry.intake;
  const gaps = kybGaps(intake);
  if (gaps.length > 0)
    return fail('KYB_INCOMPLETE', 'Every KYB check passes before credit assessment', {
      gaps: gaps.map((g) => (g.subject === undefined ? g.code : `${g.code}:${g.subject}`)).join(','),
    });
  const applicationId = applicationIdFor(intakeId);
  const owners = intake.parties.filter((p: IntakeParty) => p.role !== 'SIGNATORY');
  const signatory = intake.parties.find((p) => p.role !== 'OWNER');
  const created = await mutateBusiness(tenant, () =>
    handOver(
      tenant,
      {
        applicationId,
        upstreamRef: `intake:${intakeId}`,
        applicant: {
          businessNameEn: intake.entity.businessNameEn,
          ...(intake.entity.businessNameAr === undefined ? {} : { businessNameAr: intake.entity.businessNameAr }),
          registrationRef: intake.entity.tradeLicence,
          sector: intake.entity.sector,
          yearsInOperation: intake.entity.yearsInOperation,
          owners: owners.map((p) => ({ displayName: p.displayName, ref: p.partyRef })),
          upstreamVerificationRefs: verificationRefsOf(intake),
        },
        productCode: intake.request.productCode,
        variantCode: intake.request.variantCode,
        purpose: intake.request.purpose,
        requestedMinorUnits: intake.request.requested.minorUnits,
        tenorMonths: intake.request.tenorMonths,
        graceMonths: intake.request.graceMonths,
        contributionPerTenThousand: intake.request.contributionPerTenThousand,
        ...(signatory === undefined ? {} : { contact: { partyRef: signatory.partyRef } }),
      },
      actor,
    ),
  );
  if (!created.ok) return created;
  const marked = await withIntake(tenant, intakeId, async (b, current) => {
    const t = markHandedOver(current, applicationId, actor, developmentAttestation().epochSeconds);
    if (!t.ok) return t;
    return commit(tenant, b, t.value);
  });
  if (!marked.ok) return marked;
  return ok({ intake: marked.value, applicationId });
}

/** Clears this process's working set. Tests only. */
export function resetIntakeStore(): void {
  state.books.clear();
  state.locks.clear();
}
