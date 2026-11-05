/**
 * Tuum's lending module, for rate-priced products only (UAE M6; BNPL booking and servicing).
 *
 * The product owner's decision of 2026-10-08 (README "Lending module",
 * product-catalogue.ts) keeps the lending module open for rate-priced products
 * — conventional SME and consumer term loans, Tawarruq personal, BNPL — and
 * closed to Murabaha, which stays account-shaped in core-banking-adapter.ts.
 * This file is the only place under adapters/tuum allowed to call it
 * (test/architecture/absences.test.ts), and the services call it only for
 * a rate-priced product.
 *
 * The booking: create the customer (a legal person for a business, a natural
 * person for a consumer), open the loan's servicing account where asked, then
 * the loan contract on Sanad's terms — principal, Sanad's rate, Sanad's APR, the
 * number of payments, the first payment date, a monthly payment day or a fixed
 * interval — and read back the contract number as the loan account number.
 *
 * The servicing (consumer products): read where each instalment stands from
 * the contract's receivables, and post a repayment Sanad collected into the
 * servicing account for Tuum to allocate. Tuum is the system of record for the
 * schedule; Sanad reads it and never keeps its own.
 *
 * Tuum's vocabulary stops here: nothing it returns crosses the ports but
 * references, money and the standing of each instalment.
 *
 * - Amounts and rates are JSON numbers in Tuum's API. They are written as exact
 *   decimal tokens (JSON.rawJSON) from integer minor units and basis points: no
 *   floating-point value is ever made. Amounts read back are converted from
 *   their decimal text, never through arithmetic on a number.
 * - Sanad's rate is sent, never taken: a contract that echoes a different
 *   interest rate is REFUSED (RATE_MISMATCH) and nothing is recorded.
 * - A consumer's national identifier never passes through Sanad: the request
 *   carries a pointer, resolved here immediately before the call and never
 *   returned, logged or traced (TUUM-DEV-002).
 * - Each call carries the booking's idempotency key in x-request-id, suffixed
 *   per step, so a retried booking is the same booking. Tuum accepts only a
 *   UUID there (err.invalidUuidFormat, sandbox 2026-11-03), so the key is sent
 *   as its name-based UUID: the same key always gives the same id.
 */
import { createHash } from 'node:crypto';

import { type Money, money } from '../../core/kernel/money.ts';
import type { CurrencyCode } from '../../core/kernel/money.ts';
import type { LoanBooking, LoanBookingPort, LoanBookingRequest } from '../../core/ports/loan-booking.ts';
import type {
  InstalmentPosition,
  InstalmentStanding,
  LoanPosition,
  LoanServicingPort,
} from '../../core/ports/loan-servicing.ts';
import type { RailOutcome } from '../../core/ports/rail.ts';
import { type Result, ok, reject } from '../../core/kernel/result.ts';
import { type RailTransport, TransportError } from '../kernel/http-transport.ts';

import { type Envelope, type TuumSession, errorCodes } from './authentication.ts';

/** Sanad's namespace for request ids sent to Tuum (a fixed, random UUID). */
const REQUEST_ID_NAMESPACE = Buffer.from('6f1c2a8e4b7d4e0f9a3c5d2e8b1f7a64', 'hex');

/**
 * An idempotency key as a name-based UUID: SHA-256 in the version-8 layout (RFC 9562 §5.8, Appendix B.2),
 * deterministic, so a retry repeats the id. Tuum accepted a version-8 id on 2026-11-03.
 */
