/**
 * The credit-assessment rails for a business application (UAE M2): the
 * commercial bureau report and the bank-statement facts, each fetched under
 * the consent the business gave at Sanad's own intake.
 *
 * It sits between the intake (which holds the tenant's consent ledger) and
 * the application service (which records what was fetched), so neither has to
 * import the other. The rails are the fenced ones (intake-rails.ts): labelled
 * demonstration answers where a synthetic demonstration is permitted,
 * UNAVAILABLE everywhere else until each rail has made a verified sandbox call.
 * A rail that is down or refuses never records anything (CLAUDE.md §5).
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import { type Result, reject } from '@sanad/core/kernel/result.ts';

import {
  type BusinessApplicationView,
  getApplication,
  intakeConsentFor,
  recordBankStatementFacts,
  recordBureauFetch,
} from './business.ts';
import { intakeConsentLedger } from './intake.ts';
import { kybRails } from './intake-rails.ts';
import { developmentAttestation } from './store.ts';

const fail = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);
const unavailable = (rail: string): Result<never> =>
  reject('OP-DETERMINACY', 'RAIL_UNAVAILABLE', 'The rail is not connected here; nothing was fetched', { rail });

const attest = () => Promise.resolve(developmentAttestation());
const nowSeconds = () => Number(developmentAttestation().epochSeconds);

/** The months of statements read: a year, so seasonality shows. */
const STATEMENT_MONTHS = 12;

async function railsFor(tenant: TenantCode) {
  return kybRails(tenant, await intakeConsentLedger(tenant), attest, nowSeconds);
}

/**
 * Fetch the business's commercial bureau report and record its summary. A
 * business with no commercial file, or an application handed over by a
 * partner (whose bureau consent Sanad's ledger does not hold), is refused with
 * a reason that says to key the result from the report instead.
 */
export async function fetchBureauReport(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  const view = await getApplication(tenant, applicationId);
  if (view === undefined) return fail('BUSINESS_APPLICATION_NOT_FOUND', 'No such application', { applicationId });
  const app = view.application;
  const consentId = intakeConsentFor(app, 'credit_bureau');
  if (consentId === undefined)
    return fail(
      'BUREAU_CONSENT_NOT_IN_SANAD',
      'No bureau consent was recorded at Sanad’s intake for this application; key the result from the upstream report',
    );
  const rails = await railsFor(tenant);
  if (rails === undefined) return unavailable('CREDIT_BUREAU');
  const r = await rails.bureau.request({
    tenantId: tenant,
    counterpartyId: applicationId,
    commercialRegistration: app.applicant.registrationRef,
    consentId,
    correlationId: applicationId,
  });
  if (!r.ok) return r;
  const outcome = r.value;
  if (outcome.kind === 'UNAVAILABLE') return unavailable('CREDIT_BUREAU');
  if (outcome.kind === 'NO_RECORD')
    return fail(
      'BUREAU_NO_RECORD',
      'The bureau holds no commercial file for this business; key the result from an owner’s individual report',
    );
  const s = outcome.summary;
  if (s.bureauScore === undefined || !Number.isSafeInteger(s.bureauScore))
    return fail('BUREAU_NO_SCORE', 'The bureau report carries no score; key the result from the report');
  return recordBureauFetch(
    tenant,
    applicationId,
    {
      reportRef: s.bureauReference,
      consentId,
      score: BigInt(s.bureauScore),
      source: rails.source,
      totalExposure: s.totalExposure,
      overdueAmount: s.overdueAmount,
      worstDelinquencyDays: s.worstDelinquencyDays,
      activeFacilities: s.activeFacilities,
      defaults: s.defaults.length,
    },
    actor,
  );
}

/**
 * Read a year of the business's bank statements through Open Finance and
 * record the four facts the account-information port derives. A second person
 * confirms them before the assessment relies on them.
 */
export async function fetchBankStatements(
  tenant: TenantCode,
  applicationId: string,
  actor: string,
): Promise<Result<BusinessApplicationView>> {
  const view = await getApplication(tenant, applicationId);
  if (view === undefined) return fail('BUSINESS_APPLICATION_NOT_FOUND', 'No such application', { applicationId });
  const app = view.application;
  const consentId = intakeConsentFor(app, 'account_information');
  if (consentId === undefined)
    return fail(
      'ACCOUNT_CONSENT_NOT_IN_SANAD',
      'No bank-account consent was recorded at Sanad’s intake for this application',
    );
  const rails = await railsFor(tenant);
  if (rails === undefined) return unavailable('ACCOUNT_INFORMATION');
  const r = await rails.accounts.affordabilityFacts({
    tenantId: tenant,
    applicantRef: app.applicant.registrationRef,
    consentId,
    months: STATEMENT_MONTHS,
    correlationId: applicationId,
  });
  if (!r.ok) return r;
  if (r.value.kind !== 'ANSWERED') return unavailable('ACCOUNT_INFORMATION');
  const f = r.value.value;
  return recordBankStatementFacts(
    tenant,
    applicationId,
    {
      referenceId: f.referenceId,
      consentId,
      months: STATEMENT_MONTHS,
      averageMonthlyInflow: f.averageMonthlyInflow,
      lowestMonthEndBalance: f.lowestMonthEndBalance,
      returnedPaymentsLast6Months: f.returnedPaymentsLast6Months,
      salaryCreditsObserved: f.salaryCreditsObserved,
      source: rails.source,
    },
    actor,
  );
}
