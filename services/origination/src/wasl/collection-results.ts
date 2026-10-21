/**
 * What SADAD reported of a Wasl bill, routed by the bill's key: an
 * instalment's bill to the obligation (settlement.ts, W4a), a late amount's
 * bill to the charity liability (late-amounts.ts, W4b-2). The webhook, the
 * paid-bills reconciliation and the workbench's Fixture controls all record
 * through here, so a result reaches the one path its bill belongs to — a late
 * amount can never be applied to the sale price, nor an instalment to charity.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import type { Result } from '@sanad/core/kernel/result.ts';

import type { TransactionView } from './book.ts';
import { isLateBillKey, recordLateCollectionResult } from './late-amounts.ts';
import { recordCollectionResult } from './settlement.ts';

export function recordBillResult(
  tenant: TenantCode,
  transactionRef: string,
  result: Parameters<typeof recordCollectionResult>[2],
  actor: string,
): Promise<Result<TransactionView>> {
  return isLateBillKey(result.idempotencyKey)
    ? recordLateCollectionResult(tenant, transactionRef, result, actor)
    : recordCollectionResult(tenant, transactionRef, result, actor);
}
