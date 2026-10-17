/**
 * The daily servicing cycle (Servicing S4). Each case attempts something the
 * cycle must not do and passes only when it does not happen: charging,
 * presenting or reporting twice in a day; acting on a facility in hardship;
 * one facility's failure stopping the others; deciding the day from the
 * scheduler's clock; recording a change under a person's name. Plus the
 * pure schedule and the Temporal Schedule's registration.
 *
 * The book is the in-memory development seed (each tenant has one facility
 * current and one 38 days in arrears).
 */
import { ScheduleAlreadyRunning } from '@temporalio/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  type TaskOutcome,
  outcomeOfRefusal,
  parseServicingSchedule,
  tasksForDay,
} from '@sanad/core/servicing/schedule.ts';
import { TemporalWorkflowAdapter } from '../../adapters/workflow-temporal/adapter.ts';
import { runServicingDay } from '../../adapters/workflow-temporal/programs/servicing.ts';
import { listApplications, resetBusinessStore, setHardship } from '../../apps/ops/src/server/business.ts';
import {
  SERVICING_SCHEDULER,
  lastServicingCycle,
  runServicingCycleNow,
  servicingHost,
} from '../../apps/ops/src/server/servicing-scheduler.ts';

const SCHEDULE = { runAtLocal: '06:00', bureauReportingDay: 5 };

describe('the servicing day, pure', () => {
  it('charges, then collects, and reports to the bureau only from the reporting day', () => {
    expect(tasksForDay('2026-10-04', SCHEDULE)).toEqual(['LATE_CHARGES', 'COLLECTIONS']);
    expect(tasksForDay('2026-10-05', SCHEDULE)).toEqual(['LATE_CHARGES', 'COLLECTIONS', 'BUREAU_REPORT']);
    expect(tasksForDay('2026-10-31', SCHEDULE)).toEqual(['LATE_CHARGES', 'COLLECTIONS', 'BUREAU_REPORT']);
    expect(tasksForDay('not-a-date', SCHEDULE)).toEqual([]);
  });

  it('a schedule is a local time and a reporting day every month has', () => {
    expectOk(parseServicingSchedule(SCHEDULE));
    for (const bad of [
      { runAtLocal: '6am', bureauReportingDay: 5 },
      { runAtLocal: '24:00', bureauReportingDay: 5 },
      { runAtLocal: '06:00', bureauReportingDay: 31 },
      { runAtLocal: '06:00', bureauReportingDay: 0 },
      undefined,
    ])
      expect(parseServicingSchedule(bad).ok, JSON.stringify(bad)).toBe(false);
  });

  it('only known harmless refusals are "nothing due"; anything else is a failure for a person', () => {
    expect(outcomeOfRefusal('NOTHING_TO_COLLECT')).toEqual({ kind: 'NOTHING_DUE' });
    expect(outcomeOfRefusal('NO_LATE_CHARGE_DUE')).toEqual({ kind: 'NOTHING_DUE' });
    expect(outcomeOfRefusal('BUREAU_ALREADY_REPORTED')).toEqual({ kind: 'NOTHING_DUE' });
    expect(outcomeOfRefusal('HARDSHIP_HOLD')).toEqual({ kind: 'HELD' });
    expect(outcomeOfRefusal('PAYEE_NOT_CONFIRMED')).toEqual({ kind: 'FAILED', code: 'PAYEE_NOT_CONFIRMED' });
    expect(outcomeOfRefusal('ANYTHING_NEW')).toEqual({ kind: 'FAILED', code: 'ANYTHING_NEW' });
  });

  it('one facility’s failure does not stop the others being serviced', async () => {
    const ran: string[] = [];
    const report = await runServicingDay(
      {
        plan: () =>
          Promise.resolve({
            servicingDate: '2026-10-17',
            tasks: ['LATE_CHARGES', 'COLLECTIONS'],
            facilities: ['A', 'B'],
          }),
        runTask: (id, task): Promise<TaskOutcome> => {
          ran.push(`${id}:${task}`);
          return Promise.resolve(
            id === 'A' && task === 'LATE_CHARGES' ? { kind: 'FAILED', code: 'X' } : { kind: 'DONE' },
          );
        },
        progress: () => undefined,
      },
      { tenantId: 't' },
    );
    expect(ran).toEqual(['A:LATE_CHARGES', 'A:COLLECTIONS', 'B:LATE_CHARGES', 'B:COLLECTIONS']);
    expect(report).toMatchObject({
      facilities: 2,
      done: 3,
      failed: [{ applicationId: 'A', task: 'LATE_CHARGES', code: 'X' }],
    });
  });
});

