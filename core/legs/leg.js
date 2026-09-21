import { ok, reject } from "../kernel/result.js";
import { isStrictlyLater } from "../time/tsa.js";
function appendLeg(chain, leg) {
  const previous = chain.at(-1);
  if (previous === void 0) {
    if (leg.prevLegHash !== void 0) {
      return reject(
        "OP-CHAIN",
        "FIRST_LEG_HAS_PREDECESSOR",
        "The first leg of a transaction cannot reference a predecessor hash",
        { legId: leg.legId }
      );
    }
  } else {
    if (leg.prevLegHash !== previous.contentHash) {
      return reject("OP-CHAIN", "HASH_CHAIN_BROKEN", "Leg does not chain to its predecessor", {
        legId: leg.legId,
        expectedPrevHash: previous.contentHash
      });
    }
    if (!isStrictlyLater(leg.executedAt, previous.executedAt)) {
      return reject(
        "OP-CHAIN",
        "TIMESTAMPS_NOT_MONOTONIC",
        "Leg timestamp is not strictly later than its predecessor",
        { legId: leg.legId }
      );
    }
    if (leg.sequenceNo <= previous.sequenceNo) {
      return reject("OP-CHAIN", "SEQUENCE_NOT_MONOTONIC", "Leg sequence number must increase", {
        legId: leg.legId,
        sequenceNo: leg.sequenceNo
      });
    }
  }
  const documentClash = chain.find((existing) => existing.documentId === leg.documentId);
  if (documentClash !== void 0) {
    return reject(
      "SH-07",
      "DOCUMENT_ALREADY_BOUND_TO_A_LEG",
      "Each leg is a distinct instrument; a document may reference only one leg",
      { documentId: leg.documentId, boundToLegId: documentClash.legId }
    );
  }
  return ok([...chain, leg]);
}
function verifyChain(chain) {
  let rebuilt = [];
  for (const leg of chain) {
    const step = appendLeg(rebuilt, leg);
    if (!step.ok) return step;
    rebuilt = step.value;
  }
  return ok(true);
}
const findLeg = (chain, legType) => chain.find((l) => l.legType === legType);
const lastExecutedAt = (chain) => chain.at(-1)?.executedAt;
export {
  appendLeg,
  findLeg,
  lastExecutedAt,
  verifyChain
};
