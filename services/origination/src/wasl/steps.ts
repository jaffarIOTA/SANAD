/**
 * The Murabaha sequence's steps (Wasl W2, shared from W3): from DRAFT to the
 * executed sale, one step at a time, by the people whose step each is — the
 * institution's operations on the workbench, the distributor in the SME
 * portal.
 *
 * Every step is the domain's. The legs, the gates, the offer and the
 * acceptance run through the same activities the Temporal workflow runs
 * (adapters/workflow-temporal/activities.ts), which call the one transition
 * for each step in products/murabaha-scf/sequencing/transitions.ts — so no
 * surface has a path to a later state than the sequencing engine allows, and
 * no step here takes a role, an override or a reason to skip a gate. What a
 * surface adds is what a person supplies: the decision to take the step, the
 * evidence, the signature.
 *
 * Evidence that needs a rail or a store (the e-invoicing authority, the
 * object store) is recorded by the workbench through `step`; the rest is here.
 *
 * Time: this module reads no clock. Every instant comes from the host-clock
 * stand-in for the timestamping authority where that is permitted (SR-006),
 * and a step's instants are kept strictly later than the transaction's last
 * event, as an authority's are.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  type TenantCode,
  type WaslParties,
  loadBoardPositions,
  loadProductCatalogue,
  loadWaslParties,
} from '@sanad/config/loader.ts';
import type { EvidenceRecord, EvidenceSource, EvidenceType } from '@sanad/core/evidence/evidence.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { entryFor } from '@sanad/core/products/catalogue.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';
import { type MurabahaTerms, murabahaScf, repaymentSchedule } from '@sanad/products/murabaha-scf/index.ts';
import type { ContractLeg, LegType } from '@sanad/products/murabaha-scf/legs/leg.ts';
import type { Instalment } from '@sanad/products/murabaha-scf/obligation/obligation.ts';
import { verifyProspectiveParties } from '@sanad/products/murabaha-scf/parties/distinctness.ts';
import type { Transaction, TransactionCore } from '@sanad/products/murabaha-scf/sequencing/state.ts';
import { rejectTrade, reserveLimit, submit } from '@sanad/products/murabaha-scf/sequencing/transitions.ts';
import { type BoardPositions, templateApproved } from '@sanad/products/murabaha-scf/structures/board-positions.ts';
import type { StructureDefinition } from '@sanad/products/murabaha-scf/structures/definition.ts';

import {
  type MurabahaActivities,
  createMurabahaActivities,
} from '../../../../adapters/workflow-temporal/activities.ts';
import type { Attestation, LegPreparer } from '../../../../adapters/workflow-temporal/ports.ts';
import { SequenceRefusal } from '../../../../adapters/workflow-temporal/programs/murabaha.ts';
import { ummAlQuraIso } from '../hijri.ts';
import { hostClockInstant } from '../host-clock.ts';
import {
  type TransactionRecord,
  type TransactionView,
  WASL_PRODUCT,
  hydrate,
  structureOf,
  viewOf,
  waslPool,
  withLock,
} from './book.ts';
import {
  type ObligationWrite,
  type TransactionEventRow,
  encodeEvidence,
  encodeState,
  recordStep,
} from './persistence.ts';

export const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

/** A step offered in a state it does not belong to. A screen offers each step only where it applies. */
export const notNow = (state: string): Result<never> =>
  fail('STEP_NOT_AVAILABLE', 'This step does not apply to the transaction as it stands', { state });

// -- What a step works with -----------------------------------------------------------

export interface StepContext {
  readonly tenant: TenantCode;
  readonly record: TransactionRecord;
  /** Every transaction in the tenant's book, this one included: the programme's exposure is read from them. */
  readonly book: readonly TransactionRecord[];
  readonly parties: WaslParties;
  /** The distributor's verified registration: the buyer on the wa'd, the offer and the acceptance. */
  readonly distributorCr: string;
  readonly structure: StructureDefinition;
  readonly board: BoardPositions;
  /** The product's terms as the catalogue stood when the transaction opened: what its schedule is cut from. */
  readonly terms: MurabahaTerms;
  readonly attestation: StepAttestation;
}