describe('the cycle on the books', () => {
  beforeEach(() => {
    vi.stubEnv('SANAD_DATABASE_URL', '');
    resetBusinessStore();
  });

  it.each(['sme-fund-ae', 'bank-a', 'fintech-b'] as const)(
    '%s: charges the facility in arrears, presents what is due, reports the month — and a second run changes nothing',
    async (tenant) => {
      const first = expectOk(await runServicingCycleNow(tenant));
      expect(first.facilities).toBe(2);
      expect(first.failed).toEqual([]);
      expect(first.done).toBeGreaterThan(0);
      const views = await listApplications(tenant);
      const arrears = views.find((v) => (v.servicing?.position.daysPastDue ?? 0) > 0);
      expect(arrears?.servicing?.lateCharges.every((c) => c.assessedBy === SERVICING_SCHEDULER)).toBe(true);
      expect(arrears?.servicing?.lateCharges.length).toBeGreaterThan(0);
      expect(arrears?.servicing?.collections.length).toBeGreaterThan(0);
      // Every change the cycle made names the scheduler, never a person.
      const cycleEvents = views.flatMap((v) =>
        v.events.filter((e) =>
          ['LATE_CHARGE_ASSESSED', 'COLLECTION_PRESENTED', 'BUREAU_STATUS_REPORTED'].includes(e.eventType),
        ),
      );
      expect(cycleEvents.length).toBeGreaterThan(0);
      for (const e of cycleEvents) expect(e.actor).toBe(SERVICING_SCHEDULER);

      const second = expectOk(await runServicingCycleNow(tenant));
      expect(second.done).toBe(0);
      expect(second.failed).toEqual([]);
      const after = await listApplications(tenant);
      expect(after.flatMap((v) => v.events).length).toBe(views.flatMap((v) => v.events).length);
      expect(lastServicingCycle(tenant)?.servicingDate).toBe(second.servicingDate);
    },
  );

  it('a facility in hardship is held: no late charge and no collection', async () => {
    const before = await listApplications('bank-a');
    const arrears = before.find((v) => (v.servicing?.position.daysPastDue ?? 0) > 0);
    const id = arrears?.application.applicationId ?? '';
    expectOk(await setHardship('bank-a', id, 'Customer reported a temporary loss of a major contract', 'stf-maker-01'));
    const report = expectOk(await runServicingCycleNow('bank-a'));
    expect(report.held).toBe(2);
    const held = (await listApplications('bank-a')).find((v) => v.application.applicationId === id);
    expect(held?.servicing?.lateCharges).toEqual([]);
    expect(held?.servicing?.collections).toEqual([]);
  });

  it('the day is the attested date in the tenant’s time zone, not the scheduler’s clock', async () => {
    const host = servicingHost();
    const at = await host.attestation.attest();
    // 21:30 UTC on 16 Oct is already 17 Oct in Riyadh and Dubai.
    const late = { ...at, epochSeconds: BigInt(Date.UTC(2026, 9, 16, 21, 30) / 1000) };
    expect(await host.servicingDate('bank-a', late)).toBe('2026-10-17');
    expect(await host.servicingDate('sme-fund-ae', late)).toBe('2026-10-17');
  });
});

describe('the Temporal Schedule', () => {
  const client = () => {
    const created: unknown[] = [];
    const updated: unknown[] = [];
    let exists = false;
    const fake = {
      schedule: {
        create: (options: unknown) => {
          if (exists) return Promise.reject(new ScheduleAlreadyRunning('exists', 'x'));
          exists = true;
          created.push(options);
          return Promise.resolve({});
        },
        getHandle: () => ({
          update: (fn: (previous: unknown) => unknown) => {
            updated.push(fn({ state: { paused: false } }));
            return Promise.resolve();
          },
        }),
      },
    };
    return { fake, created, updated };
  };

  it('runs servicingDay daily at the tenant’s local time in its own time zone, once per tenant, and updates in place', async () => {
    const { fake, created, updated } = client();
    const adapter = new TemporalWorkflowAdapter(fake as never, 'sanad-sequencing');
    const params = {
      tenantId: 'bank-a',
      runAtLocal: '06:00',
      timeZone: 'Asia/Riyadh',
      retry: { maxAttempts: 3, backoffSeconds: 300 },
    };
    expectOk(await adapter.ensureServicingSchedule(params));
    expect(created[0]).toMatchObject({
      scheduleId: 'bank-a/servicing',
      spec: { calendars: [{ hour: 6, minute: 0 }], timezone: 'Asia/Riyadh' },
      action: {
        type: 'startWorkflow',
        workflowType: 'servicingDay',
        taskQueue: 'sanad-sequencing',
        args: [{ tenantId: 'bank-a', retry: { maxAttempts: 3, backoffSeconds: 300 } }],
      },
      policies: { overlap: 'SKIP', catchupWindow: '1 day' },
    });
    // A second call with a new time updates the same schedule instead of adding another.
    expectOk(await adapter.ensureServicingSchedule({ ...params, runAtLocal: '05:30' }));
    expect(created).toHaveLength(1);
    expect(updated[0]).toMatchObject({ spec: { calendars: [{ hour: 5, minute: 30 }] }, state: { paused: false } });
  });
});
