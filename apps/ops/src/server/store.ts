/**
 * An in-memory store for the workbench.
 *
 * Process-local and lost on restart. It exists so the maker–checker journey
 * can be walked end to end before there is a database — see ADR 0001. Every
 * mutation goes through the domain functions in `core/origination`, so what
 * you are exercising is the real state machine with a toy repository behind
 * it, not a mock of the state machine.
 *
 * When the database arrives, this file is what gets replaced.
 */

import {
  type AwaitingReview,
  type AwaitingServicingResponse,
  type Keying,
  type OriginationRequest,
  type OriginationRequestCore,
  type Principal,
  type ServicingOutcome,
  approve,
  raise,
  recordServicingOutcome,
  rejectRequest,
  returnToMaker,
  submitForReview,
} from '@sanad/core/origination/request.ts';
import type { OriginationChannel } from '@sanad/core/origination/channel.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type TsaInstant, tsaInstant } from '@sanad/core/time/tsa.ts';

/**
 * Stands in for the timestamping authority adapter.
 *
 * The real one verifies an RFC 3161 token and is the only thing that can
 * produce an attested instant in production. This is the development
 * substitute, and it is named so that it is obvious in a diff. Nothing here
 * feeds a sequencing gate — gate timing comes from the TSA adapter and from
 * nowhere else (SH-06).
 */
function developmentAttestation(): TsaInstant {
  return tsaInstant({
    verified: true,
    genTimeEpochSeconds: BigInt(Math.floor(Date.now() / 1000)),
    tokenDigest: 'development-substitute',
    authorityId: 'development',
  });
}

/**
 * Held on `globalThis`, not in a module-level `const`.
 *
 * A server action and the page that reads its result are compiled into
 * separate module graphs, and a module-level Map is therefore instantiated
 * more than once — the write lands in one copy and the read misses it. Hanging
 * the state off the global keeps one copy per process, and survives hot reload
 * in development too.
 *
 * This is a symptom of the store being in memory at all. It goes away with the
 * database (ADR 0001), and so does this comment.
 */
interface DevelopmentState {
  readonly requests: Map<string, OriginationRequest>;
  readonly invoiceNumbers: Map<string, string>;
  sequence: number;
  seeded: boolean;
}

const GLOBAL_KEY = Symbol.for('sanad.ops.developmentStore');
const globalScope = globalThis as unknown as Record<symbol, DevelopmentState | undefined>;

const state: DevelopmentState = (globalScope[GLOBAL_KEY] ??= {
  requests: new Map<string, OriginationRequest>(),
  invoiceNumbers: new Map<string, string>(),
  sequence: 0,
  seeded: false,
});

const REQUESTS = state.requests;

function nextRequestId(): string {
  state.sequence += 1;
  return `req_${String(state.sequence).padStart(5, '0')}`;
}

export interface KeyRequestInput {
  readonly tenantId: string;
  readonly programmeId: string;
  readonly counterpartyId: string;
  readonly channel: OriginationChannel;
  readonly invoiceUuid: string;
  readonly invoiceNumber: string;
  readonly issuerCr: string;
  readonly recipientCr: string;
  readonly amountMinorUnits: bigint;
  readonly tenorDays: number;
  readonly maker: Principal;
  /** Required on the embedded channel: the merchant's own mandate. */
  readonly merchantMandateRef?: string;
  readonly aggregatorId?: string;
}

/** Display shape. The screens never reach into the domain union directly. */
export interface RequestRow {
  readonly requestId: string;
  readonly state: OriginationRequest['state'];
  readonly channel: OriginationChannel;
  readonly counterpartyId: string;
  readonly invoiceNumber: string;
  readonly amountMinorUnits: bigint;
  readonly makerPrincipalId?: string;
  readonly servicing?: ServicingOutcome;
  readonly note?: string;
  readonly reasonCode?: string;
  readonly contraryJustification?: string;
}

const INVOICE_NUMBERS = state.invoiceNumbers;

export function toRow(requestId: string, request: OriginationRequest): RequestRow {
  const core = request.core;
  return {
    requestId,
    state: request.state,
    channel: core.channel,
    counterpartyId: core.counterpartyId,
    invoiceNumber: INVOICE_NUMBERS.get(requestId) ?? '—',
    amountMinorUnits: core.requestedAmount.minorUnits,
    ...('maker' in request ? { makerPrincipalId: request.maker.principalId } : {}),
    ...('servicing' in request && request.servicing !== undefined
      ? { servicing: request.servicing }
      : {}),
    ...('note' in request ? { note: request.note } : {}),
    ...('reasonCode' in request ? { reasonCode: request.reasonCode } : {}),
    ...('contraryToServicing' in request && request.contraryToServicing !== undefined
      ? { contraryJustification: request.contraryToServicing.justification }
      : {}),
  };
}

// -- Commands -----------------------------------------------------------------

