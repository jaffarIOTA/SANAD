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
 *   per step, so a retried booking is the same booking.
 */
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
export type RestrictedAttributesResolver = (ref: string) => Promise<
  | {
      readonly idNumber: string;
      readonly idTypeCode: string;
      readonly givenName: string;
      readonly surname: string;
    }
  | undefined
>;

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
  ) {}

  async bookLoan(r: LoanBookingRequest): Promise<Result<RailOutcome<LoanBooking>>> {
    const monthly = r.paymentDay !== undefined;
    const interval = r.intervalDays !== undefined;
    if (
      r.principal.minorUnits <= 0n ||
      r.rateBp < 0n ||
      r.numberOfPayments < 1 ||
      monthly === interval ||
      (monthly && (r.paymentDay! < 1 || r.paymentDay! > 31)) ||
      (interval && (!Number.isInteger(r.intervalDays) || r.intervalDays! < 1))
    )
      return reject('OP-DETERMINACY', 'LOAN_BOOKING_INVALID', 'The booking terms are incomplete');
    if (!DATE.test(r.firstPaymentDate))
      return reject('OP-DETERMINACY', 'LOAN_BOOKING_INVALID', 'The first payment date is yyyy-mm-dd');

    const person = await this.#person(r);
    if (!person.ok) return person;
    if (person.value.kind !== 'ANSWERED') return ok(person.value);
    const personId = person.value.value;

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
        },
      );
      if (account.kind !== 'ANSWERED') return ok(account);
      const data = account.value.data;
      servicingAccountId = isRecord(data)
        ? str(data['accountId'])
        : str((account.value as Record<string, unknown>)['accountId']);
      if (servicingAccountId === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_ACCOUNT' });
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
  async #person(r: LoanBookingRequest): Promise<Result<RailOutcome<string>>> {
    let body: Record<string, unknown>;
    if (r.borrower.kind === 'PERSON') {
      if (this.consumer === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'RESTRICTED_ATTRIBUTES_UNAVAILABLE' });
      // Resolved here, used once, never kept, returned, logged or traced (TUUM-DEV-002).
      const attributes = await this.consumer.restricted(r.borrower.restrictedAttributesRef);
      if (attributes === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'RESTRICTED_ATTRIBUTES_UNAVAILABLE' });
      body = {
        personTypeCode: 'P',
        givenName: attributes.givenName,
        surname: attributes.surname,
        identificationNumbers: [{ idNumber: attributes.idNumber, idTypeCode: attributes.idTypeCode }],
        externalReference: r.borrower.partyRef,
      };
    } else
      body = {
        personTypeCode: 'L',
        name: r.borrower.legalNameEn,
        identificationNumbers: [{ idNumber: r.borrower.registrationRef, idTypeCode: 'REG' }],
      };
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
    return ok({ kind: 'ANSWERED', value: personId });
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
        headers: { ...headers.value, 'x-request-id': requestId },
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
