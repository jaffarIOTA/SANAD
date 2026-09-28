/**
 * The programs without a server: the same activities bound to Map-backed
 * stores, signals replaced by a scenario the test drives, and a *virtual
 * attested clock* — `sleepSeconds` advances what the attestation port will
 * answer next, which is exactly the relationship the real engine has with
 * the timestamping authority: the timer wakes, the authority decides.
 */

import type { EvidenceRecord, GateId } from '../../../core/evidence/evidence.ts';
import type { Result } from '../../../core/kernel/result.ts';
import { ok } from '../../../core/kernel/result.ts';
import { type TsaInstant, tsaInstant } from '../../../core/time/tsa.ts';
import type { ContractLeg } from '../../../products/murabaha-scf/legs/leg.ts';
import type { Transaction } from '../../../products/murabaha-scf/sequencing/state.ts';
import type { StructureDefinition } from '../../../products/murabaha-scf/structures/definition.ts';
import type { TawarruqTransaction } from '../../../products/tawarruq-personal/execution.ts';
import { createMurabahaActivities } from '../activities.ts';
import { type TawarruqPorts, createTawarruqActivities } from '../activities-tawarruq.ts';
import type { Attestation, EvidenceStore, LegPreparer, SequencingPorts, StructureSource, TawarruqStore, TransactionStore } from '../ports.ts';
import { type MurabahaEffects, type MurabahaOutcome, type MurabahaSequenceInput, runMurabahaSequence } from '../programs/murabaha.ts';
import { type TawarruqEffects, type TawarruqOutcome, type TawarruqSequenceInput, runTawarruqSequence } from '../programs/tawarruq.ts';