/** What a step produced, before it is written. The transaction is the same object when the step only records evidence. */
export interface StepOutcome {
  readonly eventType: string;
  readonly transaction: Transaction;
  readonly evidence?: EvidenceRecord;
  readonly supersedes?: string;
  readonly obligation?: ObligationWrite;
  readonly detail?: Readonly<Record<string, string>>;
}

export interface StepAttestation extends Attestation {
  /** The step's latest attested instant, attesting one if the step has not. */
  occurred(): Promise<TsaInstant>;
}

/**
 * Attested instants for one step, each strictly later than the transaction's
 * last event and than the one before it — the host-clock stand-in's
 * "strictly-later successor" (SR-006), as an authority's tokens would be.
 */
function attestationAfter(record: TransactionRecord): StepAttestation {
  let last = record.events.reduce((m, e) => (e.occurredAtEpochSeconds > m ? e.occurredAtEpochSeconds : m), 0n);
  let latest: TsaInstant | undefined;
  const attest = (): Promise<TsaInstant> => {
    const observed = hostClockInstant().epochSeconds;
    last = observed > last ? observed : last + 1n;
    latest = hostClockInstant(last);
    return Promise.resolve(latest);
  };
  return { attest, occurred: () => (latest === undefined ? attest() : Promise.resolve(latest)) };
}

const legsOf = (t: Transaction): readonly ContractLeg[] => ('legs' in t ? t.legs : []);

/** The catalogue's terms for the transaction's programme, as they stood when it opened: effective-dated, so reproducible. */
function termsAtOpening(tenant: TenantCode, record: TransactionRecord): Result<MurabahaTerms> {
  const opened = record.events.find((e) => e.eventType === 'TRANSACTION_OPENED');
  const catalogue = loadProductCatalogue(tenant);
  if (!catalogue.ok) return catalogue;
  const entry = entryFor(
    catalogue.value,
    WASL_PRODUCT,
    record.transaction.core.programmeId,
    opened?.occurredAtEpochSeconds ?? 0n,
  );
  if (!entry.ok) return entry;
  return murabahaScf.validateTerms(entry.value.terms);
}

/** The schedule a transaction's sale states and its obligation books: the product's own split, from the stored maturity. */
export function scheduleOf(terms: MurabahaTerms, core: TransactionCore): readonly Instalment[] {
  return repaymentSchedule(terms, core.pricing, core.tenorDays, core.maturityDateGregorian, ummAlQuraIso);
}

/** The schedule for a transaction in the book, for a screen; undefined where the catalogue no longer resolves. */
export function scheduleFor(tenant: TenantCode, record: TransactionRecord): readonly Instalment[] | undefined {
  const terms = termsAtOpening(tenant, record);
  return terms.ok ? scheduleOf(terms.value, record.transaction.core) : undefined;
}

/**
 * Run one step under the tenant's lock: load the transaction and the
 * configuration it runs under, let the step decide, then write what it
 * decided — the leg, evidence or obligation, the state, the event — and only
 * then change the book.
 */
