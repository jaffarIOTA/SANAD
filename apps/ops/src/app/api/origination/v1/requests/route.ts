/**
 * The partner API, hosted inside the workbench for development.
 *
 * Why here as well as in `services/origination`: the two ran as separate
 * processes with separate in-memory stores, so a request an ERP raised over
 * the API never appeared in the queue an officer reviews. That defeated the
 * one property the channels exist to demonstrate — every door leads to the
 * same queue and the same gates.
 *
 * This handler shares the workbench's store, so all three channels land in
 * one place. It reuses the service's runtime-agnostic modules — the contract
 * compiled into validators, RFC 9457 problems, the credential registry, the
 * wire mapper — and re-implements only the routing, which is tied to
 * node:http over there and to the fetch API here.
 *
 * When the database arrives, both processes read one store and this file goes.
 */

import { randomUUID } from 'node:crypto';

import { correlation, json, principalOr401, refuse } from '../shared.ts';

import { validatorFor } from '@sanad/origination/contract.ts';
import { fingerprint, inMemoryIdempotencyStore, type IdempotencyStore } from '@sanad/origination/idempotency.ts';
import { hasScope } from '@sanad/origination/principal.ts';
import { fromRejection, problem } from '@sanad/origination/problem.ts';
import { toWire, type RaiseRequestBody } from '@sanad/origination/representation.ts';

import { MAKER } from '../../../../../server/session.ts';
import { keyRequest, listPartnerRequests, submit, findPartnerRequest } from '../../../../../server/store.ts';

const validateRaise = validatorFor('RaiseRequest');

const IDEMPOTENCY_KEY = Symbol.for('sanad.ops.idempotency');
const idempotency: IdempotencyStore = ((globalThis as Record<symbol, IdempotencyStore | undefined>)[IDEMPOTENCY_KEY] ??=
  inMemoryIdempotencyStore());





export async function POST(request: Request): Promise<Response> {
  const correlationId = correlation(request);
  const principal = principalOr401(request, correlationId);
  if (principal instanceof Response) return principal;
  if (!hasScope(principal, 'origination:write')) {
    return refuse(problem({ status: 403, title: 'Forbidden', detail: 'The credential does not carry the scope required.', reason: 'SCOPE_INSUFFICIENT', correlationId }));
  }

  const key = request.headers.get('idempotency-key');
  if (key === null || !/^[0-9a-f-]{36}$/i.test(key)) {
    return refuse(problem({ status: 400, kind: 'malformed-request', title: 'Malformed request', detail: 'A state-changing request requires an Idempotency-Key header carrying a UUID.', reason: 'IDEMPOTENCY_KEY_MISSING', correlationId }));
  }

  const raw = await request.text();
  const reservation = await idempotency.reserve({ tenantId: principal.tenantId, partnerId: principal.partnerId, key, fingerprint: fingerprint('POST', '/requests', raw) });
  if (reservation.kind === 'REPLAY') return json(reservation.response.status, reservation.response.body, correlationId, { 'idempotent-replay': 'true' });
  if (reservation.kind !== 'FRESH') {
    return refuse(problem({ status: 409, kind: 'conflict', title: 'Idempotency conflict', detail: reservation.kind === 'CONFLICT' ? 'This Idempotency-Key has already been used with a different request body.' : 'A request with this Idempotency-Key is still being processed.', reason: reservation.kind === 'CONFLICT' ? 'IDEMPOTENCY_KEY_REUSED' : 'IDEMPOTENCY_KEY_IN_FLIGHT', correlationId }));
  }

  const finish = async (status: number, body: unknown): Promise<Response> => {
    await idempotency.complete({ tenantId: principal.tenantId, partnerId: principal.partnerId, key, response: { status, body } });
    return json(status, body, correlationId);
  };

  let parsed: unknown;
  try { parsed = raw.trim() === '' ? {} : JSON.parse(raw); } catch {
    return finish(400, problem({ status: 400, kind: 'malformed-request', title: 'Malformed request', detail: 'The request body is not valid JSON.', reason: 'MALFORMED_JSON', correlationId }));
  }

  // Validated against the published contract. A closed schema is the control:
  // an unknown property — a proportion-shaped one included — is refused here.
  const failures = validateRaise(parsed);
  if (failures.length > 0) {
    const unknown = failures.find((f) => f.unknownProperty !== undefined);
    return finish(400, problem({
      status: 400, kind: 'malformed-request', title: 'Malformed request',
      detail: unknown === undefined
        ? failures.map((f) => `${f.path || 'body'} ${f.message}`).join(' ')
        : 'Unknown property. Return in this system is expressed as a profit amount added to a disclosed cost, never as a proportion, and there is no field to carry one.',
      reason: unknown === undefined ? 'SCHEMA_VALIDATION_FAILED' : 'UNKNOWN_PROPERTY',
      ...(unknown === undefined ? {} : { control: 'SH-01' as const }),
      correlationId,
    }));
  }

  const body = parsed as RaiseRequestBody;
  const keyed = keyRequest({
    tenantId: principal.tenantId,
    programmeId: body.programmeId,
    counterpartyId: body.counterpartyId,
    // Derived from the credential, never from the body.
    channel: principal.channel,
    invoiceUuid: body.tradeReference.invoiceUuid ?? `po-${randomUUID()}`,
    invoiceNumber: body.partnerReference ?? body.tradeReference.invoiceUuid ?? '—',
    issuerCr: body.tradeReference.issuerCr,
    recipientCr: body.tradeReference.recipientCr,
    amountMinorUnits: BigInt(body.requestedAmount.minorUnits),
    tenorDays: body.requestedTenorDays,
    // The maker of a partner-raised request is the partner. A person reviews.
    maker: { principalId: principal.partnerId, tenantId: MAKER.tenantId },
    partnerId: principal.partnerId,
    credentialRef: principal.credentialRef,
    ...(body.partnerReference === undefined ? {} : { partnerReference: body.partnerReference }),
    ...(principal.channel === 'EMBEDDED_AGGREGATOR' ? { aggregatorId: principal.partnerId } : {}),
    ...(body.initiator.kind === 'AGGREGATOR_ON_BEHALF' ? { merchantMandateRef: body.initiator.merchantMandateRef } : {}),
  });
  if (!keyed.ok) return finish(422, fromRejection(keyed.error, correlationId));

  const submitted = submit(keyed.value.requestId);
  if (!submitted.ok) return finish(422, fromRejection(submitted.error, correlationId));

  const stored = findPartnerRequest(keyed.value.requestId, principal.partnerId);
  if (stored === undefined) return finish(500, problem({ status: 500, title: 'Internal error', detail: 'Quote the correlation identifier.', reason: 'INTERNAL', correlationId }));

  const wire = toWire(stored.request, stored.partnerReference);
  await idempotency.complete({ tenantId: principal.tenantId, partnerId: principal.partnerId, key, response: { status: 201, body: wire } });
  return json(201, wire, correlationId, { location: `/api/origination/v1/requests/${keyed.value.requestId}` });
}

export async function GET(request: Request): Promise<Response> {
  const correlationId = correlation(request);
  const principal = principalOr401(request, correlationId);
  if (principal instanceof Response) return principal;

  const items = listPartnerRequests(principal.partnerId).map((r) => toWire(r.request, r.partnerReference));
  return json(200, { items, nextCursor: null }, correlationId);
}
