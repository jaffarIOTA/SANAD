/**
 * Shared by the business-application route handlers (kept out of `route.ts`:
 * Next treats every export of a route file as a handler).
 *
 * The wire shape of an application's status, and the checks every call makes
 * after authentication: the scope, and that the credential's tenant is one
 * the deployment serves (ADR 0005).
 */

import { isTenantCode, type TenantCode } from '@sanad/config/loader.ts';
import { deploymentJurisdiction } from '@sanad/origination/jurisdiction.ts';
import { type PartnerPrincipal, type Scope, hasScope } from '@sanad/origination/principal.ts';
import { problem } from '@sanad/origination/problem.ts';

import type { BusinessApplicationView } from '../../../../../server/business.ts';
import { refuse } from '../shared.ts';

export interface BusinessApplicationStatusWire {
  readonly applicationId: string;
  readonly upstreamRef: string;
  readonly status: string;
  readonly stage: number;
  readonly productCode: string;
  readonly variantCode: string;
  readonly requestedMinorUnits: string;
  readonly requestedTenorMonths: number;
  readonly currency: string;
  /** Once a decision approved the application: what the offer is quoted on. The request above is unchanged. */
  readonly approvedTerms?: {
    readonly amountMinorUnits: string;
    readonly tenorMonths: number;
    readonly basis: string;
  };
  readonly offerLetterVersion?: string;
}

export function toStatusWire(v: BusinessApplicationView): BusinessApplicationStatusWire {
  const a = v.application;
  const approved = v.approvedTerms;
  return {
    applicationId: a.applicationId,
    upstreamRef: a.upstreamRef,
    status: a.status,
    stage: v.displayStage,
    productCode: a.productCode,
    variantCode: a.variantCode,
    requestedMinorUnits: a.requested.minorUnits.toString(),
    requestedTenorMonths: a.tenorMonths,
    currency: a.requested.currency,
    ...(approved === undefined
      ? {}
      : {
          approvedTerms: {
            amountMinorUnits: approved.amount.minorUnits.toString(),
            tenorMonths: approved.tenorMonths,
            basis: approved.basis,
          },
        }),
    ...(a.offer === undefined ? {} : { offerLetterVersion: a.offer.letterVersion }),
  };
}

/** The tenant this credential may act for, or the response to send instead. */
export async function businessTenantOr403(
  principal: PartnerPrincipal,
  scope: Scope,
  correlationId: string,
): Promise<TenantCode | Response> {
  if (!hasScope(principal, scope)) {
    return refuse(
      problem({
        status: 403,
        title: 'Forbidden',
        detail: 'The credential does not carry the scope required.',
        reason: 'SCOPE_INSUFFICIENT',
        correlationId,
      }),
    );
  }
  const tenant = principal.tenantId;
  const deployment = await deploymentJurisdiction();
  if (!isTenantCode(tenant) || !deployment.activeTenants.includes(tenant)) {
    return refuse(
      problem({
        status: 403,
        title: 'Forbidden',
        detail: 'The credential’s institution is not served under the deployment’s jurisdiction.',
        reason: 'TENANT_NOT_ACTIVE',
        correlationId,
      }),
    );
  }
  return tenant;
}
