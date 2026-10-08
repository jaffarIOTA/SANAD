/**
 * POST /api/origination/v1/business-applications — the stage-5 hand-over
 * from the upstream customer-record system (ADR 0005; the contract is
 * `api/openapi/origination.v1.yaml`, schema `BusinessHandover`).
 *
 * Tenant from the credential, never the body; currency from the tenant's
 * onboarding, never the body (the closed schema has no field for either).
 * Idempotency-Key replays a response verbatim; the hand-over itself is
 * idempotent on `upstreamRef` (200 with the existing application).
 * The application is durable before the 201 is sent. If the hand-over or its
 * write throws, or the write is refused (409 STALE_APPLICATION, 503
 * PERSISTENCE_FAILED — nothing written), the Idempotency-Key is released and
 * the answer not stored, so the caller can retry with the same key.
 * No identity number anywhere in the body (contact and upstream reference
 * included) — refused with a named control before the service is called.
 */

import type { TenantCode } from '@sanad/config/loader.ts';
import { containsIdentityNumber } from '@sanad/core/origination/business-application.ts';
import { validatorFor } from '@sanad/origination/contract.ts';
import { fingerprint, type IdempotencyStore } from '@sanad/origination/idempotency.ts';
import { fromRejection, problem } from '@sanad/origination/problem.ts';

import { handOver, isSettleFailure, mutateBusiness, syncBusiness } from '../../../../../server/business.ts';
import { idempotencyLedger } from '../../../../../server/persistence.ts';
import { correlation, json, principalOr401, refuse } from '../shared.ts';
import { businessTenantOr403, toStatusWire } from './shared.ts';

const validateHandover = validatorFor('BusinessHandover');

const IDEMPOTENCY_KEY = Symbol.for('sanad.ops.idempotency');
const idempotency: IdempotencyStore = ((globalThis as Record<symbol, IdempotencyStore | undefined>)[IDEMPOTENCY_KEY] ??=
  idempotencyLedger());

interface HandoverBody {
  readonly applicationId: string;
  readonly upstreamRef: string;
  readonly applicant: {
    readonly businessNameEn: string;
    readonly businessNameAr?: string;
    readonly registrationRef: string;
    readonly sector: string;
    readonly yearsInOperation: number;
    readonly owners: readonly { readonly displayName: string; readonly ref: string }[];
    readonly upstreamVerificationRefs: readonly string[];
  };
  readonly productCode: string;
  readonly variantCode: string;
  readonly purpose: string;
  readonly requestedMinorUnits: string;
  readonly tenorMonths: number;
  readonly graceMonths?: number;
  readonly contributionPerTenThousand?: number;
  readonly contact?: { readonly partyRef: string; readonly emailMasked?: string; readonly mobileMasked?: string };
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = correlation(request);
  const principal = principalOr401(request, correlationId);
  if (principal instanceof Response) return principal;
  const tenant = await businessTenantOr403(principal, 'business:write', correlationId);
  if (tenant instanceof Response) return tenant;

  const key = request.headers.get('idempotency-key');
  if (key === null || !/^[0-9a-f-]{36}$/i.test(key)) {
    return refuse(
      problem({
        status: 400,
        kind: 'malformed-request',
        title: 'Malformed request',
        detail: 'A state-changing request requires an Idempotency-Key header carrying a UUID.',
        reason: 'IDEMPOTENCY_KEY_MISSING',
        correlationId,
      }),
    );
  }

