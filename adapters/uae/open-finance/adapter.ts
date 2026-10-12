/**
 * UAE Open Finance — account information adapter (ADR 0005).
 *
 * Implements the AccountInformationPort against the CBUAE Open Finance
 * Standards v2.1 Account Information API (published OpenAPI 3.0, base
 * `/open-finance/account-information/v2.1`): the consent is read back, then
 * the accounts, each account's balances and its booked transactions, all in
 * the published `Data` / `Links` / `Meta` envelope with the published field
 * names. From them the adapter derives the affordability facts the port
 * carries; no statement line is stored or crosses the port.
 *
 *   GET /account-access-consents/{ConsentId}
 *   GET /accounts
 *   GET /accounts/{AccountId}/balances
 *   GET /accounts/{AccountId}/transactions?fromBookingDateTime=&toBookingDateTime=
 *
 * Money: `Amount.Amount` is a decimal STRING in the specification
 * (^\d{1,13}$|^\d{1,13}\.\d{1,5}$) and becomes AED minor units by digit
 * manipulation; a JSON number is malformed. `CurrencyExchange.ExchangeRate`
 * is a JSON number in the specification and is never read.
 *
 * Consent-gated (ACCOUNT_INFORMATION). Under the standard the ConsentId is
 * assigned by the TPP, so Sanad's consent id is the Open Finance ConsentId.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. The module stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned
 * (UAE-RAIL-OPENFINANCE-01).
 */

import type { AccountInformationPort } from '../../../core/ports/account-information.ts';
import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { RailOutcome } from '../../../core/ports/rail.ts';
import type { Money } from '../../../core/kernel/money.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { type Body, RailAdapter, type RailAdapterConfig, malformed, str } from '../../kernel/rail-adapter.ts';
import { UAE_CURRENCY, aedAmountObject } from '../kernel/dirham.ts';
import { isoEpoch } from '../kernel/iso-time.ts';
import { lookupStatus } from '../kernel/vocabulary.ts';

export const OPEN_FINANCE_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'OPENFINANCE-DEV-001',
    summary:
      'The API returns full statement lines, account holder names and account identifiers (IBAN); the port carries six affordability facts.',
    containment:
      'Lines are reduced inside this adapter and discarded; no line, name or account identifier crosses the port or is stored.',
    verificationRef: 'UAE-RAIL-OPENFINANCE-01',
  },
  {
    id: 'OPENFINANCE-DEV-002',
    summary:
      'Amounts are decimal strings of up to five decimals; the FX block carries ExchangeRate as a JSON number (a float).',
    containment:
      'Amounts become AED minor units by digit manipulation; a non-zero digit below the fils, a JSON number amount, or a currency other than AED on an AED account is malformed. CurrencyExchange is never read, so no exchange rate reaches the domain.',
    verificationRef: 'UAE-RAIL-OPENFINANCE-01',
  },
  {
    id: 'OPENFINANCE-DEV-003',
    summary: 'The derivation of the affordability facts is Sanad’s, not the standard’s.',
    containment:
      'Accounts: Active, AED, CurrentAccount or Savings (cards and finance accounts are debts, not liquidity; other currencies are left out, never converted). Inflow: booked credits in the window, less Reversal, Refund, DepositReversal, WithdrawalReversal and Disbursement (loan proceeds are not income), averaged over the months asked by integer division. Month-end balance: reconstructed backwards from the booked balance through booked transactions, summed across accounts. Returned payments: Rejected debits in the last six complete months. Salary credits: booked credits flagged Payroll.',
    verificationRef: 'UAE-RAIL-OPENFINANCE-01',
  },
  {
    id: 'OPENFINANCE-DEV-004',
    summary:
      'The standard identifies a call by x-fapi-interaction-id and returns no reference for an affordability read; the port wants one.',
    containment:
      'The reference is composed from the ConsentId and the as-of instant (of:<consent>:<epoch>), which reproduces the read. The correlation id is sent as x-fapi-interaction-id. Each resource read carries the consent in x-sanad-consent-id so the live transport can present that consent’s user access token; the header is the transport’s and is not forwarded to the bank.',
    verificationRef: 'UAE-RAIL-OPENFINANCE-01',
  },
];

