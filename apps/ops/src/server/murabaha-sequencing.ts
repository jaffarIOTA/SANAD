/**
 * The Murabaha sequence in the workbench (Wasl W2): from DRAFT to the sale
 * offer, one step at a time, by the people whose job each step is.
 *
 * Every step is the domain's. The legs, the gates and the offer run through
 * the same activities the Temporal workflow runs
 * (adapters/workflow-temporal/activities.ts), which call the one transition
 * for each step in products/murabaha-scf/sequencing/transitions.ts — so the
 * workbench has no path to a later state than the sequencing engine allows,
 * and no step here takes a role, an override or a reason to skip a gate.
 * What the workbench adds is what a person supplies: the decision to take the
 * step, and the evidence.
 *
 *   1. Trade validation and the limit. The parties are checked for
 *      distinctness before anything is bought (SH-08; a trade whose goods
 *      would go back to their seller is REJECTED here), then the cost is held
 *      against the programme's limit. Facility-level holds (core.facility,
 *      core.limit_reservation) arrive with the facilities in W5.
 *   2. The wa'd and the purchase: each its own instrument, from the
 *      board-approved template version, hashed, attested and chained (SH-07).
 *   3. Gate 1: the anchor's invoice to the institution, cleared by the
 *      e-invoicing authority — validated through the e-invoicing port, never
 *      keyed as a result.
 *   4. Gate 2: possession evidence — a delivery note, a warehouse receipt —
 *      uploaded by operations, PENDING until a different person validates it.
 *   5. Gate 3: the risk-holding interval, measured between attested instants.
 *   6. The sale offer, once all three hold; it lapses if not accepted in time,
 *      and an acquired position is unwound only with its goods' disposition.
 *
 * The distributor's acceptance (`acceptSaleOffer`) is the buyer's act; it is
 * implemented here and offered to the distributor in the SME portal (W3), not
 * on the workbench.
 *
 * Time: this module reads no clock. Every instant comes from
 * `developmentAttestation()` — the host-clock stand-in for the timestamping
 * authority where that is permitted (SR-006) — and a step's instants are kept
 * strictly later than the transaction's last event, as an authority's are.
 */
import { createHash, randomUUID } from 'node:crypto';

import { type TenantCode, type WaslParties, loadBoardPositions, loadWaslParties } from '@sanad/config/loader.ts';
import { acceptUpload } from '@sanad/core/documents/upload.ts';
import type { EvidenceRecord, EvidenceSource, EvidenceType } from '@sanad/core/evidence/evidence.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { ConsentLedger } from '@sanad/core/ports/consent-ledger.ts';
import type { EInvoicingProvider } from '@sanad/core/ports/e-invoicing.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';
import { hostClockInstant } from '@sanad/origination/host-clock.ts';
import { syntheticDemonstrationPermitted } from '@sanad/origination/profile.ts';
import type { ContractLeg, LegType } from '@sanad/products/murabaha-scf/legs/leg.ts';
import { verifyProspectiveParties } from '@sanad/products/murabaha-scf/parties/distinctness.ts';
import type { Transaction, TransactionCore } from '@sanad/products/murabaha-scf/sequencing/state.ts';
import { rejectTrade, reserveLimit, submit } from '@sanad/products/murabaha-scf/sequencing/transitions.ts';
import { type BoardPositions, templateApproved } from '@sanad/products/murabaha-scf/structures/board-positions.ts';
import type { StructureDefinition } from '@sanad/products/murabaha-scf/structures/definition.ts';

import { KsaDemonstrationTransport } from '../../../../adapters/ksa/demonstration/transport.ts';
import { ZatcaEInvoicingAdapter } from '../../../../adapters/ksa/zatca-einvoicing/adapter.ts';
import {
  type MurabahaActivities,
  createMurabahaActivities,
} from '../../../../adapters/workflow-temporal/activities.ts';
import type { Attestation, LegPreparer } from '../../../../adapters/workflow-temporal/ports.ts';
import { SequenceRefusal } from '../../../../adapters/workflow-temporal/programs/murabaha.ts';
import { objectStorageFor } from './business-storage.ts';
import { DemonstrationCredentials, demonstrationConfig } from './intake-rails.ts';
import { type TransactionEventRow, encodeEvidence, encodeState, recordStep } from './murabaha-persistence.ts';
import {
  type TransactionRecord,
  type TransactionView,
  hydrate,
  structureOf,
  viewOf,
  withLock,
} from './murabaha-transactions.ts';
import { persistencePool } from './persistence.ts';
import { developmentAttestation } from './store.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

