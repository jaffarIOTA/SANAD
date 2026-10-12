/**
 * Open Banking — account information (AIS) and payment initiation (PIS) adapter (CLAUDE.md §5).
 *
 * Implements the AccountInformationPort and PaymentInitiationPort. Vendor vocabulary stops
 * here: the port sees capability-named outcomes and references, never this rail's field names.
 *
 * AIS contract: PUBLISHED — the SAMA Open Banking Framework as implemented on
 * Al Rajhi Bank's developer portal (AIS 2022.11.01-final-errata2):
 * `GET /accounts`, `/accounts/{AccountId}/balances`,
 * `/accounts/{AccountId}/transactions`, each a `Data / Links / Meta` envelope;
 * `CreditDebitIndicator` KSAOB.Credit | KSAOB.Debit, transaction `Status`
 * KSAOB.Booked | KSAOB.Pending | KSAOB.Rejected, `Flags` such as KSAOB.Payroll
 * and KSAOB.Loan, `Amount{Amount, Currency}` with Amount a decimal string. The
 * affordability facts are derived here (`affordability.ts`); no line is kept.
 *
 * PIS contract: INFERRED, not retrieved — the PIS schemas were not available
 * publicly; the instruction shape below is this platform's assumption.
 *
 * Fixture transport for tests; live transport through the institution's
 * egress. Module status stays BLOCKED until the live transport has made a
 * verified sandbox call and README.md records what was learned.
 */

import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import { ok, reject } from '../../../core/kernel/result.ts';
import { money } from '../../../core/kernel/money.ts';
import type { KnownDeviation } from '../../kernel/adapter.ts';
import type { RailTransport } from '../../kernel/http-transport.ts';
import { type Body, RailAdapter, type RailAdapterConfig, epoch, malformed, obj, str } from '../kernel/rail-adapter.ts';
import type { AccountInformationPort } from '../../../core/ports/account-information.ts';
import type { PaymentInitiationPort } from '../../../core/ports/payment-initiation.ts';
import type { RailOutcome } from '../../../core/ports/rail.ts';
import type { Money } from '../../../core/kernel/money.ts';
import {
  type ObTransaction,
  affordability,
  monthStart,
  readAccountIds,
  readBookedBalance,
  readTransactions,
} from './affordability.ts';

export const OPENBANKINGADAPTER_DEVIATIONS: readonly KnownDeviation[] = [
  {
    id: 'OB-DEV-001',
    summary: 'Statement lines are available in full from the AIS.',
    containment:
      'The adapter reads accounts, balances and transactions, derives the four affordability facts in memory and maps only those; no transaction line is stored or returned.',
    verificationRef: 'KSA-RAIL-OB-01',
  },
  {
    id: 'OB-DEV-002',
    summary:
      'The SAMA framework binds the PSU through a per-consent access token; the port carries Sanad’s applicant and consent references.',
    containment:
      'The adapter sends both references as headers to the institution’s Open Banking connection (TPP gateway), which holds the bank consent and its token. How the gateway binds them is the verification item.',
    verificationRef: 'KSA-RAIL-OB-01',
  },
  {
    id: 'OB-DEV-003',
    summary: 'The PIS request and response shapes were not retrieved from a published source.',
    containment:
      'Inferred shape; an unknown status is UNAVAILABLE, never AUTHORISED or SETTLED. Stays BLOCKED until a sandbox call confirms it.',
    verificationRef: 'KSA-RAIL-OB-02',
  },
];

/** The AIS API version path of the framework release modelled. */
export const AIS_BASE = '/open-banking/account-information/2022.11.01-final-errata2';
const MAX_ACCOUNTS = 20;
const MAX_PAGES = 50;
const MAX_MONTHS = 24;

const iso = (epochSeconds: bigint): string => new Date(Number(epochSeconds) * 1000).toISOString();

export class OpenBankingAdapter extends RailAdapter implements AccountInformationPort, PaymentInitiationPort {
  readonly vendorName = 'Open Banking TPP';
  readonly capabilities = ['ACCOUNT_INFORMATION', 'PAYMENT_INITIATION'] as const;
  readonly deviations = OPENBANKINGADAPTER_DEVIATIONS;

  constructor(config: RailAdapterConfig, credentials: CredentialProvider, transport: RailTransport) {
    super(config, credentials, transport);
  }

