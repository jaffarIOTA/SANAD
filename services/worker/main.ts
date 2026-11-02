/**
 * The workflow worker, as its own process (ADR 0003, KSA-WF-TEMPORAL-01).
 *
 * It does two things on the institution's Temporal cluster:
 *
 *   - registers each tenant's daily servicing Schedule — its local run time and
 *     time zone from configuration — creating it once and leaving it alone after;
 *   - runs the workflows on the task queue, with the servicing activities
 *     answered by the same operations the workbench's finance user presses
 *     (apps/ops/src/server/servicing-scheduler.ts), under the scheduler's own
 *     principal.
 *
 * The Murabaha and Tawarruq sequences still run in the application process;
 * their activities join this worker when they move onto the cluster.
 *
 * Run:
 *   TEMPORAL_ADDRESS=… [TEMPORAL_NAMESPACE=default] [TEMPORAL_TASK_QUEUE=…] [SANAD_WORKER_TENANTS=bank-a,…]
 *   [TEMPORAL_TLS_CERT_FILE=… TEMPORAL_TLS_KEY_FILE=… TEMPORAL_TLS_CA_FILE=…]
 *   node --experimental-transform-types --import ./services/worker/aliases.mjs services/worker/main.ts [--check]
 *
 * `--check` assembles everything — every module resolved, every tenant's
 * schedule computed — and exits without connecting: the proof that this
 * process starts outside a bundler (test/architecture/worker-process.test.ts).
 * mTLS material is read from files the cluster mounts from the vault, never
 * from the environment's values, and is never logged.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  TENANT_CODES,
  type TenantCode,
  isTenantCode,
  loadOriginationPolicy,
  loadServicingPolicy,
  loadTenantJurisdiction,
} from '@sanad/config/loader.ts';

import { SEQUENCING_TASK_QUEUE, connectTemporal } from '../../adapters/workflow-temporal/adapter.ts';
import { retryFor, startSequencingWorker } from '../../adapters/workflow-temporal/worker.ts';
import { servicingHost } from '../../apps/ops/src/server/servicing-scheduler.ts';

type Env = Readonly<Record<string, string | undefined>>;

export interface TenantSchedule {
  readonly tenantId: TenantCode;
  readonly runAtLocal: string;
  readonly timeZone: string;
  readonly retry: { readonly maxAttempts: number; readonly backoffSeconds: number };
}

/** Each tenant's daily cycle as configured; a tenant without a servicing policy has none. */
export function tenantSchedules(env: Env = process.env): readonly TenantSchedule[] {
  const named = (env['SANAD_WORKER_TENANTS'] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const unknown = named.filter((t) => !isTenantCode(t));
  if (unknown.length > 0) throw new Error(`SANAD_WORKER_TENANTS names no such tenant: ${unknown.join(', ')}`);
  const tenants = named.length > 0 ? (named as TenantCode[]) : [...TENANT_CODES];
  return tenants.flatMap((tenantId) => {
    const servicing = loadServicingPolicy(tenantId);
    const origination = loadOriginationPolicy(tenantId);
    const jurisdiction = loadTenantJurisdiction(tenantId);
    if (!servicing.ok || !origination.ok || !jurisdiction.ok) return [];
    return [
      {
        tenantId,
        runAtLocal: servicing.value.schedule.runAtLocal,
        timeZone: jurisdiction.value.timeZone,
        retry: retryFor(origination.value),
      },
    ];
  });
}

function tlsFrom(env: Env) {
  const cert = env['TEMPORAL_TLS_CERT_FILE'];
  const key = env['TEMPORAL_TLS_KEY_FILE'];
  if (cert === undefined && key === undefined) return undefined;
  if (cert === undefined || key === undefined)
    throw new Error('TEMPORAL_TLS_CERT_FILE and TEMPORAL_TLS_KEY_FILE go together');
  const ca = env['TEMPORAL_TLS_CA_FILE'];
  return {
    clientCertPem: readFileSync(cert),
    clientKeyPem: readFileSync(key),
    ...(ca === undefined ? {} : { serverRootCaPem: readFileSync(ca) }),
  };
}

export async function main(argv: readonly string[], env: Env = process.env): Promise<number> {
  const schedules = tenantSchedules(env);
  const host = servicingHost();
  const namespace = env['TEMPORAL_NAMESPACE'] ?? 'default';
  const taskQueue = env['TEMPORAL_TASK_QUEUE'] ?? SEQUENCING_TASK_QUEUE;
  const say = (line: string) => process.stdout.write(`${line}\n`);

  if (argv.includes('--check')) {
    if (typeof host.run !== 'function' || typeof host.runTenant !== 'function') return 1;
    for (const s of schedules) say(`schedule ${s.tenantId} ${s.runAtLocal} ${s.timeZone}`);
    say(`worker ready for ${namespace}/${taskQueue}`);
    return 0;
  }

  const address = env['TEMPORAL_ADDRESS'];
  if (address === undefined || address.length === 0) {
    process.stderr.write('TEMPORAL_ADDRESS is required\n');
    return 2;
  }
  const tls = tlsFrom(env);
  const adapter = await connectTemporal({ address, namespace, taskQueue, ...(tls === undefined ? {} : { tls }) });
  for (const s of schedules) {
    const ensured = await adapter.ensureServicingSchedule(s);
    say(
      ensured.ok ? `schedule ${ensured.value.scheduleId} in place` : `schedule ${s.tenantId}: ${ensured.error.reason}`,
    );
  }
  const worker = await startSequencingWorker(
    { address, namespace, taskQueue, ...(tls === undefined ? {} : { tls }) },
    { servicing: host },
  );
  const stop = () => {
    say('worker shutting down');
    worker.shutdown();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return 0;
}

// Run when started as the process; imported by a test, it only exports.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      process.stderr.write(`worker failed to start: ${error instanceof Error ? error.name : 'error'}\n`);
      process.exit(1);
    },
  );
}
