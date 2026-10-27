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

import { type TenantCode, type WaslParties, loadProductCatalogue } from '@sanad/config/loader.ts';
import type { EvidenceRecord, EvidenceSource, EvidenceType } from '@sanad/core/evidence/evidence.ts';
import type { Money } from '@sanad/core/kernel/money.ts';
import type { OutboxEvent } from '@sanad/core/outbox/outbox.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { entryFor } from '@sanad/core/products/catalogue.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';
import { type MurabahaTerms, murabahaScf, repaymentSchedule } from '@sanad/products/murabaha-scf/index.ts';
import { legAnchorDigest } from '@sanad/products/murabaha-scf/legs/anchor.ts';
import type { ContractLeg, LegType } from '@sanad/products/murabaha-scf/legs/leg.ts';
import { checkDrawdown } from '@sanad/products/murabaha-scf/limits/drawdown-limits.ts';
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
import { type TimeSource, TimestampUnavailable, stepDigest, timeSourceFor } from '../attested-time.ts';
import { ummAlQuraIso } from '../hijri.ts';
import { HOST_CLOCK_AUTHORITY, hostClockInstant } from '../host-clock.ts';
import { originationApproval } from '../shariah/approvals.ts';
import { incidentsStoppingTheSale } from '../shariah/incidents.ts';
import { resolveConcentration } from './concentration.ts';
import { resolveBoard, resolveWaslParties } from './configuration.ts';
import { HOLDING, PURCHASED, exposureOf } from './exposure.ts';
import { facilityFor } from './facilities.ts';
import { sellerSettlement } from './instructions.ts';
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
  type CharityWrite,
  type LimitMovement,
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

/** The states a step reaches by committing the institution to a new sale: each needs the approval in force (SH-17). */
const NEW_COMMITMENTS: ReadonlySet<string> = new Set(['LIMIT_RESERVED', 'WAAD_EXECUTED', 'PURCHASE_EXECUTED']);

/** The states a step reaches by committing to the sale: an open MATERIAL incident stops each (W6b-1). */
const SALE_COMMITMENTS: ReadonlySet<string> = new Set(['WAAD_EXECUTED', 'PURCHASE_EXECUTED', 'SALE_OFFERED']);

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
  /** What the obligation's paid amount moves by (W4: a receipt adds, a return takes off). */
  readonly paidDelta?: Money;
  /** External side effects this step causes, written with it (the transactional outbox). */
  readonly outbox?: readonly OutboxEvent[];
  /** A charity ledger entry raised by a collected late amount, or its disbursement (W4b-2). */
  readonly charity?: CharityWrite;
  readonly detail?: Readonly<Record<string, string>>;
}

export interface StepAttestation extends Attestation {
  /** The step's instant: attested once, over the step's own digest, the first time it is asked for. */
  attest(): Promise<TsaInstant>;
  /** The step's latest attested instant, attesting one if the step has not. */
  occurred(): Promise<TsaInstant>;
  /** A fresh instant attested over an artefact (a leg's anchor, an evidence file's SHA-256), its token retained. */
  attestOver(sha256Hex: string): Promise<TsaInstant>;
  /** The token behind an instant this step attested, by its digest; none for the host clock. */
  tokenFor(tokenDigest: string): Uint8Array | undefined;
}

/** How long to wait for an authority's next second before refusing, when its genTime is not yet strictly later. */
const LATER_RETRIES = 3;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Attested instants for one step, each strictly later than the transaction's
 * last recorded event (SR-006), so a step's leg is later than the leg before
 * it, which an earlier step recorded. Instants within one step may share a
 * second, as an authority's do. The host clock is given its "strictly-later
 * successor"; an authority's time is its own, so a genTime that is not yet
 * later is asked again a moment on, then refused.
 */
