/**
 * The credit-bureau report layout both Saudi bureaus are assumed to answer in.
 *
 * Neither SIMAH nor Bayan publishes a schema (both are released after
 * membership), so the layout is the one credit bureaus share internationally:
 * a subject block, a score block (the score with its reason codes), the
 * facilities (type, limit, outstanding, overdue, days past due, payment
 * history), enquiries, defaults and judgments. Field names are this
 * platform's assumption and each bureau's verification item.
 *
 * The score is the bureau's opaque integer. Its range is NOT public (figures
 * seen online are unreliable), so nothing here bounds, scales or compares it.
 *
 * Fail closed throughout: one facility or default that does not read exactly
 * makes the whole report UNAVAILABLE, never a report without that line.
 */

import type { BureauOutcome } from '../../../core/ports/credit-bureau.ts';
import { type Money, money } from '../../../core/kernel/money.ts';
import type { TsaInstant } from '../../../core/time/tsa.ts';
import { type Body, arr, idStr, int, obj, own } from './rail-adapter.ts';
import { KSA_CURRENCY, sar } from './riyal.ts';

/** Facility status to "is it a live exposure". An unknown status is not understood. */
const FACILITY_OPEN: Readonly<Record<string, boolean>> = {
  ACTIVE: true,
  DELINQUENT: true,
  CLOSED: false,
  SETTLED: false,
  WRITTEN_OFF: false,
};

const UNAVAILABLE = (reason: string): BureauOutcome => ({ kind: 'UNAVAILABLE', reason });

/** One bureau report to the port's summary; `attest` timestamps the retrieval only when the report is accepted. */
export async function mapBureauReport(v: Body, attest: () => Promise<TsaInstant>): Promise<BureauOutcome> {
  const reference = idStr(v['reportId']);
  const subject = obj(v['subject']);
  if (reference === undefined || subject === undefined) return UNAVAILABLE('response malformed');
  if (subject['found'] === false) return { kind: 'NO_RECORD', bureauReference: reference };
  if (subject['found'] !== true) return UNAVAILABLE('response malformed');

  let exposure = 0n;
  let overdue = 0n;
  let worst = 0;
  let active = 0;
  for (const raw of arr(v['facilities']) ?? []) {
    const f = obj(raw);
    const open = own(FACILITY_OPEN, f?.['status']);
    const outstanding = sar(f?.['outstandingBalance'], f?.['currency']);
    const late = sar(f?.['overdueAmount'], f?.['currency']);
    const dpd = int(f?.['daysPastDue']);
    if (f === undefined || open === undefined || outstanding === undefined || late === undefined || dpd === undefined)
      return UNAVAILABLE('response malformed');
    if (dpd < 0) return UNAVAILABLE('response malformed');
    if (open) {
      active += 1;
      exposure += outstanding.minorUnits;
    }
    overdue += late.minorUnits;
    worst = Math.max(worst, dpd);
  }

  const defaults: { readonly amount: Money; readonly settled: boolean }[] = [];
  for (const raw of arr(v['defaults']) ?? []) {
    const d = obj(raw);
    const amount = sar(d?.['amount'], d?.['currency']);
    // AECB parity: one unreadable default refuses the report rather than vanishing from it.
    if (d === undefined || amount === undefined || typeof d['settled'] !== 'boolean')
      return UNAVAILABLE('response malformed');
    defaults.push({ amount, settled: d['settled'] });
  }

  const scoreBlock = v['score'] === undefined || v['score'] === null ? undefined : obj(v['score']);
  if (v['score'] !== undefined && v['score'] !== null && scoreBlock === undefined)
    return UNAVAILABLE('response malformed');
  const score = scoreBlock === undefined ? undefined : int(scoreBlock['value']);
  if (scoreBlock !== undefined && score === undefined) return UNAVAILABLE('response malformed');

  return {
    kind: 'REPORT',
    summary: {
      bureauReference: reference,
      retrievedAt: await attest(),
      totalExposure: money(exposure, KSA_CURRENCY),
      overdueAmount: money(overdue, KSA_CURRENCY),
      worstDelinquencyDays: worst,
      activeFacilities: active,
      ...(score === undefined ? {} : { bureauScore: score }),
      defaults,
    },
  };
}

/** The reporting-duty acknowledgement both bureaus are assumed to return. */
export const acknowledgementOf = (v: Body): string | undefined => idStr(v['acknowledgementId']);
