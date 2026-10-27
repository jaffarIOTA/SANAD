/**
 * The Shariah audit workspace (Wasl W6c; BR-F05, BR-F08, SH-18): what a
 * Board member or Shariah auditor reads, by themselves, without technical
 * assistance — read-only by construction.
 *
 *   Replay       one transaction end to end: each contract with its time,
 *                fingerprint and link to the one before; each gate with its
 *                evidence as the sale saw it; the risk period required and
 *                held; the figures disclosed; the approval it was executed
 *                under as it stood that day; and each Shariah check passed or
 *                failed, from the same checks the daily review runs.
 *   Audit pack   the replay and everything it rests on, as one file whose
 *                manifest carries the SHA-256 of each part, so a copy that has
 *                been changed shows it.
 *   Report       the period's Shariah compliance for the Board and its annual
 *                report: transactions, the risk period held, incidents by
 *                severity and age, template drift, purification and late
 *                amounts, and the approvals register.
 *
 * Nothing here writes. Reads no clock but the host-clock stand-in (SR-006).
 */
import { createHash } from 'node:crypto';

import type { TenantCode } from '@sanad/config/loader.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import {
  type ApprovalStanding,
  type ShariahApproval,
  registerAt,
  registerFrom,
  standingOn,
} from '@sanad/core/shariah/approvals.ts';
import type { IncidentSeverity, ShariahIncident } from '@sanad/core/shariah/incidents.ts';
import { type Sample, sampleOf } from '@sanad/core/shariah/sampling.ts';
import { CHECK_CODES, type CheckCode, type Finding } from '@sanad/products/murabaha-scf/compliance/checks.ts';
import { type ContractLeg, verifyChain } from '@sanad/products/murabaha-scf/legs/leg.ts';
import { evaluateGates } from '@sanad/products/murabaha-scf/sequencing/gates.ts';

import { civilDateOf } from '../civil-date.ts';
import { hostClockInstant } from '../host-clock.ts';
import { approvalChanges } from '../shariah/approvals.ts';
import { shariahIncidents } from '../shariah/incidents.ts';
import { type TransactionRecord, hydrate, structureOf } from './book.ts';
import { findingsFor, goodsAtOpening } from './compliance.ts';
import { resolveWaslParties } from './configuration.ts';
import { HOLDING, PURCHASED } from './exposure.ts';
import { lateAmounts } from './late-amounts.ts';
import { purifications } from './purification.ts';
import { instrumentHash, termsAtOpening } from './steps.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const legsOf = (r: TransactionRecord): readonly ContractLeg[] => ('legs' in r.transaction ? r.transaction.legs : []);
const openedAt = (r: TransactionRecord): bigint =>
  r.events.find((e) => e.eventType === 'TRANSACTION_OPENED')?.occurredAtEpochSeconds ?? 0n;
const executedAt = (r: TransactionRecord): bigint | undefined =>
  legsOf(r).find((l) => l.legType === 'ACCEPTANCE')?.executedAt.epochSeconds;

// -- Finding the transactions -------------------------------------------------------

export interface AuditListing {
  readonly transactionRef: string;
  readonly counterpartyId: string;
  readonly programmeId: string;
  readonly state: string;
  readonly openedOn: string;
  readonly executedOn?: string;
  readonly salePriceMinor: bigint;
  readonly currency: string;
}

export interface AuditQuery {
  readonly text?: string;
  /** Civil dates (yyyy-mm-dd), inclusive, on the date opened. */
  readonly from?: string;
  readonly to?: string;
  readonly executedOnly?: boolean;
}

function listingOf(tenant: TenantCode, r: TransactionRecord): AuditListing {
  const done = executedAt(r);
  const core = r.transaction.core;
  return {
    transactionRef: r.transactionRef,
    counterpartyId: core.counterpartyId,
    programmeId: core.programmeId,
    state: r.transaction.state,
    openedOn: civilDateOf(tenant, { epochSeconds: openedAt(r) }),
    ...(done === undefined ? {} : { executedOn: civilDateOf(tenant, { epochSeconds: done }) }),
    salePriceMinor: core.pricing.salePriceAmount.minorUnits,
    currency: core.pricing.salePriceAmount.currency,
  };
}