export function keyRequest(input: KeyRequestInput): Result<RequestRow> {
  const requestId = nextRequestId();

  const identification =
    input.channel === 'EMBEDDED_AGGREGATOR'
      ? ({
          kind: 'AGGREGATOR_ON_BEHALF' as const,
          aggregatorId: input.aggregatorId ?? '',
          credentialRef: 'cred-development',
          merchantMandateRef: input.merchantMandateRef ?? '',
        } satisfies OriginationRequestCore['identification'])
      : ({ kind: 'STAFF_PRINCIPAL' as const, principalId: input.maker.principalId });

  const core: OriginationRequestCore = {
    requestId,
    tenantId: input.tenantId,
    programmeId: input.programmeId,
    counterpartyId: input.counterpartyId,
    channel: input.channel,
    identification,
    tradeReference: {
      type: 'CLEARED_INVOICE',
      invoiceUuid: input.invoiceUuid,
      invoiceHash: 'development-hash',
      issuerCr: input.issuerCr,
      recipientCr: input.recipientCr,
    },
    requestedAmount: money(input.amountMinorUnits),
    requestedTenorDays: input.tenorDays,
    correlationId: `cor_${requestId}`,
    raisedAt: developmentAttestation(),
  };

  const keyed = raise({ core, maker: input.maker });
  if (!keyed.ok) return keyed;

  INVOICE_NUMBERS.set(requestId, input.invoiceNumber);
  REQUESTS.set(requestId, keyed.value);
  return ok(toRow(requestId, keyed.value));
}

export function submit(requestId: string): Result<RequestRow> {
  const current = REQUESTS.get(requestId);
  if (current?.state !== 'KEYING') return notInState(requestId, 'KEYING');

  const next = submitForReview(current as Keying, developmentAttestation());
  if (!next.ok) return next;

  REQUESTS.set(requestId, next.value);
  return ok(toRow(requestId, next.value));
}

/**
 * Simulate the servicing platform answering.
 *
 * In production this arrives from the core banking adapter, asynchronously.
 * Exposed as a command here so the two-stage flow can be walked by hand.
 */
export function applyServicingOutcome(
  requestId: string,
  outcome: ServicingOutcome,
): Result<RequestRow> {
  const current = REQUESTS.get(requestId);
  if (current?.state !== 'AWAITING_SERVICING_RESPONSE') {
    return notInState(requestId, 'AWAITING_SERVICING_RESPONSE');
  }

  const next = recordServicingOutcome(current as AwaitingServicingResponse, outcome);
  if (!next.ok) return next;

  REQUESTS.set(requestId, next.value);
  return ok(toRow(requestId, next.value));
}

export function approveRequest(
  requestId: string,
  checker: Principal,
  contraryJustification?: string,
): Result<RequestRow> {
  const current = REQUESTS.get(requestId);
  if (current?.state !== 'AWAITING_REVIEW') return notInState(requestId, 'AWAITING_REVIEW');

  const next = approve(
    current as AwaitingReview,
    checker,
    developmentAttestation(),
    contraryJustification,
  );
  if (!next.ok) return next;

  REQUESTS.set(requestId, next.value);
  return ok(toRow(requestId, next.value));
}

export function returnRequest(
  requestId: string,
  reviewer: Principal,
  note: string,
): Result<RequestRow> {
  const current = REQUESTS.get(requestId);
  if (current?.state !== 'AWAITING_REVIEW') return notInState(requestId, 'AWAITING_REVIEW');

  const next = returnToMaker(current as AwaitingReview, reviewer, note);
  if (!next.ok) return next;

  REQUESTS.set(requestId, next.value);
  return ok(toRow(requestId, next.value));
}

export function declineRequest(
  requestId: string,
  reviewer: Principal,
  reasonCode: string,
): Result<RequestRow> {
  const current = REQUESTS.get(requestId);
  if (current?.state !== 'AWAITING_REVIEW') return notInState(requestId, 'AWAITING_REVIEW');

  const next = rejectRequest(current as AwaitingReview, reviewer, reasonCode);
  if (!next.ok) return next;

  REQUESTS.set(requestId, next.value);
  return ok(toRow(requestId, next.value));
}

// -- Queries ------------------------------------------------------------------

export function listRequests(): readonly RequestRow[] {
  return [...REQUESTS.entries()]
    .map(([id, request]) => toRow(id, request))
    .sort((a, b) => b.requestId.localeCompare(a.requestId));
}

export function findRequest(requestId: string): RequestRow | undefined {
  const request = REQUESTS.get(requestId);
  return request === undefined ? undefined : toRow(requestId, request);
}

function notInState(requestId: string, expected: string): Result<RequestRow> {
  return reject(
    'OP-DETERMINACY',
    'REQUEST_NOT_IN_EXPECTED_STATE',
    `This request is not in ${expected}; it may have moved since the page was loaded`,
    { requestId, expected },
  );
}

// -- Seed ---------------------------------------------------------------------

const MAKER_ONE: Principal = { principalId: 'stf-maker-01', tenantId: 'bank-a' };

if (!state.seeded) {
  state.seeded = true;
  const seeded = keyRequest({
    tenantId: 'bank-a',
    programmeId: 'prg-0001',
    counterpartyId: 'Al-Ufuq Materials Company Limited',
    channel: 'MAKER_CHECKER',
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000001',
    invoiceNumber: '452100',
    issuerCr: '1010000002',
    recipientCr: '7001000001',
    amountMinorUnits: 18_500_000n,
    tenorDays: 90,
    maker: MAKER_ONE,
  });
  if (seeded.ok) submit(seeded.value.requestId);
}
