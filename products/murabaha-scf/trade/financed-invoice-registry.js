


















import { ok, reject } from '../../../core/kernel/result.js';




































/**
 * The pre-flight check, run during trade validation so the counterparty gets a
 * specific answer rather than a failed insert. It does not replace the
 * constraint; it improves the message.
 */
export async function assertNotPreviouslyFinanced(
  registry,
  tenantId,
  invoiceUuid,
) {
  const existing = await registry.lookup(tenantId, invoiceUuid);
  if (existing !== undefined) {
    return reject(
      'SH-10',
      'DUPLICATE_FINANCING',
      'This invoice has already been financed and cannot be financed again',
      { existingReference: existing.transactionId },
    );
  }
  return ok(true);
}
