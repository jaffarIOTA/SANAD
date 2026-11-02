/**
 * Booking the disbursed loan in the institution's loan system (UAE M6), and
 * storing the loan account number it returns.
 *
 * Which loan system: the tenant's configuration names the adapter and the
 * product code each rate-priced product books under
 * (config/tenants/<t>/core-banking/loan-products.json). A product not listed
 * there — a Murabaha product never is — is not booked as a loan contract.
 *
 * Which transport:
 * - live, when the vault holds the tenant's CORE_BANKING credentials and, to
 *   opt in, the person API host (`person_api_base_url`) as well;
 * - otherwise, only where a synthetic demonstration is permitted, the
 *   demonstration transport, labelled Fixture;
 * - otherwise none, and booking is refused as unavailable.
 *
 * The call is idempotent on `business:<id>:book`: a retried booking is the
 * same booking at the loan system, and Sanad records it once.
 */
import { type TenantCode, loadLoanBookingConfig } from '@sanad/config/loader.ts';
import { type Result, reject } from '@sanad/core/kernel/result.ts';
import { loanSystemFor } from '@sanad/origination/loan-system.ts';
import { type BusinessApplicationView, bookingTermsOf, recordLoanBooked } from './business.ts';
import { persistencePool } from './persistence.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

/** Book the disbursed loan on the signed offer's terms and record the loan account number. */
export async function bookInLoanSystem(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  const found = await bookingTermsOf(tenant, applicationId);
  if (!found.ok) return found;
  const { view, terms } = found.value;
  const a = view.application;
  if (a.status !== 'DISBURSED')
    return fail('TRANSITION_NOT_ALLOWED', 'A loan is booked once it has been disbursed', { status: a.status });
  if (view.booking !== undefined) return fail('LOAN_ALREADY_BOOKED', 'This loan is already booked in the loan system');
  const config = loadLoanBookingConfig(tenant);
  if (!config.ok) return config;
  const product = config.value.products[a.productCode];
  if (product === undefined)
    return fail('LOAN_PRODUCT_NOT_MAPPED', 'This product has no loan-system product code configured', {
      productCode: a.productCode,
    });
  const system = await loanSystemFor(tenant, config.value, persistencePool());
  if (system === undefined)
    return fail('RAIL_UNAVAILABLE', 'The loan system is not connected here; nothing was booked', {
      rail: 'CORE_BANKING',
    });
  const booked = await system.bookLoan({
    tenantId: tenant,
    applicationId,
    borrower: { legalNameEn: a.applicant.businessNameEn, registrationRef: a.applicant.registrationRef },
    productCode: product.loanTypeCode,
    principal: terms.facilityAmount,
    rateBp: terms.rateBp,
    aprBp: terms.aprBp,
    numberOfPayments: terms.months,
    firstPaymentDate: terms.firstDueDate,
    paymentDay: terms.paymentDay,
    idempotencyKey: `business:${applicationId}:book`,
    correlationId: applicationId,
  });
  if (!booked.ok) return booked;
  if (booked.value.kind === 'UNAVAILABLE')
    return fail(
      'RAIL_UNAVAILABLE',
      'The loan system did not answer; nothing was booked. Try again: the booking is idempotent',
      {
        rail: 'CORE_BANKING',
      },
    );
  if (booked.value.kind === 'REFUSED')
    return fail(
      booked.value.code === 'RATE_MISMATCH' ? 'LOAN_RATE_MISMATCH' : 'LOAN_BOOKING_REFUSED',
      'The loan system did not book the loan',
      { code: booked.value.code },
    );
  return recordLoanBooked(
    tenant,
    applicationId,
    { ...booked.value.value, productCode: product.loanTypeCode, source: system.source },
    actor,
  );
}
