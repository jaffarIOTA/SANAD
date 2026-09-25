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
import { expire } from '@sanad/core/origination/request.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { loadOriginationPolicy } from '@sanad/config/loader.ts';

/**
 * The tenant's intake policy, loaded once. A malformed file throws here, at
 * start-up, rather than silently defaulting a limit away at request time.
 */
const POLICY = expectOk(loadOriginationPolicy('bank-a'));
export const originationPolicy = (): typeof POLICY => POLICY;

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
  readonly partnerReferences: Map<string, string>;
  /** Half-completed origination journeys. See `Draft` below. */
  readonly drafts: Map<string, Draft>;
  /** SH-10. invoiceUuid -> the requestId that financed it. Never purged. */
  readonly financed: Map<string, string>;
  sequence: number;
  seeded: boolean;
}

/**
 * A journey in progress.
 *
 * Deliberately *not* a domain `Keying`. `raise()` validates a whole request
 * and returns one; a half-filled wizard is not a request yet and should not
 * be able to masquerade as one. This is screen state, and it becomes a domain
 * object only at the final step, where the domain gets to refuse it.
 */
export interface Draft {
  readonly draftId: string;
  /** Chosen first. Everything else follows from it. */
  readonly invoiceUuid?: string;
  readonly programmeId?: string;
  readonly tenorDays?: number;
  readonly channel: OriginationChannel;
  readonly merchantMandateRef?: string;
  readonly aggregatorId?: string;
  readonly agentId?: string;
  readonly branchCode?: string;
}

const GLOBAL_KEY = Symbol.for('sanad.ops.developmentStore');
const globalScope = globalThis as unknown as Record<symbol, DevelopmentState | undefined>;

