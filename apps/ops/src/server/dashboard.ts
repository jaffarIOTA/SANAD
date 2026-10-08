/**
 * What the operations dashboard shows, computed from the request book and the
 * tenant's own configuration. Pure: the observed instant is an argument, and
 * nothing here reads a clock (the page passes an attested instant).
 *
 * The dashboard answers, in order: what needs attention now, where the book
 * is in the pipeline, and how the rails are configured. Every figure is a
 * count or a sum over real rows; nothing is invented to fill a slot.
 *
 * Service-level breaches use the tenant's own targets (origination policy
 * `slaSeconds`). A request's age in its current state is measured from its
 * submission (or raising, where it has not been submitted): the row does not
 * carry the moment it entered every state, so the figure is labelled "since
 * submission" on the screen. It is operational display only and feeds no gate.
 */

import { type OriginationPolicy, slaStatus } from '@sanad/core/origination/policy.ts';
import type { RailEntry } from '@sanad/core/config/rails.ts';

import type { RequestRow } from './store.ts';

export type AttentionKind = 'SLA_BREACHED' | 'AWAITING_REVIEW' | 'SERVICING_UNAVAILABLE' | 'PENDING_INFORMATION' | 'RETURNED_TO_MAKER';

export interface AttentionItem {
  readonly requestId: string;
  readonly kind: AttentionKind;
  readonly state: RequestRow['state'];
  readonly counterpartyId: string;
  readonly amountMinorUnits: bigint;
  readonly ageSeconds: bigint;
  /** The tenant's target for this state, where it has one. */
  readonly slaSeconds?: number;
  /** True when the observer made the request: four eyes means they cannot decide it. */
  readonly ownRequest: boolean;
}

export interface FunnelStage {
  readonly stage: 'IN_PROGRESS' | 'WAITING_OUTSIDE' | 'APPROVED' | 'CLOSED_WITHOUT_APPROVAL';
  readonly requestCount: number;
  readonly valueMinorUnits: bigint;
}

export interface DashboardSummary {
  readonly attention: readonly AttentionItem[];
  readonly countsByKind: Readonly<Record<AttentionKind, number>>;
  readonly funnel: readonly FunnelStage[];
  readonly openValueMinorUnits: bigint;
  readonly approvedValueMinorUnits: bigint;
  readonly requestsOnBook: number;
}

const IN_PROGRESS: ReadonlySet<string> = new Set(['KEYING', 'AWAITING_SERVICING_RESPONSE', 'AWAITING_REVIEW', 'RETURNED_TO_MAKER']);
const WAITING_OUTSIDE: ReadonlySet<string> = new Set(['PENDING_INFORMATION', 'SERVICING_UNAVAILABLE']);
const CLOSED: ReadonlySet<string> = new Set(['REJECTED', 'WITHDRAWN', 'EXPIRED']);

/** Which attention bucket a state falls in, before any breach is considered. */
const KIND_OF: Readonly<Partial<Record<string, AttentionKind>>> = {
  AWAITING_REVIEW: 'AWAITING_REVIEW',
  SERVICING_UNAVAILABLE: 'SERVICING_UNAVAILABLE',
  PENDING_INFORMATION: 'PENDING_INFORMATION',
  RETURNED_TO_MAKER: 'RETURNED_TO_MAKER',
};

/** Breaches first, then the oldest; a breach outranks any amount. */
const RANK: Readonly<Record<AttentionKind, number>> = { SLA_BREACHED: 0, SERVICING_UNAVAILABLE: 1, AWAITING_REVIEW: 2, RETURNED_TO_MAKER: 3, PENDING_INFORMATION: 4 };

export function summarise(rows: readonly RequestRow[], policy: OriginationPolicy | undefined, observedEpochSeconds: bigint, observerPrincipalId?: string): DashboardSummary {
  const attention: AttentionItem[] = [];
  for (const r of rows) {
    const base = KIND_OF[r.state];
    const since = r.submittedAtEpochSeconds ?? r.raisedAtEpochSeconds;
    const breached = policy !== undefined && slaStatus(policy, r.state, since, observedEpochSeconds) === 'BREACHED';
    if (base === undefined && !breached) continue;
    const limit = policy?.slaSeconds[r.state as keyof OriginationPolicy['slaSeconds']];
    attention.push({
      requestId: r.requestId,
      kind: breached ? 'SLA_BREACHED' : (base as AttentionKind),
      state: r.state,
      counterpartyId: r.counterpartyId,
      amountMinorUnits: r.amountMinorUnits,
      ageSeconds: observedEpochSeconds > since ? observedEpochSeconds - since : 0n,
      ...(limit === undefined ? {} : { slaSeconds: limit }),
      ownRequest: observerPrincipalId !== undefined && r.makerPrincipalId === observerPrincipalId,
    });
  }
  const older = (a: AttentionItem, b: AttentionItem): number => {
    if (a.ageSeconds === b.ageSeconds) return 0;
    return a.ageSeconds > b.ageSeconds ? -1 : 1;
  };
  attention.sort((a, b) => RANK[a.kind] - RANK[b.kind] || older(a, b));

  const countsByKind: Record<AttentionKind, number> = { SLA_BREACHED: 0, AWAITING_REVIEW: 0, SERVICING_UNAVAILABLE: 0, PENDING_INFORMATION: 0, RETURNED_TO_MAKER: 0 };
  for (const a of attention) countsByKind[a.kind] += 1;

  const stage = (name: FunnelStage['stage'], keep: (r: RequestRow) => boolean): FunnelStage => {
    const hit = rows.filter(keep);
    return { stage: name, requestCount: hit.length, valueMinorUnits: hit.reduce((s, r) => s + r.amountMinorUnits, 0n) };
  };
  const funnel = [
    stage('IN_PROGRESS', (r) => IN_PROGRESS.has(r.state)),
    stage('WAITING_OUTSIDE', (r) => WAITING_OUTSIDE.has(r.state)),
    stage('APPROVED', (r) => r.state === 'APPROVED'),
    stage('CLOSED_WITHOUT_APPROVAL', (r) => CLOSED.has(r.state)),
  ];
  const open = (funnel[0]?.valueMinorUnits ?? 0n) + (funnel[1]?.valueMinorUnits ?? 0n);

  return { attention, countsByKind, funnel, openValueMinorUnits: open, approvedValueMinorUnits: funnel[2]?.valueMinorUnits ?? 0n, requestsOnBook: rows.length };
}

export interface RailStatus {
  readonly capability: RailEntry['capability'];
  readonly adapter: string;
  readonly environment: RailEntry['environment'];
  /** Configured on, configured off. This is configuration, not a liveness probe, and the screen says so. */
  readonly enabled: boolean;
  readonly note?: string;
}

export function railStatuses(rails: readonly RailEntry[]): readonly RailStatus[] {
  return rails.map((r) => ({ capability: r.capability, adapter: r.adapter, environment: r.environment, enabled: r.enabled, ...(r.note === undefined ? {} : { note: r.note }) }));
}
