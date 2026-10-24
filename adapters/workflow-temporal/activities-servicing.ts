/**
 * Servicing activities (Servicing S4): planning the day and running one task
 * for one facility, each through the host's application service.
 *
 * The host is the origination service that owns the business records; this
 * file knows only the port below. A task's domain refusal is an answer the
 * cycle reports (nothing due, held for hardship, or a failure for a person to
 * look at), never an exception the engine retries. Only an exception — the
 * store unreachable, the process interrupted — is thrown, and the engine
 * retries it under the tenant's policy; the task is idempotent, so a retry
 * cannot charge, present or report twice.
 */

import type { Result } from '../../core/kernel/result.ts';
import {
  type ServicingSchedule,
  type ServicingTask,
  type TaskOutcome,
  type TenantTask,
  outcomeOfRefusal,
  tasksForDay,
  tenantTasksForDay,
} from '../../core/servicing/schedule.ts';
import type { TsaInstant } from '../../core/time/tsa.ts';
import { SequenceRefusal } from './programs/murabaha.ts';
import type { ServicingPlan } from './programs/servicing.ts';
import type { Attestation } from './ports.ts';

/** What the activities need from the host's application service. */
export interface ServicingHost {
  readonly attestation: Attestation;
  /** The tenant's servicing date (yyyy-mm-dd, its own time zone) at an attested instant. */
  servicingDate(tenantId: string, at: TsaInstant): Promise<string>;
  schedule(tenantId: string): Result<ServicingSchedule>;
  /** The tenant's facilities in servicing, by reference: business loans by application id, Wasl by transaction ref. */
  disbursedFacilities(tenantId: string): Promise<readonly string[]>;
  run(tenantId: string, applicationId: string, task: ServicingTask): Promise<Result<unknown>>;
  /** A tenant-wide task (W4b). A host without one runs no tenant tasks. */
  runTenant?(tenantId: string, task: TenantTask): Promise<Result<unknown>>;
}

interface DayRef {
  readonly tenantId: string;
}

export function createServicingActivities(host: ServicingHost) {
  return {
    async planServicingDay(ref: DayRef): Promise<ServicingPlan> {
      const schedule = host.schedule(ref.tenantId);
      if (!schedule.ok) throw new SequenceRefusal(schedule.error.reason, schedule.error.detail);
      const at = await host.attestation.attest();
      const servicingDate = await host.servicingDate(ref.tenantId, at);
      return {
        servicingDate,
        tenantTasks: host.runTenant === undefined ? [] : tenantTasksForDay(servicingDate),
        tasks: tasksForDay(servicingDate, schedule.value),
        facilities: await host.disbursedFacilities(ref.tenantId),
      };
    },

    async runServicingTenantTask(ref: DayRef & { readonly task: TenantTask }): Promise<TaskOutcome> {
      if (host.runTenant === undefined) return { kind: 'NOTHING_DUE' };
      const r = await host.runTenant(ref.tenantId, ref.task);
      return r.ok ? { kind: 'DONE' } : outcomeOfRefusal(r.error.reason);
    },

    async runServicingTask(
      ref: DayRef & { readonly applicationId: string; readonly task: ServicingTask },
    ): Promise<TaskOutcome> {
      const r = await host.run(ref.tenantId, ref.applicationId, ref.task);
      return r.ok ? { kind: 'DONE' } : outcomeOfRefusal(r.error.reason);
    },
  };
}

export type ServicingActivities = ReturnType<typeof createServicingActivities>;
