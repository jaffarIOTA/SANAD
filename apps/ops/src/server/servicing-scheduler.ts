/**
 * The daily servicing cycle's host (Servicing S4): the application service's
 * servicing operations behind the port the workflow activities use
 * (adapters/workflow-temporal/activities-servicing.ts).
 *
 * On the institution's cluster the Temporal Schedule starts `servicingDay`
 * for each tenant at its configured local time and the worker calls this
 * host. Until that cluster runs, the workbench can run the same program now
 * (`runServicingCycleNow`) through the in-memory runner — the same plan, the
 * same tasks, the same idempotency. Each task is the operation a finance user
 * would otherwise press, recorded under the scheduler's own principal, never a
 * person's, and persisted as that operation's change.
 */
import { type TenantCode, loadServicingPolicy } from '@sanad/config/loader.ts';
import { type Result, reject } from '@sanad/core/kernel/result.ts';
import type { ServicingDayReport, ServicingTask } from '@sanad/core/servicing/schedule.ts';

import type { ServicingHost } from '../../../../adapters/workflow-temporal/activities-servicing.ts';
import { runServicingDayInMemory } from '../../../../adapters/workflow-temporal/in-memory/runner.ts';
import { SequenceRefusal } from '../../../../adapters/workflow-temporal/programs/murabaha.ts';
import {
  assessLateCharges,
  listApplications,
  mutateBusiness,
  presentCollections,
  reportToBureau,
  servicingCalendarOf,
} from './business.ts';
import { getTransaction, listTransactions } from '@sanad/origination/wasl/book.ts';
import { reconcilePaidBills } from '@sanad/origination/wasl/reconciliation.ts';
import { presentDueInstalments } from '@sanad/origination/wasl/settlement.ts';

import { developmentAttestation } from './store.ts';

/** The principal the cycle's changes are recorded under. No person; no workbench form can act as it. */
export const SERVICING_SCHEDULER = 'system:servicing-scheduler';

const TASKS: Readonly<Record<ServicingTask, (tenant: TenantCode, id: string) => Promise<Result<unknown>>>> = {
  LATE_CHARGES: (t, id) => assessLateCharges(t, id, SERVICING_SCHEDULER),
  COLLECTIONS: (t, id) => presentCollections(t, id, SERVICING_SCHEDULER),
  BUREAU_REPORT: (t, id) => reportToBureau(t, id, SERVICING_SCHEDULER),
};

/** A Wasl transaction's reference: the cycle services it beside the business loans (W4b). */
const isWaslRef = (id: string): boolean => /^WT-\d{6,10}$/.test(id);

const notForThisFacility = (task: string): Result<never> =>
  reject('OP-DETERMINACY', 'NOT_FOR_THIS_FACILITY', 'This task is not one a Wasl transaction has yet', { task });

/**
 * A Wasl transaction's tasks. Collections present what falls due (W4a), each
 * step persisting itself. Late amounts come with W4b-2 (proposed by the cycle,
 * confirmed by two people); credit-bureau reporting of Wasl facilities is not
 * built yet — both are reported as not this facility's, never as done.
 */
const WASL_TASKS: Readonly<Record<ServicingTask, (tenant: TenantCode, ref: string) => Promise<Result<unknown>>>> = {
  LATE_CHARGES: () => Promise.resolve(notForThisFacility('LATE_CHARGES')),
  // The day's plan is made before the paid-bills file is read: a transaction that reading settled has nothing to collect.
  COLLECTIONS: async (t, ref) =>
    (await getTransaction(t, ref))?.transaction.state === 'ACTIVE'
      ? presentDueInstalments(t, ref, SERVICING_SCHEDULER)
      : reject('OP-DETERMINACY', 'NOTHING_TO_COLLECT', 'The transaction is no longer being collected'),
  BUREAU_REPORT: () => Promise.resolve(notForThisFacility('BUREAU_REPORT')),
};

/** The Wasl transactions in servicing: those whose obligation is booked and not yet settled. */
async function activeWaslTransactions(tenant: TenantCode): Promise<readonly string[]> {
  try {
    return (await listTransactions(tenant))
      .filter((v) => v.transaction.state === 'ACTIVE')
      .map((v) => v.transactionRef)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // A tenant with no Wasl programme has no transactions to service.
    return [];
  }
}