export function requestIdOf(key: string): string {
  const h = createHash('sha256').update(REQUEST_ID_NAMESPACE).update(key, 'utf8').digest().subarray(0, 16);
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x80;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export interface TuumLendingHosts {
  readonly person: string;
  readonly loan: string;
  /** The account API: servicing accounts and repayment postings. Required for the consumer products. */
  readonly account?: string;
}

/** How a consumer loan's servicing account is opened: the institution's product set-up (TUUM-SERV-01). */
export interface TuumServicingAccountSetup {
  readonly accountTypeCode: string;
  readonly customerGroupCode: string;
  readonly priceListTypeCode: string;
  /** The transaction type a collected repayment is posted under. */
  readonly repaymentTransactionTypeCode: string;
}

/**
 * Resolves a consumer's restricted attributes (national identifier and name) from the institution's
 * identity store, inside the trust boundary. Returns undefined when the pointer does not resolve.
 */
export interface RestrictedAttributes {
  readonly idNumber: string;
  /** The loan system's identification type, where the institution's set-up names one. */
  readonly idTypeCode?: string;
  /** The country that issued the identifier, ISO 3166-1 alpha-2. */
  readonly idCountryCode?: string;
  readonly givenName: string;
  readonly surname: string;
  /** Further party-master fields the institution's loan system requires, where it does (2026-11-03 run). */
  readonly birthDate?: string;
  readonly sex?: 'M' | 'F';
  readonly nationality?: string;
  readonly residencyCountryCode?: string;
  readonly address?: {
    readonly street1: string;
    readonly cityCounty: string;
    readonly zip: string;
    readonly countryCode: string;
  };
}
export type RestrictedAttributesResolver = (ref: string) => Promise<RestrictedAttributes | undefined>;

/** How long the adapter waits for the loan system's own workflow between steps of an offer. */
export interface TuumOfferPacing {
  /** Waits this many milliseconds. */
  readonly pause: (ms: number) => Promise<void>;
  readonly intervalMs: number;
  /** Reads of the offer's or the contract's state before the step is reported unavailable. */
  readonly attempts: number;
}
const DEFAULT_PACING: TuumOfferPacing = {
  pause: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
  intervalMs: 1_500,
  attempts: 40,
};

/** How often a payment instruction refused while the new offer is still being prepared is given again. */
const INSTRUCTION_RETRIES = 10;

/** An offer's states that end it without a loan. */
const OFFER_ENDED: ReadonlySet<string> = new Set(['REJECTED', 'DECLINED', 'CANCELLED', 'EXPIRED', 'WITHDRAWN']);

export const TUUM_LENDING_DEVIATIONS = [
  {
    id: 'TUUM-LEND-001',
    summary: 'A servicing account is required in practice by the sandbox (README, 2026-10-08 run).',
    containment:
      'Opened for the consumer products from the institution’s account set-up (TUUM-SERV-01); the SME products wait on TUUM-LEND-01.',
  },
  {
    id: 'TUUM-LEND-002',
    summary: 'Whether a supplied interestRate overrides the product price list is untested.',
    containment: 'Sanad sends its rate; a contract echoing another rate is refused, never accepted.',
  },
  {
    id: 'TUUM-SERV-001',
    summary:
      'The receivables read, the fixed-interval frequency field and the automatic repayment from a customer account are taken from the public documentation and are unverified in the sandbox.',
    containment:
      'Fixture only until TUUM-SERV-01 is answered; a position whose figures do not parse is UNAVAILABLE, never guessed.',
  },
  {
    id: 'TUUM-LEND-003',
    summary:
      'A consumer loan is booked as an offer that the loan system’s own workflow moves on between steps (README, KBNPL run 2026-11-03); a booking interrupted part-way leaves the offer it created, and a retry creates another.',
    containment:
      'Each step waits for the workflow’s state and stops as UNAVAILABLE when it does not arrive; the offer’s schedule is checked against the plan disclosed before anything is accepted; an unaccepted offer lapses after the product’s validity days.',
  },
] as const;

/** Minor units → an exact decimal token, two places. */
function decimalToken(minor: bigint): unknown {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const text = `${negative ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
  return (JSON as unknown as { rawJSON(t: string): unknown }).rawJSON(text);
}

/** A decimal amount as Tuum returns it ("300", "300.5", 300.5) → minor units, by its text; undefined if it is not one. */
function minorOf(v: unknown): bigint | undefined {
  const text = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (m === null) return undefined;
  return BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
}

/** Basis points → a percent decimal string ("150" → "1.50"). */
const percentText = (bp: bigint): string => `${(bp / 100n).toString()}.${(bp % 100n).toString().padStart(2, '0')}`;
const percentToken = (bp: bigint): unknown =>
  (JSON as unknown as { rawJSON(t: string): unknown }).rawJSON(percentText(bp));

/** "1.50" and 1.5 are the same percentage: compared as text, trailing zeros removed. No arithmetic on a number. */
const samePercent = (expected: string, echoed: unknown): boolean => {
  if (typeof echoed !== 'number' && typeof echoed !== 'string') return false;
  const norm = (s: string) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return norm(expected) === norm(String(echoed));
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STANDINGS: ReadonlySet<string> = new Set<InstalmentStanding>(['NOT_DUE', 'DUE', 'PAID', 'OVERDUE']);

/** Why the booking terms cannot be sent, or undefined when they can. */
function invalidBooking(r: LoanBookingRequest): string | undefined {
  const monthly = r.paymentDay !== undefined;
  const interval = r.intervalDays !== undefined;
  const whole = (n: number | undefined, max: number) => n !== undefined && Number.isInteger(n) && n >= 1 && n <= max;
  if (r.principal.minorUnits <= 0n || r.rateBp < 0n || r.numberOfPayments < 1 || monthly === interval)
    return 'The booking terms are incomplete';
  if (monthly && (!whole(r.paymentDay, 31) || (r.intervalMonths !== undefined && !whole(r.intervalMonths, 12))))
    return 'The booking terms are incomplete';
  if (interval && (!whole(r.intervalDays, 366) || r.intervalMonths !== undefined))
    return 'The booking terms are incomplete';
  if (!DATE.test(r.firstPaymentDate)) return 'The first payment date is yyyy-mm-dd';
  if (r.borrower.kind === 'PERSON' && !/^[A-Z]{2}$/.test(r.countryCode ?? ''))
    return 'A consumer loan carries the institution’s country';
  return undefined;
}

/** A civil date moved by whole months (on the same day, or the month's last when shorter) and days. */
function shiftDate(iso: string, months: number, days: number): string {
  const [y = 2000, m = 1, d = 1] = iso.split('-').map(Number);
  const month = m - 1 + months;
  const lastDay = new Date(Date.UTC(y, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, month, Math.min(d, lastDay)) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The day the customer drew the financing: one interval before the first payment, as the plan was disclosed. */
const usageDateOf = (r: LoanBookingRequest): string =>
  r.paymentDay === undefined
    ? shiftDate(r.firstPaymentDate, 0, -(r.intervalDays ?? 0))
    : shiftDate(r.firstPaymentDate, -(r.intervalMonths ?? 1), 0);

/** An offer's schedule as Tuum returns it: every component line, summed per payment date. */
function scheduleOf(data: unknown): Map<string, bigint> | undefined {
  if (!Array.isArray(data)) return undefined;
  const byDate = new Map<string, bigint>();
  for (const line of data) {
    if (!isRecord(line)) return undefined;
    const date = str(line['paymentDate']);
    const money = line['paymentMoney'];
    const amount = isRecord(money) ? minorOf(money['amount']) : undefined;
    if (date === undefined || !DATE.test(date) || amount === undefined) return undefined;
    if (line['downpayment'] === true) continue;
    byDate.set(date, (byDate.get(date) ?? 0n) + amount);
  }
  return byDate;
}

/** The loan system's schedule is the plan disclosed: the same dates, the same amount on each. */
function sameSchedule(
  lines: ReadonlyMap<string, bigint>,
  expected: readonly { readonly dueDate: string; readonly amount: Money }[],
): boolean {
  return lines.size === expected.length && expected.every((e) => lines.get(e.dueDate) === e.amount.minorUnits);
}

export class TuumLendingAdapter implements LoanBookingPort, LoanServicingPort {
  readonly deviations = TUUM_LENDING_DEVIATIONS;

  constructor(
    private readonly hosts: TuumLendingHosts,
    private readonly session: TuumSession,
    private readonly transport: RailTransport,
    /** Tuum's tenant code (required on the contract body). */
    private readonly tenantCode: string,
    readonly source: 'LIVE' | 'FIXTURE',
    private readonly consumer?: {
      readonly accountSetup: TuumServicingAccountSetup;
      readonly restricted: RestrictedAttributesResolver;
    },
    private readonly pacing: TuumOfferPacing = DEFAULT_PACING,
  ) {}

  async bookLoan(r: LoanBookingRequest): Promise<Result<RailOutcome<LoanBooking>>> {
    const invalid = invalidBooking(r);
    if (invalid !== undefined) return reject('OP-DETERMINACY', 'LOAN_BOOKING_INVALID', invalid);
    const monthly = r.paymentDay !== undefined;

    const person = await this.#person(r);
    if (!person.ok) return person;
    if (person.value.kind !== 'ANSWERED') return ok(person.value);
    const { personId, personName } = person.value.value;

    let servicingAccountId: string | undefined;
    if (r.ownAccountRef !== undefined) servicingAccountId = r.ownAccountRef;
    else if (r.openServicingAccount === true) {
      if (this.consumer === undefined || this.hosts.account === undefined)
        return ok({ kind: 'UNAVAILABLE', reason: 'SERVICING_ACCOUNT_SETUP_MISSING' });
      const setup = this.consumer.accountSetup;
      const account = await this.#call(
        'account.create',
        'POST',
        `${this.hosts.account}/api/v4/persons/${encodeURIComponent(personId)}/accounts`,
        `${r.idempotencyKey}:account`,
        {
          accountTypeCode: setup.accountTypeCode,
          customerGroupCode: setup.customerGroupCode,
          priceListTypeCode: setup.priceListTypeCode,
          currencyCode: r.principal.currency,
          ...(r.borrower.kind === 'PERSON' ? { personTypeCode: 'P' } : {}),
          ...(r.countryCode === undefined ? {} : { residencyCountryCode: r.countryCode }),
          personName,
          accountName: `Loan ${r.applicationId}`,
        },
      );
      if (account.kind !== 'ANSWERED') return ok(account);
      const data = account.value.data;
      servicingAccountId = isRecord(data)
        ? str(data['accountId'])
        : str((account.value as Record<string, unknown>)['accountId']);
      if (servicingAccountId === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_ACCOUNT' });
    }

    // A consumer's loan goes through the loan system's offer workflow, the path the sandbox books (README,
    // KBNPL run 2026-11-03); a business's keeps the direct contract call.
    if (r.borrower.kind === 'PERSON') {
      if (servicingAccountId === undefined)
        return ok({ kind: 'UNAVAILABLE', reason: 'SERVICING_ACCOUNT_SETUP_MISSING' });
      return ok(await this.#bookByOffer(r, personId, servicingAccountId));
    }

    const contract = await this.#call(
      'loan.contract.create',
      'POST',
      `${this.hosts.loan}/api/v1/persons/${encodeURIComponent(personId)}/contracts`,
      `${r.idempotencyKey}:contract`,
      {
        tenantCode: this.tenantCode,
        loanTypeCode: r.productCode,
        contractMoney: { amount: decimalToken(r.principal.minorUnits), currencyCode: r.principal.currency },
        interestRate: percentToken(r.rateBp),
        apr: percentToken(r.aprBp),
        numberOfPayments: r.numberOfPayments,
        ...(monthly ? { paymentDay: r.paymentDay } : { paymentFrequency: { value: r.intervalDays, unitCode: 'DAY' } }),
        firstPaymentDate: r.firstPaymentDate,
        ...(servicingAccountId === undefined ? {} : { servicingAccountId }),
        // The customer's own account is debited by the loan system on each due date (the OWN_ACCOUNT channel).
        ...(r.ownAccountRef === undefined ? {} : { automaticRepayment: true }),
        customFields: { sanadApplicationId: r.applicationId },
      },
    );
    if (contract.kind !== 'ANSWERED') return ok(contract);
    const data = contract.value.data;
    if (!isRecord(data)) return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_CONTRACT' });
    const contractNumber = str(data['contractNumber']);
    const headerId = str(data['headerId']);
    if (contractNumber === undefined || headerId === undefined)
      return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_CONTRACT' });
    if (
      data['interestRate'] !== undefined &&
      data['interestRate'] !== null &&
      !samePercent(percentText(r.rateBp), data['interestRate'])
    )
      return ok({ kind: 'REFUSED', code: 'RATE_MISMATCH', referenceId: headerId });
    return ok({
      kind: 'ANSWERED',
      value: {
        loanAccountNumber: contractNumber,
        contractRef: headerId,
        customerRef: personId,
        ...(servicingAccountId === undefined ? {} : { servicingAccountRef: servicingAccountId }),
      },
    });
  }

  async position(p: {
    readonly tenantId: string;
    readonly contractRef: string;
    readonly asOf: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<LoanPosition>>> {
    if (!DATE.test(p.asOf)) return reject('OP-DETERMINACY', 'LOAN_POSITION_INVALID', 'asOf is yyyy-mm-dd');
    const answered = await this.#call(
      'loan.receivables.list',
      'GET',
      `${this.hosts.loan}/api/v1/contracts/${encodeURIComponent(p.contractRef)}/receivables?asOf=${p.asOf}`,
      `position:${p.contractRef}:${p.asOf}`,
    );
    if (answered.kind !== 'ANSWERED') return ok(answered);
    const data = answered.value.data;
    const rows = isRecord(data) && Array.isArray(data['receivables']) ? data['receivables'] : undefined;
    const currency = isRecord(data) ? str(data['currencyCode']) : undefined;
    if (rows === undefined || currency === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_POSITION' });
    const instalments: InstalmentPosition[] = [];
    for (const row of rows) {
      if (!isRecord(row)) return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_POSITION' });
      const number = row['sequenceNumber'];
      const due = str(row['dueDate']);
      const amount = minorOf(row['amount']);
      const paid = minorOf(row['paidAmount']);
      const standing = str(row['statusCode']);
      const dpd = row['daysPastDue'];
      if (
        typeof number !== 'number' ||
        !Number.isInteger(number) ||
        due === undefined ||
        !DATE.test(due) ||
        amount === undefined ||
        paid === undefined ||
        paid > amount ||
        standing === undefined ||
        !STANDINGS.has(standing) ||
        typeof dpd !== 'number' ||
        !Number.isInteger(dpd) ||
        dpd < 0
      )
        return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_POSITION' });
      const c = currency as CurrencyCode;
      instalments.push({
        number,
        dueDate: due,
        amount: money(amount, c),
        paid: money(paid, c),
        outstanding: money(amount - paid, c),
        standing: standing as InstalmentStanding,
        daysPastDue: dpd,
      });
    }
    const outstanding = instalments.reduce((s, i) => s + i.outstanding.minorUnits, 0n);
    return ok({
      kind: 'ANSWERED',
      value: {
        contractRef: p.contractRef,
        asOf: p.asOf,
        instalments,
        outstanding: money(outstanding, currency as CurrencyCode),
        closed: instalments.length > 0 && outstanding === 0n,
      },
    });
  }

  async postRepayment(p: {
    readonly tenantId: string;
    readonly contractRef: string;
    readonly servicingAccountRef: string;
    readonly amount: Money;
    readonly settlementRef: string;
    readonly valueDate: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<{ readonly transactionRef: string }>>> {
    if (p.amount.minorUnits <= 0n || !DATE.test(p.valueDate))
      return reject(
        'OP-DETERMINACY',
        'REPAYMENT_INVALID',
        'A repayment is a positive amount on a yyyy-mm-dd value date',
      );
    if (this.consumer === undefined || this.hosts.account === undefined)
      return ok({ kind: 'UNAVAILABLE', reason: 'SERVICING_ACCOUNT_SETUP_MISSING' });
    const posted = await this.#call(
      'account.postTransaction',
      'POST',
      `${this.hosts.account}/api/v5/accounts/${encodeURIComponent(p.servicingAccountRef)}/transactions`,
      p.idempotencyKey,
      {
        transactionTypeCode: this.consumer.accountSetup.repaymentTransactionTypeCode,
        money: { amount: decimalToken(p.amount.minorUnits), currencyCode: p.amount.currency },
        valueDate: p.valueDate,
        externalReference: p.settlementRef,
        details: { contractRef: p.contractRef },
      },
    );
    if (posted.kind !== 'ANSWERED') return ok(posted);
    const data = posted.value.data;
    const transactionRef =
      (isRecord(data) ? str(data['transactionId']) : undefined) ??
      str((posted.value as Record<string, unknown>)['transactionId']);
    if (transactionRef === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_TRANSACTION' });
    return ok({ kind: 'ANSWERED', value: { transactionRef } });
  }

  /** The borrower in Tuum's party master: a legal person for a business, a natural person for a consumer. */
  /**
   * The party in Tuum, and the name its account must carry (the account API refuses a blank personName,
   * sandbox 2026-11-03). The name stays inside the adapter: it goes to Tuum and nowhere else.
   */
  async #person(r: LoanBookingRequest): Promise<Result<RailOutcome<{ personId: string; personName: string }>>> {
    let body: Record<string, unknown>;
    let personName: string;
    if (r.borrower.kind === 'PERSON') {
      if (this.consumer === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'RESTRICTED_ATTRIBUTES_UNAVAILABLE' });
      // Resolved here, used once, never kept, returned, logged or traced (TUUM-DEV-002).
      const attributes = await this.consumer.restricted(r.borrower.restrictedAttributesRef);
      if (attributes === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'RESTRICTED_ATTRIBUTES_UNAVAILABLE' });
      const a = attributes;
      personName = `${a.givenName} ${a.surname}`;
      body = {
        personTypeCode: 'P',
        givenName: a.givenName,
        surname: a.surname,
        identificationNumbers: [
          {
            idNumber: a.idNumber,
            ...(a.idTypeCode === undefined ? {} : { idTypeCode: a.idTypeCode }),
            ...(a.idCountryCode === undefined ? {} : { idCountryCode: a.idCountryCode }),
            primary: true,
          },
        ],
        ...(a.residencyCountryCode === undefined ? {} : { residencyCountryCode: a.residencyCountryCode }),
        ...(a.nationality === undefined ? {} : { nationality: a.nationality }),
        ...(a.birthDate === undefined ? {} : { birthDate: a.birthDate }),
        ...(a.sex === undefined ? {} : { sex: a.sex }),
        ...(a.address === undefined ? {} : { addresses: [{ addressTypeCode: 'R', ...a.address }] }),
        externalReference: r.borrower.partyRef,
      };
    } else {
      personName = r.borrower.legalNameEn;
      body = {
        personTypeCode: 'L',
        name: r.borrower.legalNameEn,
        identificationNumbers: [{ idNumber: r.borrower.registrationRef, idTypeCode: 'REG' }],
      };
    }
    const person = await this.#call(
      'person.create',
      'POST',
      `${this.hosts.person}/api/v2/persons`,
      `${r.idempotencyKey}:person`,
      body,
    );
    if (person.kind !== 'ANSWERED') return ok(person);
    const personId = isRecord(person.value.data) ? str(person.value.data['personId']) : undefined;
    if (personId === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_PERSON' });
    return ok({ kind: 'ANSWERED', value: { personId, personName } });
  }

  /**
   * The offer workflow, as the sandbox books it: the offer on Sanad's terms; its schedule checked against the
   * plan disclosed; the payment instruction; review, approval and acceptance, each when the workflow has
   * reached the state that permits it; then the contract the workflow creates, confirmed.
   */
  async #bookByOffer(
    r: LoanBookingRequest,
    personId: string,
    servicingAccountId: string,
  ): Promise<RailOutcome<LoanBooking>> {
    const key = r.idempotencyKey;
    const monthly = r.paymentDay !== undefined;
    const months = r.intervalMonths ?? 1;
    const amount = { amount: decimalToken(r.principal.minorUnits), currencyCode: r.principal.currency };
    const created = await this.#call(
      'loan.offer.create',
      'POST',
      `${this.hosts.loan}/api/v3/persons/${encodeURIComponent(personId)}/offers`,
      `${key}:offer`,
      {
        tenantCode: this.tenantCode,
        countryCode: r.countryCode,
        loanTypeCode: r.productCode,
        servicingAccountId,
        requestedMoney: amount,
        offeredMoney: amount,
        // One or the other, never both (err.loanPeriodAndNumberOfPaymentsNotAllowedTogether): a monthly plan
        // as its term in months (the product's PERIOD_IN_MONTHS rule, verified 2026-11-03); a plan in days as
        // its number of payments, which whole months cannot express.
        ...(monthly ? { loanPeriod: r.numberOfPayments * months } : { numberOfPayments: r.numberOfPayments }),
        ...(monthly
          ? { paymentDay: r.paymentDay, paymentFrequency: months, paymentFrequencyUnit: 'MONTH' }
          : { paymentFrequency: r.intervalDays, paymentFrequencyUnit: 'DAY' }),
        // The day the customer drew the financing: one interval before the first payment, as disclosed.
        limitUsageDate: usageDateOf(r),
        ...(r.rateBp > 0n ? { interestRate: percentToken(r.rateBp) } : {}),
      },
    );
    if (created.kind !== 'ANSWERED') return created;
    const offer = created.value.data;
    const offerId = isRecord(offer) ? str(offer['offerId']) : undefined;
    if (!isRecord(offer) || offerId === undefined) return { kind: 'UNAVAILABLE', reason: 'MALFORMED_OFFER' };
    const echoed = offer['interestRate'];
    if (echoed === undefined || echoed === null ? r.rateBp !== 0n : !samePercent(percentText(r.rateBp), echoed))
      return { kind: 'REFUSED', code: 'RATE_MISMATCH', referenceId: offerId };
    const offers = `${this.hosts.loan}/api/v2/offers/${encodeURIComponent(offerId)}`;

    if (r.expectedInstalments !== undefined) {
      const schedule = await this.#call(
        'loan.offer.schedule',
        'GET',
        `${this.hosts.loan}/api/v1/offers/${encodeURIComponent(offerId)}/schedule`,
        `${key}:offer:schedule`,
      );
      if (schedule.kind !== 'ANSWERED') return schedule;
      const lines = scheduleOf(schedule.value.data);
      if (lines === undefined) return { kind: 'UNAVAILABLE', reason: 'MALFORMED_SCHEDULE' };
      if (!sameSchedule(lines, r.expectedInstalments))
        return { kind: 'REFUSED', code: 'SCHEDULE_MISMATCH', referenceId: offerId };
    }

    const give = () =>
      this.#call('loan.offer.paymentInstruction', 'POST', `${offers}/payment-instructions`, `${key}:offer:pi`, {
        accountId: servicingAccountId,
        money: amount,
        paymentChannelCode: 'ACCOUNT-API',
        beneficiaryName: `Loan ${r.applicationId}`,
        details: `Sanad ${r.applicationId}`,
      });
    // Tuum refuses the instruction while it is still preparing a new offer (HTTP 400,
    // err.offerNotSuitableForValidation, sandbox 2026-11-03) and takes the same one moments later: the same
    // instruction, under the same request id, is given again after a pause, a bounded number of times.
    let instruction = await give();
    for (
      let i = 0;
      i < INSTRUCTION_RETRIES && instruction.kind === 'UNAVAILABLE' && instruction.reason === 'HTTP_400';
      i++
    ) {
      await this.pacing.pause(this.pacing.intervalMs);
      instruction = await give();
    }
    if (instruction.kind !== 'ANSWERED') return instruction;

    const moved = await this.#walkOffer(offerId, key);
    if (moved.kind !== 'ANSWERED') return moved;

    const contract = await this.#awaitContract(offerId, key);
    if (contract.kind !== 'ANSWERED') return contract;
    const { headerId, contractNumber, versionId, state: drafted } = contract.value;
    const version = `${this.hosts.loan}/api/v1/versions/${encodeURIComponent(versionId)}`;
    // A draft is confirmed here; one the workflow has already moved on is left as it is.
    if (drafted === 'DRAFT') {
      const confirmed = await this.#call(
        'loan.version.confirm',
        'POST',
        `${this.hosts.loan}/api/v1/contracts/${encodeURIComponent(headerId)}/versions/${encodeURIComponent(versionId)}/confirm`,
        `${key}:confirm`,
      );
      if (confirmed.kind !== 'ANSWERED') return confirmed;
    }
    const status = await this.#call('loan.version.read', 'GET', version, `${key}:version`);
    const state =
      status.kind === 'ANSWERED' && isRecord(status.value.data) ? str(status.value.data['statusCode']) : undefined;
    return {
      kind: 'ANSWERED',
      value: {
        loanAccountNumber: contractNumber,
        contractRef: headerId,
        customerRef: personId,
        servicingAccountRef: servicingAccountId,
        awaitingActivation: state !== 'ACTIVE',
      },
    };
  }

  /** Moves the offer through review, approval and acceptance, each when the workflow permits it. */
  async #walkOffer(offerId: string, key: string): Promise<RailOutcome<true>> {
    const v1 = `${this.hosts.loan}/api/v1/offers/${encodeURIComponent(offerId)}`;
    const v2 = `${this.hosts.loan}/api/v2/offers/${encodeURIComponent(offerId)}`;
    const steps: Readonly<
      Record<string, { readonly operation: string; readonly url: string; readonly suffix: string }>
    > = {
      WAITING_FOR_REVIEW: { operation: 'loan.offer.review', url: `${v1}/review`, suffix: 'review' },
      IN_REVIEW: { operation: 'loan.offer.approve', url: `${v2}/approve`, suffix: 'approve' },
      PRESENTED: { operation: 'loan.offer.accept', url: `${v2}/accept`, suffix: 'accept' },
    };
    const taken = new Set<string>();
    // The budget is the waits between reads; a read that leads straight to a step does not spend it.
    let waits = 0;
    while (waits < this.pacing.attempts) {
      const read = await this.#call('loan.offer.read', 'GET', v2, `${key}:offer:read`);
      if (read.kind !== 'ANSWERED') return read;
      const status = isRecord(read.value.data) ? str(read.value.data['statusCode']) : undefined;
      if (status === undefined) return { kind: 'UNAVAILABLE', reason: 'MALFORMED_OFFER' };
      if (status === 'ACCEPTED') return { kind: 'ANSWERED', value: true };
      if (OFFER_ENDED.has(status)) return { kind: 'REFUSED', code: `OFFER_${status}`, referenceId: offerId };
      const step = steps[status];
      if (step !== undefined && !taken.has(status)) {
        taken.add(status);
        const done = await this.#call(step.operation, 'POST', step.url, `${key}:offer:${step.suffix}`);
        if (done.kind !== 'ANSWERED') return done;
        continue;
      }
      await this.pacing.pause(this.pacing.intervalMs);
      waits += 1;
    }
    return { kind: 'UNAVAILABLE', reason: 'LOAN_SYSTEM_WORKFLOW_PENDING' };
  }

  /** The contract the workflow creates from the accepted offer, once it exists. */
  async #awaitContract(
    offerId: string,
    key: string,
  ): Promise<
    RailOutcome<{
      readonly headerId: string;
      readonly contractNumber: string;
      readonly versionId: string;
      readonly state: string;
    }>
  > {
    const url = `${this.hosts.loan}/api/v2/offers/${encodeURIComponent(offerId)}/contracts`;
    for (let attempt = 0; attempt < this.pacing.attempts; attempt += 1) {
      const read = await this.#call('loan.offer.contracts', 'GET', url, `${key}:offer:contracts`);
      if (read.kind === 'UNAVAILABLE') return read;
      const raw = read.kind === 'ANSWERED' ? read.value.data : undefined;
      const data = Array.isArray(raw) ? raw[0] : raw;
      if (isRecord(data)) {
        const headerId = str(data['headerId']);
        const contractNumber = str(data['contractNumber']);
        const versionId = str(data['firstVersionId']);
        if (headerId !== undefined && contractNumber !== undefined && versionId !== undefined) {
          const version = await this.#call(
            'loan.version.read',
            'GET',
            `${this.hosts.loan}/api/v1/versions/${encodeURIComponent(versionId)}`,
            `${key}:version`,
          );
          const state =
            version.kind === 'ANSWERED' && isRecord(version.value.data)
              ? str(version.value.data['statusCode'])
              : undefined;
          if (state !== undefined && state !== 'PREPARING')
            return { kind: 'ANSWERED', value: { headerId, contractNumber, versionId, state } };
        }
      }
      await this.pacing.pause(this.pacing.intervalMs);
    }
    return { kind: 'UNAVAILABLE', reason: 'LOAN_SYSTEM_WORKFLOW_PENDING' };
  }

  async #call(
    operation: string,
    method: 'GET' | 'POST',
    url: string,
    requestId: string,
    body?: Record<string, unknown>,
  ): Promise<RailOutcome<Envelope<unknown>>> {
    const headers = await this.session.authHeaders();
    if (!headers.ok) return { kind: 'UNAVAILABLE', reason: headers.error.reason };
    try {
      const envelope = (await this.transport.call(operation, {
        method,
        url,
        ...(body === undefined ? {} : { body }),
        headers: { ...headers.value, 'x-request-id': requestIdOf(requestId) },
      })) as Envelope<unknown>;
      const codes = errorCodes(envelope);
      if (codes.length > 0) return { kind: 'REFUSED', code: codes[0] ?? 'err.unknown' };
      return { kind: 'ANSWERED', value: envelope };
    } catch (error) {
      if (error instanceof TransportError) {
        if (error.status === 401 || error.status === 403) this.session.invalidate();
        return {
          kind: 'UNAVAILABLE',
          reason: error.status === undefined ? 'TRANSPORT_FAILURE' : `HTTP_${String(error.status)}`,
        };
      }
      return { kind: 'UNAVAILABLE', reason: 'TRANSPORT_FAILURE' };
    }
  }
}