function attestationAfter(record: TransactionRecord, source: TimeSource, transactionRef: string): StepAttestation {
  const floor = record.events.reduce((m, e) => (e.occurredAtEpochSeconds > m ? e.occurredAtEpochSeconds : m), 0n);
  let latest: TsaInstant | undefined;
  let stepInstant: TsaInstant | undefined;
  const tokens = new Map<string, Uint8Array>();
  const attestOver = async (sha256Hex: string): Promise<TsaInstant> => {
    for (let attempt = 0; ; attempt++) {
      const a = await source.attest(sha256Hex);
      if (a === undefined) throw new TimestampUnavailable(source.kind);
      let instant = a.instant;
      if (instant.epochSeconds <= floor) {
        if (source.kind === 'HOST_CLOCK') instant = hostClockInstant(floor + 1n);
        else if (attempt < LATER_RETRIES) {
          await pause(400);
          continue;
        } else throw new TimestampUnavailable(source.kind);
      }
      if (a.token !== undefined) tokens.set(instant.tokenDigest, a.token);
      if (latest === undefined || instant.epochSeconds >= latest.epochSeconds) latest = instant;
      return instant;
    }
  };
  const attest = async (): Promise<TsaInstant> => {
    stepInstant ??= await attestOver(stepDigest(record.transaction.core.tenantId, transactionRef, String(floor)));
    return stepInstant;
  };
  return {
    attest,
    attestOver,
    occurred: () => (latest === undefined ? attest() : Promise.resolve(latest)),
    tokenFor: (d) => tokens.get(d),
  };
}

const legsOf = (t: Transaction): readonly ContractLeg[] => ('legs' in t ? t.legs : []);

/** The catalogue's terms for the transaction's programme, as they stood when it opened: effective-dated, so reproducible. */
export function termsAtOpening(tenant: TenantCode, record: TransactionRecord): Result<MurabahaTerms> {
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
  const source = await timeSourceFor(tenant);
  return withLock(tenant, () => withoutTimeRefused(() => stepUnderLock(tenant, transactionRef, actor, work, source)));
}

/** No attested instant, no step: the step is refused and nothing is written (SH-06, SDD §4.9). */
async function withoutTimeRefused<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof TimestampUnavailable)) throw error;
    return reject('SH-06', 'TIMESTAMP_UNAVAILABLE', 'No trusted time could be attested; nothing was recorded', {
      source: error.sourceKind,
    });
  }
}