  await syncBusiness(tenant);
  const raw = await request.text();
  const reservation = await idempotency.reserve({
    tenantId: principal.tenantId,
    partnerId: principal.partnerId,
    key,
    fingerprint: fingerprint('POST', '/business-applications', raw),
  });
  if (reservation.kind === 'REPLAY')
    return json(reservation.response.status, reservation.response.body, correlationId, { 'idempotent-replay': 'true' });
  if (reservation.kind !== 'FRESH') {
    return refuse(
      problem({
        status: 409,
        kind: 'conflict',
        title: 'Idempotency conflict',
        detail:
          reservation.kind === 'CONFLICT'
            ? 'This Idempotency-Key has already been used with a different request body.'
            : 'A request with this Idempotency-Key is still being processed.',
        reason: reservation.kind === 'CONFLICT' ? 'IDEMPOTENCY_KEY_REUSED' : 'IDEMPOTENCY_KEY_IN_FLIGHT',
        correlationId,
      }),
    );
  }
  const finish = async (status: number, body: unknown, extra: Record<string, string> = {}): Promise<Response> => {
    await idempotency.complete({
      tenantId: principal.tenantId,
      partnerId: principal.partnerId,
      key,
      response: { status, body },
    });
    return json(status, body, correlationId, extra);
  };

  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    return finish(
      400,
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
  const failures = validateHandover(parsed);
  if (failures.length > 0) {
    const unknown = failures.find((f) => f.unknownProperty !== undefined);
    return finish(
      400,
      problem({
        status: 400,
        kind: 'malformed-request',
        title: 'Malformed request',
        detail:
          unknown === undefined
            ? failures.map((f) => `${f.path || 'body'} ${f.message}`).join(' ')
            : `Unknown property '${unknown.unknownProperty ?? ''}'. Tenant and currency follow from the credential; there is no field for either.`,
        reason: unknown === undefined ? 'SCHEMA_VALIDATION_FAILED' : 'UNKNOWN_PROPERTY',
        correlationId,
      }),
    );
  }

  const body = parsed as HandoverBody;
  // No identity number anywhere in the body — contact, upstream reference and every other text field, not only the applicant.
  // The amount is a digit string on the wire and is not text, so it is passed over.
  if (containsIdentityNumber(body, AMOUNT_FIELDS)) {
    return finish(
      422,
      fromRejection(
        {
          control: 'OP-DETERMINACY',
          reason: 'IDENTITY_NUMBER_IN_PAYLOAD',
          detail: 'An identity number does not belong in the application record; send a reference',
        },
        correlationId,
      ),
    );
  }

  // Anything that throws from here (the service, the database) releases the key, so the caller can retry the
  // hand-over it never received an answer to — as services/origination/src/server.ts does. So does a save that
  // wrote nothing (STALE_APPLICATION, PERSISTENCE_FAILED): its answer is not stored against the key, because the
  // same request may well succeed once retried, and a stored 409 would replay the failure forever.
  const release = (): Promise<void> =>
    idempotency.release({ tenantId: principal.tenantId, partnerId: principal.partnerId, key });
  try {
    return await handOverAndAnswer(tenant, body, principal.partnerId, correlationId, finish, release);
  } catch (error) {
    await release();
    throw error;
  }
}

/** Typed amounts on the wire that look like digits but are not text. */
const AMOUNT_FIELDS: ReadonlySet<string> = new Set(['requestedMinorUnits']);

async function handOverAndAnswer(
  tenant: TenantCode,
  body: HandoverBody,
  partnerId: string,
  correlationId: string,
  finish: (status: number, body: unknown, extra?: Record<string, string>) => Promise<Response>,
  release: () => Promise<void>,
): Promise<Response> {
  // Made and written as one unit under the tenant's lock: durable before it is acknowledged.
  const result = await mutateBusiness(tenant, () =>
    handOver(
      tenant,
      {
        applicationId: body.applicationId,
        upstreamRef: body.upstreamRef,
        applicant: {
          businessNameEn: body.applicant.businessNameEn,
          ...(body.applicant.businessNameAr === undefined ? {} : { businessNameAr: body.applicant.businessNameAr }),
          registrationRef: body.applicant.registrationRef,
          sector: body.applicant.sector,
          yearsInOperation: body.applicant.yearsInOperation,
          owners: body.applicant.owners.map((o) => ({ displayName: o.displayName, ref: o.ref })),
          upstreamVerificationRefs: [...body.applicant.upstreamVerificationRefs],
        },
        productCode: body.productCode,
        variantCode: body.variantCode,
        purpose: body.purpose,
        requestedMinorUnits: BigInt(body.requestedMinorUnits),
        tenorMonths: body.tenorMonths,
        graceMonths: body.graceMonths ?? 0,
        contributionPerTenThousand: body.contributionPerTenThousand ?? 0,
        ...(body.contact === undefined
          ? {}
          : {
              contact: {
                partyRef: body.contact.partyRef,
                ...(body.contact.emailMasked === undefined ? {} : { emailMasked: body.contact.emailMasked }),
                ...(body.contact.mobileMasked === undefined ? {} : { mobileMasked: body.contact.mobileMasked }),
              },
            }),
      },
      partnerId,
    ),
  );
  if (!result.ok && isSettleFailure(result.error)) {
    // Nothing was written: refused, not acknowledged — and the key released so the same request can be retried.
    await release();
    const stale = result.error.reason === 'STALE_APPLICATION';
    const status = stale ? 409 : 503;
    return json(
      status,
      problem({
        status,
        kind: stale ? 'conflict' : 'error',
        title: stale ? 'Conflict' : 'Service unavailable',
        detail: result.error.detail,
        reason: result.error.reason,
        control: result.error.control,
        correlationId,
      }),
      correlationId,
      stale ? {} : { 'retry-after': '1' },
    );
  }
  if (!result.ok) return finish(422, fromRejection(result.error, correlationId));
  const wire = toStatusWire(result.value.view);
  return finish(result.value.created ? 201 : 200, wire, {
    location: `/api/origination/v1/business-applications/${wire.applicationId}`,
  });
}
