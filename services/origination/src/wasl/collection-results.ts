/**
 * What SADAD reported of a Wasl bill, routed by the bill's key: an
 * instalment's bill to the obligation (settlement.ts, W4a), a late amount's
 * bill to the charity liability (late-amounts.ts, W4b-2). The webhook, the
 * paid-bills reconciliation and the workbench's Fixture controls all record
 * through here, so a result reaches the one path its bill belongs to — a late
 * amount can never be applied to the sale price, nor an instalment to charity.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { type Result, ok } from '@sanad/core/kernel/result.ts';

import { type TransactionView, getTransaction } from './book.ts';
import { isLateBillKey, recordLateCollectionResult } from './late-amounts.ts';
import { raisePurificationsDue } from './purification.ts';
import { recordCollectionResult } from './settlement.ts';

export async function recordBillResult(
  tenant: TenantCode,
  transactionRef: string,
  result: Parameters<typeof recordCollectionResult>[2],
  actor: string,
): Promise<Result<TransactionView>> {
  if (isLateBillKey(result.idempotencyKey)) return recordLateCollectionResult(tenant, transactionRef, result, actor);
  const recorded = await recordCollectionResult(tenant, transactionRef, result, actor);
  if (!recorded.ok || result.status !== 'PAID') return recorded;
  // W6b-2: a paid instalment's share of purified income is raised to charity as it is collected. The payment stands
  // whatever happens here; a share the core could not take now is raised by the daily Shariah review.
  const raised = await raisePurificationsDue(tenant, transactionRef, actor);
  return raised.ok && raised.value > 0
    ? ok((await getTransaction(tenant, transactionRef)) ?? recorded.value)
    : recorded;
}
