/**
 * Temporal as the WorkflowPort (ADR 0003).
 *
 * The one vendor word in the domain's vicinity is confined to this
 * directory. Starting is idempotent on the workflow id: a second start for
 * the same id returns the running instance rather than a duplicate, which is
 * what lets the outbox retry a start safely.
 */

import { Client, Connection, WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError } from '@temporalio/client';

import { type Result, ok, reject } from '../../core/kernel/result.ts';
import type { WorkflowHandle, WorkflowPort } from '../../core/ports/workflow.ts';

export interface TemporalAdapterConfig {
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
  /** mTLS material, from the vault, where the cluster requires it. Never logged. */
  readonly tls?: { readonly clientCertPem: Buffer; readonly clientKeyPem: Buffer; readonly serverRootCaPem?: Buffer };
}

export const SEQUENCING_TASK_QUEUE = 'sanad-sequencing';

export async function connectTemporal(config: TemporalAdapterConfig): Promise<TemporalWorkflowAdapter> {
  const connection = await Connection.connect({
    address: config.address,
    ...(config.tls === undefined ? {} : { tls: { clientCertPair: { crt: config.tls.clientCertPem, key: config.tls.clientKeyPem }, ...(config.tls.serverRootCaPem === undefined ? {} : { serverRootCACertificate: config.tls.serverRootCaPem }) } }),
  });
  return new TemporalWorkflowAdapter(new Client({ connection, namespace: config.namespace }), config.taskQueue);
}

export class TemporalWorkflowAdapter implements WorkflowPort {
  constructor(private readonly client: Client, private readonly taskQueue: string) {}

  /** Tenant-qualified, so two tenants' identifiers cannot collide in one namespace. */
  static id(tenantId: string, workflowId: string): string {
    return `${tenantId}/${workflowId}`;
  }

  async start(params: { readonly tenantId: string; readonly workflowType: string; readonly workflowId: string; readonly input: unknown; readonly correlationId: string }): Promise<Result<WorkflowHandle>> {
    const workflowId = TemporalWorkflowAdapter.id(params.tenantId, params.workflowId);
    try {
      const handle = await this.client.workflow.start(params.workflowType, {
        taskQueue: this.taskQueue,
        workflowId,
        args: [params.input],
        workflowIdReusePolicy: 'WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE' as never,
        memo: { correlationId: params.correlationId, tenantId: params.tenantId },
      });
      return ok({ workflowId: params.workflowId, runId: handle.firstExecutionRunId });
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        const existing = await this.client.workflow.getHandle(workflowId).describe();
        return ok({ workflowId: params.workflowId, runId: existing.runId });
      }
      return reject('OP-DETERMINACY', 'WORKFLOW_START_FAILED', 'The workflow engine did not accept the start', { workflowType: params.workflowType });
    }
  }

  async signal(handle: WorkflowHandle, signal: string, payload: unknown): Promise<Result<void>> {
    try {
      await this.client.workflow.getHandle(this.#qualified(handle), handle.runId).signal(signal, payload);
      return ok(undefined);
    } catch (error) {
      return reject('OP-DETERMINACY', error instanceof WorkflowNotFoundError ? 'WORKFLOW_NOT_FOUND' : 'WORKFLOW_SIGNAL_FAILED', 'The signal was not delivered', { signal });
    }
  }

  async query<T>(handle: WorkflowHandle, query: string): Promise<Result<T>> {
    try {
      return ok(await this.client.workflow.getHandle(this.#qualified(handle), handle.runId).query<T>(query));
    } catch {
      return reject('OP-DETERMINACY', 'WORKFLOW_QUERY_FAILED', 'The query was not answered', { query });
    }
  }

  async cancel(handle: WorkflowHandle, reason: string): Promise<Result<void>> {
    try {
      await this.client.workflow.getHandle(this.#qualified(handle), handle.runId).cancel();
      return ok(undefined);
    } catch {
      return reject('OP-DETERMINACY', 'WORKFLOW_CANCEL_FAILED', 'The cancellation was not accepted', { reason });
    }
  }

  /** Handles carry the tenant-qualified id; the memo holds the tenant, so the qualified id is what was started. */
  #qualified(handle: WorkflowHandle): string {
    return handle.workflowId.includes('/') ? handle.workflowId : handle.workflowId;
  }
}