/**
 * Read SADAD's paid-bills file and apply what matches (W4b). Nothing applied is
 * nothing due; an exception is a failure for operations to look at, with the
 * detail on the reconciliation screen.
 */
async function reconcile(tenant: TenantCode): Promise<Result<unknown>> {
  if ((await activeWaslTransactions(tenant)).length === 0)
    return reject('OP-DETERMINACY', 'NOTHING_TO_RECONCILE', 'No Wasl transaction is being collected');
  const r = await reconcilePaidBills(tenant, SERVICING_SCHEDULER);
  if (!r.ok) return r;
  if (r.value.exceptions.length > 0)
    return reject('OP-DETERMINACY', 'RECONCILIATION_EXCEPTIONS', 'Paid bills could not be matched; see reconciliation');
  if (r.value.applied.length === 0)
    return reject('OP-DETERMINACY', 'NOTHING_TO_RECONCILE', 'No new receipt in the paid-bills file');
  return r;
}

export function servicingHost(): ServicingHost {
  return {
    attestation: { attest: () => Promise.resolve(developmentAttestation()) },
    servicingDate: (tenantId, at) => {
      const calendar = servicingCalendarOf(tenantId as TenantCode);
      if (calendar === undefined) return Promise.reject(new Error('unknown tenant'));
      return Promise.resolve(calendar.dateAt(at.epochSeconds));
    },
    schedule: (tenantId) => {
      const policy = loadServicingPolicy(tenantId as TenantCode);
      return policy.ok ? { ok: true, value: policy.value.schedule } : policy;
    },
    disbursedFacilities: async (tenantId) => [
      ...(await listApplications(tenantId as TenantCode))
        .filter((v) => v.application.status === 'DISBURSED' && v.servicing !== undefined)
        .map((v) => v.application.applicationId)
        .sort((a, b) => a.localeCompare(b)),
      ...(await activeWaslTransactions(tenantId as TenantCode)),
    ],
    // Each task is one operation, persisted as one change, exactly as the button would.
    run: (tenantId, id, task) =>
      isWaslRef(id)
        ? WASL_TASKS[task](tenantId as TenantCode, id)
        : mutateBusiness(tenantId as TenantCode, () => TASKS[task](tenantId as TenantCode, id)),
    runTenant: (tenantId, task) =>
      task === 'RECONCILE_COLLECTIONS'
        ? reconcile(tenantId as TenantCode)
        : Promise.resolve(reject('OP-DETERMINACY', 'NOT_FOR_THIS_FACILITY', 'Unknown tenant task')),
  };
}

/**
 * The last cycle this process ran per tenant, for the workbench to show. A
 * summary only (counts, references, codes); what each task did is recorded on
 * the application itself under the scheduler's principal.
 */
const LAST_KEY = Symbol.for('sanad.ops.lastServicingCycle');
const lastRuns = (): Map<string, ServicingDayReport & { readonly ranAtEpochSeconds: bigint }> => {
  const g = globalThis as { [LAST_KEY]?: Map<string, ServicingDayReport & { readonly ranAtEpochSeconds: bigint }> };
  g[LAST_KEY] ??= new Map();
  return g[LAST_KEY];
};

export function lastServicingCycle(
  tenant: TenantCode,
): (ServicingDayReport & { readonly ranAtEpochSeconds: bigint }) | undefined {
  return lastRuns().get(tenant);
}

/** Run today's cycle for a tenant now, in process: the same program the scheduled workflow runs. */
export async function runServicingCycleNow(tenant: TenantCode): Promise<Result<ServicingDayReport>> {
  try {
    const { report } = await runServicingDayInMemory(servicingHost(), { tenantId: tenant });
    lastRuns().set(tenant, { ...report, ranAtEpochSeconds: developmentAttestation().epochSeconds });
    return { ok: true, value: report };
  } catch (error) {
    const reason = error instanceof SequenceRefusal ? error.reason : '';
    return reject(
      'OP-DETERMINACY',
      reason === 'SERVICING_POLICY_INVALID' || reason === 'SERVICING_POLICY_NOT_FOUND'
        ? reason
        : 'SERVICING_CYCLE_FAILED',
      'The servicing cycle did not complete; what it finished is recorded and a re-run continues safely',
    );
  }
}
