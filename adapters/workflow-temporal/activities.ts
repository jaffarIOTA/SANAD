/**
 * Activities: the only code in this adapter that touches the domain, a store
 * or a rail. Each activity is one step — load, call the one domain function
 * for that step with a fresh attestation, save. A domain refusal is thrown
 * as `SequencingRefusal`, which the retry policy never retries: it is a fact
 * about the sequence, not about a rail being down.
 *
 * Every argument and return value is JSON: identifiers and strings. No
 * bigint, no branded instant crosses the activity boundary.
 */

import type { GateId } from '../../core/evidence/evidence.ts';
import type { Rejection } from '../../core/kernel/result.ts';
import { elapsedSeconds } from '../../core/time/tsa.ts';
import { evaluateGates } from '../../products/murabaha-scf/sequencing/gates.ts';
import type { Transaction } from '../../products/murabaha-scf/sequencing/state.ts';
import {
  acceptOffer,
  acquireOwnership,
  bookObligation,
  confirmPossession,
  executePurchase,
  executeWaad,
  lapseOffer,
  offerSale,
  rejectTrade,
  reserveLimit,
  submit,
  unwind,
  type SequencingContext,
} from '../../products/murabaha-scf/sequencing/transitions.ts';
import type { StructureDefinition } from '../../products/murabaha-scf/structures/definition.ts';
import { SequenceRefusal, type GateReport, type LegStep } from './programs/murabaha.ts';
import type { SequencingPorts } from './ports.ts';

const GATE_ORDER: readonly GateId[] = ['GATE_1_OWNERSHIP', 'GATE_2_POSSESSION', 'GATE_3_RISK_PERIOD'];

export interface Ref {
  readonly tenantId: string;
  readonly transactionId: string;
}

const refusal = (r: Rejection): never => {
  throw new SequenceRefusal(r.reason, `${r.control}: ${r.detail}`);
};