const state: DevelopmentState = (globalScope[GLOBAL_KEY] ??= {
  requests: new Map<string, OriginationRequest>(),
  invoiceNumbers: new Map<string, string>(),
  partnerReferences: new Map<string, string>(),
  drafts: new Map<string, Draft>(),
  financed: new Map<string, string>(),
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
  /** Required on the partner channel: who the credential belongs to. */
  readonly partnerId?: string;
  readonly credentialRef?: string;
  /** Echoed back to a partner. Not used for idempotency. */
  readonly partnerReference?: string;
  /** Required on the agent channel: who keyed it, and for which branch. */
  readonly agentId?: string;
  readonly branchCode?: string;
}

/** Display shape. The screens never reach into the domain union directly. */
export interface RequestRow {
  readonly requestId: string;
  readonly state: OriginationRequest['state'];
  readonly channel: OriginationChannel;
  readonly counterpartyId: string;
  readonly invoiceNumber: string;
  readonly amountMinorUnits: bigint;
  /**
   * When the request was raised, and when it entered the queue, as attested
   * seconds.
   *
   * Exposed so a work queue can be ordered and aged. **Operational display
   * only.** No gate is evaluated from these — gate timing comes from the TSA
   * adapter through `core/sequencing`, and nothing in `apps/` can reach it.
   */
  readonly raisedAtEpochSeconds: bigint;
  readonly submittedAtEpochSeconds?: bigint;
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
    raisedAtEpochSeconds: core.raisedAt.epochSeconds,
    ...('submittedAt' in request
      ? { submittedAtEpochSeconds: request.submittedAt.epochSeconds }
      : {}),
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

// -- Drafts -------------------------------------------------------------------

export function startDraft(channel: OriginationChannel): Draft {
  state.sequence += 1;
  const draft: Draft = { draftId: `drf_${String(state.sequence).padStart(5, '0')}`, channel };
  state.drafts.set(draft.draftId, draft);
  return draft;
}

export function findDraft(draftId: string): Draft | undefined {
  return state.drafts.get(draftId);
}

export function updateDraft(draftId: string, patch: Partial<Draft>): Draft | undefined {
  const current = state.drafts.get(draftId);
  if (current === undefined) return undefined;
  const next = { ...current, ...patch, draftId: current.draftId };
  state.drafts.set(draftId, next);
  return next;
}

export function discardDraft(draftId: string): void {
  state.drafts.delete(draftId);
}

/**
 * The financed-invoice registry (SH-10).
 *
 * Records are never purged, including after settlement — which is the whole
 * point. An invoice financed once stays financed forever, so the same trade
 * cannot be financed twice by waiting.
 *
 * In production this is `config.financed_invoice_registry` with a unique
 * constraint on `(tenant_id, invoice_uuid)`, and the constraint is what
 * actually enforces it. This map is the development stand-in.
 */
export function financedInvoices(): ReadonlyMap<string, string> {
  return state.financed;
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
      : input.channel === 'PARTNER_API'
        ? ({
            kind: 'PARTNER_SYSTEM' as const,
            partnerId: input.partnerId ?? '',
            credentialRef: input.credentialRef ?? '',
          } satisfies OriginationRequestCore['identification'])
        : input.channel === 'AGENT_ASSISTED'
          ? ({ kind: 'AGENT' as const, agentId: input.agentId ?? '', branchCode: input.branchCode ?? '' })
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

  // The policy is what makes an agent's or partner's limit real.
  const keyed = raise({ core, maker: input.maker, policy: POLICY });
  if (!keyed.ok) return keyed;

  // SH-10. Written at the moment the request is raised, not at settlement:
  // two operators keying the same invoice concurrently must not both succeed,
  // and the registry is what stops the second.
  const alreadyFinanced = state.financed.get(input.invoiceUuid);
  if (alreadyFinanced !== undefined) {
    return reject(
      'SH-10',
      'INVOICE_ALREADY_FINANCED',
      'This invoice has already been financed and cannot be financed again',
      { invoiceUuid: input.invoiceUuid, financedAs: alreadyFinanced },
    );
  }
  state.financed.set(input.invoiceUuid, requestId);

  INVOICE_NUMBERS.set(requestId, input.invoiceNumber);
  if (input.partnerReference !== undefined) state.partnerReferences.set(requestId, input.partnerReference);
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
    POLICY,
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

/**
 * Expire everything that has waited past the tenant's interval.
 *
 * The instant is supplied by the caller and attested; the store reads no
 * clock. Returns the identifiers expired so the screen can say what happened.
 */
export function expireOverdue(observedAt: TsaInstant): readonly string[] {
  const expired: string[] = [];
  for (const [requestId, request] of REQUESTS) {
    if (
      request.state !== 'AWAITING_SERVICING_RESPONSE' &&
      request.state !== 'AWAITING_REVIEW' &&
      request.state !== 'RETURNED_TO_MAKER'
    ) continue;
    const result = expire(request, POLICY, observedAt);
    if (result.ok) {
      REQUESTS.set(requestId, result.value);
      expired.push(requestId);
    }
  }
  return expired;
}

// -- Queries ------------------------------------------------------------------

export function listRequests(): readonly RequestRow[] {
  return [...REQUESTS.entries()]
    .map(([id, request]) => toRow(id, request))
    .sort((a, b) => b.requestId.localeCompare(a.requestId));
}

/**
 * The domain object itself, for the partner API's wire mapper. Scoped to the
 * partner whose credential is asking: another partner's request is reported
 * as absent, not forbidden, so the API never confirms other partners' business.
 */
export function findPartnerRequest(
  requestId: string,
  partnerId: string,
): { readonly request: OriginationRequest; readonly partnerReference?: string } | undefined {
  const request = REQUESTS.get(requestId);
  if (request === undefined) return undefined;
  const id = request.core.identification;
  if (id.kind !== 'PARTNER_SYSTEM' || id.partnerId !== partnerId) return undefined;
  const partnerReference = state.partnerReferences.get(requestId);
  return { request, ...(partnerReference === undefined ? {} : { partnerReference }) };
}

export function listPartnerRequests(
  partnerId: string,
): readonly { readonly requestId: string; readonly request: OriginationRequest; readonly partnerReference?: string }[] {
  return [...REQUESTS.entries()]
    .filter(([, r]) => r.core.identification.kind === 'PARTNER_SYSTEM' && r.core.identification.partnerId === partnerId)
    .map(([requestId, request]) => {
      const partnerReference = state.partnerReferences.get(requestId);
      return { requestId, request, ...(partnerReference === undefined ? {} : { partnerReference }) };
    })
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
/**
 * A second maker, and deliberately the same principal the workbench reviews
 * as. One seeded request is therefore this reviewer's own work, so the queue
 * demonstrates the four-eyes block instead of only claiming to enforce it.
 */
const MAKER_TWO: Principal = { principalId: 'stf-checker-01', tenantId: 'bank-a' };

interface Seed {
  readonly counterpartyId: string;
  readonly invoiceNumber: string;
  readonly invoiceUuid: string;
  readonly amountMinorUnits: bigint;
  readonly tenorDays: number;
  readonly channel: OriginationChannel;
  readonly maker: Principal;
  readonly merchantMandateRef?: string;
  readonly aggregatorId?: string;
  readonly agentId?: string;
  readonly branchCode?: string;
  /** Left in `AWAITING_SERVICING_RESPONSE` when false. */
  readonly servicingResponded?: ServicingOutcome['decision'];
}

const SEEDS: readonly Seed[] = [
  {
    counterpartyId: 'Al-Ufuq Materials Company Limited',
    invoiceNumber: '452100',
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000001',
    amountMinorUnits: 18_500_000n,
    tenorDays: 90,
    channel: 'MAKER_CHECKER',
    maker: MAKER_ONE,
  },
  {
    counterpartyId: 'Rawabi Industrial Supplies Establishment',
    invoiceNumber: '452114',
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000002',
    amountMinorUnits: 7_250_000n,
    tenorDays: 60,
    channel: 'MAKER_CHECKER',
    maker: MAKER_ONE,
  },
  {
    // Keyed by the principal the workbench reviews as. Not reviewable here.
    counterpartyId: 'Najd Logistics Company',
    invoiceNumber: '452130',
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000003',
    amountMinorUnits: 42_000_000n,
    tenorDays: 120,
    channel: 'MAKER_CHECKER',
    maker: MAKER_TWO,
  },
  {
    counterpartyId: 'Tamam Foodstuff Trading Company',
    invoiceNumber: 'AGG-88120',
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000004',
    amountMinorUnits: 3_400_000n,
    tenorDays: 45,
    channel: 'EMBEDDED_AGGREGATOR',
    maker: MAKER_ONE,
    merchantMandateRef: 'mnd_dev_0001',
    aggregatorId: 'agg-dev-01',
    servicingResponded: 'DECLINED',
  },
  {
    counterpartyId: 'Rawabi Industrial Supplies Establishment',
    invoiceNumber: '452287',
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000008',
    amountMinorUnits: 9_800_000n,
    tenorDays: 60,
    channel: 'AGENT_ASSISTED',
    maker: MAKER_ONE,
    agentId: 'agt-fo-227',
    branchCode: 'JED-03',
  },
  {
    counterpartyId: 'Bahr Al-Khaleej Shipping Establishment',
    invoiceNumber: 'AGG-88147',
    invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000005',
    amountMinorUnits: 11_900_000n,
    tenorDays: 30,
    channel: 'EMBEDDED_AGGREGATOR',
    maker: MAKER_ONE,
    merchantMandateRef: 'mnd_dev_0002',
    aggregatorId: 'agg-dev-01',
    // No servicing response yet: sits with the external platform.
  },
];

if (!state.seeded) {
  state.seeded = true;

  for (const seed of SEEDS) {
    const keyed = keyRequest({
      tenantId: 'bank-a',
      programmeId: 'prg-0001',
      counterpartyId: seed.counterpartyId,
      channel: seed.channel,
      invoiceUuid: seed.invoiceUuid,
      invoiceNumber: seed.invoiceNumber,
      issuerCr: '1010000002',
      recipientCr: '7001000001',
      amountMinorUnits: seed.amountMinorUnits,
      tenorDays: seed.tenorDays,
      maker: seed.maker,
      ...(seed.merchantMandateRef === undefined
        ? {}
        : { merchantMandateRef: seed.merchantMandateRef }),
      ...(seed.aggregatorId === undefined ? {} : { aggregatorId: seed.aggregatorId }),
      ...(seed.agentId === undefined ? {} : { agentId: seed.agentId }),
      ...(seed.branchCode === undefined ? {} : { branchCode: seed.branchCode }),
    });
    if (!keyed.ok) continue;

    const submitted = submit(keyed.value.requestId);
    if (!submitted.ok) continue;

    if (seed.servicingResponded !== undefined) {
      applyServicingOutcome(keyed.value.requestId, {
        decision: seed.servicingResponded,
        reference: `svc_${keyed.value.requestId}`,
        ...(seed.servicingResponded === 'APPROVED'
          ? {}
          : { reasonCode: 'EXPOSURE_ABOVE_PROGRAMME_LIMIT' }),
        respondedAt: developmentAttestation(),
      });
    }
  }
}
