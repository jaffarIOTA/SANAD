/**
 * SADAD's report on a presented Wasl bill (W4a): paid, or a payment returned,
 * by the presentation's idempotency key. Verified before it is parsed, with
 * the tenant's BILL_COLLECTION webhook secret (server/wasl-webhooks.ts).
 * A receipt reduces what is owed and may settle the transaction; a return
 * takes a receipt off again. Recorded once.
 */
import { recordCollectionResult } from '@sanad/origination/wasl/settlement.ts';

import { NO_STORE, answer, isTransactionRef, verifiedDelivery } from '../../../../../../../server/wasl-webhooks.ts';

export async function POST(
  request: Request,
  context: { readonly params: Promise<{ readonly tenant: string }> },
): Promise<Response> {
  const { tenant } = await context.params;
  const d = await verifiedDelivery(request, tenant, 'BILL_COLLECTION');
  if (d instanceof Response) return d;
  const transactionRef = d.field('transactionRef');
  const idempotencyKey = d.field('idempotencyKey');
  const status = d.field('status');
  const reference = d.field('reference');
  const receivedOn = d.field('receivedOn');
  const amount = d.field('amountMinorUnits');
  if (
    !isTransactionRef(transactionRef) ||
    idempotencyKey === undefined ||
    (status !== 'PAID' && status !== 'RETURNED') ||
    reference === undefined ||
    receivedOn === undefined ||
    (amount !== undefined && !/^\d{1,15}$/.test(amount))
  )
    return new Response(null, { status: 400, headers: NO_STORE });
  return answer(
    await recordCollectionResult(
      d.tenant,
      transactionRef,
      {
        idempotencyKey,
        status,
        ...(amount === undefined ? {} : { amountMinorUnits: BigInt(amount) }),
        reference,
        receivedOn,
        source: 'LIVE',
      },
      'sadad',
    ),
  );
}
