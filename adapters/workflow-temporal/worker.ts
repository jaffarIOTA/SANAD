/**
 * The sequencing worker. Assembled from the same ports the services use;
 * the tenant's `servicingRetry` becomes the activity retry policy at start
 * time. Runs on the institution's cluster beside the service, one task queue.
 *
 * Connection details come from the environment; mTLS material from the
 * vault. Nothing here is logged beyond the queue name and namespace.
 */

import { fileURLToPath } from 'node:url';

import { NativeConnection, Worker } from '@temporalio/worker';

import type { OriginationPolicy } from '../../core/origination/policy.ts';
import { createMurabahaActivities } from './activities.ts';
import { type TawarruqPorts, createTawarruqActivities } from './activities-tawarruq.ts';
import { type ServicingHost, createServicingActivities } from './activities-servicing.ts';
import { SEQUENCING_TASK_QUEUE } from './adapter.ts';
import type { SequencingPorts } from './ports.ts';
import type { RetryInput } from './workflows/index.ts';

export interface WorkerConfig {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue?: string;
  /** mTLS material where the cluster requires it, as mounted from the vault. Never logged. */
  readonly tls?: { readonly clientCertPem: Buffer; readonly clientKeyPem: Buffer; readonly serverRootCaPem?: Buffer };
}

/** The tenant's retry policy as the workflow input expects it. Declared once, in configuration. */
export function retryFor(policy: OriginationPolicy): RetryInput {
  return { maxAttempts: policy.servicingRetry.maxAttempts, backoffSeconds: policy.servicingRetry.backoffSeconds };
}

export async function startSequencingWorker(
  config: WorkerConfig,
  ports: {
    /** Absent until the sequences run on a server; a workflow that needs them then fails its activity, loudly. */
    readonly murabaha?: SequencingPorts;
    readonly tawarruq?: TawarruqPorts;
    /** The origination service's servicing operations, for the daily cycle (activities-servicing.ts). */
    readonly servicing: ServicingHost;
  },
): Promise<Worker> {
  const { tls } = config;
  const connection = await NativeConnection.connect({
    address: config.address,
    ...(tls === undefined
      ? {}
      : {
          tls: {
            clientCertPair: { crt: tls.clientCertPem, key: tls.clientKeyPem },
            ...(tls.serverRootCaPem === undefined ? {} : { serverRootCACertificate: tls.serverRootCaPem }),
          },
        }),
  });
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue ?? SEQUENCING_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
    activities: {
      ...(ports.murabaha === undefined ? {} : createMurabahaActivities(ports.murabaha)),
      ...(ports.tawarruq === undefined ? {} : createTawarruqActivities(ports.tawarruq)),
      ...createServicingActivities(ports.servicing),
    },
  });
  process.stdout.write(`sequencing worker on ${config.namespace}/${config.taskQueue ?? SEQUENCING_TASK_QUEUE}\n`);
  void worker.run();
  return worker;
}
