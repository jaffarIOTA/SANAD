/**
 * Shariah incidents (BR-F04): a compliance check failed, or a reviewer saw
 * something, and the institution must show what it did about it.
 *
 *   RAISED → TRIAGED → REMEDIATION_PLANNED → REMEDIATED → CLOSED
 *
 * Linear, and each step once: triage rates the severity and names an owner
 * (a re-rating says why); the plan says what will be done; the remediation
 * says what was; closing needs evidence, and a different Shariah reviewer
 * from the one who recorded the remediation. Where income was affected the
 * remediation says so, and the incident does not close until the income is
 * purified in full (the purification branch, W6b-2: proposed, confirmed by a
 * second reviewer, and raised to charity as the profit is collected).
 *
 * Severity is the institution's four-level scale, decided with the product
 * owner on 26 October 2026: LOW, MEDIUM, HIGH, MATERIAL. An open MATERIAL
 * incident on a transaction that has not been sold stops the steps that
 * commit to the sale; the product decides which those are.
 *
 * Product-agnostic: an incident is about a subject (a transaction reference),
 * raised by a check the product module defines. Pure; no clock.
 */

import { type Result, ok, reject } from '../kernel/result.ts';

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'MATERIAL';
export const INCIDENT_SEVERITIES: readonly IncidentSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'MATERIAL'];

export type IncidentStatus = 'RAISED' | 'TRIAGED' | 'REMEDIATION_PLANNED' | 'REMEDIATED' | 'CLOSED';

/** Who raises an incident that a scheduled check found. Never a person. */
export const SHARIAH_REVIEW_PRINCIPAL = 'system:shariah-review';

/** What was found, fixed when raised. Nothing in it changes afterwards. */
export interface IncidentRaise {
  readonly incidentId: string;
  /** SI-000001: the reference people use. */
  readonly incidentRef: string;
  /** The transaction the incident is about. */
  readonly subjectRef: string;
  readonly productCode: string;
  /** The check that failed, or MANUAL for a reviewer's observation. */
  readonly checkCode: string;
  /** The Shariah control the finding is against. */
  readonly control: string;
  /** The finding's code, worded by the screen. */
  readonly reason: string;
  /** Codes and references only: never a personal datum. */
  readonly context: Readonly<Record<string, string>>;
  /** A reviewer's observation, in their words, when raised by hand. */
  readonly observation?: string;
  readonly severity: IncidentSeverity;
  /** The same finding on the same subject is raised once, ever. */
  readonly fingerprint: string;
  readonly raisedBy: string;
  readonly raisedAtEpochSeconds: bigint;
}

export type IncidentAction =
  | {
      readonly kind: 'TRIAGE';
      readonly severity: IncidentSeverity;
      readonly owner: string;
      readonly note: string;
    }
  | { readonly kind: 'PLAN'; readonly plan: string }
  | { readonly kind: 'REMEDIATE'; readonly note: string; readonly purificationRequired: boolean }
  | { readonly kind: 'CLOSE'; readonly closureEvidence: string };

export interface IncidentEvent {
  readonly action: IncidentAction;
  readonly actor: string;
  readonly atEpochSeconds: bigint;
}

export interface ShariahIncident extends IncidentRaise {
  readonly status: IncidentStatus;
  /** As triaged, or as raised until then. */
  readonly currentSeverity: IncidentSeverity;
  readonly owner?: string;
  readonly plan?: string;
  readonly remediation?: string;
  readonly remediatedBy?: string;
  readonly purificationRequired: boolean;
  readonly closureEvidence?: string;
  readonly closedBy?: string;
  readonly history: readonly IncidentEvent[];
}

/** Each action, in the only order they happen; the n-th event is the n-th of these. */
export const INCIDENT_STEPS: readonly IncidentAction['kind'][] = ['TRIAGE', 'PLAN', 'REMEDIATE', 'CLOSE'];

const AFTER: Readonly<Record<IncidentAction['kind'], IncidentStatus>> = {
  TRIAGE: 'TRIAGED',
  PLAN: 'REMEDIATION_PLANNED',
  REMEDIATE: 'REMEDIATED',
  CLOSE: 'CLOSED',
};

/** The incident its raise and its events make. */
export function incidentFrom(raise: IncidentRaise, events: readonly IncidentEvent[]): ShariahIncident {
  let i: ShariahIncident = {
    ...raise,
    status: 'RAISED',
    currentSeverity: raise.severity,
    purificationRequired: false,
    history: [],
  };
  for (const e of events) {
    const a = e.action;
    const history = [...i.history, e];
    if (a.kind === 'TRIAGE') i = { ...i, status: AFTER.TRIAGE, currentSeverity: a.severity, owner: a.owner, history };
    else if (a.kind === 'PLAN') i = { ...i, status: AFTER.PLAN, plan: a.plan, history };
    else if (a.kind === 'REMEDIATE')
      i = {
        ...i,
        status: AFTER.REMEDIATE,
        remediation: a.note,
        remediatedBy: e.actor,
        purificationRequired: a.purificationRequired,
        history,
      };
    else i = { ...i, status: AFTER.CLOSE, closureEvidence: a.closureEvidence, closedBy: e.actor, history };
  }
  return i;
}

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);
const said = (s: string, min = 3): boolean => s.trim().length >= min && s.trim().length <= 2000;

/**
 * Whether `actor` may take `action` on the incident as it stands. `purified`
 * is the product's answer to whether the income the incident affected is
 * purified in full (W6b-2); closing waits for it.
 */
export function checkIncidentAction(
  incident: ShariahIncident,
  action: IncidentAction,
  actor: string,
  purified = false,
): Result<void> {
  const expected = INCIDENT_STEPS[incident.history.length];
  if (expected !== action.kind)
    return fail('INCIDENT_STEP_OUT_OF_ORDER', 'Incidents are triaged, planned, remediated and closed, in that order', {
      status: incident.status,
    });
  switch (action.kind) {
    case 'TRIAGE':
      if (!said(action.owner, 2)) return fail('INCIDENT_OWNER_REQUIRED', 'Name who owns the remediation');
      if (action.severity !== incident.severity && !said(action.note))
        return fail('INCIDENT_RERATING_REASON_REQUIRED', 'A severity other than the one raised says why');
      return ok(undefined);
    case 'PLAN':
      return said(action.plan) ? ok(undefined) : fail('INCIDENT_PLAN_REQUIRED', 'Say what will be done');
    case 'REMEDIATE':
      return said(action.note) ? ok(undefined) : fail('INCIDENT_REMEDIATION_REQUIRED', 'Say what was done');
    case 'CLOSE':
      if (actor === incident.remediatedBy)
        return fail('FOUR_EYES_SELF_APPROVAL', 'A different reviewer from the one who remediated closes an incident');
      if (!said(action.closureEvidence))
        return fail('INCIDENT_CLOSURE_EVIDENCE_REQUIRED', 'Closing an incident needs its evidence');
      if (incident.purificationRequired && !purified)
        return reject(
          'SH-13',
          'INCIDENT_PURIFICATION_PENDING',
          'Income was affected: the incident closes once that income is purified',
          { incidentRef: incident.incidentRef },
        );
      return ok(undefined);
  }
}

/** An open MATERIAL incident: the one kind that stops a subject's commitment to a sale. */
export const stopsTheSale = (i: ShariahIncident): boolean => i.status !== 'CLOSED' && i.currentSeverity === 'MATERIAL';
