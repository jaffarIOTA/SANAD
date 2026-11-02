'use server';

/**
 * Server actions for the consumer loans screen. Plain form posts and
 * redirects; a refusal travels back as a control code and a reason, never a
 * generic failure. The decisions are core/servicing/core-held-loan.ts's and
 * the acts services/origination's.
 *
 * Who acts is the signed-in principal (`authorise()`), and the tenant is that
 * principal's; neither ever comes from the form. Standing in for the rails'
 * answers is a separate authority (SERVICING_STAND_IN) and works only in a
 * synthetic demonstration.
 */

import { redirect } from 'next/navigation';

import { bookConsumerLoan, runConsumerLoanServicing } from '@sanad/origination/consumer-loan-servicing.ts';

import { persistencePool } from './persistence.ts';
import { authorise, localeSegmentOf } from './session.ts';

const field = (form: FormData, name: string): string => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const localeOf = (form: FormData): string => localeSegmentOf(field(form, 'locale') || 'en');
const LOAN_REF = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function back(locale: string, params: Readonly<Record<string, string>>): never {
  redirect(`/${locale}/bnpl?${new URLSearchParams(params).toString()}`);
}

export async function bookConsumerLoanAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const staff = await authorise(locale, 'CONSUMER_LOAN_SERVICE', `/${locale}/bnpl`);
  const loanRef = field(form, 'loanRef');
  const pool = persistencePool();
  if (pool === undefined || !LOAN_REF.test(loanRef))
    back(locale, {
      control: 'OP-DETERMINACY',
      reason: 'LOAN_NOT_FOUND',
      message: 'No consumer loan with this reference',
    });
  const r = await bookConsumerLoan(pool, staff.tenantId, loanRef, staff.principalId);
  if (!r.ok) back(locale, { loan: loanRef, control: r.error.control, reason: r.error.reason, message: r.error.detail });
  back(locale, { loan: loanRef, done: 'BOOKED' });
}

export async function serviceConsumerLoanAction(form: FormData): Promise<void> {
  const locale = localeOf(form);
  const simulate = field(form, 'simulateRailResults') === 'yes';
  const staff = await authorise(locale, simulate ? 'SERVICING_STAND_IN' : 'CONSUMER_LOAN_SERVICE', `/${locale}/bnpl`);
  const loanRef = field(form, 'loanRef');
  const asOf = field(form, 'asOf');
  const pool = persistencePool();
  if (pool === undefined || !LOAN_REF.test(loanRef))
    back(locale, {
      control: 'OP-DETERMINACY',
      reason: 'LOAN_NOT_FOUND',
      message: 'No consumer loan with this reference',
    });
  const r = await runConsumerLoanServicing(pool, staff.tenantId, loanRef, asOf, staff.principalId, {
    simulateRailResults: simulate,
  });
  if (!r.ok)
    back(locale, { loan: loanRef, asOf, control: r.error.control, reason: r.error.reason, message: r.error.detail });
  const run = r.value;
  back(locale, {
    loan: loanRef,
    asOf,
    done: 'SERVICED',
    posted: String(run.posted),
    queued: String(run.queued),
    settled: String(run.settled),
    returned: String(run.returned),
    overdue: String(run.overdue),
    closed: run.closed ? 'yes' : 'no',
  });
}
