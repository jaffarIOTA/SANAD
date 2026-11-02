/**
 * Temporal workflows: the programs bound to activities, signals, queries and
 * durable timers. This file runs inside Temporal's deterministic sandbox —
 * nothing here may import a Node built-in or a value from the domain; the
 * programs import types only, and every effect that does anything is an
 * activity proxied through `proxyActivities`.
 *
 * Retry: rails fail and are retried under the policy the worker was given
 * (mapped from the tenant's `servicingRetry`); a `SequencingRefusal` is a
 * domain fact and is never retried.
 */

import { condition, defineQuery, defineSignal, proxyActivities, setHandler, sleep } from '@temporalio/workflow';

import type { GateId } from '../../../core/evidence/evidence.ts';
import type { MurabahaActivities } from '../activities.ts';
import type { TawarruqActivities } from '../activities-tawarruq.ts';
import {
  type MurabahaEffects,
  type MurabahaOutcome,
  type MurabahaSequenceInput,
  runMurabahaSequence,
} from '../programs/murabaha.ts';
import {
  type TawarruqEffects,
  type TawarruqOutcome,
  type TawarruqSequenceInput,
  runTawarruqSequence,
} from '../programs/tawarruq.ts';
import type { ServicingActivities } from '../activities-servicing.ts';
import { type ServicingDayInput, type ServicingEffects, runServicingDay } from '../programs/servicing.ts';
import type { ServicingDayReport } from '../../../core/servicing/schedule.ts';

export interface RetryInput {
  readonly maxAttempts: number;
  readonly backoffSeconds: number;
}

export const evidenceRecorded = defineSignal<[{ readonly gateId: GateId }]>('evidenceRecorded');
export const offerAnswered = defineSignal<[{ readonly outcome: 'ACCEPTED' | 'LAPSED' }]>('offerAnswered');
export const saleSigned = defineSignal<[{ readonly documentRef: string }]>('saleSigned');
export const progressQuery = defineQuery<string>('progress');

function activities<T>(retry: RetryInput): T {
  return proxyActivities<T>({
    startToCloseTimeout: '5 minutes',
    retry: {
      maximumAttempts: retry.maxAttempts,
      initialInterval: `${String(retry.backoffSeconds)} seconds`,
      backoffCoefficient: 2,
      nonRetryableErrorTypes: ['SequenceRefusal'],
    },
  } as never) as T;
}

export async function murabahaSequence(
  input: MurabahaSequenceInput & { readonly retry: RetryInput },
): Promise<MurabahaOutcome> {
  const acts = activities<MurabahaActivities>(input.retry);
  const ref = { tenantId: input.tenantId, transactionId: input.transactionId };
  const evidenceSeen = new Set<GateId>();
  let offer: 'ACCEPTED' | 'LAPSED' | undefined;
  let progress = 'STARTED';
  setHandler(evidenceRecorded, ({ gateId }) => {
    evidenceSeen.add(gateId);
  });
  setHandler(offerAnswered, ({ outcome }) => {
    offer = outcome;
  });
  setHandler(progressQuery, () => progress);

  const fx: MurabahaEffects = {
    validateAndReserve: () => acts.validateAndReserve(ref),
    executeLeg: (step) => acts.executeLeg(ref, step),
    evaluateGates: () => acts.evaluateGates(ref),
    acquireOwnership: () => acts.acquireOwnership(ref),
    confirmPossession: () => acts.confirmPossession(ref),
    offerSale: (validity) => acts.offerSale(ref, validity),
    acceptOffer: () => acts.acceptOffer(ref),
    bookObligation: () => acts.bookObligation(ref),
    lapseOffer: () => acts.lapseOffer(ref),
    unwind: (disposition) => acts.unwind(ref, disposition),
    // A signal says evidence arrived; only the next evaluateGates() says it counts.
    waitForEvidence: async (gate) => {
      await condition(() => evidenceSeen.has(gate));
      evidenceSeen.delete(gate);
    },
    waitForOfferOutcome: async (validity) => {
      const answered = await condition(() => offer !== undefined, validity * 1000);
      return answered && offer === 'ACCEPTED' ? 'ACCEPTED' : 'LAPSED';
    },
    // The durable timer wakes the workflow. It never decides anything.
    sleepSeconds: (seconds) => sleep(seconds * 1000),
    progress: (step) => {
      progress = step;
    },
  };
  return runMurabahaSequence(fx, input);
}

export async function tawarruqSequence(
  input: TawarruqSequenceInput & { readonly retry: RetryInput },
): Promise<TawarruqOutcome> {
  const acts = activities<TawarruqActivities>(input.retry);
  const ref = { tenantId: input.tenantId, transactionId: input.transactionId };
  let signature: string | undefined;
  let progress = 'STARTED';
  setHandler(saleSigned, ({ documentRef }) => {
    signature = documentRef;
  });
  setHandler(progressQuery, () => progress);

  const fx: TawarruqEffects = {
    purchaseCommodity: () => acts.purchaseCommodity(ref),
    sellToCustomer: () => acts.sellToCustomer(ref, signature ?? ''),
    transferTitle: () => acts.transferTitle(ref),
    realiseProceeds: () => acts.realiseProceeds(ref),
    disburse: () => acts.disburse(ref),
    waitForSaleSignature: async (timeout) =>
      (await condition(() => signature !== undefined, timeout * 1000)) ? 'SIGNED' : 'TIMED_OUT',
    unwind: (reason) => acts.unwind(ref, reason),
    progress: (step) => {
      progress = step;
    },
  };
  return runTawarruqSequence(fx, input);
}

/**
 * One tenant's servicing day. Started by the tenant's Temporal Schedule at its
 * local run time (see ensureServicingSchedule in ../adapter.ts), or by hand;
 * the schedule only wakes it — the date comes from an attested instant in the
 * planning activity.
 */
export async function servicingDay(
  input: ServicingDayInput & { readonly retry: RetryInput },
): Promise<ServicingDayReport> {
  const acts = activities<ServicingActivities>(input.retry);
  let progress = 'STARTED';
  setHandler(progressQuery, () => progress);
  const fx: ServicingEffects = {
    plan: () => acts.planServicingDay({ tenantId: input.tenantId }),
    runTenantTask: (task) => acts.runServicingTenantTask({ tenantId: input.tenantId, task }),
    runTask: (applicationId, task) => acts.runServicingTask({ tenantId: input.tenantId, applicationId, task }),
    progress: (step) => {
      progress = step;
    },
  };
  return runServicingDay(fx, input);
}
