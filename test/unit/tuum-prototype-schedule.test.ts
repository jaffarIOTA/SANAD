/**
 * The partner's prototype offer schedule, reproduced to the fil.
 *
 * Source: docs/partners/tuum/prototype-2026-10-08/09-stage7-offer-schedule.jpg
 * (and 10, 11): AED 2,000,000 over 60 monthly instalments at 1.5% p.a., no
 * grace, first due 10 September 2029. Every figure the screen shows is pinned
 * here, so a change to the day count, rounding or rate basis that would make
 * our schedule disagree with the partner's fails this test
 * (docs/partners/tuum/SME-TRACEABILITY.md, schedule check).
 *
 * The disbursement date is not on the screen. It is inferred: only a 37-day
 * first period (disbursed 4 August 2029) gives the first-row interest of
 * AED 3,041.10 under actual/365 on the reducing balance. Ask the partner to
 * confirm it (traceability questions).
 */
import { describe, expect, it } from 'vitest';

import { loadProductCatalogue, loadSmeDefinition } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import type { QuoteRequest } from '@sanad/core/products/module.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { smeTermConventional } from '@sanad/products/sme-term-conventional/index.ts';

const T0 = 1_790_000_000n;
const at = tsaInstant({ verified: true, genTimeEpochSeconds: T0, tokenDigest: 't', authorityId: 'test' });
const aed = (fils: bigint) => money(fils, 'AED');

function prototypeQuote() {
  const catalogue = expectOk(loadProductCatalogue('sme-fund-ae'));
  const entry = catalogue.entries.find((e) => e.productCode === 'sme-term-conventional');
  if (entry === undefined) throw new Error('the fund carries sme-term-conventional');
  const terms = expectOk(smeTermConventional.validateTerms(entry.terms));
  const request = {
    tenantId: 'sme-fund-ae',
    programmeId: 'prototype',
    counterpartyId: 'prototype-applicant',
    requestedAmount: aed(200_000_000n),
    requestedTenorDays: 60 * 30,
    asOf: at,
    pricing: {
      rate: {
        rate: rate(150n, 'REDUCING'),
        source: 'TENANT_CATALOGUE',
        sourceRef: 'prototype',
        snapshottedAtEpochSeconds: T0,
      },
    },
    regulatory: { smeDefinition: expectOk(loadSmeDefinition('AE')) },
    affordability: {
      business: {
        annualRevenue: aed(234_000_000n),
        fullTimeEmployees: 20,
        sector: 'SERVICES',
        annualOperatingCashFlow: aed(100_000_000n),
        existingAnnualDebtService: aed(0n),
        financialsSourceRef: 'prototype',
      },
    },
    preferences: {
      variant: 'FIXED_ASSETS',
      purpose: 'EQUIPMENT',
      contributionPerTenThousand: '2000',
      yearsInOperation: '4',
      disbursementDate: '2029-08-04',
      firstDueDate: '2029-09-10',
    },
  } as unknown as QuoteRequest;
  return expectOk(smeTermConventional.quote(terms, request));
}

// number, due date, opening balance, principal, interest, instalment, closing balance — in fils, as the screen shows them.
const SCREEN_ROWS: readonly (readonly [number, string, bigint, bigint, bigint, bigint, bigint])[] = [
  [1, '2029-09-10', 200_000_000n, 3_158_808n, 304_110n, 3_462_918n, 196_841_192n],
  [2, '2029-10-10', 196_841_192n, 3_220_237n, 242_681n, 3_462_918n, 193_620_955n],
  [3, '2029-11-10', 193_620_955n, 3_216_250n, 246_668n, 3_462_918n, 190_404_705n],
  [4, '2029-12-10', 190_404_705n, 3_228_172n, 234_746n, 3_462_918n, 187_176_533n],
  [5, '2030-01-10', 187_176_533n, 3_224_460n, 238_458n, 3_462_918n, 183_952_073n],
  [58, '2034-06-10', 10_362_609n, 3_449_716n, 13_202n, 3_462_918n, 6_912_893n],
  [59, '2034-07-10', 6_912_893n, 3_454_395n, 8_523n, 3_462_918n, 3_458_498n],
  [60, '2034-08-10', 3_458_498n, 3_458_498n, 4_406n, 3_462_904n, 0n],
];

describe('the partner’s prototype offer schedule (AED 2,000,000 · 60 months · 1.5% p.a.)', () => {
  const quote = prototypeQuote();
  const schedule = quote.datedSchedule;
  if (schedule === undefined) throw new Error('a conventional SME quote carries a dated schedule');

  it('has sixty instalments and the level instalment of AED 34,629.18', () => {
    expect(schedule.rows).toHaveLength(60);
    expect(schedule.levelInstalment.minorUnits).toBe(3_462_918n);
  });

  it('reproduces every row the screen shows, to the fil', () => {
    for (const [n, due, opening, principal, interest, instalment, closing] of SCREEN_ROWS) {
      const row = schedule.rows.find((r) => r.number === n);
      expect(row, `row ${String(n)}`).toBeDefined();
      if (row === undefined) continue;
      expect(row.dueDate, `row ${String(n)} due date`).toBe(due);
      expect(row.openingBalance.minorUnits, `row ${String(n)} opening`).toBe(opening);
      expect(row.principal.minorUnits, `row ${String(n)} principal`).toBe(principal);
      expect(row.interest.minorUnits, `row ${String(n)} interest`).toBe(interest);
      expect(row.instalment.minorUnits, `row ${String(n)} instalment`).toBe(instalment);
      expect(row.closingBalance.minorUnits, `row ${String(n)} closing`).toBe(closing);
    }
  });

  it('totals AED 2,000,000 principal, AED 77,750.66 interest and AED 2,077,750.66 payable', () => {
    expect(schedule.totalPrincipal.minorUnits).toBe(200_000_000n);
    expect(schedule.totalInterest.minorUnits).toBe(7_775_066n);
    expect(quote.totalPayable.minorUnits).toBe(207_775_066n);
  });
});