/** The transactions matching a search: by reference, distributor or programme text, the dates opened, executed only. */
export async function searchTransactions(tenant: TenantCode, q: AuditQuery): Promise<readonly AuditListing[]> {
  const text = q.text?.trim().toLowerCase() ?? '';
  return [...(await hydrate(tenant)).records.values()]
    .map((r) => listingOf(tenant, r))
    .filter(
      (l) =>
        (text === '' ||
          [l.transactionRef, l.counterpartyId, l.programmeId].some((s) => s.toLowerCase().includes(text))) &&
        (q.from === undefined || l.openedOn >= q.from) &&
        (q.to === undefined || l.openedOn <= q.to) &&
        (q.executedOnly !== true || l.executedOn !== undefined),
    );
}

/** A reproducible sample of the transactions a search finds (core/shariah/sampling.ts). */
export async function sampleTransactions(
  tenant: TenantCode,
  q: AuditQuery,
  seed: string,
  size: number,
): Promise<Sample<AuditListing>> {
  return sampleOf(await searchTransactions(tenant, q), (l) => l.transactionRef, seed, size, sha256);
}

// -- The replay ------------------------------------------------------------------------

export interface ReplayLeg {
  readonly legType: string;
  readonly sequenceNo: number;
  readonly executedAtEpochSeconds: bigint;
  readonly timestampAuthority: string;
  readonly timestampTokenDigest: string;
  readonly templateVersionId: string;
  /** The document's fingerprint (SHA-256 of what was executed). */
  readonly documentHash: string;
  /** Links to the contract before it (the first links to nothing). */
  readonly linkedToPrevious: boolean;
  /** Later than the contract before it. */
  readonly timeAfterPrevious: boolean;
  readonly counterpartyRole: string;
  readonly counterpartyRegistration: string;
  /** The approval it was executed under covers its template; undefined where that approval is not in the register. */
  readonly templateApproved?: boolean;
  /** The document is what its template makes of the transaction's figures; undefined where it cannot be rebuilt. */
  readonly documentMatchesTemplate?: boolean;
}

export interface ReplayEvidence {
  readonly evidenceType: string;
  readonly source: string;
  readonly capturedAtEpochSeconds: bigint;
  readonly status: string;
  readonly artefactHash: string;
  readonly superseded: boolean;
}

export interface ReplayGate {
  readonly gateId: string;
  readonly kind: string;
  /** As the sale offer saw it, or now where there has been no sale offer. */
  readonly status: string;
  readonly evidence: readonly ReplayEvidence[];
}

export type CheckVerdict = {
  readonly checkCode: CheckCode;
  readonly passed: boolean;
  readonly findings: readonly Finding[];
};

export interface TransactionReplay {
  readonly listing: AuditListing;
  readonly asOfEpochSeconds: bigint;
  readonly legs: readonly ReplayLeg[];
  readonly chain: { readonly verified: boolean; readonly reason?: string };
  readonly gates: readonly ReplayGate[];
  /** At the sale offer, or so far where there has been none. */
  readonly riskPeriod: {
    readonly requiredSeconds: number;
    readonly heldSeconds?: bigint;
    readonly measuredAt: 'SALE_OFFER' | 'NOW';
  };
  readonly figures: {
    readonly costMinor: bigint;
    readonly profitMinor: bigint;
    readonly salePriceMinor: bigint;
    readonly currency: string;
    readonly salePriceIsCostPlusProfit: boolean;
    readonly disclosedInOffer: boolean;
  };
  readonly approval: {
    readonly approvalRef: string;
    /** As it stood on the day the transaction opened, from the changes confirmed by then. */
    readonly atOpening?: ShariahApproval;
    readonly standingAtOpening?: ApprovalStanding;
  };
  readonly goods?: readonly { readonly lineNo: number; readonly goodsClassificationCode: string }[];
  readonly checks: readonly CheckVerdict[];
  /** No other transaction holds or bought the same invoice (SH-10). */
  readonly financedOnce: boolean;
  readonly incidents: readonly ShariahIncident[];
  readonly charity: {
    readonly lateAmountsCollectedMinor: bigint;
    readonly purifiedRaisedMinor: bigint;
    readonly disbursedMinor: bigint;
  };
  readonly events: readonly {
    readonly eventType: string;
    readonly actor: string;
    readonly atEpochSeconds: bigint;
    readonly toState: string | null;
  }[];
}

