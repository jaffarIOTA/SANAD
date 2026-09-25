/**
 * Eligibility pre-check, hosted in the workbench for development (BRD §5).
 *
 * Answers what the institution's credit policy would decide on the facts held
 * today. Creates nothing: no request, no decision, no snapshot. The only
 * state it touches is the idempotency store, so the same question asked
 * twice gets the same answer.
 */

import { correlation, json, principalOr401, refuse } from '../shared.ts';

import { preCheck } from '@sanad/core/decisioning/eligibility.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { isTenantCode, loadAllForTenant } from '@sanad/config/loader.ts';
import { validatorFor } from '@sanad/origination/contract.ts';
import { fingerprint, inMemoryIdempotencyStore, type IdempotencyStore } from '@sanad/origination/idempotency.ts';
import { hasScope } from '@sanad/origination/principal.ts';
import { fromRejection, problem } from '@sanad/origination/problem.ts';
import { eligibilityToWire, type EligibilityRequestBody } from '@sanad/origination/representation.ts';
import { developmentSnapshots } from '@sanad/origination/snapshots.ts';

import { developmentAttestation } from '../../../../../server/store.ts';

const validate = validatorFor('EligibilityRequest');
const snapshots = developmentSnapshots();

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
    return refuse(problem({ status: 400, kind: 'malformed-request', title: 'Malformed request', detail: 'An Idempotency-Key header carrying a UUID is required.', reason: 'IDEMPOTENCY_KEY_MISSING', correlationId }));
  }
  const raw = await request.text();
  const scope = { tenantId: principal.tenantId, partnerId: principal.partnerId, key };
  const reservation = await idempotency.reserve({ ...scope, fingerprint: fingerprint('POST', '/eligibility', raw) });
  if (reservation.kind === 'REPLAY') return json(reservation.response.status, reservation.response.body, correlationId, { 'idempotent-replay': 'true' });
  if (reservation.kind !== 'FRESH') {
    return refuse(problem({ status: 409, kind: 'conflict', title: 'Idempotency conflict', detail: 'This Idempotency-Key has already been used with a different request body.', reason: 'IDEMPOTENCY_KEY_REUSED', correlationId }));
  }
  const finish = async (status: number, body: unknown): Promise<Response> => {
    await idempotency.complete({ ...scope, response: { status, body } });
    return json(status, body, correlationId);
  };

  let parsed: unknown;
  try { parsed = raw.trim() === '' ? {} : JSON.parse(raw); } catch {
    return finish(400, problem({ status: 400, kind: 'malformed-request', title: 'Malformed request', detail: 'The request body is not valid JSON.', reason: 'MALFORMED_JSON', correlationId }));
  }
  const failures = validate(parsed);
  if (failures.length > 0) {
    const unknown = failures.find((f) => f.unknownProperty !== undefined);
    return finish(400, problem({
      status: 400, kind: 'malformed-request', title: 'Malformed request',
      detail: unknown === undefined ? failures.map((f) => `${f.path || 'body'} ${f.message}`).join(' ') : 'Unknown property. Eligibility is whether the institution would trade, not a price; there is no field for a proportion.',
      reason: unknown === undefined ? 'SCHEMA_VALIDATION_FAILED' : 'UNKNOWN_PROPERTY',
      ...(unknown === undefined ? {} : { control: 'SH-01' as const }),
      correlationId,
    }));
  }
  const body = parsed as EligibilityRequestBody;
  if (!isTenantCode(principal.tenantId)) return finish(500, problem({ status: 500, title: 'Internal error', detail: 'Quote the correlation identifier.', reason: 'INTERNAL', correlationId }));
  const all = loadAllForTenant(principal.tenantId);
  if (!all.ok) return finish(422, fromRejection(all.error, correlationId));

  const at = developmentAttestation();
  const snapshot = await snapshots.assemble({ tenantId: principal.tenantId, counterpartyId: body.counterpartyId, programmeId: body.programmeId, at });
  if (!snapshot.ok) return finish(422, fromRejection(snapshot.error, correlationId));

  const outcome = preCheck(all.value.creditPolicies, {
    snapshot: snapshot.value,
    requestedAmount: money(BigInt(body.requestedAmount.minorUnits), body.requestedAmount.currency),
    requestedTenorDays: body.requestedTenorDays,
    evaluatedAt: at,
  });
  if (!outcome.ok) return finish(422, fromRejection(outcome.error, correlationId));
  return finish(200, eligibilityToWire(outcome.value));
}
