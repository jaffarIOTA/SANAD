/**
 * Tuum's lending module, for rate-priced products only (UAE M6).
 *
 * The product owner's decision of 2026-10-08 (README "Lending module",
 * product-catalogue.ts) keeps the lending module open for rate-priced products
 * — conventional SME and consumer term loans, Tawarruq personal, BNPL — and
 * closed to Murabaha, which stays account-shaped in core-banking-adapter.ts.
 * This file is the only place under adapters/tuum allowed to call it
 * (test/architecture/absences.test.ts), and the ops service calls it only for
 * a rate-priced product.
 *
 * The booking: create the customer as a legal person, then the loan contract
 * on Sanad's terms — principal, Sanad's rate, Sanad's APR, the number of
 * payments, the first payment date — and read back the contract number as the
 * loan account number. Tuum's vocabulary stops here: nothing it returns
 * crosses the port but the three references.
 *
 * - Amounts and rates are JSON numbers in Tuum's API. They are written as exact
 *   decimal tokens (JSON.rawJSON) from integer minor units and basis points: no
 *   floating-point value is ever made.
 * - Sanad's rate is sent, never taken: a contract that echoes a different
 *   interest rate is REFUSED (RATE_MISMATCH) and nothing is recorded.
 * - Each call carries the booking's idempotency key in x-request-id, suffixed
 *   per step, so a retried booking is the same booking.
 */
import type { LoanBooking, LoanBookingPort, LoanBookingRequest } from '../../core/ports/loan-booking.ts';
import type { RailOutcome } from '../../core/ports/rail.ts';
import { type Result, ok, reject } from '../../core/kernel/result.ts';
import { type RailTransport, TransportError } from '../kernel/http-transport.ts';

import { type Envelope, type TuumSession, errorCodes } from './authentication.ts';

export interface TuumLendingHosts {
  readonly person: string;
  readonly loan: string;
}

export const TUUM_LENDING_DEVIATIONS = [
  {
    id: 'TUUM-LEND-001',
    summary: 'A servicing account is required in practice by the sandbox (README, 2026-10-08 run).',
    containment:
      'Not sent until the UAE product is set up with its account type, customer group and price list; the verification item TUUM-LEND-01 decides how it is opened.',
  },
  {
    id: 'TUUM-LEND-002',
    summary: 'Whether a supplied interestRate overrides the product price list is untested.',
    containment: 'Sanad sends its rate; a contract echoing another rate is refused, never accepted.',
  },
] as const;

/** Minor units → an exact decimal token, two places. */
function decimalToken(minor: bigint): unknown {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const text = `${negative ? '-' : ''}${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, '0')}`;
  return (JSON as unknown as { rawJSON(t: string): unknown }).rawJSON(text);
}

/** Basis points → a percent decimal string ("150" → "1.50"). */
const percentText = (bp: bigint): string => `${(bp / 100n).toString()}.${(bp % 100n).toString().padStart(2, '0')}`;
const percentToken = (bp: bigint): unknown => (JSON as unknown as { rawJSON(t: string): unknown }).rawJSON(percentText(bp));

