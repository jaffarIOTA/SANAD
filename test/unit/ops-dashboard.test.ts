/**
 * The operations dashboard's figures: what needs attention, in what order,
 * against the tenant's own service-level targets, and the pipeline funnel.
 */
import { describe, expect, it } from 'vitest';

import { loadOriginationPolicy } from '@sanad/config/loader.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';

import { summarise } from '../../apps/ops/src/server/dashboard.ts';
import type { RequestRow } from '../../apps/ops/src/server/store.ts';

const POLICY = expectOk(loadOriginationPolicy('bank-a'));
const NOW = 1_800_000_000n;
const HOUR = 3_600n;

const row = (
  requestId: string,
  state: RequestRow['state'],
  ageHours: bigint,
  amount = 1_000_00n,
  maker?: string,
): RequestRow => ({
  requestId,
  state,
  channel: 'MAKER_CHECKER',
  counterpartyId: `cp-${requestId}`,
  invoiceNumber: `INV-${requestId}`,
  amountMinorUnits: amount,
  raisedAtEpochSeconds: NOW - ageHours * HOUR,
  submittedAtEpochSeconds: NOW - ageHours * HOUR,
  ...(maker === undefined ? {} : { makerPrincipalId: maker }),
});

describe('ops dashboard summary', () => {
  it('puts breaches of the tenant’s own targets first, then the oldest of each kind', () => {
    // bank-a: AWAITING_REVIEW target is 24h, SERVICING_UNAVAILABLE 1h.
    const rows = [
      row('a', 'AWAITING_REVIEW', 2n),
      row('b', 'AWAITING_REVIEW', 30n),
      row('c', 'SERVICING_UNAVAILABLE', 0n),
      row('d', 'APPROVED', 100n),
      row('e', 'AWAITING_REVIEW', 5n),
    ];
    const s = summarise(rows, POLICY, NOW);
    expect(s.attention.map((a) => `${a.requestId}:${a.kind}`)).toEqual([
      'b:SLA_BREACHED',
      'c:SERVICING_UNAVAILABLE',
      'e:AWAITING_REVIEW',
      'a:AWAITING_REVIEW',
    ]);
    expect(s.countsByKind.SLA_BREACHED).toBe(1);
    expect(s.attention[0]?.slaSeconds).toBe(86_400);
  });

  it('marks the observer’s own requests, which four eyes forbids them to decide', () => {
    const s = summarise(
      [row('a', 'AWAITING_REVIEW', 1n, 100n, 'mkr-1'), row('b', 'AWAITING_REVIEW', 1n, 100n, 'mkr-2')],
      POLICY,
      NOW,
      'mkr-1',
    );
    expect(s.attention.find((a) => a.requestId === 'a')?.ownRequest).toBe(true);
    expect(s.attention.find((a) => a.requestId === 'b')?.ownRequest).toBe(false);
  });

  it('funnels every request into exactly one stage, values in minor units', () => {
    const rows = [
      row('a', 'AWAITING_REVIEW', 1n, 500n),
      row('b', 'PENDING_INFORMATION', 1n, 300n),
      row('c', 'APPROVED', 1n, 700n),
      row('d', 'REJECTED', 1n, 900n),
      row('e', 'KEYING', 0n, 100n),
    ];
    const s = summarise(rows, POLICY, NOW);
    expect(s.funnel.reduce((n, f) => n + f.requestCount, 0)).toBe(rows.length);
    expect(s.openValueMinorUnits).toBe(900n);
    expect(s.approvedValueMinorUnits).toBe(700n);
    expect(s.requestsOnBook).toBe(5);
  });

  it('without a policy nothing is called a breach, and settled requests never need attention', () => {
    const s = summarise([row('a', 'AWAITING_REVIEW', 1_000n), row('b', 'APPROVED', 1_000n)], undefined, NOW);
    expect(s.attention.map((a) => a.kind)).toEqual(['AWAITING_REVIEW']);
  });
});
