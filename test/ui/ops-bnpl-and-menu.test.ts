/**
 * The BNPL list-and-panel screen and the menu page (2026-11-04).
 *
 * The logic lives in plain TypeScript (bnpl/loan-standing.ts and
 * [locale]/navigation.ts) and is tested directly; the pages are `.tsx` that
 * Vitest cannot import, so their markup is asserted from the source, as in
 * business-screens.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { ConsumerLoanView, StoredLoanEvent } from '@sanad/origination/consumer-loans.ts';

import { matchesFilter, standingOf } from '../../apps/ops/src/app/[locale]/bnpl/loan-standing.ts';
import { activeItemId, navigationFor, searchModules, sidebarOf } from '../../apps/ops/src/app/[locale]/navigation.ts';
import { MODULE_GROUPS } from '../../apps/ops/src/server/modules.ts';
import { source as repoSource } from './source.ts';

const source = (path: string): string => repoSource(`apps/ops/src/app/[locale]/${path}`);

let sequence = 0;
const event = (
  kind: StoredLoanEvent['kind'],
  scheduleNumber?: number,
  detail: Record<string, string> = {},
): StoredLoanEvent => ({
  kind,
  ...(scheduleNumber === undefined ? {} : { scheduleNumber }),
  idempotencyKey: `k${String(++sequence)}`,
  detail,
  sequence: String(sequence),
  createdAt: '2026-11-03T10:00:00Z',
  createdBy: 'test',
});

const loanOf = (events: StoredLoanEvent[]): ConsumerLoanView => ({
  loan: {
    loanRef: 'txn_t1',
    productCode: 'BNPL',
    applicantRef: 'a',
    originRef: 'o',
    principalMinorUnits: 40_000n,
    currency: 'SAR',
    rateBp: 0n,
    aprBp: 0n,
    numberOfInstalments: 4,
    intervalMonths: 1,
    firstDueDate: '2026-12-03',
    collectionChannel: 'CARD',
    collectionMandateRef: 'm',
    correlationId: 'c',
    createdBy: 'test',
  },
  events,
});

describe('where a BNPL loan stands, from Sanad’s own events', () => {
  it('is not booked until the loan system has it, with the first due date next', () => {
    expect(standingOf(loanOf([]))).toEqual({ stage: 'NOT_BOOKED', paidCount: 0, planLength: 4, nextDue: '2026-12-03' });
  });

  it('is awaiting activation while the loan system says so, and counts as active under the chip', () => {
    const s = standingOf(loanOf([event('BOOKED_IN_LOAN_SYSTEM', undefined, { loanState: 'AWAITING_ACTIVATION' })]));
    expect(s.stage).toBe('AWAITING_ACTIVATION');
    expect(s.bookedAt).toBe('2026-11-03T10:00:00Z');
    expect(matchesFilter(s.stage, 'ACTIVE')).toBe(true);
    expect(matchesFilter(s.stage, 'NOT_BOOKED')).toBe(false);
  });

  it('counts each instalment repaid once, and moves the next due date past them', () => {
    const s = standingOf(
      loanOf([
        event('BOOKED_IN_LOAN_SYSTEM'),
        event('REPAYMENT_POSTED', 1),
        event('REPAYMENT_POSTED', 1),
        event('REPAYMENT_POSTED', 2),
      ]),
    );
    expect(s).toMatchObject({ stage: 'ACTIVE', paidCount: 2, nextDue: '2027-02-03' });
  });

  it('is overdue while an instalment reported overdue is unpaid, and active again once it is paid', () => {
    const overdue = [event('BOOKED_IN_LOAN_SYSTEM'), event('INSTALMENT_OVERDUE', 1)];
    expect(standingOf(loanOf(overdue)).stage).toBe('OVERDUE');
    expect(standingOf(loanOf([...overdue, event('REPAYMENT_POSTED', 1)])).stage).toBe('ACTIVE');
  });

  it('is paid in full when closed, with every instalment counted and nothing next', () => {
    const s = standingOf(loanOf([event('BOOKED_IN_LOAN_SYSTEM'), event('LOAN_CLOSED')]));
    expect(s).toEqual({ stage: 'PAID_IN_FULL', paidCount: 4, planLength: 4, bookedAt: '2026-11-03T10:00:00Z' });
  });
});

describe('the sidebar: pinned shortcuts, and the page you are on', () => {
  it('keeps only pinned items with a screen, and is short in both jurisdictions', () => {
    for (const code of ['SA', 'AE'] as const) {
      const { pinned } = sidebarOf(navigationFor(code), undefined);
      expect(pinned.length).toBeGreaterThan(2);
      expect(pinned.length).toBeLessThanOrEqual(8);
      expect(pinned.map((p) => p.id)).toContain('review-queue');
    }
    expect(sidebarOf(navigationFor('SA'), undefined).pinned.map((p) => p.id)).toContain('bnpl');
    expect(sidebarOf(navigationFor('AE'), undefined).pinned.map((p) => p.id)).not.toContain('bnpl');
  });

  it('pins nothing that cannot be opened', () => {
    for (const g of MODULE_GROUPS)
      for (const i of g.items)
        if (i.pinned === true) {
          expect(i.readiness.kind, i.id).toBe('LIVE');
          expect(i.href, i.id).toBeDefined();
        }
  });

  it('shows the page you are on when it is not pinned, and not twice when it is', () => {
    const groups = navigationFor('SA');
    const onDocs = activeItemId(groups, 'en', '/en/documents');
    expect(sidebarOf(groups, onDocs).current?.id).toBe('viewer');
    const onBnpl = activeItemId(groups, 'en', '/en/bnpl');
    expect(sidebarOf(groups, onBnpl).current).toBeUndefined();
  });

  it('no longer lists the module map, and opens the menu page from its first entry', () => {
    const nav = source('SideNav.tsx');
    expect(nav).toContain('/menu');
    expect(nav).not.toContain('groups.map(');
  });
});

describe('the menu page', () => {
  it('finds a module by English, Arabic or reference, word by word', () => {
    const groups = navigationFor('SA');
    const ids = (q: string) => searchModules(groups, q).flatMap((g) => g.items.map((i) => i.id));
    expect(ids('review queue')).toContain('review-queue');
    expect(ids('قائمة المراجعة')).toContain('review-queue');
    expect(ids('SIMAH')).toContain('simah');
    expect(ids('no such module anywhere')).toEqual([]);
    expect(searchModules(groups, '  ')).toBe(groups);
  });

  it('lists every module the jurisdiction has, with its readiness, and opens only what has a screen', () => {
    const menu = source('menu/page.tsx');
    expect(menu).toContain('navigationFor(jurisdiction.code)');
    expect(menu).toContain("item.readiness.kind === 'LIVE' && item.href !== undefined");
    expect(menu).toContain('READINESS[item.readiness.kind]');
  });
});

describe('the BNPL screen', () => {
  it('is a list beside the chosen loan, with the booking action only where it is needed', () => {
    const page = source('bnpl/page.tsx');
    expect(page).toContain('xl:grid-cols-[minmax(0,1fr)_minmax(400px,460px)]');
    expect(page).toContain('LOAN_FILTERS.map');
    expect(page).toContain('role="progressbar"');
    expect(page).toMatch(/booking === undefined \? \(\s*<div[^>]*attention/);
    expect(page).toContain('act="CONSUMER_LOAN_SERVICE"');
  });
});
