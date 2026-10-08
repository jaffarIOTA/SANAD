/**
 * The Murabaha sequence as a program over effects (ADR 0003).
 *
 * This file is the orchestration and nothing else: it says which step comes
 * after which, when to wait for evidence, and when to sleep for the risk
 * period. It performs no I/O and reads no clock. Every step is an effect the
 * host supplies — Temporal binds them to activities, signals and durable
 * timers; the in-memory runner binds them to stores and a virtual attested
 * clock so the same program is tested without a server.
 *
 * Two properties the domain already guarantees are restated here so the
 * orchestration cannot undermine them:
 *   - a gate is passed only when `evaluateGates` (the pure domain function,
 *     run in an activity against a fresh attestation) says it is satisfied;
 *     a timer waking up is a reason to *ask again*, never a reason to proceed;
 *   - every transition is an activity that calls the one domain function for
 *     that step, so there is no path from here to a later state than the
 *     domain allows.
 *
 * Nothing in this file may import a value from `@sanad/core` or a product
 * module: workflow code runs in Temporal's deterministic sandbox and must not
 * pull Node built-ins in. Types only.
 */

import type { GateId } from '@sanad/core/evidence/evidence.ts';

export type LegStep = 'WAAD' | 'PURCHASE';

/** What the gate activity reports back, in JSON-safe form. */
export interface GateReport {
  readonly allSatisfied: boolean;
  /** The first unsatisfied gate, in sequence order, and what discharges it. */
  readonly next?: {
    readonly gateId: GateId;
    readonly kind: 'EVIDENCE' | 'ELAPSE';
    /** For an elapse gate: whole seconds still to hold, per the attestation the activity fetched. */
    readonly remainingSeconds?: string;
  };
}

export interface MurabahaEffects {
  /** Origination: DRAFT → TRADE_VALIDATION → LIMIT_RESERVED, or REJECTED with reasons. */
  validateAndReserve(): Promise<'LIMIT_RESERVED' | 'REJECTED'>;
  /** Prepare (render, sign, timestamp) and execute one leg. */
  executeLeg(step: LegStep): Promise<void>;
  /** The pure gate evaluation, run against a fresh attestation. */
  evaluateGates(): Promise<GateReport>;
  acquireOwnership(): Promise<void>;
  confirmPossession(): Promise<void>;
  /** Prepares the offer leg and executes it. */
  offerSale(validitySeconds: number): Promise<void>;
  /** Prepares the acceptance leg and executes it. */
  acceptOffer(): Promise<void>;
  bookObligation(): Promise<void>;
  lapseOffer(): Promise<void>;
  unwind(goodsDisposition: string): Promise<void>;

  /** Waits — resolved by a signal (evidence recorded, offer answered) or a durable timer. */
  waitForEvidence(gate: GateId): Promise<void>;
  waitForOfferOutcome(validitySeconds: number): Promise<'ACCEPTED' | 'LAPSED'>;
  sleepSeconds(seconds: number): Promise<void>;

  /** For the progress query. Never a domain input. */
  progress(step: string): void;
}

export interface MurabahaSequenceInput {
  readonly tenantId: string;
  readonly transactionId: string;
  readonly offerValiditySeconds: number;
  /** Bound on how many times a gate is re-asked after evidence or a timer, so a wedged gate surfaces as a failure rather than a loop. */
  readonly maxGateChecks?: number;
}

export type MurabahaOutcome = 'BOOKED' | 'REJECTED' | 'LAPSED_AND_UNWOUND';

export async function runMurabahaSequence(fx: MurabahaEffects, input: MurabahaSequenceInput): Promise<MurabahaOutcome> {
  const maxChecks = input.maxGateChecks ?? 200;

  fx.progress('VALIDATING');
  const opened = await fx.validateAndReserve();
  if (opened === 'REJECTED') {
    fx.progress('REJECTED');
    return 'REJECTED';
  }

  fx.progress('WAAD');
  await fx.executeLeg('WAAD');
  fx.progress('PURCHASE');
  await fx.executeLeg('PURCHASE');

  // Gates 1 and 2: evidence gates. Wait for evidence, then ask the domain.
  await passGate(fx, 'GATE_1_OWNERSHIP', maxChecks);
  fx.progress('OWNERSHIP_ACQUIRED');
  await fx.acquireOwnership();

  await passGate(fx, 'GATE_2_POSSESSION', maxChecks);
  fx.progress('POSSESSION_CONFIRMED');
  await fx.confirmPossession();

  // Gate 3: the risk-holding interval. The timer wakes the workflow; the
  // attestation the activity fetches decides.
  await passGate(fx, 'GATE_3_RISK_PERIOD', maxChecks);

  fx.progress('SALE_OFFERED');
  await fx.offerSale(input.offerValiditySeconds);

  const outcome = await fx.waitForOfferOutcome(input.offerValiditySeconds);
  if (outcome === 'ACCEPTED') {
    fx.progress('ACCEPTED');
    await fx.acceptOffer();
    await fx.bookObligation();
    fx.progress('BOOKED');
    return 'BOOKED';
  }
  fx.progress('LAPSED');
  await fx.lapseOffer();
  await fx.unwind('OFFER_LAPSED');
  fx.progress('UNWOUND');
  return 'LAPSED_AND_UNWOUND';
}

/**
 * Ask the domain until the gate is satisfied. Between asks, wait for the
 * thing the domain said was missing: evidence, or time. An answer that
 * names a *different* gate than the one we are on is the domain telling us
 * the sequence is somewhere else — refuse rather than guess.
 */
async function passGate(fx: MurabahaEffects, gate: GateId, maxChecks: number): Promise<void> {
  for (let check = 0; check < maxChecks; check += 1) {
    const report = await fx.evaluateGates();
    const next = report.next;
    if (report.allSatisfied || next === undefined || next.gateId !== gate) {
      if (report.allSatisfied || (next !== undefined && isLater(next.gateId, gate))) return;
      throw new SequenceRefusal(
        'GATE_OUT_OF_SEQUENCE',
        `Expected to be at ${gate}; the domain reports ${String(next?.gateId)}`,
      );
    }
    fx.progress(`WAITING_${gate}`);
    if (next.kind === 'EVIDENCE') {
      await fx.waitForEvidence(gate);
    } else {
      const remaining = Number.parseInt(next.remainingSeconds ?? '0', 10);
      await fx.sleepSeconds(Number.isFinite(remaining) && remaining > 0 ? remaining : 1);
    }
  }
  throw new SequenceRefusal('GATE_CHECKS_EXHAUSTED', `${gate} was not satisfied after ${String(maxChecks)} checks`);
}

const ORDER: readonly GateId[] = ['GATE_1_OWNERSHIP', 'GATE_2_POSSESSION', 'GATE_3_RISK_PERIOD'];
const isLater = (a: GateId, b: GateId): boolean => ORDER.indexOf(a) > ORDER.indexOf(b);

/** A refusal the orchestration itself raises. Never retried: it is a fact about the sequence, not about a rail. */
export class SequenceRefusal extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SequenceRefusal';
  }
}
