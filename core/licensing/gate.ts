/**
 * The one licence gate (ADR 0006 §4–5).
 *
 * `assertNewBusinessPermitted` is the only place a licence state becomes a
 * decision — as `core/pricing/apr.ts` is the only place an APR is computed,
 * and `test/architecture/licensing.test.ts` holds it to that. Every
 * new-business entry point calls it: starting an application by any channel,
 * a quote or a new offer, and booking a facility.
 *
 * What it never sees is just as deliberate: servicing, collections,
 * repayments, early settlement, bureau reporting, audit, exports, regulator
 * access, sign-in and installing a licence do not call it, so no licence
 * state can stop them. A licence dispute is with the institution, never with
 * its customers.
 *
 * Refused, as `LICENCE_NOT_ACTIVE`:
 *   - in `NEW_BUSINESS_BLOCKED`, every new-business act — except booking an
 *     offer the customer accepted before grace ended, which is never refused
 *     on the licence's state (stopping it would harm a customer who has
 *     already committed);
 *   - in every state that has a licence, a product or a jurisdiction the
 *     licence does not name, or more active tenants than it allows.
 *
 * `DEVELOPMENT_UNLICENSED` (outside production, nothing installed) permits
 * everything: there is no licence to hold an act against.
 */

import { type Rejection, type Result, err, ok } from '../kernel/result.ts';
import type { LicensedJurisdiction } from './licence.ts';
import type { LicenceState, LicenceStateReason } from './state.ts';

export type LicenceGateReason =
  | Extract<LicenceStateReason, 'NO_LICENCE' | 'NO_VALID_LICENCE' | 'NOT_YET_VALID' | 'GRACE_ENDED' | 'CLOCK_ROLLBACK'>
  | 'PRODUCT_NOT_LICENSED'
  | 'JURISDICTION_NOT_LICENSED'
  | 'TENANT_LIMIT_EXCEEDED';

/** The typed refusal. `decidedBy` names this file, as an offer's APR names apr.ts. */
export interface LicenceNotActive {
  readonly outcome: 'LICENCE_NOT_ACTIVE';
  readonly reason: LicenceGateReason;
  readonly detail: string;
  readonly decidedBy: 'core/licensing/gate.ts';
}

export interface NewBusinessQuestion {
  readonly state: LicenceState;
  /** The product module code the act is for, e.g. `bnpl`. */
  readonly productCode: string;
  /** The deployment's jurisdiction (ADR 0005). */
  readonly jurisdiction: LicensedJurisdiction;
  /** Tenants active in this deployment. */
  readonly activeTenantCount: number;
  /** Present when the act is booking a facility: when the customer accepted its offer. */
  readonly booking?: { readonly offerAcceptedAtEpochSeconds: bigint };
}

export interface NewBusinessPermitted {
  readonly decidedBy: 'core/licensing/gate.ts';
  /** True where the act passed only because its offer was accepted before grace ended. */
  readonly acceptedBeforeGraceEnded: boolean;
}

const refuse = (reason: LicenceGateReason, detail: string): Result<never, LicenceNotActive> =>
  err({ outcome: 'LICENCE_NOT_ACTIVE', reason, detail, decidedBy: 'core/licensing/gate.ts' });

const STATE_DETAIL: Readonly<Record<LicenceGateReason, string>> = {
  NO_LICENCE: 'No licence is installed on this installation',
  NO_VALID_LICENCE: 'No installed licence verifies on this installation',
  NOT_YET_VALID: 'The installed licence has not started yet',
  GRACE_ENDED: 'The licence has expired and its grace period has ended',
  CLOCK_ROLLBACK: 'The server clock is behind the latest time this installation has seen',
  PRODUCT_NOT_LICENSED: 'The licence does not name this product',
  JURISDICTION_NOT_LICENSED: 'The licence does not name this jurisdiction',
  TENANT_LIMIT_EXCEEDED: 'More institutions are active than the licence allows',
};

/** Why a blocked state blocks, in the gate's vocabulary. A label, not a decision: it is only read once a state is blocked. */
export function blockedReasonOf(state: LicenceState): LicenceGateReason {
  switch (state.reason) {
    case 'NO_LICENCE':
    case 'NO_VALID_LICENCE':
    case 'NOT_YET_VALID':
    case 'CLOCK_ROLLBACK':
      return state.reason;
    default:
      return 'GRACE_ENDED';
  }
}

export function assertNewBusinessPermitted(q: NewBusinessQuestion): Result<NewBusinessPermitted, LicenceNotActive> {
  const { state } = q;
  if (state.status === 'DEVELOPMENT_UNLICENSED')
    return ok({ decidedBy: 'core/licensing/gate.ts', acceptedBeforeGraceEnded: false });

  let acceptedBeforeGraceEnded = false;
  if (state.status === 'NEW_BUSINESS_BLOCKED') {
    const graceEnd = state.graceEndsAtEpochSeconds;
    const committed =
      q.booking !== undefined && graceEnd !== undefined && q.booking.offerAcceptedAtEpochSeconds < graceEnd;
    if (!committed) {
      const reason = blockedReasonOf(state);
      return refuse(reason, STATE_DETAIL[reason]);
    }
    acceptedBeforeGraceEnded = true;
  }

  // Entitlements, in every state that has a licence. The effective one is what is in force (or was last).
  const licence = state.effective;
  if (licence === undefined) return refuse('NO_VALID_LICENCE', STATE_DETAIL.NO_VALID_LICENCE);
  if (!licence.products.includes(q.productCode))
    return refuse('PRODUCT_NOT_LICENSED', STATE_DETAIL.PRODUCT_NOT_LICENSED);
  if (!licence.jurisdictions.includes(q.jurisdiction))
    return refuse('JURISDICTION_NOT_LICENSED', STATE_DETAIL.JURISDICTION_NOT_LICENSED);
  if (!Number.isSafeInteger(q.activeTenantCount) || q.activeTenantCount > licence.maxActiveTenants)
    return refuse('TENANT_LIMIT_EXCEEDED', STATE_DETAIL.TENANT_LIMIT_EXCEEDED);

  return ok({ decidedBy: 'core/licensing/gate.ts', acceptedBeforeGraceEnded });
}

/**
 * The refusal as the kernel's control-coded rejection, for the edges that
 * carry one (RFC 9457 problems, screens). The machine reason is always
 * `LICENCE_NOT_ACTIVE`; why travels as `licenceReason` in the context.
 */
export function licenceRejection(refusal: LicenceNotActive): Rejection {
  return {
    control: 'OP-LICENCE',
    reason: refusal.outcome,
    detail: refusal.detail,
    context: { licenceReason: refusal.reason },
  };
}