/** The consent statuses of the standard; only Authorized may be read under. */
const CONSENT_REFUSAL: Readonly<Record<string, string | undefined>> = {
  Authorized: undefined,
  AwaitingAuthorization: 'CONSENT_AWAITING_AUTHORIZATION',
  Rejected: 'CONSENT_REJECTED',
  Revoked: 'CONSENT_REVOKED',
  Expired: 'CONSENT_EXPIRED',
  Consumed: 'CONSENT_CONSUMED',
  Suspended: 'CONSENT_SUSPENDED',
};
/** The billing purposes under which an affordability read is within the consent (PDPL purpose limitation). */
const PURPOSES: Readonly<Record<string, true>> = { RiskAssessment: true };
const ELIGIBLE_SUBTYPE: Readonly<Record<string, true>> = { CurrentAccount: true, Savings: true };
/** Balance types in order of preference: a booked figure first. */
const BALANCE_PREFERENCE = ['ClosingBooked', 'InterimBooked', 'ClosingAvailable', 'InterimAvailable', 'Expected'];
/** Credits that are not income. */
const NOT_INFLOW: Readonly<Record<string, true>> = {
  Reversal: true,
  Refund: true,
  DepositReversal: true,
  WithdrawalReversal: true,
  Disbursement: true,
};
const ENTRY_STATUS: Readonly<Record<string, 'Booked' | 'Pending' | 'Rejected'>> = {
  Booked: 'Booked',
  Pending: 'Pending',
  Rejected: 'Rejected',
};
const SIGN: Readonly<Record<string, bigint>> = { Credit: 1n, Debit: -1n };

/**
 * The header that tells the transport which consent a resource read is made under. The standard binds a
 * consent to the user's access token; the live transport uses this header to pick that token and does not
 * forward it to the bank.
 */
export const CONSENT_HEADER = 'x-sanad-consent-id';

const MAX_PAGES = 100;
const MAX_MONTHS = 24;
const RETURNED_WINDOW_MONTHS = 6;

type Rec = Readonly<Record<string, unknown>>;
const rec = (v: unknown): Rec | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined;

/** "YYYY-MM" shifted by whole months. */
function shiftMonth(month: string, by: number): string {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + by;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}
/** The LFI's own calendar month of an ISO date-time ("2026-03-31T23:10:00+04:00" is March), or undefined when unreadable. */
const monthOf = (v: unknown): string | undefined =>
  typeof v === 'string' && isoEpoch(v) !== undefined ? v.slice(0, 7) : undefined;

interface AccountFacts {
  readonly balance: bigint;
  /** Net booked movement per month. */
  readonly net: ReadonlyMap<string, bigint>;
  readonly inflow: bigint;
  readonly salaryCredits: number;
  readonly returned: number;
}

export interface AffordabilityFacts {
  readonly averageMonthlyInflow: Money;
  readonly lowestMonthEndBalance: Money;
  readonly returnedPaymentsLast6Months: number;
  readonly salaryCreditsObserved: number;
  readonly retrievedAtEpochSeconds: bigint;
  readonly referenceId: string;
}

