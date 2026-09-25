/**
 * Exceptions — the things that stop a request and need a person.
 *
 * BRD §17 asks that each exception carry a type, a severity, an owner, an SLA,
 * a resolution, a resolver and a complete audit trail. This is that, as a
 * small aggregate with an append-only history: nothing on an exception is
 * ever edited in place, every change is an event with who and when, and the
 * current state is derived from the events. That is what makes "complete
 * audit trail" a property of the data rather than a discipline of the team.
 *
 * Every instant is attested. Whether an exception has breached its SLA is a
 * pure function of its events and an observed instant, so it is replayable.
 *
 * What is deliberately absent: any way to *waive* an exception into
 * resolution without saying how it was resolved. `resolve` requires a
 * resolution; "closed, no reason" is not a state this aggregate can reach.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import type { TsaInstant } from '../time/tsa.ts';
import type { Principal } from '../origination/request.ts';

export const EXCEPTION_TYPES = [
  'MISSING_DOCUMENTS',
  'DOCUMENT_EXPIRED',
  'POLICY_EXCEPTION',
  'BUREAU_UNAVAILABLE',
  'SCREENING_UNAVAILABLE',
  'KYC_MISMATCH',
  'IDENTITY_MISMATCH',
  'INCOME_MISMATCH',
  'HIGH_EXPOSURE',
  'MANUAL_UNDERWRITING',
  'PENDING_INVESTIGATION',
  'INTEGRATION_FAILURE',
  'EXTRACTION_CONFIDENCE',
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

export const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type ExceptionStatus = 'OPEN' | 'ASSIGNED' | 'ESCALATED' | 'RESOLVED';

export type ExceptionEvent =
  | { readonly kind: 'OPENED'; readonly at: TsaInstant; readonly by: Principal; readonly detail: string }
  | { readonly kind: 'ASSIGNED'; readonly at: TsaInstant; readonly by: Principal; readonly to: Principal }
  | { readonly kind: 'NOTE'; readonly at: TsaInstant; readonly by: Principal; readonly note: string }
  | { readonly kind: 'ESCALATED'; readonly at: TsaInstant; readonly by: Principal; readonly to: Principal; readonly reason: string }
  | { readonly kind: 'RESOLVED'; readonly at: TsaInstant; readonly by: Principal; readonly resolution: string };

export interface CaseException {
  readonly exceptionId: string;
  readonly tenantId: string;
  /** What it blocks. A request today; a transaction later. */
  readonly subjectId: string;
  readonly type: ExceptionType;
  readonly severity: Severity;
  /** Seconds from opening within which it must be resolved. */
  readonly slaSeconds: number;
  /** Append-only. The current state is derived from this, never stored beside it. */
  readonly events: readonly ExceptionEvent[];
}

const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

export function statusOf(e: CaseException): ExceptionStatus {
  const final = last(e.events);
  if (final?.kind === 'RESOLVED') return 'RESOLVED';
  if (final?.kind === 'ESCALATED') return 'ESCALATED';
  return e.events.some((ev) => ev.kind === 'ASSIGNED' || ev.kind === 'ESCALATED') ? 'ASSIGNED' : 'OPEN';
}

export function ownerOf(e: CaseException): Principal | undefined {
  for (let i = e.events.length - 1; i >= 0; i -= 1) {
    const ev = e.events[i];
    if (ev?.kind === 'ASSIGNED' || ev?.kind === 'ESCALATED') return ev.to;
  }
  return undefined;
}

export function openedAt(e: CaseException): TsaInstant {
  const first = e.events[0];
  if (first?.kind !== 'OPENED') throw new Error('an exception begins with OPENED');
  return first.at;
}

/** Pure: SLA breach is a function of the events and an observed instant. */
export function slaBreached(e: CaseException, observedAt: TsaInstant): boolean {
  if (statusOf(e) === 'RESOLVED') return false;
  return observedAt.epochSeconds - openedAt(e).epochSeconds > BigInt(e.slaSeconds);
}

export function open(params: {
  readonly exceptionId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly type: ExceptionType;
  readonly severity: Severity;
  readonly slaSeconds: number;
  readonly by: Principal;
  readonly at: TsaInstant;
  readonly detail: string;
}): Result<CaseException> {
  if (params.detail.trim().length === 0) {
    return reject('OP-DETERMINACY', 'EXCEPTION_WITHOUT_DETAIL', 'An exception must say what is wrong', { type: params.type });
  }
  if (params.slaSeconds <= 0) {
    return reject('OP-DETERMINACY', 'EXCEPTION_SLA_INVALID', 'An exception needs a positive SLA', { type: params.type });
  }
  return ok({
    exceptionId: params.exceptionId,
    tenantId: params.tenantId,
    subjectId: params.subjectId,
    type: params.type,
    severity: params.severity,
    slaSeconds: params.slaSeconds,
    events: [{ kind: 'OPENED', at: params.at, by: params.by, detail: params.detail }],
  });
}

function openOnly(e: CaseException, action: string): Result<true> {
  if (statusOf(e) === 'RESOLVED') {
    return reject('OP-DETERMINACY', 'EXCEPTION_ALREADY_RESOLVED', `Cannot ${action} a resolved exception`, { exceptionId: e.exceptionId });
  }
  return ok(true);
}

export function assign(e: CaseException, by: Principal, to: Principal, at: TsaInstant): Result<CaseException> {
  const openCheck = openOnly(e, 'assign'); if (!openCheck.ok) return openCheck;
  if (to.tenantId !== e.tenantId) {
    return reject('OP-DETERMINACY', 'EXCEPTION_OWNER_TENANT_MISMATCH', 'An exception is owned within its own tenant', { exceptionId: e.exceptionId });
  }
  return ok({ ...e, events: [...e.events, { kind: 'ASSIGNED', at, by, to }] });
}

export function note(e: CaseException, by: Principal, text: string, at: TsaInstant): Result<CaseException> {
  const openCheck = openOnly(e, 'annotate'); if (!openCheck.ok) return openCheck;
  if (text.trim().length === 0) return reject('OP-DETERMINACY', 'EXCEPTION_NOTE_EMPTY', 'A note must say something', { exceptionId: e.exceptionId });
  return ok({ ...e, events: [...e.events, { kind: 'NOTE', at, by, note: text }] });
}

export function escalate(e: CaseException, by: Principal, to: Principal, reason: string, at: TsaInstant): Result<CaseException> {
  const openCheck = openOnly(e, 'escalate'); if (!openCheck.ok) return openCheck;
  if (reason.trim().length === 0) return reject('OP-DETERMINACY', 'ESCALATION_WITHOUT_REASON', 'Escalating requires a reason', { exceptionId: e.exceptionId });
  return ok({ ...e, events: [...e.events, { kind: 'ESCALATED', at, by, to, reason }] });
}

/** The only way out. A resolution is required; "closed" without one is not reachable. */
export function resolve(e: CaseException, by: Principal, resolution: string, at: TsaInstant): Result<CaseException> {
  const openCheck = openOnly(e, 'resolve'); if (!openCheck.ok) return openCheck;
  if (resolution.trim().length === 0) {
    return reject('OP-DETERMINACY', 'RESOLUTION_REQUIRED', 'An exception is resolved by saying how, not by closing it', { exceptionId: e.exceptionId });
  }
  return ok({ ...e, events: [...e.events, { kind: 'RESOLVED', at, by, resolution }] });
}

export const resolverOf = (e: CaseException): Principal | undefined => {
  const final = last(e.events);
  return final?.kind === 'RESOLVED' ? final.by : undefined;
};
