/**
 * The servicing day as a program over effects (Servicing S4). Same
 * discipline as the sequencing programs: orchestration only, types only from
 * the domain, every step an effect the host supplies.
 *
 * One run per tenant per servicing date: plan the day (the attested date, the
 * tasks the tenant's schedule runs on it, the disbursed facilities), then run
 * each task for each facility in order. A facility whose task fails is
 * reported and the cycle carries on with the next; one facility's problem
 * never stops the others being serviced. Every task is idempotent in the
 * application service, so a re-run changes nothing already done.
 */

import type { ServicingDayReport, ServicingTask, TaskOutcome, TenantTask } from '../../../core/servicing/schedule.ts';

export interface ServicingPlan {
  readonly servicingDate: string;
  /** Run once, before any facility (W4b): the day's receipts first. Absent in a plan from before W4b. */
  readonly tenantTasks?: readonly TenantTask[];
  readonly tasks: readonly ServicingTask[];
  readonly facilities: readonly string[];
}

export interface ServicingEffects {
  plan(): Promise<ServicingPlan>;
  /** Runs a tenant-wide task; a host with none never plans one. */
  runTenantTask?(task: TenantTask): Promise<TaskOutcome>;
  runTask(applicationId: string, task: ServicingTask): Promise<TaskOutcome>;
  progress(step: string): void;
}

/** The facility a tenant-wide task is reported under. */
export const TENANT_SUBJECT = 'TENANT';

export interface ServicingDayInput {
  readonly tenantId: string;
}

export async function runServicingDay(fx: ServicingEffects, input: ServicingDayInput): Promise<ServicingDayReport> {
  fx.progress('PLANNING');
  const plan = await fx.plan();
  let done = 0;
  let nothingDue = 0;
  let held = 0;
  const failed: { applicationId: string; task: ServicingTask | TenantTask; code: string }[] = [];
  const count = (applicationId: string, task: ServicingTask | TenantTask, outcome: TaskOutcome) => {
    if (outcome.kind === 'DONE') done += 1;
    else if (outcome.kind === 'NOTHING_DUE') nothingDue += 1;
    else if (outcome.kind === 'HELD') held += 1;
    else failed.push({ applicationId, task, code: outcome.code });
  };
  // The tenant's own tasks first: a failure is reported and the facilities are still serviced.
  const runTenantTask = fx.runTenantTask?.bind(fx);
  if (runTenantTask !== undefined)
    for (const task of plan.tenantTasks ?? []) {
      fx.progress(`TENANT ${task}`);
      count(TENANT_SUBJECT, task, await runTenantTask(task));
    }
  for (const applicationId of plan.facilities) {
    fx.progress(`SERVICING ${applicationId}`);
    for (const task of plan.tasks) count(applicationId, task, await fx.runTask(applicationId, task));
  }
  fx.progress('DONE');
  return {
    tenantId: input.tenantId,
    servicingDate: plan.servicingDate,
    facilities: plan.facilities.length,
    done,
    nothingDue,
    held,
    failed,
  };
}
