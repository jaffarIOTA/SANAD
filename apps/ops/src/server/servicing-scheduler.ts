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
import { developmentAttestation } from './store.ts';

/** The principal the cycle's changes are recorded under. No person; no workbench form can act as it. */
export const SERVICING_SCHEDULER = 'system:servicing-scheduler';

const TASKS: Readonly<Record<ServicingTask, (tenant: TenantCode, id: string) => Promise<Result<unknown>>>> = {
  LATE_CHARGES: (t, id) => assessLateCharges(t, id, SERVICING_SCHEDULER),
  COLLECTIONS: (t, id) => presentCollections(t, id, SERVICING_SCHEDULER),
  BUREAU_REPORT: (t, id) => reportToBureau(t, id, SERVICING_SCHEDULER),
};

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
    disbursedFacilities: async (tenantId) =>
      (await listApplications(tenantId as TenantCode))
        .filter((v) => v.application.status === 'DISBURSED' && v.servicing !== undefined)
        .map((v) => v.application.applicationId)
        .sort((a, b) => a.localeCompare(b)),
    // Each task is one operation, persisted as one change, exactly as the button would.
    run: (tenantId, applicationId, task) =>
      mutateBusiness(tenantId as TenantCode, () => TASKS[task](tenantId as TenantCode, applicationId)),
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
