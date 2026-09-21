import { ok, reject } from "../kernel/result.js";
function parsePartySlot(reference) {
  const [legType, role] = reference.split(".");
  if (legType === void 0 || role === void 0) {
    return reject("OP-DETERMINACY", "MALFORMED_PARTY_REFERENCE", "Expected the form LEG_TYPE.role", {
      reference
    });
  }
  const upper = role.toUpperCase();
  if (upper !== "SELLER" && upper !== "BUYER" && upper !== "INSTITUTION") {
    return reject("OP-DETERMINACY", "UNKNOWN_PARTY_ROLE", "Unknown party role", { reference });
  }
  return ok({ legType: legType.toUpperCase(), role: upper });
}
function resolve(legs, slot) {
  return legs.find((l) => l.legType === slot.legType && l.counterpartyRole === slot.role);
}
function verifyDistinctParties(definition, legs) {
  for (const [leftRef, rightRef] of definition.constraints.distinctParties) {
    const left = parsePartySlot(leftRef);
    if (!left.ok) return left;
    const right = parsePartySlot(rightRef);
    if (!right.ok) return right;
    const leftLeg = resolve(legs, left.value);
    const rightLeg = resolve(legs, right.value);
    if (leftLeg === void 0 || rightLeg === void 0) continue;
    if (normaliseCr(leftLeg.counterpartyCr) === normaliseCr(rightLeg.counterpartyCr)) {
      return reject(
        "SH-08",
        "PARTIES_NOT_DISTINCT",
        "The same legal entity appears on both sides of the transaction",
        { left: leftRef, right: rightRef }
      );
    }
  }
  return ok(true);
}
function verifyNoBuyBack(legs) {
  const sellers = new Set(
    legs.filter((l) => l.counterpartyRole === "SELLER").map((l) => normaliseCr(l.counterpartyCr))
  );
  for (const leg of legs) {
    if (leg.counterpartyRole !== "BUYER") continue;
    if (sellers.has(normaliseCr(leg.counterpartyCr))) {
      return reject(
        "SH-08",
        "BUY_BACK_TO_ORIGINAL_SELLER",
        "The goods would return to the entity they were purchased from",
        { legId: leg.legId }
      );
    }
  }
  return ok(true);
}
function normaliseCr(cr) {
  return cr.trim().toUpperCase().replace(/[\s-]/g, "");
}
export {
  parsePartySlot,
  verifyDistinctParties,
  verifyNoBuyBack
};
