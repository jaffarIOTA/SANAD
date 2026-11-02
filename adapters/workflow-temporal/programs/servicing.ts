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

import type { ServicingDayReport, ServicingTask, TaskOutcome } from '../../../core/servicing/schedule.ts';

export interface ServicingPlan {
  readonly servicingDate: string;
  readonly tasks: readonly ServicingTask[];
  readonly facilities: readonly string[];
}

export interface ServicingEffects {
  plan(): Promise<ServicingPlan>;
  runTask(applicationId: string, task: ServicingTask): Promise<TaskOutcome>;
  progress(step: string): void;
}

export interface ServicingDayInput {
  readonly tenantId: string;
}

export async function runServicingDay(fx: ServicingEffects, input: ServicingDayInput): Promise<ServicingDayReport> {
  fx.progress('PLANNING');
  const plan = await fx.plan();
  let done = 0;
  let nothingDue = 0;
  let held = 0;
  const failed: { applicationId: string; task: ServicingTask; code: string }[] = [];
  for (const applicationId of plan.facilities) {
    fx.progress(`SERVICING ${applicationId}`);
    for (const task of plan.tasks) {
      const outcome = await fx.runTask(applicationId, task);
      if (outcome.kind === 'DONE') done += 1;
      else if (outcome.kind === 'NOTHING_DUE') nothingDue += 1;
      else if (outcome.kind === 'HELD') held += 1;
      else failed.push({ applicationId, task, code: outcome.code });
    }
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
