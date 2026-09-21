import { ok, reject } from "../kernel/result.js";
function buildLegRenderRequest(legs, params) {
  if (legs.length === 0) {
    return reject("SH-07", "NO_LEG_SUPPLIED", "A document must render exactly one contractual leg");
  }
  if (legs.length > 1) {
    return reject(
      "SH-07",
      "COMBINED_LEG_RENDERING_REFUSED",
      "Each leg is a distinct instrument with its own execution event and timestamp; two legs cannot be rendered into one document",
      { legCount: legs.length, legIds: legs.map((l) => l.legId).join(",") }
    );
  }
  const leg = legs[0];
  if (leg === void 0) {
    return reject("SH-07", "NO_LEG_SUPPLIED", "A document must render exactly one contractual leg");
  }
  if (params.templateVersionId.length === 0) {
    return reject(
      "SH-17",
      "TEMPLATE_VERSION_UNRESOLVED",
      "Rendering is always against an explicit approved template version"
    );
  }
  return ok({
    requestId: params.requestId,
    tenantId: params.tenantId,
    leg,
    templateVersionId: params.templateVersionId,
    governingLocale: "ar-SA",
    translationLocale: params.translationLocale,
    mergeFields: params.mergeFields,
    shariahApprovalId: params.shariahApprovalId,
    correlationId: params.correlationId
  });
}
export {
  buildLegRenderRequest
};
