import { ok, reject } from "../kernel/result.js";
async function assertNotPreviouslyFinanced(registry, tenantId, invoiceUuid) {
  const existing = await registry.lookup(tenantId, invoiceUuid);
  if (existing !== void 0) {
    return reject(
      "SH-10",
      "DUPLICATE_FINANCING",
      "This invoice has already been financed and cannot be financed again",
      { existingReference: existing.transactionId }
    );
  }
  return ok(true);
}
export {
  assertNotPreviouslyFinanced
};