/** One transaction replayed for the Board: facts first, then the verdict of each check on them. */
export async function replayTransaction(
  tenant: TenantCode,
  transactionRef: string,
): Promise<Result<TransactionReplay>> {
  const book = await hydrate(tenant);
  const record = book.records.get(transactionRef);
  if (record === undefined)
    return reject('OP-DETERMINACY', 'TRANSACTION_NOT_FOUND', 'No such transaction', { transactionRef });
  const structure = structureOf(tenant);
  if (!structure.ok) return structure;
  const parties = await resolveWaslParties(tenant);
  if (!parties.ok) return parties;
  const t = record.transaction;
  const legs = legsOf(record);
  const now = hostClockInstant();

  // The approval as it stood when the transaction opened, and what it covered.
  const changes = await approvalChanges(tenant);
  const opened = openedAt(record);
  const atOpening = registerAt(changes, opened).find((a) => a.approvalRef === t.core.shariahApprovalId);
  const inRegister = registerFrom(changes).find((a) => a.approvalRef === t.core.shariahApprovalId);

  // Each contract: its link, its time, its template and whether its document is what the template makes.
  const terms = termsAtOpening(tenant, record);
  const institutionCr = parties.value.institution.registrationNo;
  const replayLegs: ReplayLeg[] = legs.map((leg, i) => {
    const before = legs[i - 1];
    const document = structure.value.legs.find((l) => l.type === leg.legType)?.document;
    const rebuilt =
      terms.ok && document !== undefined
        ? instrumentHash(leg, { document, institutionCr, terms: terms.value, core: t.core })
        : undefined;
    return {
      legType: leg.legType,
      sequenceNo: leg.sequenceNo,
      executedAtEpochSeconds: leg.executedAt.epochSeconds,
      timestampAuthority: leg.executedAt.authorityId,
      timestampTokenDigest: leg.tsaTokenDigest,
      templateVersionId: leg.templateVersionId,
      documentHash: leg.contentHash,
      linkedToPrevious: before === undefined ? leg.prevLegHash === undefined : leg.prevLegHash === before.contentHash,
      timeAfterPrevious: before === undefined || leg.executedAt.epochSeconds > before.executedAt.epochSeconds,
      counterpartyRole: leg.counterpartyRole,
      counterpartyRegistration: leg.counterpartyCr,
      ...(inRegister === undefined
        ? {}
        : { templateApproved: inRegister.templateVersionIds.includes(leg.templateVersionId) }),
      ...(rebuilt === undefined ? {} : { documentMatchesTemplate: rebuilt === leg.contentHash }),
    };
  });
  const chain = verifyChain(legs);

  // The gates as the sale offer saw them (or now), with the evidence behind each.
  const offer = legs.find((l) => l.legType === 'SALE_OFFER');
  const observedAt = offer?.executedAt ?? now;
  const atSale = evaluateGates({
    definition: structure.value,
    legs: offer === undefined ? legs : legs.filter((l) => l.sequenceNo < offer.sequenceNo),
    evidence:
      offer === undefined
        ? record.evidence
        : record.evidence.filter((e) => e.capturedAt.epochSeconds <= offer.executedAt.epochSeconds),
    riskPeriodRequiredSeconds: t.core.riskPeriodRequiredSeconds,
    observedAt,
  });
  const gates: ReplayGate[] = structure.value.gates.map((g) => ({
    gateId: g.id,
    kind: g.kind,
    status: atSale.gates.find((o) => o.gateId === g.id)?.status ?? 'NOT_STARTED',
    evidence: record.evidence
      .filter((e) => e.gateSatisfied === g.id)
      .map((e) => ({
        evidenceType: e.evidenceType,
        source: e.source,
        capturedAtEpochSeconds: e.capturedAt.epochSeconds,
        status: e.validationStatus,
        artefactHash: e.artefactHash,
        superseded: e.supersededBy !== undefined,
      })),
  }));

  const found = await findingsFor(tenant, record);
  if (!found.ok) return found;
  const checks: CheckVerdict[] = CHECK_CODES.map((checkCode) => {
    const f = found.value.filter((x) => x.checkCode === checkCode);
    return { checkCode, passed: f.length === 0, findings: f };
  });
  const invoice = t.core.tradeReference.invoiceUuid;
  const financedOnce =
    invoice === undefined ||
    ![...book.records.values()].some(
      (r) =>
        r.transactionRef !== transactionRef &&
        r.transaction.core.tradeReference.invoiceUuid === invoice &&
        (HOLDING.has(r.transaction.state) || PURCHASED.has(r.transaction.state)),
    );

  const p = t.core.pricing;
  const offerLeg = replayLegs.find((l) => l.legType === 'SALE_OFFER');
  const late = lateAmounts(record);
  const purified = purifications(record).flatMap((x) => x.shares);
  const listing = listingOf(tenant, record);
  const goods = goodsAtOpening(record);
  return ok({
    listing,
    asOfEpochSeconds: now.epochSeconds,
    legs: replayLegs,
    chain: chain.ok ? { verified: true } : { verified: false, reason: chain.error.reason },
    gates,
    riskPeriod: {
      requiredSeconds: t.core.riskPeriodRequiredSeconds,
      ...(atSale.riskPeriodHeldSeconds === undefined ? {} : { heldSeconds: atSale.riskPeriodHeldSeconds }),
      measuredAt: offer === undefined ? 'NOW' : 'SALE_OFFER',
    },
    figures: {
      costMinor: p.costAmount.minorUnits,
      profitMinor: p.profitAmount.minorUnits,
      salePriceMinor: p.salePriceAmount.minorUnits,
      currency: p.salePriceAmount.currency,
      salePriceIsCostPlusProfit: p.salePriceAmount.minorUnits === p.costAmount.minorUnits + p.profitAmount.minorUnits,
      // The offer states cost, profit and price, and is what its approved template makes of them (SH-15).
      disclosedInOffer: offerLeg?.documentMatchesTemplate === true,
    },
    approval: {
      approvalRef: t.core.shariahApprovalId,
      ...(atOpening === undefined
        ? {}
        : {
            atOpening,
            standingAtOpening: standingOn(atOpening, listing.openedOn),
          }),
    },
    ...(goods === undefined ? {} : { goods }),
    checks,
    financedOnce,
    incidents: (await shariahIncidents(tenant)).filter((i) => i.subjectRef === transactionRef),
    charity: {
      lateAmountsCollectedMinor: late
        .filter((a) => a.charity !== undefined)
        .reduce((s, a) => s + a.amount.minorUnits, 0n),
      purifiedRaisedMinor: purified.filter((s) => s.raised !== undefined).reduce((s, x) => s + x.amount.minorUnits, 0n),
      disbursedMinor:
        late.filter((a) => a.status === 'DISBURSED').reduce((s, a) => s + a.amount.minorUnits, 0n) +
        purified.filter((s) => s.disbursed !== undefined).reduce((s, x) => s + x.amount.minorUnits, 0n),
    },
    events: record.events.map((e) => ({
      eventType: e.eventType,
      actor: e.actor,
      atEpochSeconds: e.occurredAtEpochSeconds,
      toState: e.toState,
    })),
  });
}

