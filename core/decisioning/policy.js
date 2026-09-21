import { ok, reject } from "../kernel/result.js";
import { referencedFields } from "./expression.js";
const PERMITTED_SECTIONS = /* @__PURE__ */ new Set([
  "policyId",
  "version",
  "tenantId",
  "programmeScope",
  "currency",
  "effectiveFromEpochSeconds",
  "effectiveToEpochSeconds",
  "approval",
  "dataRequirements",
  "knockouts",
  "scorecard",
  "grades",
  "limit",
  "reasons",
  "notes"
]);
function parseCreditPolicy(input) {
  if (typeof input !== "object" || input === null) {
    return reject("OP-DETERMINACY", "POLICY_NOT_AN_OBJECT", "Credit policy is not an object");
  }
  const p = input;
  for (const key of Object.keys(input)) {
    if (!PERMITTED_SECTIONS.has(key)) {
      return reject(
        "OP-DETERMINACY",
        "UNKNOWN_POLICY_SECTION",
        "Credit policy contains a section the engine does not recognise; a policy decides capacity, never price",
        { section: key }
      );
    }
  }
  if (!p.approval?.creditApprovalRef) {
    return reject(
      "OP-DETERMINACY",
      "POLICY_NOT_APPROVED",
      "A credit policy must carry the approval reference it was signed off under",
      { policyId: String(p.policyId) }
    );
  }
  if (p.grades.length === 0) {
    return reject("OP-DETERMINACY", "NO_GRADE_BANDS", "A policy must declare at least one grade band");
  }
  const gradeCodes = /* @__PURE__ */ new Set();
  for (const g of p.grades) {
    if (gradeCodes.has(g.grade)) {
      return reject("OP-DETERMINACY", "DUPLICATE_GRADE", "Grade codes must be unique", {
        grade: g.grade
      });
    }
    gradeCodes.add(g.grade);
  }
  for (const g of p.grades) {
    if (g.outcome === "APPROVE" && p.limit.basisByGrade[g.grade] === void 0) {
      return reject(
        "OP-DETERMINACY",
        "APPROVING_GRADE_HAS_NO_LIMIT_BASIS",
        "A grade that approves must declare how its limit is sized",
        { grade: g.grade }
      );
    }
  }
  const seenCharacteristics = /* @__PURE__ */ new Set();
  for (const c of p.scorecard.characteristics) {
    if (seenCharacteristics.has(c.code)) {
      return reject("OP-DETERMINACY", "DUPLICATE_CHARACTERISTIC", "Characteristic codes must be unique", {
        code: c.code
      });
    }
    seenCharacteristics.add(c.code);
    for (const b of c.bands) {
      if (b.points > c.maxPoints) {
        return reject(
          "OP-DETERMINACY",
          "BAND_EXCEEDS_CHARACTERISTIC_MAX",
          "A band awards more points than its characteristic declares",
          { code: c.code, points: b.points, maxPoints: c.maxPoints }
        );
      }
    }
  }
  const koCodes = /* @__PURE__ */ new Set();
  for (const k of p.knockouts) {
    if (koCodes.has(k.code)) {
      return reject("OP-DETERMINACY", "DUPLICATE_KNOCKOUT", "Knockout codes must be unique", {
        code: k.code
      });
    }
    koCodes.add(k.code);
  }
  const from = safeBigInt(p.effectiveFromEpochSeconds);
  if (from === void 0) {
    return reject("OP-DETERMINACY", "MALFORMED_EFFECTIVE_FROM", "effectiveFromEpochSeconds is not an integer");
  }
  if (p.effectiveToEpochSeconds !== void 0) {
    const to = safeBigInt(p.effectiveToEpochSeconds);
    if (to === void 0 || to <= from) {
      return reject(
        "OP-DETERMINACY",
        "EFFECTIVE_WINDOW_INVALID",
        "effectiveToEpochSeconds must be later than effectiveFromEpochSeconds"
      );
    }
  }
  const missing = [];
  for (const code of emittableReasonCodes(p)) {
    const text = p.reasons[code];
    if (text === void 0 || text.ar.trim().length === 0 || text.en.trim().length === 0) {
      missing.push(code);
    }
  }
  if (missing.length > 0) {
    return reject(
      "OP-DETERMINACY",
      "REASON_WORDING_MISSING",
      "Every reason the policy can emit must have approved Arabic and English wording; a decline the counterparty cannot be told the reason for is not issuable",
      { missing: missing.join(",") }
    );
  }
  return ok(p);
}
function emittableReasonCodes(p) {
  const codes = /* @__PURE__ */ new Set();
  for (const k of p.knockouts) codes.add(k.reasonCode);
  for (const c of p.scorecard.characteristics) {
    if (c.defaultReasonCode !== void 0) codes.add(c.defaultReasonCode);
    for (const b of c.bands) if (b.reasonCode !== void 0) codes.add(b.reasonCode);
  }
  for (const g of p.grades) if (g.reasonCode !== void 0) codes.add(g.reasonCode);
  codes.add(p.dataRequirements.staleDataReasonCode);
  codes.add(p.dataRequirements.missingConsentReasonCode);
  return [...codes].sort();
}
function policyReferencedFields(p) {
  const fields = /* @__PURE__ */ new Set();
  for (const k of p.knockouts) referencedFields(k.when, fields);
  for (const c of p.scorecard.characteristics) {
    for (const b of c.bands) referencedFields(b.when, fields);
  }
  for (const expr of Object.values(p.limit.basisByGrade)) referencedFields(expr, fields);
  for (const cap of p.limit.caps) {
    if (cap.kind === "EXPRESSION") {
      referencedFields(cap.max, fields);
      if (cap.when !== void 0) referencedFields(cap.when, fields);
    }
  }
  for (const path of Object.keys(p.dataRequirements.maximumSourceAgeSeconds)) fields.add(path);
  return [...fields].sort();
}
function resolveEffectivePolicy(versions, asOfEpochSeconds) {
  const inForce = versions.filter((v) => {
    const from = safeBigInt(v.effectiveFromEpochSeconds);
    if (from === void 0 || from > asOfEpochSeconds) return false;
    if (v.effectiveToEpochSeconds === void 0) return true;
    const to = safeBigInt(v.effectiveToEpochSeconds);
    return to !== void 0 && to > asOfEpochSeconds;
  }).sort((a, b) => {
    const af = safeBigInt(a.effectiveFromEpochSeconds) ?? 0n;
    const bf = safeBigInt(b.effectiveFromEpochSeconds) ?? 0n;
    return af === bf ? 0 : af < bf ? 1 : -1;
  });
  const latest = inForce[0];
  if (latest === void 0) {
    return reject(
      "OP-DETERMINACY",
      "NO_POLICY_IN_FORCE",
      "No credit policy version is in force for the moment being evaluated",
      { asOfEpochSeconds: String(asOfEpochSeconds) }
    );
  }
  if (inForce.length > 1) {
    const tied = inForce.filter(
      (v) => v.effectiveFromEpochSeconds === latest.effectiveFromEpochSeconds
    );
    if (tied.length > 1) {
      return reject(
        "OP-DETERMINACY",
        "AMBIGUOUS_POLICY_VERSIONS",
        "More than one policy version shares the same effective date; the governing version is ambiguous",
        { policyId: latest.policyId, count: tied.length }
      );
    }
  }
  return ok(latest);
}
function safeBigInt(v) {
  try {
    return BigInt(v);
  } catch {
    return void 0;
  }
}
export {
  emittableReasonCodes,
  parseCreditPolicy,
  policyReferencedFields,
  resolveEffectivePolicy
};
