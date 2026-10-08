/**
 * GET /api/origination/v1/business-applications/{applicationId} — the stage
 * and status of an application the upstream system handed over. Another
 * tenant's application is reported as absent, not forbidden.
 */

import { problem } from '@sanad/origination/problem.ts';

import { getApplication, syncBusiness } from '../../../../../../server/business.ts';
import { correlation, json, principalOr401, refuse } from '../../shared.ts';
import { businessTenantOr403, toStatusWire } from '../shared.ts';

export async function GET(request: Request, context: { params: Promise<{ applicationId: string }> }): Promise<Response> {
  const correlationId = correlation(request);
  const principal = principalOr401(request, correlationId);
  if (principal instanceof Response) return principal;
  const tenant = await businessTenantOr403(principal, 'business:read', correlationId);
  if (tenant instanceof Response) return tenant;

  const { applicationId } = await context.params;
  await syncBusiness(tenant);
  const found = /^[A-Z]{2,4}-[0-9]{6,10}$/.test(applicationId) ? await getApplication(tenant, applicationId) : undefined;
  if (found === undefined) {
    return refuse(problem({ status: 404, title: 'Not found', detail: 'No such resource within this credential’s scope.', reason: 'BUSINESS_APPLICATION_NOT_FOUND', correlationId }));
  }
  return json(200, toStatusWire(found), correlationId);
}
