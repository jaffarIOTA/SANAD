/**
 * The payments hub's status report on a Wasl seller payment (W4a): accepted,
 * settled, rejected or returned, by the instruction's idempotency key.
 * Verified before it is parsed, with the tenant's PAYMENTS_HUB webhook secret
 * (server/wasl-webhooks.ts). Recorded once; a rejected or returned payment is
 * instructed again by finance, never by this route.
 */
import { recordSellerPaymentResult } from '@sanad/origination/wasl/settlement.ts';

import { NO_STORE, answer, isTransactionRef, verifiedDelivery } from '../../../../../../../server/wasl-webhooks.ts';

const STATUSES = new Set(['ACCEPTED', 'SETTLED', 'REJECTED', 'RETURNED']);

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly tenant: string }> },
): Promise<Response> {
  const { tenant } = await context.params;
  const d = await verifiedDelivery(request, tenant, 'PAYMENTS_HUB');
  if (d instanceof Response) return d;
  const transactionRef = d.field('transactionRef');
  const idempotencyKey = d.field('idempotencyKey');
  const status = d.field('status');
  if (
    !isTransactionRef(transactionRef) ||
    idempotencyKey === undefined ||
    status === undefined ||
    !STATUSES.has(status)
  )
    return new Response(null, { status: 400, headers: NO_STORE });
  const instructionRef = d.field('instructionRef');
  const reasonCode = d.field('reasonCode');
  return answer(
    await recordSellerPaymentResult(
      d.tenant,
      transactionRef,
      {
        idempotencyKey,
        status: status as 'ACCEPTED' | 'SETTLED' | 'REJECTED' | 'RETURNED',
        ...(instructionRef === undefined ? {} : { instructionRef }),
        ...(reasonCode === undefined ? {} : { reasonCode }),
        source: 'LIVE',
      },
      'payments-hub',
    ),
  );
}