export class OpenFinanceAdapter extends RailAdapter implements AccountInformationPort {
  readonly vendorName = 'UAE Open Finance';
  readonly capabilities = ['ACCOUNT_INFORMATION'] as const;
  readonly deviations = OPEN_FINANCE_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  async affordabilityFacts(p: {
    readonly tenantId: string;
    readonly applicantRef: string;
    readonly consentId: string;
    readonly months: number;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<AffordabilityFacts>>> {
    const consent = await this.requireConsent(p.tenantId, p.consentId, 'ACCOUNT_INFORMATION');
    if (!consent.ok) return consent;
    if (!Number.isInteger(p.months) || p.months < 1 || p.months > MAX_MONTHS)
      return reject(
        'OP-DETERMINACY',
        'MONTHS_OUT_OF_RANGE',
        `Affordability is read over 1 to ${String(MAX_MONTHS)} months`,
      );

    // 1. The consent, as the bank holds it: authorised, for risk assessment, with the reads we need.
    const c = await this.invoke(
      'openfinance.consent',
      {
        method: 'GET',
        path: `/account-access-consents/${encodeURIComponent(p.consentId)}`,
        headers: { 'x-fapi-interaction-id': p.correlationId },
      },
      p.correlationId,
    );
    // An unknown consent at the bank is the bank's refusal, not an outage.
    if (c.kind === 'REFUSED' && c.code === 'HTTP_404') return ok({ kind: 'REFUSED', code: 'CONSENT_NOT_FOUND' });
    if (c.kind !== 'ANSWERED') return ok(c);
    const data = rec(c.value['Data']);
    const status = data?.['Status'];
    if (
      data === undefined ||
      typeof status !== 'string' ||
      !Object.hasOwn(CONSENT_REFUSAL, status) ||
      data['ConsentId'] !== p.consentId
    )
      return ok(malformed());
    const refusal = CONSENT_REFUSAL[status];
    if (refusal !== undefined) return ok({ kind: 'REFUSED', code: refusal });
    if (lookupStatus(PURPOSES, rec(data['OpenFinanceBilling'])?.['Purpose']) === undefined)
      return ok({ kind: 'REFUSED', code: 'CONSENT_PURPOSE_MISMATCH' });
    const permissions = Array.isArray(data['Permissions']) ? (data['Permissions'] as unknown[]) : [];
    const has = (...codes: string[]) => codes.some((x) => permissions.includes(x));
    if (
      !has('ReadAccountsBasic', 'ReadAccountsDetail') ||
      !has('ReadBalances') ||
      !has('ReadTransactionsBasic', 'ReadTransactionsDetail')
    )
      return ok({ kind: 'REFUSED', code: 'CONSENT_PERMISSIONS_INSUFFICIENT' });

    // 2. The accounts that count.
    const accounts = await this.#pages('openfinance.accounts', '/accounts', 'Account', p.consentId, p.correlationId);
    if (accounts.kind !== 'ANSWERED') return ok(accounts);
    const eligible: string[] = [];
    for (const a of accounts.value) {
      const id = str(a['AccountId']);
      if (id === undefined) return ok(malformed());
      if (
        a['Status'] === 'Active' &&
        a['Currency'] === UAE_CURRENCY &&
        lookupStatus(ELIGIBLE_SUBTYPE, a['AccountSubType'])
      )
        eligible.push(id);
    }
    if (eligible.length === 0) return ok({ kind: 'REFUSED', code: 'NO_ELIGIBLE_ACCOUNT' });

    // 3. Each account's booked balance, and the as-of instant: the latest balance read.
    const balances: { readonly id: string; readonly amount: bigint; readonly at: bigint; readonly raw: string }[] = [];
    for (const id of eligible) {
      const b = await this.#pages(
        'openfinance.balances',
        `/accounts/${encodeURIComponent(id)}/balances`,
        'Balance',
        p.consentId,
        p.correlationId,
      );
      if (b.kind !== 'ANSWERED') return ok(b);
      const chosen = BALANCE_PREFERENCE.map((t) => b.value.find((x) => x['Type'] === t)).find((x) => x !== undefined);
      const amount = aedAmountObject(chosen?.['Amount']);
      const sign = lookupStatus(SIGN, chosen?.['CreditDebitIndicator']);
      const raw = chosen?.['DateTime'];
      const at = isoEpoch(raw);
      if (
        chosen === undefined ||
        amount === undefined ||
        sign === undefined ||
        at === undefined ||
        typeof raw !== 'string'
      )
        return ok(malformed());
      balances.push({ id, amount: sign * amount.minorUnits, at, raw });
    }
    const asOf = balances.reduce((m, b) => (b.at > m.at ? b : m));
    const asOfMonth = asOf.raw.slice(0, 7);
    const windowStart = shiftMonth(asOfMonth, -p.months);
    const returnedStart = shiftMonth(asOfMonth, -RETURNED_WINDOW_MONTHS);
    const fetchFrom = windowStart < returnedStart ? windowStart : returnedStart;
    const inWindow = (m: string) => m >= windowStart && m < asOfMonth;
    const inReturnedWindow = (m: string) => m >= returnedStart && m < asOfMonth;

    // 4. Transactions, reduced per account.
    const facts: AccountFacts[] = [];
    for (const b of balances) {
      // The standard says the LFI ignores a zone on these parameters, so none is sent; the balance's own wall time bounds the read.
      const query = `fromBookingDateTime=${fetchFrom}-01T00:00:00&toBookingDateTime=${b.raw.slice(0, 19)}`;
      const t = await this.#pages(
        'openfinance.transactions',
        `/accounts/${encodeURIComponent(b.id)}/transactions?${query}`,
        'Transaction',
        p.consentId,
        p.correlationId,
      );
      if (t.kind !== 'ANSWERED') return ok(t);
      const reduced = reduceTransactions(t.value, inWindow, inReturnedWindow);
      if (reduced === undefined) return ok(malformed());
      facts.push({ balance: b.amount, ...reduced });
    }

    // 5. The facts. Month-end balance of M = today's balance less every booked movement after M.
    let lowest: bigint | undefined;
    for (let i = p.months; i >= 1; i -= 1) {
      const month = shiftMonth(asOfMonth, -i);
      let total = 0n;
      for (const f of facts) {
        let after = 0n;
        for (const [m, n] of f.net) if (m > month) after += n;
        total += f.balance - after;
      }
      if (lowest === undefined || total < lowest) lowest = total;
    }
    const inflow = facts.reduce((s, f) => s + f.inflow, 0n);
    return ok({
      kind: 'ANSWERED',
      value: {
        averageMonthlyInflow: { minorUnits: inflow / BigInt(p.months), currency: UAE_CURRENCY },
        lowestMonthEndBalance: { minorUnits: lowest ?? 0n, currency: UAE_CURRENCY },
        returnedPaymentsLast6Months: facts.reduce((s, f) => s + f.returned, 0),
        salaryCreditsObserved: facts.reduce((s, f) => s + f.salaryCredits, 0),
        retrievedAtEpochSeconds: asOf.at,
        referenceId: `of:${p.consentId}:${asOf.at.toString()}`,
      },
    });
  }