export async function step(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  work: (c: StepContext) => Promise<Result<StepOutcome>>,
): Promise<Result<TransactionView>> {
  return withLock(tenant, async () => {
    const book = await hydrate(tenant);
    const record = book.records.get(transactionRef);
    if (record === undefined) return fail('TRANSACTION_NOT_FOUND', 'No such transaction', { transactionRef });
    const parties = loadWaslParties(tenant);
    if (!parties.ok) return parties;
    const structure = structureOf(tenant);
    if (!structure.ok) return structure;
    const board = loadBoardPositions(tenant);
    if (!board.ok) return board;
    const terms = termsAtOpening(tenant, record);
    if (!terms.ok) return terms;
    const before = record.transaction;
    const distributor = parties.value.distributors.find((d) => d.counterpartyId === before.core.counterpartyId);
    if (distributor === undefined)
      return fail('COUNTERPARTY_NOT_CONFIGURED', 'The distributor on this transaction is not onboarded');
    const attestation = attestationAfter(record);
    const out = await work({
      tenant,
      record,
      book: [...book.records.values()],
      parties: parties.value,
      distributorCr: distributor.registrationNo,
      structure: structure.value,
      board: board.value,
      terms: terms.value,
      attestation,
    });
    if (!out.ok) return out;

    const after = out.value.transaction;
    const moved = after !== before;
    const leg = legsOf(after).length > legsOf(before).length ? legsOf(after).at(-1) : undefined;
    const { evidence, supersedes, obligation } = out.value;
    const event: TransactionEventRow = {
      eventType: out.value.eventType,
      fromState: moved ? before.state : null,
      toState: moved ? after.state : null,
      actor,
      detail: {
        ...out.value.detail,
        ...(moved ? { state: encodeState(after) } : {}),
        ...(evidence === undefined ? {} : { evidence: encodeEvidence(evidence) }),
        ...(supersedes === undefined ? {} : { supersedes }),
        ...(obligation === undefined ? {} : { obligation: encodeObligation(obligation) }),
      },
      occurredAtEpochSeconds: (await attestation.occurred()).epochSeconds,
    };
    const pool = waslPool();
    if (pool !== undefined) {
      const saved = await recordStep(pool, tenant, {
        transactionRef,
        expectedState: before.state,
        toState: after.state,
        event,
        ...(leg === undefined ? {} : { leg }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(supersedes === undefined ? {} : { supersedes }),
        ...(obligation === undefined ? {} : { obligation }),
        ...(after.state === 'POSSESSION_CONFIRMED' ? { riskPeriodStartAt: after.riskPeriodStartAt } : {}),
        ...(after.state === 'SALE_OFFERED' ? { saleOfferedAt: after.saleOfferedAt } : {}),
        correlationId: before.core.correlationId,
      });
      if (!saved.ok) return saved;
    }
    const kept = record.evidence.map((e) =>
      e.evidenceId === supersedes && evidence !== undefined ? { ...e, supersededBy: evidence.evidenceId } : e,
    );
    const next: TransactionRecord = {
      ...record,
      transaction: after,
      evidence: evidence === undefined ? kept : [...kept, evidence],
      events: [...record.events, event],
    };
    book.records.set(transactionRef, next);
    return ok(viewOf(tenant, next));
  });
}

/** The obligation as its event records it: amounts as minor-unit strings. */
function encodeObligation(o: ObligationWrite): Record<string, unknown> {
  return {
    obligationId: o.obligationId,
    bookingRef: o.bookingRef,
    currency: o.total.currency,
    totalMinor: o.total.minorUnits.toString(),
    instalments: o.instalments.map((i) => ({
      sequenceNumber: i.sequenceNumber,
      dueDateGregorian: i.dueDateGregorian,
      dueDateHijri: i.dueDateHijri,
      amountMinor: i.amount.minorUnits.toString(),
    })),
  };
}

// -- The domain's steps, through the activities ---------------------------------------

/** A refusal the activities raised, back in the domain's terms (`CONTROL: detail`). */
function refusalOf(e: SequenceRefusal): Result<never> {
  const m = /^(SH-\d{2}|OP-[A-Z]+|PLAT-\d{2}): (.*)$/.exec(e.message);
  if (m === null) return fail(e.reason, e.message);
  return reject(m[1] as 'OP-DETERMINACY', e.reason, m[2] ?? e.message);
}

type ActivityRef = { readonly tenantId: string; readonly transactionId: string };

/**
 * One activity, bound to this transaction: it loads the record, calls the
 * one transition for its step against a fresh attestation, and saves — here,
 * into the outcome rather than a store, so the step writes it with its event.
 */
export async function viaActivity(
  c: StepContext,
  run: (acts: MurabahaActivities, ref: ActivityRef) => Promise<unknown>,
): Promise<Result<Transaction>> {
  let saved: Transaction | undefined;
  const acts = createMurabahaActivities({
    transactions: {
      load: () => Promise.resolve(c.record.transaction),
      save: (t) => {
        saved = t;
        return Promise.resolve();
      },
    },
    evidence: { forTransaction: () => Promise.resolve(c.record.evidence) },
    structures: { definition: () => Promise.resolve(ok(c.structure)) },
    legs: legPreparer(c),
    attestation: c.attestation,
  });
  const core = c.record.transaction.core;
  try {
    await run(acts, { tenantId: core.tenantId, transactionId: core.transactionId });
  } catch (error) {
    if (!(error instanceof SequenceRefusal)) throw error;
    return error.reason === 'STATE_MISMATCH' ? notNow(c.record.transaction.state) : refusalOf(error);
  }
  return saved === undefined ? notNow(c.record.transaction.state) : ok(saved);
}

const activityStep =
  (
    eventType: string,
    run: (acts: MurabahaActivities, ref: ActivityRef, c: StepContext) => Promise<unknown>,
    detail?: Readonly<Record<string, string>>,
  ) =>
  (tenant: TenantCode, transactionRef: string, actor: string): Promise<Result<TransactionView>> =>
    step(tenant, transactionRef, actor, async (c) => {
      const t = await viaActivity(c, (acts, ref) => run(acts, ref, c));
      return t.ok ? ok({ eventType, transaction: t.value, ...(detail === undefined ? {} : { detail }) }) : t;
    });

/** The wa'd: the distributor's binding promise to buy the goods once the institution owns them. */
export const executeWaad = activityStep('LEG_EXECUTED', (a, r) => a.executeLeg(r, 'WAAD'));
/** The purchase: the institution buys the goods from the anchor. */
export const executePurchase = activityStep('LEG_EXECUTED', (a, r) => a.executeLeg(r, 'PURCHASE'));
/** Gate 1: passes only on valid, third-party ownership evidence. */
export const acquireOwnership = activityStep('GATE_PASSED', (a, r) => a.acquireOwnership(r), {
  gateId: 'GATE_1_OWNERSHIP',
});
/** Gate 2: passes only on valid possession evidence; the risk-holding interval starts from it. */
export const confirmPossession = activityStep('GATE_PASSED', (a, r) => a.confirmPossession(r), {
  gateId: 'GATE_2_POSSESSION',
});
/** Gate 3 and the offer: all three gates re-evaluated, then the offer leg, open for the configured validity. */
export const offerSale = activityStep('SALE_OFFERED', (a, r, c) => a.offerSale(r, c.parties.saleOfferValiditySeconds));
/** An offer not accepted in time lapses; the domain checks it really has expired. */
export const lapseSaleOffer = activityStep('OFFER_LAPSED', (a, r) => a.lapseOffer(r));

/**
 * The distributor's acceptance: strictly after the offer and before it
 * lapses, the goods to a party other than the one they were bought from. The
 * signature that authorises it — the identity service's assertion, bound to
 * the offer instrument's hash — is the caller's to obtain; it is recorded
 * here with the acceptance.
 */
export function acceptSaleOffer(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  signature?: { readonly assertionId: string; readonly offerHash: string; readonly signatoryRef: string },
): Promise<Result<TransactionView>> {
  return activityStep(
    'OFFER_ACCEPTED',
    (a, r) => a.acceptOffer(r),
    signature === undefined
      ? undefined
      : {
          identityAssertionId: signature.assertionId,
          signedOfferHash: signature.offerHash,
          signatoryRef: signature.signatoryRef,
        },
  )(tenant, transactionRef, actor);
}

/** Unwind before the sale executes, recording what happens to goods the institution already holds (BR-D14). */
export function unwindTransaction(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  goodsDisposition: string,
): Promise<Result<TransactionView>> {
  return activityStep('UNWOUND', (a, r) => a.unwind(r, goodsDisposition.trim()))(tenant, transactionRef, actor);
}

// -- The legs' instruments ------------------------------------------------------------

/** What each leg's instrument states, in minor units. A profit amount, never a rate. */
function legFigures(legType: LegType, c: StepContext, core: TransactionCore): Readonly<Record<string, unknown>> {
  const p = core.pricing;
  switch (legType) {
    case 'PURCHASE':
      return { price: p.costAmount.minorUnits.toString() };
    case 'SALE_OFFER':
      // The offer discloses cost, profit and the fixed sale price, and how the price falls due (SH-15).
      return {
        cost: p.costAmount.minorUnits.toString(),
        profit: p.profitAmount.minorUnits.toString(),
        salePrice: p.salePriceAmount.minorUnits.toString(),
        maturityGregorian: core.maturityDateGregorian,
        maturityHijri: core.maturityDateHijri,
        instalments: scheduleOf(c.terms, core).map((i) => ({
          due: i.dueDateGregorian,
          dueHijri: i.dueDateHijri,
          amount: i.amount.minorUnits.toString(),
        })),
      };
    default:
      return { salePrice: p.salePriceAmount.minorUnits.toString() };
  }
}

/**
 * The document pipeline for one leg: the board-approved template version for
 * the leg's document (SH-17), the instrument's content — parties, goods,
 * figures, its predecessor's hash, its attested instant — and the SHA-256 of
 * that content as the leg's hash. The seller on the purchase is the anchor
 * that issued the invoice; the buyer on every other leg is the distributor.
 * The PDF rendition through the document engine is not yet produced here.
 */
function legPreparer(c: StepContext): LegPreparer {
  return {
    async prepare(p): Promise<Result<ContractLeg>> {
      const approved = c.board.approvedTemplates.find((t) => t.document === p.document);
      if (approved === undefined || !templateApproved(c.board, approved.templateVersionId, p.document))
        return reject('SH-17', 'TEMPLATE_NOT_APPROVED', 'The board has approved no template version for this leg', {
          document: p.document,
        });
      const core = p.transaction.core;
      const role: ContractLeg['counterpartyRole'] = p.legType === 'PURCHASE' ? 'SELLER' : 'BUYER';
      const counterpartyCr = role === 'SELLER' ? core.tradeReference.issuerCr : c.distributorCr;
      const executedAt = await c.attestation.attest();
      const instrument = {
        document: p.document,
        templateVersionId: approved.templateVersionId,
        transaction: core.transactionId,
        leg: p.legType,
        sequenceNo: p.sequenceNo,
        institutionCr: c.parties.institution.registrationNo,
        counterpartyRole: role,
        counterpartyCr,
        goods: {
          invoiceUuid: core.tradeReference.invoiceUuid ?? null,
          invoiceHash: core.tradeReference.invoiceHash ?? null,
        },
        currency: core.pricing.costAmount.currency,
        figures: legFigures(p.legType, c, core),
        prevLegHash: p.previousContentHash ?? null,
        executedAt: executedAt.epochSeconds.toString(),
        authority: executedAt.authorityId,
      };
      return ok({
        legId: randomUUID(),
        tenantId: core.tenantId,
        transactionId: core.transactionId,
        legType: p.legType,
        sequenceNo: p.sequenceNo,
        documentId: randomUUID(),
        contentHash: createHash('sha256').update(JSON.stringify(instrument)).digest('hex'),
        ...(p.previousContentHash === undefined ? {} : { prevLegHash: p.previousContentHash }),
        executedAt,
        tsaTokenDigest: executedAt.tokenDigest,
        templateVersionId: approved.templateVersionId,
        counterpartyRole: role,
        counterpartyCr,
        immutable: true,
      });
    },
  };
}

// -- Trade validation and the limit ---------------------------------------------------

/** States in which a transaction's cost counts against its programme: from the hold until it is settled or unwound. */
const HOLDING: ReadonlySet<string> = new Set([
  'LIMIT_RESERVED',
  'WAAD_EXECUTED',
  'PURCHASE_EXECUTED',
  'OWNERSHIP_ACQUIRED',
  'POSSESSION_CONFIRMED',
  'SALE_OFFERED',
  'OFFER_LAPSED',
  'EXECUTED',
  'ACTIVE',
  'DELINQUENT',
  'HARDSHIP',
  'RESCHEDULED',
]);

/**
 * Validate the trade and hold its cost against the programme. A trade whose
 * parties are not distinct is REJECTED, for good; a programme without room
 * is refused and the transaction stays in DRAFT, to be tried again.
 * Facility-level holds (core.facility, core.limit_reservation) come with W5.
 */
export function validateAndReserve(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => Promise.resolve(tradeValidation(c, transactionRef)));
}

