/**
 * The bank's status for a released tranche (UAE M5b).
 *
 * Live, it arrives as the partner bank's signed status report on the webhook
 * (api/business/v1/webhooks/payment-results/[tenant]), verified before it is
 * parsed with the tenant's own secret from the vault. On the synthetic site,
 * where no bank is connected, finance may record a result marked Fixture —
 * the same rule as every demonstration rail: only where a synthetic
 * demonstration is permitted, refused everywhere else.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { type Result, reject } from '@sanad/core/kernel/result.ts';
import { syntheticDemonstrationPermitted } from '@sanad/origination/profile.ts';

import {
  type BusinessApplicationView,
  type PaymentResultStatus,
  getApplication,
  recordCollectionResult,
  recordPaymentResult,
} from './business.ts';
import { persistencePool } from './persistence.ts';

/** Record a bank result for the latest released tranche, marked Fixture. Synthetic demonstration only. */
export async function recordFixturePaymentResult(
  tenant: TenantCode,
  applicationId: string,
  status: PaymentResultStatus,
  actor: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Result<BusinessApplicationView>> {
  if (!(await syntheticDemonstrationPermitted(persistencePool(env), env)))
    return reject('OP-DETERMINACY', 'RAIL_UNAVAILABLE', 'Bank results arrive from the bank here, never from the screen', {
      rail: 'PARTNER_BANK',
    });
  const view = await getApplication(tenant, applicationId);
  const released = [...(view?.closing.tranches ?? [])].reverse().find((t) => t.status === 'RELEASED');
  if (released?.idempotencyKey === undefined)
    return reject('OP-DETERMINACY', 'PAYMENT_NOT_FOUND', 'No released tranche is awaiting its result');
  return recordPaymentResult(
    tenant,
    applicationId,
    {
      idempotencyKey: released.idempotencyKey,
      status,
      instructionRef: `pb-demo-${released.trancheId}`,
      ...(status === 'REJECTED' ? { reasonCode: 'AC04' } : {}),
      source: 'FIXTURE',
    },
    actor,
  );
}

/** Record the channel's result for the oldest presented, unanswered instalment, marked Fixture. Synthetic demonstration only. */
export async function recordFixtureCollectionResult(
  tenant: TenantCode,
  applicationId: string,
  status: 'PAID' | 'RETURNED',
  actor: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Result<BusinessApplicationView>> {
  if (!(await syntheticDemonstrationPermitted(persistencePool(env), env)))
    return reject('OP-DETERMINACY', 'RAIL_UNAVAILABLE', 'Collection results arrive from the channel here, never from the screen', {
      rail: 'BILL_COLLECTION',
    });
  const view = await getApplication(tenant, applicationId);
  const pending = view?.servicing?.collections.find((c) => c.result === undefined);
  if (pending === undefined) return reject('OP-DETERMINACY', 'COLLECTION_NOT_FOUND', 'No presented instalment is awaiting its result');
  return recordCollectionResult(
    tenant,
    applicationId,
    {
      idempotencyKey: pending.idempotencyKey,
      status,
      reference: `${pending.channel === 'SADAD' ? 'sadad' : 'pb'}-demo-${pending.idempotencyKey.split(':').at(-1) ?? 'x'}`,
      receivedOn: view?.servicing?.position.asOf ?? pending.dueDate,
      source: 'FIXTURE',
    },
    actor,
  );
}
