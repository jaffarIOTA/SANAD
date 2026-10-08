/** Shared by the review route handlers: staff authentication, the wire form of a request row, problems. */

import { randomUUID } from 'node:crypto';

import type { Principal } from '@sanad/core/origination/request.ts';
import { requiredAuthority } from '@sanad/core/origination/policy.ts';
import { problem, type Problem } from '@sanad/origination/problem.ts';
import { compileContract, contractPath } from '@sanad/origination/contracts.ts';

import { authenticateStaff, requestPrincipal } from '../../../../server/staff.ts';
import { originationPolicy, type RequestRow } from '../../../../server/store.ts';

export const contract = compileContract(contractPath('review.v1.yaml'));

export function json(
  status: number,
  body: unknown,
  correlationId: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
      'x-correlation-id': correlationId,
      'cache-control': 'no-store',
      ...extra,
    },
  });
}
export const refuse = (p: Problem): Response => json(p.status, p, p.correlationId);
export function correlation(request: Request): string {
  const supplied = request.headers.get('x-correlation-id');
  return supplied !== null && /^[0-9a-f-]{36}$/i.test(supplied) ? supplied : randomUUID();
}
/** The staff principal behind a bearer credential, as the origination domain sees it (identity, tenant, highest approval tier). */
export function staffOr401(request: Request, correlationId: string): Principal | Response {
  const staff = authenticateStaff(request.headers.get('authorization') ?? undefined);
  return staff === undefined
    ? refuse(
        problem({
          status: 401,
          title: 'Unauthenticated',
          detail: 'No staff credential was recognised.',
          reason: 'CREDENTIAL_NOT_RECOGNISED',
          correlationId,
        }),
      )
    : requestPrincipal(staff);
}

const iso = (epoch: bigint) => new Date(Number(epoch) * 1000).toISOString();

export function toWire(row: RequestRow): Record<string, unknown> {
  const policy = originationPolicy();
  return {
    requestId: row.requestId,
    state: row.state,
    channel: row.channel,
    counterpartyId: row.counterpartyId,
    invoiceNumber: row.invoiceNumber,
    amount: { minorUnits: row.amountMinorUnits.toString(), currency: 'SAR' },
    raisedAt: iso(row.raisedAtEpochSeconds),
    ...(row.submittedAtEpochSeconds === undefined ? {} : { submittedAt: iso(row.submittedAtEpochSeconds) }),
    ...(row.makerPrincipalId === undefined ? {} : { makerPrincipalId: row.makerPrincipalId }),
    requiredAuthority: requiredAuthority(policy, { minorUnits: row.amountMinorUnits, currency: 'SAR' }),
    ...(row.note === undefined ? {} : { note: row.note }),
    ...(row.reasonCode === undefined ? {} : { reasonCode: row.reasonCode }),
    ...(row.contraryJustification === undefined ? {} : { contraryJustification: row.contraryJustification }),
    ...(row.changes === undefined ? {} : { changes: row.changes }),
    ...(row.pending === undefined ? {} : { pending: row.pending }),
    ...(row.attempts === undefined
      ? {}
      : {
          attempts: row.attempts.map((a) => ({
            at: iso(a.atEpochSeconds),
            reason: a.reason,
            ...(a.manualBy === undefined ? {} : { manualBy: a.manualBy }),
            ...(a.manualNote === undefined ? {} : { manualNote: a.manualNote }),
          })),
        }),
  };
}
