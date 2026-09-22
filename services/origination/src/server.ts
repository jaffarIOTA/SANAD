/**
 * The origination service.
 *
 * `node:http` and a small router, with no web framework. The surface is four
 * operations; a framework would add a dependency tree a bank's supply-chain
 * review has to account for (SDD §6.12) in exchange for routing we can write
 * in thirty lines. It also keeps the service free of anything that assumes a
 * particular gateway or runtime (§5).
 *
 * The order of the pipeline is the important part, and it is deliberate:
 *
 *   1. correlation identifier — so every later step can be traced
 *   2. authenticate          — tenant, channel and partner come from here
 *   3. authorise             — scope
 *   4. read and parse body   — bounded
 *   5. idempotency reserve   — before any domain work
 *   6. validate against the contract
 *   7. domain
 *   8. record the response against the key
 *
 * Idempotency is claimed *before* validation, not after, so a malformed retry
 * cannot slip past a key that a well-formed one already holds. Validation
 * comes from the published document rather than from hand-written checks —
 * see `contract.ts`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import {
  type OriginationRequestCore,
  type Principal,
  raise,
  submitForReview,
  withdraw,
} from '@sanad/core/origination/request.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { type TsaInstant, tsaInstant } from '@sanad/core/time/tsa.ts';

import { validatorFor, type Validator } from './contract.ts';
import { fromRejection, problem, type Problem } from './problem.ts';
import {
  fingerprint,
  type IdempotencyStore,
  type StoredResponse,
} from './idempotency.ts';
import {
  authenticate,
  hasScope,
  type CredentialRegistry,
  type PartnerPrincipal,
} from './principal.ts';
import { toWire, type RaiseRequestBody } from './representation.ts';
import type { RequestRepository, StoredRequest } from './repository.ts';

export const BASE_PATH = '/origination/v1';

/** Bodies are bounded before they are read, not after. */
const MAX_BODY_BYTES = 64 * 1024;

export interface TimestampPort {
  /** The attested instant for an act happening now. */
  attest(): Promise<TsaInstant>;
}

/**
 * Development substitute for the timestamping authority.
 *
 * Named so it is obvious in a diff and obvious in a deployment. Nothing it
 * produces feeds a sequencing gate — gate timing comes from the real adapter
 * (SH-06) — but from UAT onward even this must be an accredited authority.
 * See ClaudeRecommendations.md E-04.
 */
export function developmentTimestamps(): TimestampPort {
  return {
    attest(): Promise<TsaInstant> {
      return Promise.resolve(
        tsaInstant({
          verified: true,
          genTimeEpochSeconds: BigInt(Math.floor(Date.now() / 1000)),
          tokenDigest: 'development-substitute',
          authorityId: 'development',
        }),
      );
    },
  };
}

export interface ServiceDependencies {
  readonly repository: RequestRepository;
  readonly idempotency: IdempotencyStore;
  readonly credentials: CredentialRegistry;
  readonly timestamps: TimestampPort;
}

// -- Plumbing -----------------------------------------------------------------

interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly problem?: boolean;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({
  status,
  body,
  ...(headers === undefined ? {} : { headers }),
});

const fail = (p: Problem): Reply => ({ status: p.status, body: p, problem: true });

function send(response: ServerResponse, reply: Reply, correlationId: string): void {
  const headers: Record<string, string> = {
    'content-type': reply.problem === true ? 'application/problem+json' : 'application/json',
    'x-correlation-id': correlationId,
    // The contract names no gateway header, and neither does the response.
    'cache-control': 'no-store',
    ...reply.headers,
  };
  response.writeHead(reply.status, headers);
  response.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
}

function readBody(request: IncomingMessage): Promise<{ ok: true; raw: string } | { ok: false }> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve({ ok: false });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolve({ ok: true, raw: Buffer.concat(chunks).toString('utf8') });
    });
    request.on('error', () => {
      resolve({ ok: false });
    });
  });
}

// -- The service --------------------------------------------------------------

