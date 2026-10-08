import { fromRejection, problem } from '@sanad/origination/problem.ts';

import { contract, correlation, json, refuse, staffOr401, toWire } from '../../../shared.ts';
import { canReview } from '../../../../../../../server/session.ts';
import {
  approveRequest,
  declineRequest,
  findRequest,
  flushStore,
  requestInformation,
  returnRequest,
  syncStore,
} from '../../../../../../../server/store.ts';

const validate = contract.validatorFor('Decision');
interface Decision {
  readonly decision: 'APPROVE' | 'RETURN' | 'REJECT' | 'REQUEST_INFORMATION';
  readonly note?: string;
  readonly reasonCode?: string;
  readonly contraryJustification?: string;
  readonly from?: 'COUNTERPARTY' | 'PARTNER' | 'DOCUMENTS';
  readonly items?: readonly string[];
}

export async function PUT(
  request: Request,
  ctx: { readonly params: Promise<{ readonly requestId: string }> },
): Promise<Response> {
  const correlationId = correlation(request);
  const staff = staffOr401(request, correlationId);
  if (staff instanceof Response) return staff;
  const key = request.headers.get('idempotency-key');
  if (key === null || !/^[0-9a-f-]{36}$/i.test(key))
    return refuse(
      problem({
        status: 400,
        kind: 'malformed-request',
        title: 'Malformed request',
        detail: 'A decision requires an Idempotency-Key header carrying a UUID.',
        reason: 'IDEMPOTENCY_KEY_MISSING',
        correlationId,
      }),
    );
  const { requestId } = await ctx.params;
  await syncStore();
  // Another institution's request is not found, not forbidden (SEC-TM08, SEC-TM12).
  const found = findRequest(requestId);
  const row = found?.tenantId === staff.tenantId ? found : undefined;
  if (row === undefined)
    return refuse(
      problem({
        status: 404,
        title: 'Not found',
        detail: 'No such request.',
        reason: 'REQUEST_NOT_FOUND',
        correlationId,
      }),
    );
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return refuse(
      problem({
        status: 400,
        kind: 'malformed-request',
        title: 'Malformed request',
        detail: 'The request body is not valid JSON.',
        reason: 'MALFORMED_JSON',
        correlationId,
      }),
    );
  }
  const failures = validate(parsed);
  if (failures.length > 0)
    return refuse(
      problem({
        status: 400,
        kind: 'malformed-request',
        title: 'Malformed request',
        detail: failures.map((f) => `${f.path || 'body'} ${f.message}`).join(' '),
        reason: failures.some((f) => f.unknownProperty !== undefined) ? 'UNKNOWN_PROPERTY' : 'SCHEMA_VALIDATION_FAILED',
        correlationId,
      }),
    );
  const body = parsed as Decision;

  // Deciding needs an approval authority; a maker's or finance user's credential decides nothing.
  if (staff.authority === undefined)
    return refuse(
      problem({
        status: 403,
        kind: 'control-rejection',
        title: 'Forbidden',
        detail: 'Deciding a request needs an approval authority.',
        reason: 'AUTHORITY_REQUIRED',
        control: 'OP-DETERMINACY',
        correlationId,
      }),
    );

  // Four eyes: derived from the credential, refused by the service, never by the client.
  const eyes = canReview(staff, row.makerPrincipalId);
  if (!eyes.allowed)
    return refuse(
      problem({
        status: 403,
        kind: 'control-rejection',
        title: 'Forbidden',
        detail: 'A principal may not decide their own work.',
        reason: 'OWN_WORK',
        control: 'OP-DETERMINACY',
        correlationId,
      }),
    );

  const outcome =
    body.decision === 'APPROVE'
      ? approveRequest(requestId, staff, body.contraryJustification)
      : body.decision === 'RETURN'
        ? body.note === undefined
          ? undefined
          : returnRequest(requestId, staff, body.note)
        : body.decision === 'REJECT'
          ? body.reasonCode === undefined
            ? undefined
            : declineRequest(requestId, staff, body.reasonCode)
          : body.from === undefined || body.items === undefined
            ? undefined
            : requestInformation(requestId, staff, body.from, body.items);
  if (outcome === undefined)
    return refuse(
      problem({
        status: 400,
        kind: 'malformed-request',
        title: 'Malformed request',
        detail: 'The decision is missing the field it requires (note, reasonCode, or from and items).',
        reason: 'DECISION_FIELD_MISSING',
        correlationId,
      }),
    );
  if (!outcome.ok) return refuse(fromRejection(outcome.error, correlationId));
  // The decision is durable before it is acknowledged.
  await flushStore();
  return json(200, toWire(outcome.value), correlationId);
}