/** A step offered in a state it does not belong to. The screen offers each step only where it applies. */
const notNow = (state: string): Result<never> =>
  fail('STEP_NOT_AVAILABLE', 'This step does not apply to the transaction as it stands', { state });

// -- What a step works with -----------------------------------------------------------

interface StepContext {
  readonly tenant: TenantCode;
  readonly record: TransactionRecord;
  /** Every transaction in the tenant's book, this one included: the programme's exposure is read from them. */
  readonly book: readonly TransactionRecord[];
  readonly parties: WaslParties;
  /** The distributor's verified registration: the buyer on the wa'd, the offer and the acceptance. */
  readonly distributorCr: string;
  readonly structure: StructureDefinition;
  readonly board: BoardPositions;
  readonly attestation: StepAttestation;
}

/** What a step produced, before it is written. The transaction is the same object when the step only records evidence. */
interface StepOutcome {
  readonly eventType: string;
  readonly transaction: Transaction;
  readonly evidence?: EvidenceRecord;
  readonly supersedes?: string;
  readonly detail?: Readonly<Record<string, string>>;
}

interface StepAttestation extends Attestation {
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
    const observed = developmentAttestation().epochSeconds;
    last = observed > last ? observed : last + 1n;
    latest = hostClockInstant(last);
    return Promise.resolve(latest);
  };
  return { attest, occurred: () => (latest === undefined ? attest() : Promise.resolve(latest)) };
}

const legsOf = (t: Transaction): readonly ContractLeg[] => ('legs' in t ? t.legs : []);

/**
 * Run one step under the tenant's lock: load the transaction and the
 * configuration it runs under, let the step decide, then write what it
 * decided — the leg or evidence, the state, the event — and only then
 * change the book.
 */