async function stepUnderLock(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  work: (c: StepContext) => Promise<Result<StepOutcome>>,
  source: TimeSource,
): Promise<Result<TransactionView>> {
  const book = await hydrate(tenant);
  const record = book.records.get(transactionRef);
  if (record === undefined) return fail('TRANSACTION_NOT_FOUND', 'No such transaction', { transactionRef });
  // The programmes and the board's positions in force now: an approved Admin revision binds from its moment (W5b).
  const parties = await resolveWaslParties(tenant);
  if (!parties.ok) return parties;
  const structure = structureOf(tenant);
  if (!structure.ok) return structure;
  const board = (await resolveBoard(tenant)).value;
  if (!board.ok) return board;
  const terms = termsAtOpening(tenant, record);
  if (!terms.ok) return terms;
  const before = record.transaction;
  const distributor = parties.value.distributors.find((d) => d.counterpartyId === before.core.counterpartyId);
  if (distributor === undefined)
    return fail('COUNTERPARTY_NOT_CONFIGURED', 'The distributor on this transaction is not onboarded');
  const attestation = attestationAfter(record, source, transactionRef);
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
  // SH-17, BR-F02: holding the limit, the wa'd and the purchase commit the institution to a new sale, and are
  // refused once the approval the transaction was opened under is not in force. What follows the purchase —
  // completing the sale of goods already owned, servicing — continues under it, or the goods are unwound.
  if (moved && NEW_COMMITMENTS.has(after.state)) {
    const approval = await originationApproval(
      tenant,
      WASL_PRODUCT,
      before.core.shariahApprovalId,
      await attestation.occurred(),
    );
    if (!approval.ok) return approval;
  }
  // W6b-1: an open MATERIAL Shariah incident on the transaction stops its commitment to the sale until it is
  // closed (decided 26 October 2026). Unwinding is not stopped; a transaction already sold is not touched.
  if (moved && SALE_COMMITMENTS.has(after.state)) {
    const stopping = await incidentsStoppingTheSale(tenant, transactionRef);
    const first = stopping[0];
    if (first !== undefined)
      return reject('SH-17', 'SHARIAH_INCIDENT_OPEN', 'A material Shariah incident is open on this transaction', {
        incidentRef: first.incidentRef,
      });
  }
  const leg = legsOf(after).length > legsOf(before).length ? legsOf(after).at(-1) : undefined;
  const { evidence, supersedes, obligation, paidDelta, outbox, charity } = out.value;
  // Buying the goods finances the invoice, once (SH-10): checked here for every path to the purchase, and again
  // by the registry's unique constraint as the purchase is written.
  if (after.state === 'PURCHASE_EXECUTED' && before.state !== 'PURCHASE_EXECUTED') {
    const other = invoiceFinancedBy(record, [...book.records.values()]);
    if (other !== undefined)
      return reject('SH-10', 'DUPLICATE_FINANCING', 'This invoice is already financed by another transaction', {
        existingReference: other,
      });
  }
  const limit = limitMovement(before.state, after.state);
  const event: TransactionEventRow = {
    eventType: out.value.eventType,
    fromState: moved ? before.state : null,
    toState: moved ? after.state : null,
    actor,
    detail: eventDetail(out.value, moved),
    occurredAtEpochSeconds: (await attestation.occurred()).epochSeconds,
  };
  const pool = waslPool();
  if (pool !== undefined) {
    const saved = await recordStep(pool, tenant, {
      transactionRef,
      expectedState: before.state,
      toState: after.state,
      event,
      ...(leg === undefined ? {} : { leg, legToken: attestation.tokenFor(leg.tsaTokenDigest) }),
      ...(evidence === undefined
        ? {}
        : { evidence, evidenceToken: attestation.tokenFor(evidence.capturedAt.tokenDigest) }),
      ...(supersedes === undefined ? {} : { supersedes }),
      ...(obligation === undefined ? {} : { obligation }),
      ...(paidDelta === undefined ? {} : { paidDelta }),
      ...(outbox === undefined ? {} : { outbox }),
      ...(charity === undefined ? {} : { charity }),
      ...(limit === undefined ? {} : { limit }),
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
}

/**
 * What a move between states does to the distributor's facility in the database (W5a): the hold at trade
 * validation; the hold consumed into utilisation when the goods are bought; the hold released by an unwind before
 * the purchase; utilisation repaid by settlement or by an unwind after the purchase. Nothing for any other move.
 */
export function limitMovement(from: string, to: string): LimitMovement | undefined {
  if (from === to) return undefined;
  if (to === 'LIMIT_RESERVED') return 'HOLD';
  if (to === 'PURCHASE_EXECUTED') return 'CONSUME';
  if (to === 'UNWIND') return PURCHASED.has(from) ? 'REPAY' : 'RELEASE';
  if (to === 'SETTLED') return 'REPAY';
  return undefined;
}

/** Another transaction financing the same invoice, from its hold on (SH-10): its reference, or undefined. */
function invoiceFinancedBy(record: TransactionRecord, book: readonly TransactionRecord[]): string | undefined {
  const invoice = record.transaction.core.tradeReference.invoiceUuid;
  if (invoice === undefined) return undefined;
  return book.find(
    (r) =>
      r.transactionRef !== record.transactionRef &&
      r.transaction.core.tradeReference.invoiceUuid === invoice &&
      (HOLDING.has(r.transaction.state) || PURCHASED.has(r.transaction.state)),
  )?.transactionRef;
}

/**
 * What a step's event records: the step's own detail, the state it left the
 * transaction in, and whatever it recorded — evidence, the obligation, a
 * movement of the paid amount, the side effects it queued — so the event log
 * alone rebuilds the transaction and shows what was instructed.
 */
function eventDetail(out: StepOutcome, moved: boolean): Record<string, unknown> {
  const { evidence, supersedes, obligation, paidDelta, outbox, charity } = out;
  return {
    ...(charity === undefined ? {} : { charity: encodeCharity(charity) }),
    ...out.detail,
    ...(moved ? { state: encodeState(out.transaction) } : {}),
    ...(evidence === undefined ? {} : { evidence: encodeEvidence(evidence) }),
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(obligation === undefined ? {} : { obligation: encodeObligation(obligation) }),
    ...(paidDelta === undefined ? {} : { paidDeltaMinor: paidDelta.minorUnits.toString() }),
    ...(outbox === undefined || outbox.length === 0
      ? {}
      : {
          outbox: outbox.map((o) => ({
            kind: o.kind,
            idempotencyKey: o.idempotencyKey,
            subjectRef: o.subjectRef,
            payload: o.payload,
          })),
        }),
  };
}

/** A charity write as its event records it: amounts as minor-unit strings, instants as epoch seconds. */
function encodeCharity(c: CharityWrite): Record<string, string> {
  return c.kind === 'RAISE'
    ? {
        kind: c.kind,
        entryId: c.entryId,
        reason: c.reason ?? 'LATE_PAYMENT',
        amountMinor: c.amount.minorUnits.toString(),
        currency: c.amount.currency,
        sourceRef: c.sourceRef,
        computationBasisKey: c.computationBasisKey,
        recordedAtEpoch: c.recordedAt.epochSeconds.toString(),
        recordedAtDigest: c.recordedAt.tokenDigest,
        recordedAtAuthority: c.recordedAt.authorityId,
      }
    : {
        kind: c.kind,
        entryId: c.entryId,
        recipientId: c.recipientId,
        disbursementRef: c.disbursementRef,
        disbursedAtEpoch: c.disbursedAt.epochSeconds.toString(),
      };
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
export function executePurchase(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    // The seller's payment is instructed with the purchase, in the same transaction: the institution owes the cost.
    const payment = sellerSettlement(c.parties, transactionRef, c.record.transaction.core, 0);
    if (!payment.ok) return payment;
    const t = await viaActivity(c, (a, r) => a.executeLeg(r, 'PURCHASE'));
    if (!t.ok) return t;
    return ok({
      eventType: 'LEG_EXECUTED',
      transaction: t.value,
      outbox: [payment.value],
      detail: { sellerPaymentKey: payment.value.idempotencyKey },
    });
  });
}
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
function legFigures(legType: LegType, terms: MurabahaTerms, core: TransactionCore): Readonly<Record<string, unknown>> {
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
        instalments: scheduleOf(terms, core).map((i) => ({
          due: i.dueDateGregorian,
          dueHijri: i.dueDateHijri,
          amount: i.amount.minorUnits.toString(),
        })),
      };
    default:
      return { salePrice: p.salePriceAmount.minorUnits.toString() };
  }
}