export class VirtualAttestation implements Attestation {
  #epochSeconds: bigint;
  #serial = 0;
  constructor(startEpochSeconds: bigint) { this.#epochSeconds = startEpochSeconds; }
  advance(seconds: number): void { this.#epochSeconds += BigInt(seconds); }
  get now(): bigint { return this.#epochSeconds; }
  /** Every attestation is a strictly later instant, as the authority's would be. */
  attest(): Promise<TsaInstant> {
    this.#serial += 1;
    this.#epochSeconds += 1n;
    return Promise.resolve(tsaInstant({ verified: true, genTimeEpochSeconds: this.#epochSeconds, tokenDigest: `virtual-${String(this.#serial)}`, authorityId: 'virtual-tsa' }));
  }
}

export class MapTransactionStore implements TransactionStore {
  readonly #rows = new Map<string, Transaction>();
  readonly history: Transaction['state'][] = [];
  load(tenantId: string, transactionId: string): Promise<Transaction | undefined> { return Promise.resolve(this.#rows.get(`${tenantId}/${transactionId}`)); }
  save(t: Transaction): Promise<void> { this.#rows.set(`${t.core.tenantId}/${t.core.transactionId}`, t); this.history.push(t.state); return Promise.resolve(); }
}

export class MapTawarruqStore implements TawarruqStore {
  readonly #rows = new Map<string, TawarruqTransaction>();
  readonly history: TawarruqTransaction['state'][] = [];
  load(tenantId: string, transactionId: string): Promise<TawarruqTransaction | undefined> { return Promise.resolve(this.#rows.get(`${tenantId}/${transactionId}`)); }
  save(t: TawarruqTransaction): Promise<void> { this.#rows.set(`${t.core.tenantId}/${t.core.transactionId}`, t); this.history.push(t.state); return Promise.resolve(); }
}

export class MapEvidenceStore implements EvidenceStore {
  readonly #rows: EvidenceRecord[] = [];
  add(record: EvidenceRecord): void { this.#rows.push(record); }
  forTransaction(tenantId: string, transactionId: string): Promise<readonly EvidenceRecord[]> {
    return Promise.resolve(this.#rows.filter((e) => e.tenantId === tenantId && e.transactionId === transactionId));
  }
}

export const fixedStructure = (definition: StructureDefinition): StructureSource => ({ definition: () => Promise.resolve(ok(definition)) });

/** A leg preparer that stands in for the document pipeline: chained hashes, attested instants, the party the structure names. */
export function simpleLegPreparer(attestation: Attestation, parties: { readonly institutionCr: string; readonly buyerCr: string; readonly sellerCr: string }): LegPreparer {
  return {
    async prepare(p): Promise<Result<ContractLeg>> {
      const executedAt = await attestation.attest();
      const role: ContractLeg['counterpartyRole'] = p.legType === 'PURCHASE' ? 'SELLER' : 'BUYER';
      const contentHash = `hash-${p.transaction.core.transactionId}-${String(p.sequenceNo)}`;
      return ok({
        legId: `leg-${p.transaction.core.transactionId}-${String(p.sequenceNo)}`,
        tenantId: p.transaction.core.tenantId,
        transactionId: p.transaction.core.transactionId,
        legType: p.legType,
        sequenceNo: p.sequenceNo,
        documentId: `doc-${p.transaction.core.transactionId}-${String(p.sequenceNo)}`,
        contentHash,
        ...(p.previousContentHash === undefined ? {} : { prevLegHash: p.previousContentHash }),
        executedAt,
        tsaTokenDigest: executedAt.tokenDigest,
        templateVersionId: `${p.document}@approved`,
        counterpartyRole: role,
        counterpartyCr: role === 'SELLER' ? parties.sellerCr : parties.buyerCr,
        immutable: true,
      });
    },
  };
}

export interface MurabahaScenario {
  /** Called when the program waits for a gate's evidence. Add evidence (or not) and return. */
  onWaitEvidence(gate: GateId, attestation: VirtualAttestation): Promise<void> | void;
  offerOutcome: 'ACCEPTED' | 'LAPSED';
}

export async function runMurabahaInMemory(ports: SequencingPorts & { readonly attestation: VirtualAttestation }, input: MurabahaSequenceInput, scenario: MurabahaScenario): Promise<{ readonly outcome: MurabahaOutcome; readonly progress: readonly string[]; readonly slept: number[] }> {
  const acts = createMurabahaActivities(ports);
  const ref = { tenantId: input.tenantId, transactionId: input.transactionId };
  const progress: string[] = [];
  const slept: number[] = [];
  const fx: MurabahaEffects = {
    validateAndReserve: () => acts.validateAndReserve(ref),
    executeLeg: (step) => acts.executeLeg(ref, step),
    evaluateGates: () => acts.evaluateGates(ref),
    acquireOwnership: () => acts.acquireOwnership(ref),
    confirmPossession: () => acts.confirmPossession(ref),
    offerSale: (v) => acts.offerSale(ref, v),
    acceptOffer: () => acts.acceptOffer(ref),
    bookObligation: () => acts.bookObligation(ref),
    lapseOffer: () => acts.lapseOffer(ref),
    unwind: (d) => acts.unwind(ref, d),
    waitForEvidence: async (gate) => { await scenario.onWaitEvidence(gate, ports.attestation); },
    // A lapse is a timer expiring, so the virtual authority moves past the
    // offer's validity — as wall time would have. The domain still checks.
    waitForOfferOutcome: (validity) => { if (scenario.offerOutcome === 'LAPSED') ports.attestation.advance(validity + 1); return Promise.resolve(scenario.offerOutcome); },
    sleepSeconds: (s) => { slept.push(s); ports.attestation.advance(s); return Promise.resolve(); },
    progress: (step) => { progress.push(step); },
  };
  const outcome = await runMurabahaSequence(fx, input);
  return { outcome, progress, slept };
}

export async function runTawarruqInMemory(ports: TawarruqPorts, input: TawarruqSequenceInput, scenario: { readonly signature: 'SIGNED' | 'TIMED_OUT' }): Promise<{ readonly outcome: TawarruqOutcome; readonly progress: readonly string[] }> {
  const acts = createTawarruqActivities(ports);
  const ref = { tenantId: input.tenantId, transactionId: input.transactionId };
  const progress: string[] = [];
  const fx: TawarruqEffects = {
    purchaseCommodity: () => acts.purchaseCommodity(ref),
    sellToCustomer: () => acts.sellToCustomer(ref, 'doc-sale-1'),
    transferTitle: () => acts.transferTitle(ref),
    realiseProceeds: () => acts.realiseProceeds(ref),
    disburse: () => acts.disburse(ref),
    waitForSaleSignature: () => Promise.resolve(scenario.signature),
    unwind: (r) => acts.unwind(ref, r),
    progress: (s) => { progress.push(s); },
  };
  return { outcome: await runTawarruqSequence(fx, input), progress };
}
