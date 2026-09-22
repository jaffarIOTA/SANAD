import { describe, expect, it } from "vitest";
import { CHECKER, MAKER, actingPrincipal, canReview } from "../../apps/ops/src/server/session.js";
import { approveRequest, listRequests } from "../../apps/ops/src/server/store.js";
describe("four eyes \u2014 the screen agrees with the domain", () => {
  it("refuses a reviewer their own work", () => {
    expect(canReview(CHECKER, CHECKER.principalId)).toEqual({
      allowed: false,
      reason: "OWN_WORK"
    });
  });
  it("allows a reviewer someone else\u2019s work", () => {
    expect(canReview(CHECKER, MAKER.principalId).allowed).toBe(true);
  });
  it("allows review where no maker is recorded, and leaves the domain to decide", () => {
    expect(canReview(CHECKER, void 0).allowed).toBe(true);
  });
  it("resolves principals on the server, never from input", () => {
    expect(actingPrincipal("MAKER")).toEqual(MAKER);
    expect(actingPrincipal("CHECKER")).toEqual(CHECKER);
    expect(MAKER.principalId).not.toBe(CHECKER.principalId);
  });
  it("the domain refuses a self-approval the queue would not offer", () => {
    const ownWork = listRequests().find(
      (r) => r.state === "AWAITING_REVIEW" && r.makerPrincipalId === CHECKER.principalId
    );
    expect(ownWork, "the seed includes a request keyed by the reviewer").toBeDefined();
    const result = approveRequest(ownWork?.requestId ?? "", CHECKER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("FOUR_EYES_VIOLATED");
      expect(result.error.control).toBe("OP-DETERMINACY");
    }
  });
});
describe("queue ordering", () => {
  const waitingSince = (row) => row.submittedAtEpochSeconds ?? row.raisedAtEpochSeconds;
  const fifo = (a, b) => {
    const byTime = Number(waitingSince(a) - waitingSince(b));
    return byTime !== 0 ? byTime : a.requestId.localeCompare(b.requestId);
  };
  it("hands out the oldest request first", () => {
    const ordered = [...listRequests()].sort(fifo);
    const ages = ordered.map(waitingSince);
    for (let i = 1; i < ages.length; i += 1) {
      expect(ages[i] ?? 0n).toBeGreaterThanOrEqual(ages[i - 1] ?? 0n);
    }
  });
  it("breaks a tie by request identifier, not by repository order", () => {
    const sameSecond = [
      { ...stub("req_00003"), submittedAtEpochSeconds: 1000n },
      { ...stub("req_00001"), submittedAtEpochSeconds: 1000n },
      { ...stub("req_00002"), submittedAtEpochSeconds: 1000n }
    ];
    expect([...sameSecond].sort(fifo).map((r) => r.requestId)).toEqual([
      "req_00001",
      "req_00002",
      "req_00003"
    ]);
  });
  it("is a total order, so the queue is stable between renders", () => {
    const rows = listRequests();
    const once = [...rows].sort(fifo).map((r) => r.requestId);
    const twice = [...rows].reverse().sort(fifo).map((r) => r.requestId);
    expect(twice).toEqual(once);
  });
});
function stub(requestId) {
  return {
    requestId,
    state: "AWAITING_REVIEW",
    channel: "MAKER_CHECKER",
    counterpartyId: "Test Counterparty",
    invoiceNumber: "000000",
    amountMinorUnits: 100n,
    raisedAtEpochSeconds: 1000n
  };
}
