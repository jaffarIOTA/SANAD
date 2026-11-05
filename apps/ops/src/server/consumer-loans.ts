/**
 * The workbench's view of consumer loans (BNPL first): each loan as accepted,
 * where it is booked in the loan system, how it is collected, what has
 * happened to it, and the loan system's position for a chosen date.
 *
 * The tenant is always the signed-in person's (the callers pass
 * `staff.tenantId`). Servicing itself is services/origination's.
 */
import type { TenantCode } from '@sanad/config/loader.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import type { LoanPosition } from '@sanad/core/ports/loan-servicing.ts';
import { consumerLoanPosition } from '@sanad/origination/consumer-loan-servicing.ts';
import { type ConsumerLoanView, listConsumerLoans } from '@sanad/origination/consumer-loans.ts';

import { persistencePool } from './persistence.ts';

export const consumerLoansAvailable = (): boolean => persistencePool() !== undefined;

export async function consumerLoans(tenant: TenantCode): Promise<readonly ConsumerLoanView[]> {
  const pool = persistencePool();
  return pool === undefined ? [] : listConsumerLoans(pool, tenant);
}

export async function consumerLoanPositionFor(
  tenant: TenantCode,
  loanRef: string,
  asOf: string,
): Promise<Result<{ position: LoanPosition; source: 'LIVE' | 'FIXTURE' }> | undefined> {
  const pool = persistencePool();
  return pool === undefined ? undefined : consumerLoanPosition(pool, tenant, loanRef, asOf);
}