async function step(
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
      attestation,
    });
    if (!out.ok) return out;

    const after = out.value.transaction;
    const moved = after !== before;
    const leg = legsOf(after).length > legsOf(before).length ? legsOf(after).at(-1) : undefined;
    const { evidence, supersedes } = out.value;
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
      },
      occurredAtEpochSeconds: (await attestation.occurred()).epochSeconds,
    };
    const pool = persistencePool();
    if (pool !== undefined) {
      const saved = await recordStep(pool, tenant, {
        transactionRef,
        expectedState: before.state,
        toState: after.state,
        event,
        ...(leg === undefined ? {} : { leg }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(supersedes === undefined ? {} : { supersedes }),
        ...(after.state === 'POSSESSION_CONFIRMED' ? { riskPeriodStartAt: after.riskPeriodStartAt } : {}),
        ...(after.state === 'SALE_OFFERED' ? { saleOfferedAt: after.saleOfferedAt } : {}),
        correlationId: before.core.correlationId,
      });
      if (!saved.ok) {
        // Another process moved it meanwhile: this book is behind, so it reloads before the next attempt.
        if (saved.error.reason === 'TRANSACTION_MOVED') {
          book.records.clear();
          book.hydrated = false;
        }
        return saved;
      }
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
async function viaActivity(
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
/** The distributor's acceptance, strictly after the offer and before it lapses. Offered in the SME portal (W3). */
export const acceptSaleOffer = activityStep('OFFER_ACCEPTED', (a, r) => a.acceptOffer(r));
/** An offer not accepted in time lapses; the domain checks it really has expired. */
export const lapseSaleOffer = activityStep('OFFER_LAPSED', (a, r) => a.lapseOffer(r));

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
function legFigures(legType: LegType, core: TransactionCore): Readonly<Record<string, string>> {
  const p = core.pricing;
  switch (legType) {
    case 'PURCHASE':
      return { price: p.costAmount.minorUnits.toString() };
    case 'SALE_OFFER':
      return {
        cost: p.costAmount.minorUnits.toString(),
        profit: p.profitAmount.minorUnits.toString(),
        salePrice: p.salePriceAmount.minorUnits.toString(),
        maturityGregorian: core.maturityDateGregorian,
        maturityHijri: core.maturityDateHijri,
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
        figures: legFigures(p.legType, core),
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

// -- 1. Trade validation and the limit ------------------------------------------------

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

// -- 3. Gate 1: the ownership invoice -------------------------------------------------

/** E-invoicing asks no consent: an invoice the institution is party to is its own record. */
const NO_CONSENTS: ConsentLedger = {
  live: () => Promise.resolve(reject('OP-DETERMINACY', 'CONSENT_NOT_APPLICABLE', 'An invoice lookup needs no consent')),
};

/**
 * The e-invoicing authority, as the port. Only the demonstration transport
 * stands behind it yet, labelled FIXTURE, and only where a synthetic
 * demonstration is permitted; it is told the invoice the transaction expects
 * (the anchor to the institution, for the cost), and its steering markers
 * still apply (a hash containing "reject" is not cleared, "unknown" is not
 * found). Anywhere else the authority is unavailable until the live adapter
 * has made a verified call (KSA-RAIL-ZATCA-01). The transport's relative
 * dates hang from the step's attested instant, not a clock.
 */
async function ownershipInvoiceRail(
  tenant: TenantCode,
  at: TsaInstant,
  expected: { readonly sellerCr: string; readonly buyerCr: string; readonly totalMinor: bigint },
): Promise<{ readonly provider: EInvoicingProvider; readonly source: 'FIXTURE' } | undefined> {
  if (!(await syntheticDemonstrationPermitted(persistencePool(), process.env))) return undefined;
  const attested = () => Number(at.epochSeconds);
  return {
    provider: new ZatcaEInvoicingAdapter(
      demonstrationConfig(tenant, 'E_INVOICING', NO_CONSENTS, attested),
      new DemonstrationCredentials(),
      new KsaDemonstrationTransport(attested, () => expected),
    ),
    source: 'FIXTURE',
  };
}

const INVOICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record the anchor's invoice to the institution as ownership evidence.
 * The e-invoicing authority answers; the evidence is VALID only if the
 * invoice is cleared, issued by the purchase's seller, names the institution
 * as buyer and is for the cost. An answer that fails any of those is recorded
 * INVALID — on file, discharging nothing.
 */
export function recordOwnershipInvoice(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  invoice: { readonly invoiceUuid: string; readonly invoiceHash: string },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const t = c.record.transaction;
    if (t.state !== 'PURCHASE_EXECUTED') return notNow(t.state);
    const invoiceUuid = invoice.invoiceUuid.trim().toLowerCase();
    const invoiceHash = invoice.invoiceHash.trim();
    if (!INVOICE_UUID.test(invoiceUuid) || invoiceHash.length === 0 || invoiceHash.length > 128)
      return fail('INVOICE_REFERENCE_MALFORMED', 'An invoice is named by its UUID and its hash');
    if (invoiceUuid === t.core.tradeReference.invoiceUuid?.toLowerCase())
      return fail(
        'OWNERSHIP_INVOICE_IS_THE_TRADE_INVOICE',
        'The financed invoice names the distributor; ownership is evidenced by the anchor’s invoice to the institution',
      );
    const artefactUri = `einvoice:${invoiceUuid}`;
    if (c.book.some((r) => r.evidence.some((e) => e.artefactUri === artefactUri && e.validationStatus === 'VALID')))
      return reject(
        'SH-10',
        'OWNERSHIP_INVOICE_ALREADY_EVIDENCED',
        'This invoice already evidences ownership of goods',
      );
    const sellerCr = t.core.tradeReference.issuerCr;
    const institutionCr = c.parties.institution.registrationNo;
    const cost = t.core.pricing.costAmount;
    const capturedAt = await c.attestation.attest();
    const rail = await ownershipInvoiceRail(c.tenant, capturedAt, {
      sellerCr,
      buyerCr: institutionCr,
      totalMinor: cost.minorUnits,
    });
    if (rail === undefined)
      return fail(
        'EINVOICING_UNAVAILABLE',
        'The e-invoicing authority cannot be reached from here; nothing was recorded',
      );
    const answered = await rail.provider.validateInvoice(c.tenant, { invoiceUuid, invoiceHash }, t.core.correlationId);
    if (!answered.ok) return answered;
    const v = answered.value;
    const recipientIsInstitution = v.recipientCr === institutionCr;
    const issuerIsSeller = v.issuerCr === sellerCr;
    const totalMatchesCost = v.totalAmount.minorUnits === cost.minorUnits && v.totalAmount.currency === cost.currency;
    // The demonstration cannot sign as the authority, so its stamp never verifies; a FIXTURE answer is labelled as such.
    const stampAccepted = v.stampValid || rail.source === 'FIXTURE';
    const valid =
      v.clearanceStatus === 'CLEARED' && recipientIsInstitution && issuerIsSeller && totalMatchesCost && stampAccepted;
    const evidence: EvidenceRecord = {
      evidenceId: randomUUID(),
      tenantId: t.core.tenantId,
      transactionId: t.core.transactionId,
      evidenceType: 'OWNERSHIP_INVOICE',
      gateSatisfied: 'GATE_1_OWNERSHIP',
      source: 'E_INVOICING_AUTHORITY',
      artefactUri,
      artefactHash: invoiceHash,
      capturedAt,
      validationStatus: valid ? 'VALID' : 'INVALID',
      validationDetail: {
        clearanceStatus: v.clearanceStatus,
        recipientIsInstitution,
        issuerIsSeller,
        totalMatchesCost,
        stampValid: v.stampValid,
        rail: rail.source,
      },
    };
    return ok({ eventType: 'EVIDENCE_RECORDED', transaction: t, evidence });
  });
}

// -- 4. Gate 2: possession ------------------------------------------------------------

/** Where possession evidence may come from on the workbench. The e-invoicing authority evidences ownership, not possession. */
export const POSSESSION_SOURCES: readonly EvidenceSource[] = ['ANCHOR_SYSTEM', 'PARTNER', 'UPLOAD'];

/** The evidence types the structure admits for possession (gate 2's `anyOf`), in its order. */
export function possessionEvidenceTypes(tenant: TenantCode): readonly EvidenceType[] {
  const s = structureOf(tenant);
  const gate = s.ok ? s.value.gates.find((g) => g.id === 'GATE_2_POSSESSION') : undefined;
  return gate?.kind === 'EVIDENCE' ? gate.requires.anyOf : [];
}

/**
 * Record possession evidence: the file goes to the tenant's object store, the
 * evidence is recorded PENDING with its hash, and a different person
 * validates it before it can discharge gate 2.
 */
export function recordPossessionEvidence(
  tenant: TenantCode,
  transactionRef: string,
  actor: string,
  input: { readonly evidenceType: string; readonly source: string; readonly bytes: Uint8Array },
): Promise<Result<TransactionView>> {
  return step(tenant, transactionRef, actor, async (c) => {
    const t = c.record.transaction;
    if (t.state !== 'OWNERSHIP_ACQUIRED') return notNow(t.state);
    const type = possessionEvidenceTypes(tenant).find((x) => x === input.evidenceType);
    if (type === undefined)
      return reject(
        'SH-05',
        'EVIDENCE_TYPE_NOT_ADMISSIBLE',
        'The structure does not admit this evidence for possession',
        {
          evidenceType: input.evidenceType,
        },
      );
    const source = POSSESSION_SOURCES.find((x) => x === input.source);
    if (source === undefined) return fail('EVIDENCE_SOURCE_UNKNOWN', 'Name where the evidence came from');
    const accepted = acceptUpload(input.bytes);
    if (!accepted.ok) return accepted;
    const { sha256Hex, mediaType, byteLength } = accepted.value;
    if (c.record.evidence.some((e) => e.artefactHash === sha256Hex && e.supersededBy === undefined))
      return fail('EVIDENCE_ALREADY_RECORDED', 'This file is already on the transaction');
    const store = await objectStorageFor(tenant);
    if (store === undefined)
      return fail('STORAGE_UNAVAILABLE', 'No document store is configured here; nothing was recorded');
    const put = await store.put({
      tenantId: tenant,
      objectKey: `${tenant}/transactions/${transactionRef}/${sha256Hex}`,
      bytes: input.bytes,
      mediaType,
      sha256Hex,
      correlationId: t.core.correlationId,
    });
    if (!put.ok) return put;
    if (put.value.kind !== 'ANSWERED')
      return fail('STORAGE_UNAVAILABLE', 'The document store did not take the file; nothing was recorded');
    const evidence: EvidenceRecord = {
      evidenceId: randomUUID(),
      tenantId: t.core.tenantId,
      transactionId: t.core.transactionId,
      evidenceType: type,
      gateSatisfied: 'GATE_2_POSSESSION',
      source,
      artefactUri: `obj:transactions/${transactionRef}/${sha256Hex}`,
      artefactHash: sha256Hex,
      capturedAt: await c.attestation.attest(),
      validationStatus: 'PENDING',
      validationDetail: { mediaType, byteLength, storage: store.source },
    };
    return ok({ eventType: 'EVIDENCE_RECORDED', transaction: t, evidence });
  });
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