/** "1.50" and 1.5 are the same percentage: compared as text, trailing zeros removed. No arithmetic on a number. */
const samePercent = (expected: string, echoed: unknown): boolean => {
  if (typeof echoed !== 'number' && typeof echoed !== 'string') return false;
  const norm = (s: string) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return norm(expected) === norm(String(echoed));
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

export class TuumLendingAdapter implements LoanBookingPort {
  readonly deviations = TUUM_LENDING_DEVIATIONS;

  constructor(
    private readonly hosts: TuumLendingHosts,
    private readonly session: TuumSession,
    private readonly transport: RailTransport,
    /** Tuum's tenant code (required on the contract body). */
    private readonly tenantCode: string,
    readonly source: 'LIVE' | 'FIXTURE',
  ) {}

  async bookLoan(r: LoanBookingRequest): Promise<Result<RailOutcome<LoanBooking>>> {
    if (r.principal.minorUnits <= 0n || r.rateBp < 0n || r.numberOfPayments < 1 || r.paymentDay < 1 || r.paymentDay > 31)
      return reject('OP-DETERMINACY', 'LOAN_BOOKING_INVALID', 'The booking terms are incomplete');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.firstPaymentDate))
      return reject('OP-DETERMINACY', 'LOAN_BOOKING_INVALID', 'The first payment date is yyyy-mm-dd');

    const person = await this.#post('person.create', `${this.hosts.person}/api/v2/persons`, `${r.idempotencyKey}:person`, {
      personTypeCode: 'L',
      name: r.borrower.legalNameEn,
      identificationNumbers: [{ idNumber: r.borrower.registrationRef, idTypeCode: 'REG' }],
    });
    if (person.kind !== 'ANSWERED') return ok(person);
    const personId = isRecord(person.value.data) ? str(person.value.data['personId']) : undefined;
    if (personId === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_PERSON' });

    const contract = await this.#post(
      'loan.contract.create',
      `${this.hosts.loan}/api/v1/persons/${encodeURIComponent(personId)}/contracts`,
      `${r.idempotencyKey}:contract`,
      {
        tenantCode: this.tenantCode,
        loanTypeCode: r.productCode,
        contractMoney: { amount: decimalToken(r.principal.minorUnits), currencyCode: r.principal.currency },
        interestRate: percentToken(r.rateBp),
        apr: percentToken(r.aprBp),
        numberOfPayments: r.numberOfPayments,
        paymentDay: r.paymentDay,
        firstPaymentDate: r.firstPaymentDate,
        customFields: { sanadApplicationId: r.applicationId },
      },
    );
    if (contract.kind !== 'ANSWERED') return ok(contract);
    const data = contract.value.data;
    if (!isRecord(data)) return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_CONTRACT' });
    const contractNumber = str(data['contractNumber']);
    const headerId = str(data['headerId']);
    if (contractNumber === undefined || headerId === undefined) return ok({ kind: 'UNAVAILABLE', reason: 'MALFORMED_CONTRACT' });
    // Sanad's rate is the contract's rate: an echo that differs means the loan system priced it, and nothing is booked.
    if (data['interestRate'] !== undefined && data['interestRate'] !== null && !samePercent(percentText(r.rateBp), data['interestRate']))
      return ok({ kind: 'REFUSED', code: 'RATE_MISMATCH', referenceId: headerId });
    return ok({ kind: 'ANSWERED', value: { loanAccountNumber: contractNumber, contractRef: headerId, customerRef: personId } });
  }

  async #post(
    operation: string,
    url: string,
    requestId: string,
    body: Record<string, unknown>,
  ): Promise<RailOutcome<Envelope<unknown>>> {
    const headers = await this.session.authHeaders();
    if (!headers.ok) return { kind: 'UNAVAILABLE', reason: headers.error.reason };
    try {
      const envelope = (await this.transport.call(operation, {
        method: 'POST',
        url,
        body,
        headers: { ...headers.value, 'x-request-id': requestId },
      })) as Envelope<unknown>;
      // A 200 can carry errors (authentication.ts, point 3): the loan system refused.
      const codes = errorCodes(envelope);
      if (codes.length > 0) return { kind: 'REFUSED', code: codes[0] ?? 'err.unknown' };
      return { kind: 'ANSWERED', value: envelope };
    } catch (error) {
      if (error instanceof TransportError) {
        if (error.status === 401 || error.status === 403) this.session.invalidate();
        return { kind: 'UNAVAILABLE', reason: error.status === undefined ? 'TRANSPORT_FAILURE' : `HTTP_${String(error.status)}` };
      }
      return { kind: 'UNAVAILABLE', reason: 'TRANSPORT_FAILURE' };
    }
  }
}
