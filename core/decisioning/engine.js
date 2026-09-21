import {
  evaluateCondition,
  evaluateMoney,
  pathResolver
} from "./expression.js";
import {
  aggregateExposureMinorUnits,
  programmeHeadroomMinorUnits
} from "./snapshot.js";
function evaluateCreditPolicy(policy, snapshot, decisionId) {
  const trace = [];
  const reasonCodes = [];
  const ctx = { resolve: pathResolver(snapshot) };
  let sequence = 0;
  const step = (entry) => {
    trace.push({ sequence: sequence++, ...entry });
  };
  const base = {
    decisionId,
    tenantId: snapshot.tenantId,
    counterpartyId: snapshot.counterpartyId,
    programmeId: snapshot.programmeId,
    snapshotId: snapshot.snapshotId,
    policyId: policy.policyId,
    policyVersion: policy.version,
    creditApprovalRef: policy.approval.creditApprovalRef,
    currency: policy.currency,
    snapshotCapturedAtEpochSeconds: snapshot.capturedAtEpochSeconds
  };
  const finish = (outcome, score2, limit2, grade, bindingCapCode2) => ({
    ...base,
    outcome,
    score: score2,
    assignedLimitMinorUnits: limit2,
    reasons: resolveReasons(policy, reasonCodes),
    trace,
    ...grade !== void 0 ? { grade } : {},
    ...bindingCapCode2 !== void 0 ? { bindingCapCode: bindingCapCode2 } : {}
  });
  if (policy.tenantId !== snapshot.tenantId) {
    step({
      stage: "FAULT",
      code: "POLICY_TENANT_MISMATCH",
      inputs: { policyTenant: policy.tenantId, snapshotTenant: snapshot.tenantId },
      result: "REFER"
    });
    return finish("REFER", 0, 0n);
  }
  if (policy.currency !== snapshot.currency) {
    step({
      stage: "FAULT",
      code: "POLICY_CURRENCY_MISMATCH",
      inputs: { policy: policy.currency, snapshot: snapshot.currency },
      result: "REFER"
    });
    return finish("REFER", 0, 0n);
  }
  for (const consent of policy.dataRequirements.requiredConsents) {
    const given = snapshot.consent[consent];
    step({
      stage: "DATA_SUFFICIENCY",
      code: `CONSENT_${String(consent)}`,
      inputs: { consent: String(consent) },
      result: given ? "PRESENT" : "ABSENT"
    });
    if (!given) {
      reasonCodes.push(policy.dataRequirements.missingConsentReasonCode);
      return finish("REFER", 0, 0n);
    }
  }
  for (const [path, maxAge] of Object.entries(policy.dataRequirements.maximumSourceAgeSeconds)) {
    const age = ctx.resolve(path);
    if (typeof age !== "number") {
      step({
        stage: "FAULT",
        code: "FRESHNESS_FIELD_UNREADABLE",
        inputs: { path },
        result: "REFER"
      });
      return finish("REFER", 0, 0n);
    }
    const fresh = age <= maxAge;
    step({
      stage: "DATA_SUFFICIENCY",
      code: `FRESHNESS_${path}`,
      inputs: { path, ageSeconds: String(age), maximumSeconds: String(maxAge) },
      result: fresh ? "FRESH" : "STALE"
    });
    if (!fresh) {
      reasonCodes.push(policy.dataRequirements.staleDataReasonCode);
      return finish("REFER", 0, 0n);
    }
  }
  for (const knockout of policy.knockouts) {
    const fired = evaluateCondition(knockout.when, ctx);
    if (!fired.ok) {
      step({
        stage: "FAULT",
        code: knockout.code,
        inputs: { reason: fired.error.reason },
        result: "REFER"
      });
      return finish("REFER", 0, 0n);
    }
    step({
      stage: "KNOCKOUT",
      code: knockout.code,
      inputs: {},
      result: fired.value ? "FIRED" : "PASSED",
      ...fired.value ? { reasonCode: knockout.reasonCode } : {}
    });
    if (fired.value) {
      reasonCodes.push(knockout.reasonCode);
      return finish(knockout.outcome, 0, 0n);
    }
  }
  let score = policy.scorecard.baseScore;
  const shortfalls = [];
  for (const characteristic of policy.scorecard.characteristics) {
    let awarded = characteristic.defaultPoints;
    let matchedBand = -1;
    let reasonCode = characteristic.defaultReasonCode;
    for (let i = 0; i < characteristic.bands.length; i++) {
      const band2 = characteristic.bands[i];
      if (band2 === void 0) continue;
      const matched = evaluateCondition(band2.when, ctx);
      if (!matched.ok) {
        step({
          stage: "FAULT",
          code: `${characteristic.code}#${i}`,
          inputs: { reason: matched.error.reason },
          result: "REFER"
        });
        return finish("REFER", 0, 0n);
      }
      if (matched.value) {
        awarded = band2.points;
        matchedBand = i;
        reasonCode = band2.reasonCode ?? characteristic.defaultReasonCode;
        break;
      }
    }
    score += awarded;
    step({
      stage: "SCORECARD",
      code: characteristic.code,
      inputs: { matchedBand: matchedBand === -1 ? "DEFAULT" : String(matchedBand) },
      result: `${awarded}/${characteristic.maxPoints}`,
      pointsAwarded: awarded,
      ...reasonCode !== void 0 ? { reasonCode } : {}
    });
    if (awarded < characteristic.maxPoints && reasonCode !== void 0) {
      shortfalls.push({
        code: characteristic.code,
        shortfall: characteristic.maxPoints - awarded,
        reasonCode
      });
    }
  }
  const band = gradeFor(policy.grades, score);
  if (band === void 0) {
    step({
      stage: "FAULT",
      code: "NO_GRADE_BAND_FOR_SCORE",
      inputs: { score: String(score) },
      result: "REFER"
    });
    return finish("REFER", score, 0n);
  }
  step({
    stage: "GRADE",
    code: band.grade,
    inputs: { score: String(score), minScore: String(band.minScore) },
    result: band.outcome,
    ...band.reasonCode !== void 0 ? { reasonCode: band.reasonCode } : {}
  });
  if (band.reasonCode !== void 0) reasonCodes.push(band.reasonCode);
  if (band.outcome !== "APPROVE") {
    for (const s of topShortfalls(shortfalls)) reasonCodes.push(s.reasonCode);
    return finish(band.outcome, score, 0n, band.grade);
  }
  const basisExpr = policy.limit.basisByGrade[band.grade];
  if (basisExpr === void 0) {
    step({
      stage: "FAULT",
      code: "NO_LIMIT_BASIS_FOR_GRADE",
      inputs: { grade: band.grade },
      result: "REFER"
    });
    return finish("REFER", score, 0n, band.grade);
  }
  const basis = evaluateMoney(basisExpr, ctx);
  if (!basis.ok) {
    step({
      stage: "FAULT",
      code: "LIMIT_BASIS_UNEVALUABLE",
      inputs: { grade: band.grade, reason: basis.error.reason },
      result: "REFER"
    });
    return finish("REFER", score, 0n, band.grade);
  }
  let limit = basis.value < 0n ? 0n : basis.value;
  step({
    stage: "LIMIT_BASIS",
    code: band.grade,
    inputs: { grade: band.grade },
    result: String(limit)
  });
  let bindingCapCode;
  for (const cap of policy.limit.caps) {
    const capped = applyCap(cap, limit, snapshot, ctx);
    if (capped === void 0) {
      step({ stage: "FAULT", code: cap.code, inputs: {}, result: "REFER" });
      return finish("REFER", score, 0n, band.grade);
    }
    if (capped < limit) {
      bindingCapCode = cap.code;
      step({
        stage: "CAP",
        code: cap.code,
        inputs: { before: String(limit) },
        result: String(capped)
      });
      limit = capped;
    } else {
      step({ stage: "CAP", code: cap.code, inputs: { before: String(limit) }, result: "NOT_BINDING" });
    }
  }
  const granularity = toBigInt(policy.limit.roundDownToMultipleOfMinorUnits);
  if (granularity !== void 0 && granularity > 0n) {
    const rounded = limit / granularity * granularity;
    if (rounded !== limit) {
      step({
        stage: "CAP",
        code: "ROUND_DOWN",
        inputs: { before: String(limit), granularity: String(granularity) },
        result: String(rounded)
      });
      limit = rounded;
    }
  }
  const minimum = toBigInt(policy.limit.minimumViableMinorUnits) ?? 0n;
  if (limit < minimum) {
    step({
      stage: "CAP",
      code: "BELOW_MINIMUM_VIABLE",
      inputs: { limit: String(limit), minimum: String(minimum) },
      result: "REFER"
    });
    for (const s of topShortfalls(shortfalls)) reasonCodes.push(s.reasonCode);
    return finish("REFER", score, 0n, band.grade, bindingCapCode);
  }
  return finish("APPROVE", score, limit, band.grade, bindingCapCode);
}
function evaluateWithChallenger(champion, challenger, snapshot, decisionId, challengerDecisionId) {
  const applied = evaluateCreditPolicy(champion, snapshot, decisionId);
  if (challenger === void 0) return { applied };
  return {
    applied,
    challenger: evaluateCreditPolicy(challenger, snapshot, challengerDecisionId)
  };
}
function gradeFor(grades, score) {
  return [...grades].sort((a, b) => b.minScore - a.minScore).find((g) => score >= g.minScore);
}
function applyCap(cap, current, snapshot, ctx) {
  switch (cap.kind) {
    case "ABSOLUTE": {
      const max = toBigInt(cap.maxMoneyMinorUnits);
      return max === void 0 ? void 0 : min(current, max);
    }
    case "EXPRESSION": {
      if (cap.when !== void 0) {
        const applies = evaluateCondition(cap.when, ctx);
        if (!applies.ok) return void 0;
        if (!applies.value) return current;
      }
      const max = evaluateMoney(cap.max, ctx);
      return max.ok ? min(current, max.value) : void 0;
    }
    case "PROGRAMME_HEADROOM":
      return min(current, programmeHeadroomMinorUnits(snapshot));
    case "SHARE_OF_PROGRAMME_LIMIT": {
      if (!Number.isInteger(cap.shareBasisPoints) || cap.shareBasisPoints < 0) return void 0;
      const share = snapshot.programme.programmeLimitMinorUnits * BigInt(cap.shareBasisPoints) / 10000n;
      return min(current, share);
    }
    case "NET_OF_EXISTING_EXPOSURE": {
      const net = current - aggregateExposureMinorUnits(snapshot);
      return net > 0n ? net : 0n;
    }
  }
}
function topShortfalls(shortfalls) {
  return [...shortfalls].sort((a, b) => b.shortfall - a.shortfall).slice(0, 3);
}
function resolveReasons(policy, codes) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const code of codes) {
    if (seen.has(code)) continue;
    seen.add(code);
    const text = policy.reasons[code];
    out.push({
      code,
      ar: text?.ar ?? "",
      en: text?.en ?? ""
    });
  }
  return out;
}
const min = (a, b) => a < b ? a : b;
function toBigInt(v) {
  try {
    return BigInt(v);
  } catch {
    return void 0;
  }
}
export {
  evaluateCreditPolicy,
  evaluateWithChallenger,
  gradeFor
};