export function createService(deps: ServiceDependencies): Server {
  const validateRaise: Validator = validatorFor('RaiseRequest');
  let sequence = 0;

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      // Nothing about the failure reaches the caller beyond the correlation
      // identifier. Internal detail, credentials and personal data stay in.
      const correlationId = randomUUID();
      send(
        response,
        fail(
          problem({
            status: 500,
            title: 'Internal error',
            detail: 'An unexpected error occurred. Quote the correlation identifier.',
            reason: 'INTERNAL',
            correlationId,
          }),
        ),
        correlationId,
      );
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const supplied = request.headers['x-correlation-id'];
    const correlationId =
      typeof supplied === 'string' && /^[0-9a-f-]{36}$/i.test(supplied) ? supplied : randomUUID();

    const url = new URL(request.url ?? '/', 'http://service.invalid');
    const method = (request.method ?? 'GET').toUpperCase();

    if (!url.pathname.startsWith(BASE_PATH)) {
      send(response, notFound(correlationId, 'ROUTE_NOT_FOUND'), correlationId);
      return;
    }
    const path = url.pathname.slice(BASE_PATH.length) || '/';

    // 2. Authenticate. Tenant, channel and partner all come from here — never
    //    from the body, never from a gateway header.
    const auth = authenticate(
      typeof request.headers.authorization === 'string'
        ? request.headers.authorization
        : undefined,
      deps.credentials,
    );
    if (!auth.ok) {
      send(
        response,
        fail(
          problem({
            status: 401,
            title: 'Unauthenticated',
            detail:
              auth.reason === 'CREDENTIAL_MISSING'
                ? 'No credential was presented.'
                : 'The credential was not recognised.',
            reason: auth.reason,
            correlationId,
          }),
        ),
        correlationId,
      );
      return;
    }
    const principal = auth.principal;

    const write = method !== 'GET' && method !== 'HEAD';
    if (!hasScope(principal, write ? 'origination:write' : 'origination:read')) {
      send(response, forbidden(correlationId), correlationId);
      return;
    }

    // -- Routing ------------------------------------------------------------
    const detail = /^\/requests\/([^/]+)$/.exec(path);
    const withdrawal = /^\/requests\/([^/]+)\/withdrawal$/.exec(path);

    if (path === '/requests' && method === 'POST') {
      await withIdempotency(request, response, correlationId, principal, method, path, (body) =>
        raiseHandler(body, principal, correlationId),
      );
      return;
    }
    if (path === '/requests' && method === 'GET') {
      send(response, await listHandler(url, principal), correlationId);
      return;
    }
    if (detail !== null && method === 'GET') {
      send(response, await getHandler(detail[1] ?? '', principal, correlationId), correlationId);
      return;
    }
    if (withdrawal !== null && method === 'PUT') {
      const requestId = withdrawal[1] ?? '';
      await withIdempotency(request, response, correlationId, principal, method, path, (body) =>
        withdrawHandler(requestId, body, principal, correlationId),
      );
      return;
    }
    if (path === '/requests' || detail !== null || withdrawal !== null) {
      send(
        response,
        fail(
          problem({
            status: 405,
            title: 'Method not allowed',
            detail: `${method} is not allowed on this path.`,
            reason: 'METHOD_NOT_ALLOWED',
            correlationId,
          }),
        ),
        correlationId,
      );
      return;
    }

    send(response, notFound(correlationId, 'ROUTE_NOT_FOUND'), correlationId);
  }

  // -- Idempotent write path ----------------------------------------------

  async function withIdempotency(
    request: IncomingMessage,
    response: ServerResponse,
    correlationId: string,
    principal: PartnerPrincipal,
    method: string,
    path: string,
    run: (body: unknown) => Promise<Reply>,
  ): Promise<void> {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[0-9a-f-]{36}$/i.test(key)) {
      send(
        response,
        fail(
          problem({
            status: 400,
            kind: 'malformed-request',
            title: 'Malformed request',
            detail: 'A state-changing request requires an Idempotency-Key header carrying a UUID.',
            reason: 'IDEMPOTENCY_KEY_MISSING',
            correlationId,
          }),
        ),
        correlationId,
      );
      return;
    }

    const read = await readBody(request);
    if (!read.ok) {
      send(
        response,
        fail(
          problem({
            status: 413,
            title: 'Payload too large',
            detail: 'The request body exceeded the permitted size.',
            reason: 'PAYLOAD_TOO_LARGE',
            correlationId,
          }),
        ),
        correlationId,
      );
      return;
    }

    // 5. Claim the key before any work, so a retry cannot race the original.
    const reservation = await deps.idempotency.reserve({
      tenantId: principal.tenantId,
      partnerId: principal.partnerId,
      key,
      fingerprint: fingerprint(method, path, read.raw),
    });

    if (reservation.kind === 'REPLAY') {
      send(
        response,
        {
          status: reservation.response.status,
          body: reservation.response.body,
          headers: { 'idempotent-replay': 'true' },
          problem: reservation.response.status >= 400,
        },
        correlationId,
      );
      return;
    }
    if (reservation.kind === 'CONFLICT' || reservation.kind === 'IN_FLIGHT') {
      send(
        response,
        fail(
          problem({
            status: 409,
            kind: 'conflict',
            title: 'Idempotency conflict',
            detail:
              reservation.kind === 'CONFLICT'
                ? 'This Idempotency-Key has already been used with a different request body.'
                : 'A request with this Idempotency-Key is still being processed.',
            reason:
              reservation.kind === 'CONFLICT'
                ? 'IDEMPOTENCY_KEY_REUSED'
                : 'IDEMPOTENCY_KEY_IN_FLIGHT',
            correlationId,
          }),
        ),
        correlationId,
      );
      return;
    }

    let reply: Reply;
    try {
      let parsed: unknown;
      try {
        parsed = read.raw.trim() === '' ? {} : JSON.parse(read.raw);
      } catch {
        reply = fail(
          problem({
            status: 400,
            kind: 'malformed-request',
            title: 'Malformed request',
            detail: 'The request body is not valid JSON.',
            reason: 'MALFORMED_JSON',
            correlationId,
          }),
        );
        await complete(principal, key, reply);
        send(response, reply, correlationId);
        return;
      }

      reply = await run(parsed);
    } catch (error) {
      // The key is released so the caller can retry the instruction it never
      // received an answer to.
      await deps.idempotency.release({
        tenantId: principal.tenantId,
        partnerId: principal.partnerId,
        key,
      });
      throw error;
    }

    await complete(principal, key, reply);
    send(response, reply, correlationId);
  }

  async function complete(
    principal: PartnerPrincipal,
    key: string,
    reply: Reply,
  ): Promise<void> {
    const stored: StoredResponse = { status: reply.status, body: reply.body };
    await deps.idempotency.complete({
      tenantId: principal.tenantId,
      partnerId: principal.partnerId,
      key,
      response: stored,
    });
  }

  // -- Operations ----------------------------------------------------------

  async function raiseHandler(
    body: unknown,
    principal: PartnerPrincipal,
    correlationId: string,
  ): Promise<Reply> {
    // 6. Validate against the published contract, not against a local copy of
    //    what we remember it saying.
    const failures = validateRaise(body);
    if (failures.length > 0) return malformed(failures, correlationId);

    const payload = body as RaiseRequestBody;

    // The initiator's identity comes from the credential. The only thing the
    // body contributes is the merchant's own mandate, which the credential
    // cannot establish.
    const identification: OriginationRequestCore['identification'] =
      principal.channel === 'EMBEDDED_AGGREGATOR'
        ? {
            kind: 'AGGREGATOR_ON_BEHALF',
            aggregatorId: principal.partnerId,
            credentialRef: principal.credentialRef,
            merchantMandateRef:
              payload.initiator.kind === 'AGGREGATOR_ON_BEHALF'
                ? payload.initiator.merchantMandateRef
                : '',
          }
        : {
            kind: 'PARTNER_SYSTEM',
            partnerId: principal.partnerId,
            credentialRef: principal.credentialRef,
          };

    const requestId = await deps.repository.nextRequestId();
    const raisedAt = await deps.timestamps.attest();

    const core: OriginationRequestCore = {
      requestId,
      tenantId: principal.tenantId,
      programmeId: payload.programmeId,
      counterpartyId: payload.counterpartyId,
      channel: principal.channel,
      identification,
      tradeReference: {
        type: payload.tradeReference.type,
        ...(payload.tradeReference.invoiceUuid === undefined
          ? {}
          : { invoiceUuid: payload.tradeReference.invoiceUuid }),
        ...(payload.tradeReference.invoiceHash === undefined
          ? {}
          : { invoiceHash: payload.tradeReference.invoiceHash }),
        issuerCr: payload.tradeReference.issuerCr,
        recipientCr: payload.tradeReference.recipientCr,
      },
      // A string of digits, never a JSON number, so no float touches this.
      requestedAmount: money(BigInt(payload.requestedAmount.minorUnits)),
      requestedTenorDays: payload.requestedTenorDays,
      correlationId,
      raisedAt,
    };

    const maker: Principal = {
      principalId: principal.partnerId,
      tenantId: principal.tenantId,
    };

    const keyed = raise({ core, maker });
    if (!keyed.ok) return fail(fromRejection(keyed.error, correlationId));

    // Partner channels consult the servicing platform, so this lands in
    // AWAITING_SERVICING_RESPONSE rather than in front of a person. The
    // return type is the union of both landing states, so nothing here
    // assumes the shorter path.
    const submitted = submitForReview(keyed.value, raisedAt);
    if (!submitted.ok) return fail(fromRejection(submitted.error, correlationId));

    sequence += 1;
    const record: StoredRequest = {
      requestId,
      tenantId: principal.tenantId,
      partnerId: principal.partnerId,
      request: submitted.value,
      ...(payload.partnerReference === undefined
        ? {}
        : { partnerReference: payload.partnerReference }),
      sequence,
    };
    await deps.repository.save(record);

    return ok(201, toWire(record.request, record.partnerReference), {
      location: `${BASE_PATH}/requests/${requestId}`,
    });
  }

  async function getHandler(
    requestId: string,
    principal: PartnerPrincipal,
    correlationId: string,
  ): Promise<Reply> {
    const record = await deps.repository.find(
      principal.tenantId,
      principal.partnerId,
      requestId,
    );
    if (record === undefined) return notFound(correlationId, 'REQUEST_NOT_FOUND');
    return ok(200, toWire(record.request, record.partnerReference));
  }

  async function listHandler(url: URL, principal: PartnerPrincipal): Promise<Reply> {
    const states = url.searchParams.getAll('state');
    const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '25', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25;
    const cursor = url.searchParams.get('cursor') ?? undefined;

    const page = await deps.repository.list({
      tenantId: principal.tenantId,
      partnerId: principal.partnerId,
      ...(states.length === 0 ? {} : { states: states as never }),
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });

    return ok(200, {
      items: page.items.map((r) => toWire(r.request, r.partnerReference)),
      nextCursor: page.nextCursor,
    });
  }

  async function withdrawHandler(
    requestId: string,
    body: unknown,
    principal: PartnerPrincipal,
    correlationId: string,
  ): Promise<Reply> {
    const reason = (body as { reason?: unknown } | null)?.reason;
    if (typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 500) {
      return malformed(
        [{ path: '/reason', message: "Missing required property 'reason'." }],
        correlationId,
      );
    }

    const record = await deps.repository.find(
      principal.tenantId,
      principal.partnerId,
      requestId,
    );
    if (record === undefined) return notFound(correlationId, 'REQUEST_NOT_FOUND');

    const current = record.request;

    // Idempotent by nature: withdrawing an already withdrawn request is the
    // same outcome, not an error. This is why the operation is a PUT.
    if (current.state === 'WITHDRAWN') {
      return ok(200, toWire(current, record.partnerReference));
    }

    if (
      current.state === 'APPROVED' ||
      current.state === 'REJECTED'
    ) {
      return fail(
        problem({
          status: 422,
          kind: 'control-rejection',
          title: 'Refused',
          detail: 'A request that has been decided cannot be withdrawn.',
          reason: 'NOT_WITHDRAWABLE',
          control: 'OP-DETERMINACY',
          correlationId,
          context: { state: current.state },
        }),
      );
    }

    const withdrawn = withdraw(current);
    await deps.repository.save({ ...record, request: withdrawn });
    return ok(200, toWire(withdrawn, record.partnerReference));
  }

  // -- Shared replies ------------------------------------------------------

  function malformed(
    failures: readonly { path: string; message: string; unknownProperty?: string }[],
    correlationId: string,
  ): Reply {
    const unknown = failures.find((f) => f.unknownProperty !== undefined);
    return fail(
      problem({
        status: 400,
        kind: 'malformed-request',
        title: 'Malformed request',
        detail:
          unknown === undefined
            ? failures.map((f) => `${f.path || 'body'} ${f.message}`).join(' ')
            : 'Unknown property. Return in this system is expressed as a profit amount added to a disclosed cost, never as a proportion, and there is no field to carry one.',
        reason: unknown === undefined ? 'SCHEMA_VALIDATION_FAILED' : 'UNKNOWN_PROPERTY',
        ...(unknown === undefined ? {} : { control: 'SH-01' as const }),
        correlationId,
      }),
    );
  }

  function notFound(correlationId: string, reason: string): Reply {
    return fail(
      problem({
        status: 404,
        title: 'Not found',
        detail: 'No such resource within this credential’s scope.',
        reason,
        correlationId,
      }),
    );
  }

  function forbidden(correlationId: string): Reply {
    return fail(
      problem({
        status: 403,
        title: 'Forbidden',
        detail: 'The credential does not carry the scope required for this operation.',
        reason: 'SCOPE_INSUFFICIENT',
        correlationId,
      }),
    );
  }
}