// -- The audit pack ----------------------------------------------------------------------

/** JSON for the pack: whole numbers as strings, never a float. */
const plain = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)));

export interface AuditPack {
  readonly format: 'sanad.shariah-audit-pack/1';
  readonly tenant: string;
  readonly transactionRef: string;
  readonly generatedAtEpochSeconds: string;
  readonly generatedBy: string;
  /** The SHA-256 of each part's canonical JSON, and of the list of them: change a part and it no longer matches. */
  readonly manifest: { readonly parts: Readonly<Record<string, string>>; readonly packHash: string };
  readonly parts: Readonly<Record<string, unknown>>;
}

/** The SHA-256 of a part, as the manifest records it: its JSON, keys in the order written. */
export const partHash = (part: unknown): string => sha256(JSON.stringify(part));

/** A manifest's own hash: over the part names and hashes in name order. */
export const manifestHash = (parts: Readonly<Record<string, string>>): string =>
  sha256(
    Object.keys(parts)
      .sort()
      .map((k) => `${k}:${parts[k] ?? ''}`)
      .join('\n'),
  );

/** One transaction's audit pack: its replay and the record it rests on. */
export async function auditPack(
  tenant: TenantCode,
  transactionRef: string,
  generatedBy: string,
): Promise<Result<AuditPack>> {
  const replay = await replayTransaction(tenant, transactionRef);
  if (!replay.ok) return replay;
  const record = (await hydrate(tenant)).records.get(transactionRef);
  if (record === undefined) return reject('OP-DETERMINACY', 'TRANSACTION_NOT_FOUND', 'No such transaction');
  const r = replay.value;
  const parts: Record<string, unknown> = {
    transaction: plain(r.listing),
    contracts: plain({ legs: r.legs, chain: r.chain }),
    gatesAndEvidence: plain({ gates: r.gates, riskPeriod: r.riskPeriod }),
    figures: plain(r.figures),
    approval: plain(r.approval),
    goods: plain(r.goods ?? null),
    checks: plain({ checks: r.checks, financedOnce: r.financedOnce }),
    incidents: plain(r.incidents),
    charity: plain({
      summary: r.charity,
      lateAmounts: lateAmounts(record),
      purifications: purifications(record),
    }),
    eventLog: plain(r.events),
  };
  const hashes = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, partHash(v)]));
  return ok({
    format: 'sanad.shariah-audit-pack/1',
    tenant,
    transactionRef,
    generatedAtEpochSeconds: r.asOfEpochSeconds.toString(),
    generatedBy,
    manifest: { parts: hashes, packHash: manifestHash(hashes) },
    parts,
  });
}

