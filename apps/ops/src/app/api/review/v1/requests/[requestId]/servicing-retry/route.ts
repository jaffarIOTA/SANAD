import { fromRejection, problem } from '@sanad/origination/problem.ts';

import { correlation, json, refuse, staffOr401, toWire } from '../../../shared.ts';
import { findRequest, retryServicing } from '../../../../../../../server/store.ts';

export async function PUT(request: Request, ctx: { readonly params: Promise<{ readonly requestId: string }> }): Promise<Response> {
  const correlationId = correlation(request);
  const staff = staffOr401(request, correlationId);
  if (staff instanceof Response) return staff;
  const { requestId } = await ctx.params;
  if (findRequest(requestId) === undefined) return refuse(problem({ status: 404, title: 'Not found', detail: 'No such request.', reason: 'REQUEST_NOT_FOUND', correlationId }));
  let note: string | undefined;
  try { const parsed = (await request.text()).trim(); if (parsed !== '') { const b = JSON.parse(parsed) as { note?: unknown }; if (typeof b.note === 'string' && b.note.trim().length > 0) note = b.note; } } catch { return refuse(problem({ status: 400, kind: 'malformed-request', title: 'Malformed request', detail: 'The request body is not valid JSON.', reason: 'MALFORMED_JSON', correlationId })); }
  const outcome = retryServicing(requestId, note === undefined ? undefined : { by: staff, note });
  if (!outcome.ok) return refuse(fromRejection(outcome.error, correlationId));
  return json(200, toWire(outcome.value), correlationId);
}
