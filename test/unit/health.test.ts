/**
 * Health aggregation and the rules that keep the three endpoints distinct.
 *
 * The behavioural tests for the endpoints themselves live in
 * `test/contract/service.test.ts`, driven over HTTP. What is tested here is
 * the logic underneath: how component results become one status, what a
 * failing check is allowed to say, and that a hanging dependency cannot take
 * the endpoint down with it.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  aggregate,
  createHealthService,
  statusCodeFor,
  type ComponentReport,
  type HealthCheck,
} from '../../services/origination/src/health.ts';

const report = (name: string, status: ComponentReport['status']): ComponentReport => ({
  name,
  status,
  tookMs: 1,
});

const check = (
  name: string,
  critical: boolean,
  run: HealthCheck['run'],
): HealthCheck => ({ name, critical, run });

describe('aggregation', () => {
  const critical = new Map([
    ['db', true],
    ['cache', false],
  ]);

  it('is UP when everything is up', () => {
    expect(aggregate([report('db', 'UP'), report('cache', 'UP')], critical)).toBe('UP');
  });

  it('is DOWN when a critical component is down', () => {
    expect(aggregate([report('db', 'DOWN'), report('cache', 'UP')], critical)).toBe('DOWN');
  });

  it('is only DEGRADED when a non-critical component is down', () => {
    // The service can still do its job without the cache. Reporting DOWN
    // would take it out of rotation for a problem it works around.
    expect(aggregate([report('db', 'UP'), report('cache', 'DOWN')], critical)).toBe('DEGRADED');
  });

  it('is DEGRADED when anything is degraded', () => {
    expect(aggregate([report('db', 'DEGRADED')], critical)).toBe('DEGRADED');
  });

  it('treats an unknown component as critical', () => {
    // Failing closed. A check added without registering its criticality
    // should make the service look worse than it is, not better.
    expect(aggregate([report('mystery', 'DOWN')], new Map())).toBe('DOWN');
  });

  it('is UP with no checks at all', () => {
    expect(aggregate([], critical)).toBe('UP');
  });
});

describe('status codes', () => {
  it('answers 200 for UP', () => {
    expect(statusCodeFor('UP')).toBe(200);
  });

  it('answers 200 for DEGRADED, not 503', () => {
    // Degraded means serving. A 503 here would fail the deployment out of
    // rotation over a non-critical dependency, and would train people to
    // ignore the alarm.
    expect(statusCodeFor('DEGRADED')).toBe(200);
  });

  it('answers 503 for DOWN', () => {
    expect(statusCodeFor('DOWN')).toBe(503);
  });
});

describe('running the checks', () => {
  it('reports every component with its timing', async () => {
    const service = createHealthService({
      checks: [
        check('a', true, () => Promise.resolve({ status: 'UP' })),
        check('b', false, () => Promise.resolve({ status: 'DEGRADED', detail: 'slow' })),
      ],
    });

    const result = await service.check();
    expect(result.status).toBe('DEGRADED');
    expect(result.components.map((c) => c.name).sort()).toEqual(['a', 'b']);
    for (const component of result.components) {
      expect(component.tookMs).toBeGreaterThanOrEqual(0);
    }
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('runs checks concurrently, not one after another', async () => {
    const slow = (): Promise<{ status: 'UP' }> =>
      new Promise((resolve) => setTimeout(() => { resolve({ status: 'UP' }); }, 60));

    const service = createHealthService({
      checks: [check('a', true, slow), check('b', true, slow), check('c', true, slow)],
    });

    const started = Date.now();
    await service.check();
    const elapsed = Date.now() - started;

    // Sequentially this would be ~180ms. Concurrently it is ~60ms. A health
    // endpoint whose latency is the sum of every dependency's worst case is
    // one that times out exactly when you need it.
    expect(elapsed).toBeLessThan(150);
  });

  it('survives a check that throws, without quoting the exception', async () => {
    const service = createHealthService({
      checks: [
        check('leaky', true, () =>
          Promise.reject(
            new Error('connect failed: postgres://sanad:hunter2@db.internal:5432/sanad'),
          ),
        ),
      ],
    });

    const result = await service.check();
    expect(result.status).toBe('DOWN');

    // The decisive assertion. A client library's exception routinely carries
    // a connection string, and a connection string routinely carries a
    // password. None of it reaches the report (§4).
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('postgres://');
    expect(serialised).not.toContain('db.internal');
  });

  it('does not hang when a dependency hangs', async () => {
    vi.useFakeTimers();
    try {
      const service = createHealthService({
        checks: [check('wedged', true, () => new Promise<never>(() => {}))],
      });

      const pending = service.check();
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await pending;

      expect(result.status).toBe('DOWN');
      expect(result.components[0]?.detail).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});
