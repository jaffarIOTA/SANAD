/**
 * Entitlements.
 *
 * The catalogue below is closed, and every action in it is something a human can
 * legitimately do. None of them advances a transaction through a sequencing
 * gate, and none of them can be composed into something that does — the
 * transitions in `products/murabaha-scf/sequencing/transitions.ts` take no actor and consult no
 * entitlement, so there is nothing for an elevated role to unlock (SH-05,
 * BR-D10, SDD §6.12).
 *
 * This is a deliberate absence rather than an omission, so it is defended two
 * ways: `defineEntitlement` refuses an action outside the catalogue, and the
 * adversarial suite asserts the catalogue is disjoint from the set of gate
 * transitions and contains nothing whose name suggests a bypass.
 *
 * If you are here because you need an override for an operational problem: the
 * problem is evidence, and the fix is to record valid evidence. Operations
 * resolves evidence and data problems; it cannot resolve a compliance gate by
 * deciding to.
 */

import { type Result, ok, reject } from '../kernel/result.ts';

/**
 * The closed catalogue. Adding an entry is a reviewed change; adding one that
 * advances a gate is rejected by test.
 */
export const ENTITLEMENT_ACTIONS = [
  // Programme and configuration
  'programme.read',
  'programme.draft',
  'programme.submit_for_shariah_approval',
  'programme.activate', // guarded on an in-force approval, not on a role
  'programme.suspend',

  // Counterparty
  'counterparty.read',
  'counterparty.invite',
  'counterparty.resolve_verification_exception',
  'counterparty.suspend',

  // Decisioning and limits
  'decision.read',
  'decision.request_recompute',
  'limit.read',
  'limit.propose_change',
  'limit.approve_change', // four-eyes; the proposer cannot approve
  'limit.suspend',

  // Origination intake. These govern a *request to originate*, never a gate.
  // An approval here buys a transaction in DRAFT and nothing further.
  'origination.key',
  'origination.submit_for_review',
  'origination.review',
  'origination.approve', // four-eyes; the maker cannot be the approver
  'origination.return_to_maker',
  'origination.reject',
  'origination.channel.configure',

  // Transaction and evidence
  'transaction.read',
  'transaction.initiate',
  'evidence.upload',
  'evidence.resolve_extraction_exception',
  'evidence.mark_invalid', // supersedes; never deletes
  'transaction.request_unwind',
  'transaction.approve_unwind',

  // Documents
  'document.read',
  'document.regenerate_failed',
  'document.resolve_drift_exception',

  // Settlement
  'settlement.read',
  'settlement.retry_failed',
  'settlement.resolve_return',

  // Lifecycle
  'hardship.open',
  'hardship.assess',
  'reschedule.propose',
  'reschedule.approve',

  // Shariah governance — read-only by construction for audit
  'shariah.audit.read',
  'shariah.audit.export',
  'shariah.audit.raise_observation',
  'shariah.incident.triage',
  'shariah.incident.close',
  'shariah.approval.record',
  'purification.compute',
  'purification.disburse',

  // Administration
  'admin.user.manage',
  'admin.entitlement.assign',
  'admin.configuration.propose',
  'admin.configuration.approve',
] as const;

export type EntitlementAction = (typeof ENTITLEMENT_ACTIONS)[number];

const CATALOGUE: ReadonlySet<string> = new Set(ENTITLEMENT_ACTIONS);

/**
 * The gate-advancing operations, named so a test can assert the catalogue does
 * not contain them and that no entitlement maps onto one.
 */
export const SEQUENCING_TRANSITIONS = [
  'acquireOwnership',
  'confirmPossession',
  'offerSale',
  'acceptOffer',
] as const;

/**
 * Words that have no legitimate place in an entitlement name here. A catalogue
 * entry matching one of these is a design smell that the suite turns into a
 * build failure.
 */
export const FORBIDDEN_ENTITLEMENT_PATTERNS: readonly RegExp[] = [
  /\boverride\b/i,
  /\bbypass\b/i,
  /\bforce\b/i,
  /\bskip[_.]?gate/i,
  /gate[_.]?(advance|satisfy|waive|override)/i,
  /\bwaive[_.]?risk/i,
  /\bsuperuser\b/i,
  /\bimpersonat/i,
];

export type DataScope =
  | { readonly kind: 'TENANT' }
  | { readonly kind: 'PROGRAMME'; readonly programmeIds: readonly string[] }
  | { readonly kind: 'OWN_CASES' };

export interface Entitlement {
  readonly entitlementId: string;
  readonly tenantId: string;
  readonly roleCode: string;
  readonly actions: readonly EntitlementAction[];
  readonly scope: DataScope;
  /** Where set, a second, different principal must approve. */
  readonly requiresFourEyes: boolean;
}

export interface EntitlementSpec {
  readonly entitlementId: string;
  readonly tenantId: string;
  readonly roleCode: string;
  readonly actions: readonly string[];
  readonly scope: DataScope;
  readonly requiresFourEyes?: boolean;
}

/**
 * The only constructor. Refuses anything outside the catalogue, so an
 * entitlement cannot be defined in configuration that the platform does not
 * recognise — which is what stops "just add a permission" from becoming a
 * bypass.
 */
export function defineEntitlement(spec: EntitlementSpec): Result<Entitlement> {
  const unknown = spec.actions.filter((a) => !CATALOGUE.has(a));
  if (unknown.length > 0) {
    return reject(
      'SH-05',
      'UNKNOWN_ENTITLEMENT_ACTION',
      'Entitlements may only grant actions from the closed catalogue',
      { roleCode: spec.roleCode, unknown: unknown.join(',') },
    );
  }

  for (const action of spec.actions) {
    for (const pattern of FORBIDDEN_ENTITLEMENT_PATTERNS) {
      if (pattern.test(action)) {
        return reject(
          'SH-05',
          'BYPASS_SHAPED_ENTITLEMENT',
          'No entitlement may be capable of advancing a transaction past an unsatisfied gate',
          { roleCode: spec.roleCode, action },
        );
      }
    }
    if ((SEQUENCING_TRANSITIONS as readonly string[]).includes(action)) {
      return reject(
        'SH-05',
        'ENTITLEMENT_NAMES_A_SEQUENCING_TRANSITION',
        'Sequencing transitions are not entitlement-guarded operations; they are state machine edges',
        { roleCode: spec.roleCode, action },
      );
    }
  }

  return ok({
    entitlementId: spec.entitlementId,
    tenantId: spec.tenantId,
    roleCode: spec.roleCode,
    actions: spec.actions as readonly EntitlementAction[],
    scope: spec.scope,
    requiresFourEyes: spec.requiresFourEyes ?? false,
  });
}

export function permits(entitlement: Entitlement, action: EntitlementAction): boolean {
  return entitlement.actions.includes(action);
}
