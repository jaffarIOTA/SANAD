/**
 * Merchants, as the workbench handles them: onboarding begun by a maker,
 * verified by a checker, suspended, reinstated or closed by a named person
 * with a reason. Every transition is the domain's (core/merchants/merchant.ts)
 * and every one is written to `core.merchant` with an audit event.
 *
 * Who acts is the signed-in principal the action passes in, and the tenant is
 * that principal's own — never a constant here and never a form field. The
 * domain refuses the person who onboarded a merchant its verification.
 *
 * The registry lookup and the screening result are entered here as references
 * because the business-registry and screening rails are not live; in
 * production the adapters supply them and nobody types them.
 */

import { randomUUID } from 'node:crypto';

import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import {
  type Merchant,
  type Verification,
  beginOnboarding,
  close,
  reinstate,
  suspend,
  verify,
} from '@sanad/core/merchants/merchant.ts';
import {
  type MerchantActivity,
  findMerchant,
  loadMerchants,
  merchantActivity,
  saveMerchant,
} from '@sanad/origination/merchants.ts';

import { persistencePool } from './persistence.ts';
import { developmentAttestation } from './store.ts';

/** The person acting and the tenant they act for, from the session. */
export interface MerchantActor {
  readonly principalId: string;
  readonly tenantId: string;
}

export const merchantsAvailable = (): boolean => persistencePool() !== undefined;

export interface MerchantView {
  readonly merchant: Merchant;
  readonly activity: readonly MerchantActivity[];
}

export async function listMerchantViews(tenantCode: string): Promise<readonly MerchantView[]> {
  const pool = persistencePool();
  if (pool === undefined) return [];
  const merchants = await loadMerchants(pool, tenantCode);
  return Promise.all(
    merchants.map(async (merchant) => ({
      merchant,
      activity: await merchantActivity(pool, tenantCode, merchant.core.merchantId),
    })),
  );
}

const NO_DATABASE = (): Result<never> =>
  reject('OP-DETERMINACY', 'NO_DATABASE', 'Merchants are kept in the database, and none is configured');
const NOT_FOUND = (): Result<never> => reject('OP-DETERMINACY', 'MERCHANT_NOT_FOUND', 'No such merchant');

export interface OnboardInput {
  readonly commercialRegistration: string;
  readonly legalNameAr: string;
  readonly legalNameEn: string;
  readonly categoryCode: string;
  readonly settlementAccountRef: string;
  readonly introducedByPartnerRef?: string;
}

export async function onboardMerchant(input: OnboardInput, actor: MerchantActor): Promise<Result<Merchant>> {
  const pool = persistencePool();
  if (pool === undefined) return NO_DATABASE();
  const correlationId = randomUUID();
  const begun = beginOnboarding(
    {
      merchantId: `mer-${randomUUID().slice(0, 8)}`,
      tenantId: actor.tenantId,
      commercialRegistration: input.commercialRegistration,
      legalNameAr: input.legalNameAr,
      legalNameEn: input.legalNameEn,
      categoryCode: input.categoryCode,
      settlementAccountRef: input.settlementAccountRef,
      onboardedBy: actor.principalId,
      correlationId,
      ...(input.introducedByPartnerRef === undefined ? {} : { introducedByPartnerRef: input.introducedByPartnerRef }),
    },
    developmentAttestation(),
  );
  if (!begun.ok) return begun;
  try {
    await saveMerchant(pool, actor.tenantId, {
      merchant: begun.value,
      event: 'MERCHANT_ONBOARDING_BEGUN',
      actor: actor.principalId,
      correlationId,
    });
  } catch (error) {
    // One registration, one merchant: the table's uniqueness constraint is the control.
    if (error instanceof Error && /merchant_registration_once/.test(error.message))
      return reject(
        'OP-DETERMINACY',
        'MERCHANT_ALREADY_ONBOARDED',
        'A merchant with this commercial registration already exists for this tenant',
      );
    throw error;
  }
  return ok(begun.value);
}

export type VerificationInput = Omit<Verification, 'verifiedBy' | 'verifiedAt'>;

export async function verifyMerchant(
  merchantId: string,
  evidence: VerificationInput,
  actor: MerchantActor,
): Promise<Result<Merchant>> {
  const pool = persistencePool();
  if (pool === undefined) return NO_DATABASE();
  const current = await findMerchant(pool, actor.tenantId, merchantId);
  if (current === undefined) return NOT_FOUND();
  if (current.status !== 'PENDING_VERIFICATION')
    return reject('OP-DETERMINACY', 'MERCHANT_NOT_PENDING', 'Only a merchant awaiting verification can be verified', {
      status: current.status,
    });
  // The checker verifies; the domain refuses the person who onboarded it.
  const verified = verify(current, {
    ...evidence,
    verifiedBy: actor.principalId,
    verifiedAt: developmentAttestation(),
  });
  if (!verified.ok) return verified;
  await saveMerchant(pool, actor.tenantId, {
    merchant: verified.value,
    event: 'MERCHANT_VERIFIED',
    actor: actor.principalId,
    correlationId: current.core.correlationId,
  });
  return ok(verified.value);
}

export async function changeMerchant(
  merchantId: string,
  change: 'SUSPEND' | 'REINSTATE' | 'CLOSE',
  reason: string,
  actor: MerchantActor,
): Promise<Result<Merchant>> {
  const pool = persistencePool();
  if (pool === undefined) return NO_DATABASE();
  const current = await findMerchant(pool, actor.tenantId, merchantId);
  if (current === undefined) return NOT_FOUND();
  const at = developmentAttestation();
  const by = actor.principalId;
  let next: Result<Merchant>;
  if (change === 'SUSPEND')
    next =
      current.status === 'ACTIVE'
        ? suspend(current, by, reason, at)
        : reject('OP-DETERMINACY', 'MERCHANT_NOT_ACTIVE', 'Only an active merchant can be suspended', {
            status: current.status,
          });
  else if (change === 'REINSTATE')
    next =
      current.status === 'SUSPENDED'
        ? ok(reinstate(current, at))
        : reject('OP-DETERMINACY', 'MERCHANT_NOT_SUSPENDED', 'Only a suspended merchant can be reinstated', {
            status: current.status,
          });
  else
    next =
      current.status === 'ACTIVE' || current.status === 'SUSPENDED'
        ? close(current, by, reason, at)
        : reject('OP-DETERMINACY', 'MERCHANT_NOT_CLOSABLE', 'Only an active or suspended merchant can be closed', {
            status: current.status,
          });
  if (!next.ok) return next;
  const event =
    change === 'SUSPEND' ? 'MERCHANT_SUSPENDED' : change === 'REINSTATE' ? 'MERCHANT_REINSTATED' : 'MERCHANT_CLOSED';
  await saveMerchant(pool, actor.tenantId, {
    merchant: next.value,
    event,
    actor: by,
    correlationId: current.core.correlationId,
  });
  return next;
}