function tradeValidation(c: StepContext, transactionRef: string): Result<StepOutcome> {
  const t = c.record.transaction;
  if (t.state !== 'DRAFT') return notNow(t.state);
  const validating = submit(t);
  const distinct = verifyProspectiveParties(c.structure, {
    SELLER: t.core.tradeReference.issuerCr,
    BUYER: c.distributorCr,
  });
  if (!distinct.ok) return ok({ eventType: 'TRADE_REJECTED', transaction: rejectTrade(validating, [distinct.error]) });
  const programme = c.parties.programmes.find((p) => p.programmeId === t.core.programmeId);
  if (programme === undefined)
    return fail('PROGRAMME_NOT_CONFIGURED', 'The transaction names a programme that is not configured');
  const cost = t.core.pricing.costAmount.minorUnits;
  const held = c.book
    .filter((r) => r.transaction.core.programmeId === programme.programmeId && HOLDING.has(r.transaction.state))
    .reduce((s, r) => s + r.transaction.core.pricing.costAmount.minorUnits, 0n);
  if (held + cost > programme.programmeLimitMinorUnits)
    return reject('OP-LIMIT', 'PROGRAMME_LIMIT_EXCEEDED', 'The programme has no room for this cost; nothing was held', {
      programmeId: programme.programmeId,
    });
  return ok({
    eventType: 'LIMIT_RESERVED',
    transaction: reserveLimit(validating, `programme:${programme.programmeId}:${transactionRef}`),
    detail: { heldAgainst: 'PROGRAMME_LIMIT', programmeId: programme.programmeId, amountMinor: cost.toString() },
  });
}