type InstrumentLeg = Pick<
  ContractLeg,
  'legType' | 'sequenceNo' | 'templateVersionId' | 'counterpartyRole' | 'counterpartyCr' | 'prevLegHash'
>;

interface InstrumentFacts {
  readonly document: string;
  readonly institutionCr: string;
  readonly terms: MurabahaTerms;
  readonly core: TransactionCore;
}

/**
 * A leg's instrument — what its template makes of the transaction's figures:
 * parties, goods, figures, its predecessor's hash — as the SHA-256 of that
 * content. One definition, so the hash a leg is executed with and the hash the
 * drift check rebuilds it to (W6b, BR-F07) are the same function of the same
 * facts.
 *
 * The instant is not in it. The authority's token is stamped over the leg's
 * anchor, which carries this hash, and the token's genTime is the leg's
 * instant: so the time is attested over the content, as a document's timestamp
 * is, rather than written inside what is timestamped — which no authority's
 * time could ever satisfy (SR-006). Version 2; see `legacyInstrumentHash`.
 */
export function instrumentHash(leg: InstrumentLeg, facts: InstrumentFacts): string {
  return createHash('sha256')
    .update(JSON.stringify({ hashVersion: 2, ...instrumentOf(leg, facts) }))
    .digest('hex');
}

/**
 * Version 1, with the instant inside: what legs the host clock attested before
 * 28 October 2026 were executed with. Only a host-clock leg may still match it
 * (`instrumentMatches`); those exist only where data is synthetic (ADR 0004).
 */
export function legacyInstrumentHash(
  leg: InstrumentLeg & Pick<ContractLeg, 'executedAt'>,
  facts: InstrumentFacts,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...instrumentOf(leg, facts),
        executedAt: leg.executedAt.epochSeconds.toString(),
        authority: leg.executedAt.authorityId,
      }),
    )
    .digest('hex');
}

/** The hash a leg should carry, rebuilt from the facts: version 2, or version 1 for a host-clock leg that matches it. */
export function rebuiltInstrumentHash(leg: ContractLeg, facts: InstrumentFacts): string {
  const current = instrumentHash(leg, facts);
  if (current === leg.contentHash || leg.executedAt.authorityId !== HOST_CLOCK_AUTHORITY) return current;
  const legacy = legacyInstrumentHash(leg, facts);
  return legacy === leg.contentHash ? legacy : current;
}

