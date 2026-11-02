/**
 * Wasl W4b: the servicing day's tenant-wide tasks (reading the collection
 * rail's paid-bills file) run once, before any facility; one failing is
 * reported and never stops the facilities being serviced. Pure, over the
 * program's effects.
 */
import { describe, expect, it } from 'vitest';

import { tenantTasksForDay } from '@sanad/core/servicing/schedule.ts';

import { runServicingDay } from '../../adapters/workflow-temporal/programs/servicing.ts';

describe('tenant-wide tasks', () => {
  it('run first, once, and a failure is reported while the facilities are still serviced', async () => {
    const calls: string[] = [];
    const report = await runServicingDay(
      {
        plan: () =>
          Promise.resolve({
            servicingDate: '2026-10-21',
            tenantTasks: ['RECONCILE_COLLECTIONS'],
            tasks: ['COLLECTIONS'],
            facilities: ['BA-1', 'WT-000001'],
          }),
        runTenantTask: (task) => {
          calls.push(`TENANT:${task}`);
          return Promise.resolve({ kind: 'FAILED', code: 'RECONCILIATION_EXCEPTIONS' });
        },
        runTask: (id, task) => {
          calls.push(`${id}:${task}`);
          return Promise.resolve({ kind: 'DONE' });
        },
        progress: () => undefined,
      },
      { tenantId: 'bank-a' },
    );
    expect(calls).toEqual(['TENANT:RECONCILE_COLLECTIONS', 'BA-1:COLLECTIONS', 'WT-000001:COLLECTIONS']);
    expect(report.done).toBe(2);
    expect(report.failed).toEqual([
      { applicationId: 'TENANT', task: 'RECONCILE_COLLECTIONS', code: 'RECONCILIATION_EXCEPTIONS' },
    ]);
  });

  it('a host without tenant tasks runs none, and a malformed date plans none', async () => {
    const report = await runServicingDay(
      {
        plan: () =>
          Promise.resolve({
            servicingDate: '2026-10-21',
            tenantTasks: ['RECONCILE_COLLECTIONS'],
            tasks: [],
            facilities: [],
          }),
        runTask: () => Promise.resolve({ kind: 'DONE' }),
        progress: () => undefined,
      },
      { tenantId: 'bank-a' },
    );
    expect(report.done + report.nothingDue + report.failed.length).toBe(0);
    expect(tenantTasksForDay('2026-13-40')).toEqual([]);
    // Reconciliation first, so the day's receipts are in before the Shariah review reads the book (W6b-1).
    expect(tenantTasksForDay('2026-10-21')).toEqual(['RECONCILE_COLLECTIONS', 'SHARIAH_REVIEW']);
  });
});
