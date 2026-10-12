/**
 * Affordability facts from SAMA Open Banking account information (AIS).
 *
 * Pure: the accounts, balances and transactions a bank returned under the
 * SAMA Open Banking Framework (as implemented on Al Rajhi's developer portal,
 * AIS 2022.11.01-final-errata2) in, the four facts the port carries out. No
 * transaction line leaves this module.
 *
 *   averageMonthlyInflow     booked credits in the window ÷ months
 *   lowestMonthEndBalance    the lowest of the month-end balances in the
 *                            window, walked back from the current booked
 *                            balance through the booked transactions after it
 *   returnedPayments         rejected debits in the last six months
 *   salaryCreditsObserved    booked credits flagged KSAOB.Payroll in the window
 *
 * Every figure is integer minor units; an amount, indicator, status or date
 * that does not read exactly is "not understood" for the whole computation.
 */

import { arr, decimalToMinor, isoToEpoch, obj, own, str } from '../kernel/rail-adapter.ts';
import { KSA_CURRENCY } from '../kernel/riyal.ts';

export interface ObTransaction {
  readonly bookedAt: bigint;
  /** Signed: credits positive, debits negative. */
  readonly signedMinor: bigint;
  readonly status: 'BOOKED' | 'PENDING' | 'REJECTED';
  readonly payroll: boolean;
}

const SIGN: Readonly<Record<string, 1n | -1n>> = { 'KSAOB.Credit': 1n, 'KSAOB.Debit': -1n };
const STATUS: Readonly<Record<string, ObTransaction['status']>> = {
  'KSAOB.Booked': 'BOOKED',
  'KSAOB.Pending': 'PENDING',
  'KSAOB.Rejected': 'REJECTED',
};
/** Balance types in order of preference for "the booked balance now". */
const BOOKED_BALANCE_TYPES = ['KSAOB.InterimBooked', 'KSAOB.ClosingBooked', 'KSAOB.ExpectedBooked'] as const;

/** `Amount{Amount, Currency}` in SAR to signed minor units under a `CreditDebitIndicator`. */
function signedAmount(rec: Readonly<Record<string, unknown>>): bigint | undefined {
  const amount = obj(rec['Amount']);
  const sign = own(SIGN, rec['CreditDebitIndicator']);
  // Amount is a string in the standard; a JSON number has already been a float.
  const minor = typeof amount?.['Amount'] === 'string' ? decimalToMinor(amount['Amount']) : undefined;
  if (sign === undefined || minor === undefined || minor < 0n || amount?.['Currency'] !== KSA_CURRENCY)
    return undefined;
  return sign * minor;
}

/** `Data.Transaction[]` of one page, or undefined when any line is not understood. */
export function readTransactions(body: Readonly<Record<string, unknown>>): ObTransaction[] | undefined {
  const list = arr(obj(body['Data'])?.['Transaction']);
  if (list === undefined) return undefined;
  const out: ObTransaction[] = [];
  for (const raw of list) {
    const t = obj(raw);
    if (t === undefined) return undefined;
    const signedMinor = signedAmount(t);
    const status = own(STATUS, t['Status']);
    const bookedAt = isoToEpoch(t['BookingDateTime']);
    const flags = t['Flags'] === undefined ? [] : arr(t['Flags']);
    if (signedMinor === undefined || status === undefined || bookedAt === undefined || flags === undefined)
      return undefined;
    out.push({ bookedAt, signedMinor, status, payroll: flags.includes('KSAOB.Payroll') });
  }
  return out;
}

/** The current booked balance of one account from `Data.Balance[]`, signed minor units. */
export function readBookedBalance(body: Readonly<Record<string, unknown>>): bigint | undefined {
  const list = arr(obj(body['Data'])?.['Balance']);
  if (list === undefined) return undefined;
  const balances = list.map(obj);
  for (const type of BOOKED_BALANCE_TYPES) {
    const b = balances.find((x) => x?.['Type'] === type);
    if (b !== undefined) return signedAmount(b);
  }
  return undefined;
}

/** `Data.Account[]` — the SAR accounts' ids. Accounts in another currency are not part of a riyal affordability. */
export function readAccountIds(body: Readonly<Record<string, unknown>>): string[] | undefined {
  const list = arr(obj(body['Data'])?.['Account']);
  if (list === undefined) return undefined;
  const out: string[] = [];
  for (const raw of list) {
    const a = obj(raw);
    const id = str(a?.['AccountId']);
    if (a === undefined || id === undefined) return undefined;
    if (a['Currency'] === KSA_CURRENCY) out.push(id);
  }
  return out;
}

/** Midnight UTC on the first of the month `back` months before the month containing `at`. */
export function monthStart(at: bigint, back: number): bigint {
  const d = new Date(Number(at) * 1000);
  return BigInt(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) / 1000);
}

export interface AffordabilityFigures {
  readonly averageMonthlyInflowMinor: bigint;
  readonly lowestMonthEndBalanceMinor: bigint;
  readonly returnedPaymentsLast6Months: number;
  readonly salaryCreditsObserved: number;
}

/**
 * The window is the `months` complete calendar months before the month of `now`. Balances and
 * transactions are summed across the applicant's SAR accounts.
 */
export function affordability(
  accounts: readonly { readonly bookedBalanceMinor: bigint; readonly transactions: readonly ObTransaction[] }[],
  months: number,
  now: bigint,
): AffordabilityFigures {
  const windowEnd = monthStart(now, 0);
  const windowStart = monthStart(now, months);
  const sixMonthsStart = monthStart(now, 6);
  const all = accounts.flatMap((a) => a.transactions);
  const booked = all.filter((t) => t.status === 'BOOKED');
  const inWindow = booked.filter((t) => t.bookedAt >= windowStart && t.bookedAt < windowEnd);

  const inflow = inWindow.filter((t) => t.signedMinor > 0n).reduce((s, t) => s + t.signedMinor, 0n);
  const salaryCreditsObserved = inWindow.filter((t) => t.signedMinor > 0n && t.payroll).length;
  const returnedPaymentsLast6Months = all.filter(
    (t) => t.status === 'REJECTED' && t.signedMinor < 0n && t.bookedAt >= sixMonthsStart && t.bookedAt < windowEnd,
  ).length;

  // Walk back from the booked balance now: the balance at the end of month m is today's balance less
  // everything booked after that month ended.
  const balanceNow = accounts.reduce((s, a) => s + a.bookedBalanceMinor, 0n);
  let lowest: bigint | undefined;
  for (let back = 0; back < months; back += 1) {
    const monthEnd = monthStart(now, back);
    const after = booked.filter((t) => t.bookedAt >= monthEnd).reduce((s, t) => s + t.signedMinor, 0n);
    const balance = balanceNow - after;
    if (lowest === undefined || balance < lowest) lowest = balance;
  }
  return {
    averageMonthlyInflowMinor: months > 0 ? inflow / BigInt(months) : 0n,
    lowestMonthEndBalanceMinor: lowest ?? balanceNow,
    returnedPaymentsLast6Months,
    salaryCreditsObserved,
  };
}