/** Whether a pack is as it was generated: each part matches its hash, and the manifest its own. */
export function verifyAuditPack(pack: AuditPack): { readonly intact: boolean; readonly changed: readonly string[] } {
  const changed = Object.entries(pack.parts)
    .filter(([k, v]) => pack.manifest.parts[k] !== partHash(v))
    .map(([k]) => k);
  const missing = Object.keys(pack.manifest.parts).filter((k) => !(k in pack.parts));
  const all = [...changed, ...missing];
  return { intact: all.length === 0 && manifestHash(pack.manifest.parts) === pack.manifest.packHash, changed: all };
}

// -- The Board report --------------------------------------------------------------------

export interface BoardReport {
  readonly tenant: string;
  readonly from: string;
  readonly to: string;
  readonly generatedAtEpochSeconds: bigint;
  readonly transactions: {
    readonly opened: number;
    readonly executed: number;
    /** Every transaction in the book, by where it stands now. */
    readonly byState: Readonly<Record<string, number>>;
  };
  /** Sales offered in the period: the interval required and held at each. */
  readonly riskPeriod: {
    readonly salesOffered: number;
    readonly shortestHeldSeconds?: bigint;
    readonly medianHeldSeconds?: bigint;
    readonly heldBelowRequired: number;
  };
  readonly incidents: {
    readonly raised: Readonly<Record<IncidentSeverity, number>>;
    readonly closed: number;
    /** Open at the period's end, by severity, and by days open: up to 7, 8 to 30, over 30. */
    readonly openAtEnd: Readonly<Record<IncidentSeverity, number>>;
    readonly openByAge: { readonly upTo7: number; readonly from8To30: number; readonly over30: number };
    readonly templateDriftRaised: number;
  };
  readonly charity: {
    readonly lateAmountsCollectedMinor: bigint;
    readonly purifiedRaisedMinor: bigint;
    readonly disbursedMinor: bigint;
    /** Held for charity at the period's end, late amounts and purified income together. */
    readonly heldAtEndMinor: bigint;
    readonly currency: string;
  };
  readonly approvals: readonly {
    readonly approvalRef: string;
    readonly approvingBody: string;
    readonly productCodes: readonly string[];
    readonly standingAtEnd: ApprovalStanding;
    readonly reviewOrExpiry?: string;
    readonly changesInPeriod: number;
  }[];
}

