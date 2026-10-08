/**
 * The UAE SME pipeline screens' arithmetic.
 *
 * The dashboard and the offer page are async server components that read
 * the business service, so what is tested here is the logic they depend on
 * (apps/ops/src/server/business-dashboard.ts): the four figures, the stage
 * clock and status chip on each card, and the schedule excerpt the offer
 * page shows. Each has a way of being quietly wrong — a count that includes
 * withdrawn applications, an SLA chip that turns amber a day late, an
 * excerpt that drops or repeats an instalment — and none of those would
 * stop a page from rendering.
 *
 * The book is the service's own ILLUSTRATIVE seed for sme-fund-ae, walked
 * through the real state machine, in memory.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { type BusinessApplicationView, listApplications, resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import {
  documentGroup,
  formatPercent,
  formatTimes,
  scheduleExcerpt,
  stageClock,
  statusChip,
  summarisePipeline,
  turnaroundSeconds,
} from '../../apps/ops/src/server/business-dashboard.ts';

const DAY = 86_400n;
let views: readonly BusinessApplicationView[] = [];
const byId = (id: string): BusinessApplicationView => {
  const v = views.find((x) => x.application.applicationId === id);
  if (v === undefined) throw new Error(`seed ${id} missing`);
  return v;
};

beforeAll(async () => {
  resetBusinessStore();
  views = await listApplications('sme-fund-ae');
});

describe('the pipeline summary', () => {
  it('counts the seed into origination, portfolio and the stage-5 queue', () => {
    const now = byId('FR-00005101').application.receivedAtEpochSeconds + DAY;
    const s = summarisePipeline(views, now);
    expect(views).toHaveLength(8);
    expect(s.activeCount).toBe(6);
    expect(s.portfolioCount).toBe(2);
    expect(s.pendingAssessmentCount).toBe(3);
    expect(s.completedCount).toBe(2);
    expect(Object.fromEntries(Object.entries(s.byStage).map(([k, v]) => [k, v.length]))).toEqual({ 5: 3, 6: 2, 7: 1, 8: 1, 9: 1 });
    expect(s.targetDays).toBe(23);
  });

  it('leaves withdrawn and declined applications out of every open count', () => {
    const base = byId('FR-00005101');
    const withdrawn: BusinessApplicationView = { ...base, application: { ...base.application, applicationId: 'FR-00009999', status: 'WITHDRAWN', withdrawal: { reason: 'test', atEpochSeconds: base.application.receivedAtEpochSeconds } } };
    const now = base.application.receivedAtEpochSeconds + DAY;
    const s = summarisePipeline([...views, withdrawn], now);
    expect(s.activeCount).toBe(6);
    expect(s.pendingAssessmentCount).toBe(3);
  });

  it('averages hand-over-to-disbursement in tenths of a day, rounded half up', () => {
    const disbursed = views.filter((v) => v.application.disbursement !== undefined);
    const now = byId('FR-00005101').application.receivedAtEpochSeconds;
    const sum = disbursed.reduce((acc, v) => acc + turnaroundSeconds(v, now), 0n);
    const n = BigInt(disbursed.length);
    const s = summarisePipeline(views, now);
    expect(s.averageTurnaroundTenthsOfDay).toBe((sum * 10n + (n * DAY) / 2n) / (n * DAY));
    // Turnaround of a closed application does not grow with the clock.
    expect(turnaroundSeconds(disbursed[0] as BusinessApplicationView, now + 400n * DAY)).toBe(turnaroundSeconds(disbursed[0] as BusinessApplicationView, now));
  });

  it('sums the facility amounts disbursed in the current UAE calendar month', () => {
    const ibex = byId('FR-00005107');
    const at = ibex.application.disbursement?.atEpochSeconds ?? 0n;
    const s = summarisePipeline(views, at);
    expect(s.disbursedThisMonthCount).toBeGreaterThanOrEqual(1);
    expect(s.disbursedThisMonthMinorUnits >= ibex.application.requested.minorUnits).toBe(true);
    // Far in the future, nothing was disbursed "this month".
    expect(summarisePipeline(views, at + 400n * DAY).disbursedThisMonthMinorUnits).toBe(0n);
  });

  it('reports near-SLA at 80% of the stage target and a breach past it', () => {
    const v = byId('FR-00005101');
    const t0 = v.application.receivedAtEpochSeconds;
    expect(stageClock(v, t0 + DAY).state).toBe('ON_TRACK');
    expect(stageClock(v, t0 + 4n * DAY).state).toBe('NEAR');
    expect(stageClock(v, t0 + 5n * DAY + 1n).state).toBe('BREACHED');
    expect(stageClock(v, t0 + 4n * DAY).day).toBe(5);
    expect(summarisePipeline(views, t0 + 6n * DAY).nearSlaCount).toBeGreaterThanOrEqual(1);
  });
});

describe('the status chip', () => {
  it('shows days past due for a facility in collections', () => {
    const chip = statusChip(byId('FR-00005108'), byId('FR-00005108').application.receivedAtEpochSeconds + 200n * DAY);
    expect(chip).toMatchObject({ code: 'DPD', en: 'DPD 34', tone: 'bad' });
  });

  it('shows a performing facility as on track', () => {
    expect(statusChip(byId('FR-00005107'), 2_000_000_000n).code).toBe('ON_TRACK');
  });

  it('counts the days since the offer was sent', () => {
    const v = byId('FR-00005106');
    const sent = v.application.offer?.sentAtEpochSeconds ?? 0n;
    expect(statusChip(v, sent + 1n).en).toBe('Offer sent day 1');
    expect(statusChip(v, sent + DAY + 1n).en).toBe('Offer sent day 2');
  });

  it('marks a straight-through case awaiting its checker and a referred case with the committee', () => {
    const stp = byId('FR-00005105');
    const committee = byId('FR-00005104');
    expect(statusChip(stp, stp.application.receivedAtEpochSeconds).code).toBe('SCORING_COMPLETE');
    expect(['IN_STAGE', 'SLA_NEAR', 'SLA_BREACHED']).toContain(statusChip(committee, committee.application.receivedAtEpochSeconds + 9n * DAY).code);
  });

  it('turns the stage-5 chip amber on the last day', () => {
    const v = byId('FR-00005103');
    const entered = stageClock(v, 0n).enteredAtEpochSeconds;
    expect(statusChip(v, entered + 4n * DAY + 1n)).toMatchObject({ code: 'SLA_NEAR', en: 'Day 5 of 5 ⚠ SLA', tone: 'warn' });
  });
});

describe('the offer page schedule excerpt', () => {
  const rows = Array.from({ length: 36 }, (_, i) => ({ number: i + 1 }));

  it('shows the first five and the last three, and says how many it skipped', () => {
    const e = scheduleExcerpt(rows, 5, 3);
    expect(e.head.map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);
    expect(e.tail.map((r) => r.number)).toEqual([34, 35, 36]);
    expect(e.omitted).toBe(28);
    expect(e.head.length + e.omitted + e.tail.length).toBe(36);
  });

  it('shows a short schedule whole rather than an ellipsis standing for one row', () => {
    for (const n of [1, 6, 8, 9]) {
      const e = scheduleExcerpt(rows.slice(0, n), 5, 3);
      expect(e.omitted).toBe(0);
      expect(e.tail).toEqual([]);
      expect(e.head).toHaveLength(n);
    }
    expect(scheduleExcerpt(rows.slice(0, 10), 5, 3).omitted).toBe(2);
  });

  it('excerpts the recorded dated schedule of a sent offer without losing an instalment', () => {
    const offer = byId('FR-00005106').latestOffer;
    expect(offer).toBeDefined();
    const schedule = offer?.schedule;
    if (schedule === undefined) return;
    const e = scheduleExcerpt(schedule.rows);
    expect(e.head[0]?.number).toBe(1);
    expect(e.tail.at(-1)?.number).toBe(schedule.rows.length);
    expect(e.head.length + e.omitted + e.tail.length).toBe(schedule.rows.length);
    // The totals row the page shows is the schedule's own, and it reconciles with the rows.
    expect(schedule.rows.reduce((s, r) => s + r.principal.minorUnits, 0n)).toBe(schedule.totalPrincipal.minorUnits);
    expect(schedule.rows.reduce((s, r) => s + r.instalment.minorUnits, 0n)).toBe(schedule.totalPayable.minorUnits);
    expect(schedule.rows.at(-1)?.closingBalance.minorUnits).toBe(0n);
  });
});

describe('display formatting', () => {
  it('renders per-ten-thousand ratios without a float', () => {
    expect(formatTimes(14_000n)).toBe('1.40×');
    expect(formatTimes(81_666n)).toBe('8.16×');
    expect(formatPercent(388n)).toBe('3.88%');
    expect(formatPercent(-150n)).toBe('-1.50%');
  });

  it('groups the checklist for display and never drops an unknown document', () => {
    expect(documentGroup('TRADE_LICENCE')).toBe('CORE');
    expect(documentGroup('AUDITED_FINANCIALS_2Y')).toBe('FINANCIAL');
    expect(documentGroup('ASSET_VALUATION_REPORT')).toBe('PROJECT_COLLATERAL');
    expect(documentGroup('SOMETHING_NEW')).toBe('PROJECT_COLLATERAL');
  });
});
