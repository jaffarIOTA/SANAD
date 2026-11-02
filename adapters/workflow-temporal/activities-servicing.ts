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
  outcomeOfRefusal,
  tasksForDay,
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
  /** The tenant's disbursed facilities, by application id. */
  disbursedFacilities(tenantId: string): Promise<readonly string[]>;
  run(tenantId: string, applicationId: string, task: ServicingTask): Promise<Result<unknown>>;
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
        tasks: tasksForDay(servicingDate, schedule.value),
        facilities: await host.disbursedFacilities(ref.tenantId),
      };
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