export function createMurabahaActivities(ports: SequencingPorts) {
  async function load(ref: Ref): Promise<Transaction> {
    const t = await ports.transactions.load(ref.tenantId, ref.transactionId);
    if (t === undefined) throw new SequenceRefusal('TRANSACTION_NOT_FOUND', `No transaction ${ref.transactionId}`);
    return t;
  }
  async function context(t: Transaction): Promise<SequencingContext & { readonly definition: StructureDefinition }> {
    const definition = await ports.structures.definition(t.core.tenantId, t.core.structureDefinitionId);
    if (!definition.ok) return refusal(definition.error);
    const evidence = await ports.evidence.forTransaction(t.core.tenantId, t.core.transactionId);
    return { definition: definition.value, evidence, observedAt: await ports.attestation.attest() };
  }
  function expect<S extends Transaction['state']>(t: Transaction, ...states: S[]): Extract<Transaction, { state: S }> {
    if (!states.includes(t.state as S))
      throw new SequenceRefusal('STATE_MISMATCH', `Expected ${states.join('|')}, found ${t.state}`);
    return t as Extract<Transaction, { state: S }>;
  }
  async function prepareLeg(t: Transaction, legType: LegStep | 'SALE_OFFER' | 'ACCEPTANCE') {
    const ctx = await context(t);
    const legDefinition = ctx.definition.legs.find((l) => l.type === legType);
    if (legDefinition === undefined)
      throw new SequenceRefusal('LEG_NOT_IN_STRUCTURE', `${legType} is not a leg of ${ctx.definition.definitionId}`);
    const legs = 'legs' in t ? t.legs : [];
    const previous = legs.at(-1);
    const leg = await ports.legs.prepare({
      transaction: t,
      legType,
      sequenceNo: legDefinition.seq,
      ...(previous === undefined ? {} : { previousContentHash: previous.contentHash }),
      document: legDefinition.document,
    });
    if (!leg.ok) return refusal(leg.error);
    return { leg: leg.value, ctx };
  }

  return {
    async validateAndReserve(ref: Ref): Promise<'LIMIT_RESERVED' | 'REJECTED'> {
      const draft = expect(await load(ref), 'DRAFT');
      const validating = submit(draft);
      // Trade validation itself (e-invoice clearance, distinctness) runs in the
      // origination decision before a transaction is opened; here the trade is
      // re-checked for a registry-level refusal only, via the structure's own
      // constraints when the purchase leg executes. An explicit rejection path
      // exists so a later validation rail can use it without a workflow change.
      const reasons: Rejection[] = [];
      if (reasons.length > 0) {
        await ports.transactions.save(rejectTrade(validating, reasons));
        return 'REJECTED';
      }
      await ports.transactions.save(reserveLimit(validating, `rsv-${ref.transactionId}`));
      return 'LIMIT_RESERVED';
    },

    async executeLeg(ref: Ref, step: LegStep): Promise<void> {
      const t = await load(ref);
      if (step === 'WAAD') {
        const { leg, ctx } = await prepareLeg(expect(t, 'LIMIT_RESERVED'), 'WAAD');
        const next = executeWaad(expect(t, 'LIMIT_RESERVED'), leg, ctx);
        if (!next.ok) return refusal(next.error);
        await ports.transactions.save(next.value);
        return;
      }
      const { leg, ctx } = await prepareLeg(expect(t, 'WAAD_EXECUTED'), 'PURCHASE');
      const next = executePurchase(expect(t, 'WAAD_EXECUTED'), leg, ctx);
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },

    async evaluateGates(ref: Ref): Promise<GateReport> {
      const t = await load(ref);
      const ctx = await context(t);
      const legs = 'legs' in t ? t.legs : [];
      const evaluation = evaluateGates({
        definition: ctx.definition,
        legs,
        evidence: ctx.evidence,
        riskPeriodRequiredSeconds: t.core.riskPeriodRequiredSeconds,
        observedAt: ctx.observedAt,
      });
      if (evaluation.allSatisfied) return { allSatisfied: true };
      const nextId = GATE_ORDER.find((g) => evaluation.unsatisfied.includes(g));
      if (nextId === undefined) return { allSatisfied: false };
      const gate = ctx.definition.gates.find((g) => g.id === nextId);
      if (gate?.kind === 'ELAPSE') {
        const held = evaluation.riskPeriodHeldSeconds ?? 0n;
        const remaining = BigInt(t.core.riskPeriodRequiredSeconds) - held;
        return {
          allSatisfied: false,
          next: { gateId: nextId, kind: 'ELAPSE', remainingSeconds: (remaining > 0n ? remaining : 0n).toString() },
        };
      }
      return { allSatisfied: false, next: { gateId: nextId, kind: 'EVIDENCE' } };
    },

    async acquireOwnership(ref: Ref): Promise<void> {
      const t = expect(await load(ref), 'PURCHASE_EXECUTED');
      const next = acquireOwnership(t, await context(t));
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },

    async confirmPossession(ref: Ref): Promise<void> {
      const t = expect(await load(ref), 'OWNERSHIP_ACQUIRED');
      const next = confirmPossession(t, await context(t));
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },

    async offerSale(ref: Ref, validitySeconds: number): Promise<void> {
      const t = expect(await load(ref), 'POSSESSION_CONFIRMED');
      const { leg, ctx } = await prepareLeg(t, 'SALE_OFFER');
      const next = offerSale(t, leg, ctx.observedAt.epochSeconds + BigInt(validitySeconds), ctx);
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },

    async acceptOffer(ref: Ref): Promise<void> {
      const t = expect(await load(ref), 'SALE_OFFERED');
      const { leg, ctx } = await prepareLeg(t, 'ACCEPTANCE');
      const next = acceptOffer(t, leg, ctx);
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },

    async bookObligation(ref: Ref): Promise<void> {
      const t = expect(await load(ref), 'EXECUTED');
      await ports.transactions.save(bookObligation(t, `obl-${ref.transactionId}`, `bk-${ref.transactionId}`));
    },

    async lapseOffer(ref: Ref): Promise<void> {
      const t = expect(await load(ref), 'SALE_OFFERED');
      const next = lapseOffer(t, await context(t));
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },

    async unwind(ref: Ref, goodsDisposition: string): Promise<void> {
      const t = expect(
        await load(ref),
        'WAAD_EXECUTED',
        'PURCHASE_EXECUTED',
        'OWNERSHIP_ACQUIRED',
        'POSSESSION_CONFIRMED',
        'OFFER_LAPSED',
      );
      const next = unwind(t, goodsDisposition);
      if (!next.ok) return refusal(next.error);
      await ports.transactions.save(next.value);
    },

    /** Seconds held so far, for the Board's view; the program never uses it to decide. */
    async heldSeconds(ref: Ref): Promise<string> {
      const t = await load(ref);
      const ctx = await context(t);
      return t.state === 'POSSESSION_CONFIRMED' ? elapsedSeconds(t.riskPeriodStartAt, ctx.observedAt).toString() : '0';
    },
  };
}

export type MurabahaActivities = ReturnType<typeof createMurabahaActivities>;
