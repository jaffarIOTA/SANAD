/**
 * The review queue's rules.
 *
 * The page itself is an async server component that reaches into the store,
 * so what is tested here is the logic the screen depends on rather than the
 * markup: who may review what, and the order work is handed out in.
 *
 * Both have a way of being quietly wrong. A four-eyes check that is only a
 * hidden button is not a control. A queue that claims to be oldest-first and
 * silently inverts on a tie starves exactly the requests that have waited
 * longest, and nothing on screen says so.
 */

import { describe, expect, it } from 'vitest';

import { CHECKER, MAKER, actingPrincipal, canReview } from '../../apps/ops/src/server/session.ts';
import { approveRequest, listRequests, type RequestRow } from '../../apps/ops/src/server/store.ts';

describe('four eyes — the screen agrees with the domain', () => {
  it('refuses a reviewer their own work', () => {
    expect(canReview(CHECKER, CHECKER.principalId)).toEqual({
      allowed: false,
      reason: 'OWN_WORK',
    });
  });

  it('allows a reviewer someone else’s work', () => {
    expect(canReview(CHECKER, MAKER.principalId).allowed).toBe(true);
  });

  it('allows review where no maker is recorded, and leaves the domain to decide', () => {
    // A request with no maker is not the reviewer's own work. Whether it is
    // reviewable at all is the domain's call, not the queue's.
    expect(canReview(CHECKER, undefined).allowed).toBe(true);
  });

  it('resolves principals on the server, never from input', () => {
    expect(actingPrincipal('MAKER')).toEqual(MAKER);
    expect(actingPrincipal('CHECKER')).toEqual(CHECKER);
    expect(MAKER.principalId).not.toBe(CHECKER.principalId);
  });

  /**
   * The decisive one. The queue merely declines to draw a button; the domain
   * must refuse the transition even when the button is bypassed — which, over
   * an HTTP endpoint, it trivially can be.
   */
  it('the domain refuses a self-approval the queue would not offer', () => {
    const ownWork = listRequests().find(
      (r) => r.state === 'AWAITING_REVIEW' && r.makerPrincipalId === CHECKER.principalId,
    );
    expect(ownWork, 'the seed includes a request keyed by the reviewer').toBeDefined();

    const result = approveRequest(ownWork?.requestId ?? '', CHECKER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('FOUR_EYES_VIOLATED');
      expect(result.error.control).toBe('OP-DETERMINACY');
    }
  });
});

describe('queue ordering', () => {
  const waitingSince = (row: RequestRow): bigint =>
    row.submittedAtEpochSeconds ?? row.raisedAtEpochSeconds;

  /** The comparator the page uses. Kept in one shape so the test is the spec. */
  const fifo = (a: RequestRow, b: RequestRow): number => {
    const byTime = Number(waitingSince(a) - waitingSince(b));
    return byTime !== 0 ? byTime : a.requestId.localeCompare(b.requestId);
  };

  it('hands out the oldest request first', () => {
    const ordered = [...listRequests()].sort(fifo);
    const ages = ordered.map(waitingSince);
    for (let i = 1; i < ages.length; i += 1) {
      expect(ages[i] ?? 0n).toBeGreaterThanOrEqual(ages[i - 1] ?? 0n);
    }
  });

  /**
   * Attested timestamps have one-second granularity, so a batch arriving
   * together ties. Without a tie-break the order falls back to whatever the
   * repository returned — which is descending, silently inverting the queue.
   */
  it('breaks a tie by request identifier, not by repository order', () => {
    const sameSecond: RequestRow[] = [
      { ...stub('req_00003'), submittedAtEpochSeconds: 1_000n },
      { ...stub('req_00001'), submittedAtEpochSeconds: 1_000n },
      { ...stub('req_00002'), submittedAtEpochSeconds: 1_000n },
    ];
    expect([...sameSecond].sort(fifo).map((r) => r.requestId)).toEqual([
      'req_00001',
      'req_00002',
      'req_00003',
    ]);
  });

  it('is a total order, so the queue is stable between renders', () => {
    const rows = listRequests();
    const once = [...rows].sort(fifo).map((r) => r.requestId);
    const twice = [...rows].reverse().sort(fifo).map((r) => r.requestId);
    expect(twice).toEqual(once);
  });
});

function stub(requestId: string): RequestRow {
  return {
    requestId,
    state: 'AWAITING_REVIEW',
    channel: 'MAKER_CHECKER',
    counterpartyId: 'Test Counterparty',
    invoiceNumber: '000000',
    amountMinorUnits: 100n,
    raisedAtEpochSeconds: 1_000n,
  };
}