function instrumentOf(leg: InstrumentLeg, facts: InstrumentFacts): Record<string, unknown> {
  const { core } = facts;
  return {
    document: facts.document,
    templateVersionId: leg.templateVersionId,
    transaction: core.transactionId,
    leg: leg.legType,
    sequenceNo: leg.sequenceNo,
    institutionCr: facts.institutionCr,
    counterpartyRole: leg.counterpartyRole,
    counterpartyCr: leg.counterpartyCr,
    goods: {
      invoiceUuid: core.tradeReference.invoiceUuid ?? null,
      invoiceHash: core.tradeReference.invoiceHash ?? null,
    },
    currency: core.pricing.costAmount.currency,
    figures: legFigures(leg.legType, facts.terms, core),
    prevLegHash: leg.prevLegHash ?? null,
  };
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
      const instrument = {
        legType: p.legType,
        sequenceNo: p.sequenceNo,
        templateVersionId: approved.templateVersionId,
        counterpartyRole: role,
        counterpartyCr,
        ...(p.previousContentHash === undefined ? {} : { prevLegHash: p.previousContentHash }),
      };
      const unstamped = {
        ...instrument,
        legId: randomUUID(),
        tenantId: core.tenantId,
        transactionId: core.transactionId,
        documentId: randomUUID(),
        contentHash: instrumentHash(instrument, {
          document: p.document,
          institutionCr: c.parties.institution.registrationNo,
          terms: c.terms,
          core,
        }),
        immutable: true as const,
      };
      // The leg's instant is the token stamped over its anchor: its content, its place and its predecessor (SR-008).
      const executedAt = await c.attestation.attestOver(legAnchorDigest(unstamped));
      return ok({ ...unstamped, executedAt, tsaTokenDigest: executedAt.tokenDigest });
    },
  };
}

// -- Trade validation and the limit ---------------------------------------------------

/**
 * Validate the trade and hold its cost (W5a). A trade whose parties are not
 * distinct is REJECTED, for good. An invoice already financed by another
 * transaction is refused (SH-10). Then the cost must fit the distributor's
 * approved facility, the programme's limit and the concentration rules the
 * institution has chosen (products/murabaha-scf/limits/drawdown-limits.ts);
 * the first it does not fit refuses it, nothing is held, and the transaction
 * stays in DRAFT, to be tried again. With a database, the hold is also a
 * `core.limit_reservation` against the facility, whose capacity trigger is
 * the second lock (persistence.ts).
 */
export function validateAndReserve(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, (c) => tradeValidation(c, transactionRef));
}

async function tradeValidation(c: StepContext, transactionRef: string): Promise<Result<StepOutcome>> {
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
  const financed = financedElsewhere(c);
  if (financed !== undefined)
    return reject('SH-10', 'DUPLICATE_FINANCING', 'This invoice is already financed by another transaction', {
      existingReference: financed,
    });
  const at = await c.attestation.attest();
  const policy = await resolveConcentration(waslPool(), c.tenant, at.epochSeconds);
  if (!policy.ok) return policy;
  const facility = await facilityFor(c.tenant, t.core.counterpartyId, programme.programmeId);
  const exposure = exposureOf(c.book, c.parties, t.core.counterpartyId, programme.programmeId);
  const cost = t.core.pricing.costAmount.minorUnits;
  const fits = checkDrawdown(
    {
      ...exposure,
      cost,
      facilityLimit: facility?.limit.minorUnits,
      programmeLimit: programme.programmeLimitMinorUnits,
    },
    policy.value,
  );
  if (!fits.ok)
    return reject(fits.error.control, fits.error.reason, `${fits.error.detail}; nothing was held`, {
      programmeId: programme.programmeId,
      ...(fits.error.context ?? {}),
    });
  return ok({
    eventType: 'LIMIT_RESERVED',
    transaction: reserveLimit(validating, `facility:${programme.programmeId}:${transactionRef}`),
    detail: {
      heldAgainst: 'FACILITY',
      programmeId: programme.programmeId,
      facilityApprovalId: facility?.approvalId ?? '',
      amountMinor: cost.toString(),
      concentrationPolicy: policy.value.policyRef,
    },
  });
}

const financedElsewhere = (c: StepContext): string | undefined => invoiceFinancedBy(c.record, c.book);

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
