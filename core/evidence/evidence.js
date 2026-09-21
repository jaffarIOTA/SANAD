const THIRD_PARTY_SOURCES = /* @__PURE__ */ new Set([
  "E_INVOICING_AUTHORITY",
  "BUSINESS_REGISTRY",
  "PARTNER"
]);
const isThirdParty = (source) => THIRD_PARTY_SOURCES.has(source);
function isLive(e) {
  return e.supersededBy === void 0 && e.validationStatus === "VALID";
}
function liveEvidenceForGate(evidence, gate) {
  return evidence.filter((e) => isLive(e) && e.gateSatisfied === gate);
}
function earliestCapturedAt(evidence) {
  let earliest;
  for (const e of evidence) {
    if (earliest === void 0 || e.capturedAt.epochSeconds < earliest.epochSeconds) {
      earliest = e.capturedAt;
    }
  }
  return earliest;
}
export {
  THIRD_PARTY_SOURCES,
  earliestCapturedAt,
  isLive,
  isThirdParty,
  liveEvidenceForGate
};