// -- Gate 2: who may decide possession evidence ----------------------------------------

/** Where possession evidence may come from. The e-invoicing authority evidences ownership, not possession. */
export const POSSESSION_SOURCES: readonly EvidenceSource[] = ['ANCHOR_SYSTEM', 'PARTNER', 'UPLOAD'];

/** The evidence types the structure admits for possession (gate 2's `anyOf`), in its order. */
export function possessionEvidenceTypes(tenant: TenantCode): readonly EvidenceType[] {
  const s = structureOf(tenant);
  const gate = s.ok ? s.value.gates.find((g) => g.id === 'GATE_2_POSSESSION') : undefined;
  return gate?.kind === 'EVIDENCE' ? gate.requires.anyOf : [];
}

/** Who recorded a piece of evidence: the actor on the event that first recorded it. */
export function recorderOf(record: TransactionRecord, evidenceId: string): string | undefined {
  return record.events.find(
    (e) =>
      e.eventType === 'EVIDENCE_RECORDED' &&
      (e.detail['evidence'] as { evidenceId?: unknown } | undefined)?.evidenceId === evidenceId,
  )?.actor;
}

/**
 * A checker's decision on PENDING possession evidence: a new record, VALID
 * or INVALID, superseding the pending one. The fact keeps the instant it was
 * captured at — the risk-holding interval runs from possession, not from the
 * review. Never the person who recorded it.
 */
export function decidePossessionEvidence(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  evidenceId: string,
  decision: 'VALID' | 'INVALID',
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => {
    const t = c.record.transaction;
    if (t.state !== 'OWNERSHIP_ACQUIRED') return Promise.resolve(notNow(t.state));
    const pending = c.record.evidence.find(
      (e) => e.evidenceId === evidenceId && e.supersededBy === undefined && e.validationStatus === 'PENDING',
    );
    if (pending === undefined)
      return Promise.resolve(fail('EVIDENCE_NOT_PENDING', 'That evidence is not awaiting a decision'));
    if (recorderOf(c.record, evidenceId) === actor)
      return Promise.resolve(
        fail('FOUR_EYES_SELF_VERIFICATION', 'The person who recorded evidence may not validate it'),
      );
    const decided: EvidenceRecord = { ...pending, evidenceId: randomUUID(), validationStatus: decision };
    return Promise.resolve(
      ok({
        eventType: decision === 'VALID' ? 'EVIDENCE_VALIDATED' : 'EVIDENCE_REFUSED',
        transaction: t,
        evidence: decided,
        supersedes: pending.evidenceId,
      }),
    );
  });
}