  /** One AIS GET under the applicant's consent. */
  async #get(operation: string, path: string, p: { applicantRef: string; consentId: string; correlationId: string }) {
    const r = await this.invoke(
      operation,
      {
        method: 'GET',
        path,
        headers: {
          'x-fapi-interaction-id': p.correlationId,
          'x-sanad-applicant-ref': p.applicantRef,
          'x-sanad-consent-ref': p.consentId,
        },
      },
      p.correlationId,
    );
    if (r.kind === 'REFUSED' && r.code === 'HTTP_404') return { kind: 'REFUSED' as const, code: 'NOT_FOUND' };
    return r;
  }

  /** Every page of one account's transactions, following `Links.Next` only within this rail's base URL. */
  async #transactions(
    accountId: string,
    from: bigint,
    to: bigint,
    p: { applicantRef: string; consentId: string; correlationId: string },
  ): Promise<RailOutcome<ObTransaction[]>> {
    let path: string | undefined =
      `${AIS_BASE}/accounts/${encodeURIComponent(accountId)}/transactions` +
      `?fromBookingDateTime=${encodeURIComponent(iso(from))}&toBookingDateTime=${encodeURIComponent(iso(to))}`;
    const out: ObTransaction[] = [];
    for (let page = 0; path !== undefined; page += 1) {
      if (page >= MAX_PAGES) return malformed();
      const r: RailOutcome<Body> = await this.#get('ais.transactions', path, p);
      if (r.kind !== 'ANSWERED') return r;
      const lines = readTransactions(r.value);
      if (lines === undefined) return malformed();
      out.push(...lines);
      const next = str(obj(r.value['Links'])?.['Next']);
      if (next === undefined) path = undefined;
      // A next link elsewhere is not followed: the adapter calls only the rail it is configured for.
      else if (next.startsWith(`${this.config.baseUrl}/`)) path = next.slice(this.config.baseUrl.length);
      else return malformed();
    }
    return { kind: 'ANSWERED', value: out };
  }

  async affordabilityFacts(p: {
    readonly tenantId: string;
    readonly applicantRef: string;
    readonly consentId: string;
    readonly months: number;
    readonly correlationId: string;
  }) {
    const consent = await this.requireConsent(p.tenantId, p.consentId, 'ACCOUNT_INFORMATION');
    if (!consent.ok) return consent;
    if (!Number.isInteger(p.months) || p.months < 1 || p.months > MAX_MONTHS)
      return reject('OP-DETERMINACY', 'MONTHS_OUT_OF_RANGE', 'Affordability is read over one to twenty-four months');
    const now = BigInt(this.config.nowEpochSeconds());
    const accountsAnswer = await this.#get('ais.accounts', `${AIS_BASE}/accounts`, p);
    if (accountsAnswer.kind !== 'ANSWERED') return ok(accountsAnswer);
    const ids = readAccountIds(accountsAnswer.value);
    if (ids === undefined || ids.length > MAX_ACCOUNTS) return ok(malformed());
    if (ids.length === 0) return ok({ kind: 'REFUSED' as const, code: 'NO_SAR_ACCOUNT' });

    const from = monthStart(now, Math.max(p.months, 6));
    const accounts: { bookedBalanceMinor: bigint; transactions: ObTransaction[] }[] = [];
    for (const id of ids) {
      const balances = await this.#get('ais.balances', `${AIS_BASE}/accounts/${encodeURIComponent(id)}/balances`, p);
      if (balances.kind !== 'ANSWERED') return ok(balances);
      const bookedBalanceMinor = readBookedBalance(balances.value);
      if (bookedBalanceMinor === undefined) return ok(malformed());
      const transactions = await this.#transactions(id, from, now, p);
      if (transactions.kind !== 'ANSWERED') return ok(transactions);
      accounts.push({ bookedBalanceMinor, transactions: transactions.value });
    }
    const facts = affordability(accounts, p.months, now);
    return ok({
      kind: 'ANSWERED' as const,
      value: {
        averageMonthlyInflow: money(facts.averageMonthlyInflowMinor),
        lowestMonthEndBalance: money(facts.lowestMonthEndBalanceMinor),
        returnedPaymentsLast6Months: facts.returnedPaymentsLast6Months,
        salaryCreditsObserved: facts.salaryCreditsObserved,
        retrievedAtEpochSeconds: now,
        referenceId: `ob-ais:${p.consentId}:${now.toString()}`,
      },
    });
  }

  async initiate(p: {
    readonly tenantId: string;
    readonly applicantRef: string;
    readonly consentId: string;
    readonly amount: Money;
    readonly direction: 'COLLECT' | 'DISBURSE';
    readonly reference: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }) {
    const consent = await this.requireConsent(p.tenantId, p.consentId, 'PAYMENT_INITIATION');
    if (!consent.ok) return consent;
    // Inferred shape (OB-DEV-003): not retrieved from a published source.
    const r = await this.invoke(
      'pis.initiate',
      {
        method: 'POST',
        path: '/v1/pis/payments',
        body: {
          applicantRef: p.applicantRef,
          consentRef: p.consentId,
          amount: p.amount.minorUnits.toString(),
          currency: p.amount.currency,
          direction: p.direction,
          reference: p.reference,
          idempotencyKey: p.idempotencyKey,
        },
      },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const ref = str(r.value['paymentId']);
    const at = epoch(r.value['initiatedAt']);
    const status = (['INITIATED', 'AUTHORISED', 'REJECTED'] as const).find((k) => k === r.value['status']);
    if (ref === undefined || at === undefined || status === undefined) return ok(malformed());
    return ok({ kind: 'ANSWERED' as const, value: { instructionRef: ref, status, initiatedAtEpochSeconds: at } });
  }

  async status(p: { readonly tenantId: string; readonly instructionRef: string; readonly correlationId: string }) {
    const r = await this.invoke(
      'pis.status',
      { method: 'GET', path: `/v1/pis/payments/${encodeURIComponent(p.instructionRef)}` },
      p.correlationId,
    );
    if (r.kind !== 'ANSWERED') return ok(r);
    const status = str(r.value['status']);
    const known = ['INITIATED', 'AUTHORISED', 'SETTLED', 'REJECTED', 'RETURNED'] as const;
    const s = known.find((k) => k === status);
    return ok(s === undefined ? malformed() : { kind: 'ANSWERED' as const, value: { status: s } });
  }
}