  /**
   * Every page of a list resource, following `Links.Next` (absolute under the
   * base URL, or a path). `Data[key]` must be an array of objects.
   */
  async #pages(
    operation: string,
    firstPath: string,
    key: string,
    consentId: string,
    correlationId: string,
  ): Promise<RailOutcome<readonly Rec[]>> {
    const out: Rec[] = [];
    let path: string | undefined = firstPath;
    for (let page = 0; path !== undefined; page += 1) {
      if (page >= MAX_PAGES) return malformed();
      const r: RailOutcome<Body> = await this.invoke(
        operation,
        { method: 'GET', path, headers: { 'x-fapi-interaction-id': correlationId, [CONSENT_HEADER]: consentId } },
        correlationId,
      );
      if (r.kind !== 'ANSWERED') return r;
      const list = rec(r.value['Data'])?.[key];
      if (!Array.isArray(list) || rec(r.value['Links']) === undefined) return malformed();
      for (const item of list as unknown[]) {
        const o = rec(item);
        if (o === undefined) return malformed();
        out.push(o);
      }
      const next = rec(r.value['Links'])?.['Next'];
      if (next === undefined) path = undefined;
      else if (typeof next === 'string' && next.startsWith(this.config.baseUrl))
        path = next.slice(this.config.baseUrl.length);
      else if (typeof next === 'string' && next.startsWith('/')) path = next;
      else return malformed();
    }
    return { kind: 'ANSWERED', value: out };
  }
}

/** One account's transactions, reduced. `undefined` when any line is unreadable: one bad line refuses the read. */
function reduceTransactions(
  lines: readonly Rec[],
  inWindow: (month: string) => boolean,
  inReturnedWindow: (month: string) => boolean,
): Omit<AccountFacts, 'balance'> | undefined {
  const net = new Map<string, bigint>();
  let inflow = 0n;
  let salaryCredits = 0;
  let returned = 0;
  for (const t of lines) {
    const status = lookupStatus(ENTRY_STATUS, t['Status']);
    const sign = lookupStatus(SIGN, t['CreditDebitIndicator']);
    const amount = aedAmountObject(t['Amount']);
    const month = monthOf(t['BookingDateTime']);
    if (status === undefined || sign === undefined || amount === undefined || month === undefined) return undefined;
    if (status === 'Rejected') {
      if (sign < 0n && inReturnedWindow(month)) returned += 1;
      continue;
    }
    if (status !== 'Booked') continue;
    net.set(month, (net.get(month) ?? 0n) + sign * amount.minorUnits);
    if (sign < 0n || !inWindow(month)) continue;
    const sub = t['SubTransactionType'];
    if (!(typeof sub === 'string' && Object.hasOwn(NOT_INFLOW, sub))) inflow += amount.minorUnits;
    const flags = t['Flags'];
    if (Array.isArray(flags) && flags.includes('Payroll')) salaryCredits += 1;
  }
  return { net, inflow, salaryCredits, returned };
}
