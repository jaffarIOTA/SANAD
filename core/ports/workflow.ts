/**
 * Durable orchestration, as a port (ADR 0003).
 *
 * The domain is pure state machines. Something durable has to call the
 * transitions in order, wait days for an interval to elapse, and retry an
 * adapter under a declared policy. That something is behind this port, and
 * it is never a domain input: a timer here *wakes* a step, and the step then
 * asks the timestamping authority what time it is.
 */

import type { Result } from '../kernel/result.ts';

export interface WorkflowHandle {
  readonly workflowId: string;
  readonly runId: string;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffSeconds: number;
}

export interface WorkflowPort {
  /** Idempotent on `workflowId`: starting the same id twice returns the running instance. */
  start(params: {
    readonly tenantId: string;
    readonly workflowType: string;
    readonly workflowId: string;
    readonly input: unknown;
    readonly correlationId: string;
  }): Promise<Result<WorkflowHandle>>;

  /** Deliver an external event (evidence arrived, servicing answered) to a running instance. */
  signal(handle: WorkflowHandle, signal: string, payload: unknown): Promise<Result<void>>;

  /** Read a running instance's own view of where it is. Never the domain record. */
  query<T>(handle: WorkflowHandle, query: string): Promise<Result<T>>;

  cancel(handle: WorkflowHandle, reason: string): Promise<Result<void>>;
}
