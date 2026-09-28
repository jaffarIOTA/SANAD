import { problem } from '@sanad/origination/problem.ts';

import { correlation, json, refuse, staffOr401, toWire } from '../../shared.ts';
import { findRequest } from '../../../../../../server/store.ts';

export async function GET(request: Request, ctx: { readonly params: Promise<{ readonly requestId: string }> }): Promise<Response> {
  const correlationId = correlation(request);
  const staff = staffOr401(request, correlationId);
  if (staff instanceof Response) return staff;
  const { requestId } = await ctx.params;
  const row = findRequest(requestId);
  if (row === undefined) return refuse(problem({ status: 404, title: 'Not found', detail: 'No such request.', reason: 'REQUEST_NOT_FOUND', correlationId }));
  return json(200, toWire(row), correlationId);
}