const DAY = 86_400n;

/** The period's Shariah compliance, for the Board (BR-F08). Dates are civil dates, inclusive. */
export async function boardReport(tenant: TenantCode, from: string, to: string): Promise<BoardReport> {
  const records = [...(await hydrate(tenant)).records.values()];
  const dayOf = (s: bigint) => civilDateOf(tenant, { epochSeconds: s });
  const inPeriod = (s: bigint | undefined) => s !== undefined && dayOf(s) >= from && dayOf(s) <= to;
  const byState: Record<string, number> = {};
  for (const r of records) byState[r.transaction.state] = (byState[r.transaction.state] ?? 0) + 1;
  const structure = structureOf(tenant);

  // The interval held at each sale offered in the period.
  const held: bigint[] = [];
  let below = 0;
  for (const r of records) {
    const offer = legsOf(r).find((l) => l.legType === 'SALE_OFFER');
    if (offer === undefined || !inPeriod(offer.executedAt.epochSeconds) || !structure.ok) continue;
    const g = evaluateGates({
      definition: structure.value,
      legs: legsOf(r).filter((l) => l.sequenceNo < offer.sequenceNo),
      evidence: r.evidence.filter((e) => e.capturedAt.epochSeconds <= offer.executedAt.epochSeconds),
      riskPeriodRequiredSeconds: r.transaction.core.riskPeriodRequiredSeconds,
      observedAt: offer.executedAt,
    });
    const h = g.riskPeriodHeldSeconds ?? 0n;
    held.push(h);
    if (h < BigInt(r.transaction.core.riskPeriodRequiredSeconds)) below += 1;
  }
  held.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Incidents: raised and closed in the period, and open at its end.
  const incidents = await shariahIncidents(tenant);
  const zero = (): Record<IncidentSeverity, number> => ({ LOW: 0, MEDIUM: 0, HIGH: 0, MATERIAL: 0 });
  const raised = zero();
  const openAtEnd = zero();
  const openByAge = { upTo7: 0, from8To30: 0, over30: 0 };
  let closed = 0;
  let drift = 0;
  const endDay = to;
  for (const i of incidents) {
    if (inPeriod(i.raisedAtEpochSeconds)) {
      raised[i.severity] += 1;
      if (i.checkCode === 'TEMPLATE_DRIFT') drift += 1;
    }
    const closedAt = i.history.find((e) => e.action.kind === 'CLOSE')?.atEpochSeconds;
    if (inPeriod(closedAt)) closed += 1;
    const raisedDay = dayOf(i.raisedAtEpochSeconds);
    const stillOpen = raisedDay <= endDay && (closedAt === undefined || dayOf(closedAt) > endDay);
    if (stillOpen) {
      const severity = i.history.find((e) => e.action.kind === 'TRIAGE' && dayOf(e.atEpochSeconds) <= endDay);
      openAtEnd[severity?.action.kind === 'TRIAGE' ? severity.action.severity : i.severity] += 1;
      const days = Number((BigInt(Date.parse(`${endDay}T00:00:00Z`) / 1000) - i.raisedAtEpochSeconds) / DAY);
      if (days <= 7) openByAge.upTo7 += 1;
      else if (days <= 30) openByAge.from8To30 += 1;
      else openByAge.over30 += 1;
    }
  }

  // Charity: late amounts collected, purified income raised, what was disbursed, and what is held at the end.
  let lateCollected = 0n;
  let purifiedRaised = 0n;
  let disbursed = 0n;
  let heldAtEnd = 0n;
  let currency = 'SAR';
  for (const r of records) {
    currency = r.transaction.core.pricing.salePriceAmount.currency;
    for (const a of lateAmounts(r)) {
      const at = a.charity?.recordedAt.epochSeconds;
      if (at === undefined) continue;
      if (inPeriod(at)) lateCollected += a.amount.minorUnits;
      const out = r.events.find(
        (e) => e.eventType === 'CHARITY_DISBURSED' && e.detail['sequenceNumber'] === String(a.sequenceNumber),
      )?.occurredAtEpochSeconds;
      if (inPeriod(out)) disbursed += a.amount.minorUnits;
      if (dayOf(at) <= to && (out === undefined || dayOf(out) > to)) heldAtEnd += a.amount.minorUnits;
    }
    for (const p of purifications(r))
      for (const s of p.shares) {
        const at = s.raised?.recordedAt.epochSeconds;
        if (at === undefined) continue;
        if (inPeriod(at)) purifiedRaised += s.amount.minorUnits;
        const out = r.events.find(
          (e) =>
            e.eventType === 'PURIFICATION_DISBURSED' &&
            e.detail['incidentRef'] === p.incidentRef &&
            e.detail['sequenceNumber'] === String(s.sequenceNumber),
        )?.occurredAtEpochSeconds;
        if (inPeriod(out)) disbursed += s.amount.minorUnits;
        if (dayOf(at) <= to && (out === undefined || dayOf(out) > to)) heldAtEnd += s.amount.minorUnits;
      }
  }

  // The approvals register as it stood at the period's end, and what changed in it.
  const changes = await approvalChanges(tenant);
  const endEpoch = BigInt(Date.parse(`${to}T23:59:59Z`) / 1000);
  const approvals = registerAt(changes, endEpoch).map((a) => ({
    approvalRef: a.approvalRef,
    approvingBody: a.approvingBody,
    productCodes: a.productCodes,
    standingAtEnd: standingOn(a, to),
    ...(a.reviewOrExpiry === undefined ? {} : { reviewOrExpiry: a.reviewOrExpiry }),
    changesInPeriod: a.history.filter((e) => inPeriod(e.decidedAtEpochSeconds)).length,
  }));

  return {
    tenant,
    from,
    to,
    generatedAtEpochSeconds: hostClockInstant().epochSeconds,
    transactions: {
      opened: records.filter((r) => inPeriod(openedAt(r))).length,
      executed: records.filter((r) => inPeriod(executedAt(r))).length,
      byState,
    },
    riskPeriod: {
      salesOffered: held.length,
      ...(held.length === 0
        ? {}
        : { shortestHeldSeconds: held[0], medianHeldSeconds: held[Math.floor((held.length - 1) / 2)] }),
      heldBelowRequired: below,
    },
    incidents: { raised, closed, openAtEnd, openByAge, templateDriftRaised: drift },
    charity: {
      lateAmountsCollectedMinor: lateCollected,
      purifiedRaisedMinor: purifiedRaised,
      disbursedMinor: disbursed,
      heldAtEndMinor: heldAtEnd,
      currency,
    },
    approvals,
  };
}

/** The report as JSON for download: whole numbers as strings. */
export const boardReportJson = (r: BoardReport): unknown => plain(r);
