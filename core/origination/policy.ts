/**
 * Origination policy — the tenant's operating parameters for intake.
 *
 * Five things a bank configures about *requests* (never about gates): how long
 * a request may wait before it expires, which approval authority a given
 * amount needs, the SLA per stage, which agents may originate and within what
 * limits, and which partners may originate and within what limits.
 *
 * All of it is tenant-scoped configuration rather than code, for the same
 * reason the Board's parameters are (§1.7): two institutions will answer these
 * differently, and a difference that needed a code change would mean the
 * design was wrong at that point.
 *
 * Two boundaries, stated because they are the ones that erode:
 *
 * - **Nothing here touches a sequencing gate.** An approval tier decides who
 *   may approve *raising a transaction*; it has no bearing on whether goods
 *   were bought, possessed and held at risk. The transitions in
 *   `core/sequencing` take no authority and consult no policy, and the
 *   adversarial suite asserts this file's exports appear nowhere near them.
 * - **Nothing here is a rate.** Limits are amounts in minor units, held as
 *   strings in JSON — the same rule as on the wire — and parsed to `bigint`.
 *
 * Like the credit policy, the parser refuses what it does not recognise. A
 * misspelt key is a refusal to activate, never a silent default.
 */

import { type Money, money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { InitiatorIdentification, OriginationChannel } from './channel.ts';

/** Ordered: each level may do what the levels below it may. */
export const APPROVAL_AUTHORITIES = ['CHECKER', 'SENIOR_CHECKER', 'CREDIT_COMMITTEE'] as const;
export type ApprovalAuthority = (typeof APPROVAL_AUTHORITIES)[number];

export type ParticipantStatus = 'ACTIVE' | 'SUSPENDED';

export interface ApprovalTier {
  /** Inclusive upper bound. `undefined` on the last tier means unbounded. */
  readonly upToMinorUnits?: bigint;
  readonly authority: ApprovalAuthority;
}

export interface AgentEntitlement {
  readonly agentId: string;
  readonly status: ParticipantStatus;
  readonly branchCode: string;
  /** Programme identifiers, or 'ALL'. */
  readonly programmes: readonly string[] | 'ALL';
  readonly maxRequestMinorUnits: bigint;
}

export interface PartnerEntitlement {
  readonly partnerId: string;
  readonly status: ParticipantStatus;
  readonly channel: Extract<OriginationChannel, 'PARTNER_API' | 'EMBEDDED_AGGREGATOR'>;
  readonly programmes: readonly string[] | 'ALL';
  readonly maxRequestMinorUnits: bigint;
}

/** States a request can wait in. Keys of the expiry and SLA tables. */
export const WAITING_STATES = [
  'AWAITING_SERVICING_RESPONSE',
  'AWAITING_REVIEW',
  'RETURNED_TO_MAKER',
  'AWAITING_CREDIT_REVIEW',
  'PENDING_INFORMATION',
  'SERVICING_UNAVAILABLE',
] as const;
export type WaitingState = (typeof WAITING_STATES)[number];

export interface OriginationPolicy {
  readonly tenantId: string;
  readonly version: string;
  /** Seconds a request may sit in a state before it expires. Absent = never. */
  readonly expirySeconds: Readonly<Partial<Record<WaitingState, number>>>;
  /** Seconds before a request in a state is in breach. Absent = no SLA. */
  readonly slaSeconds: Readonly<Partial<Record<WaitingState, number>>>;
  /** Ascending by bound; the last may be unbounded. */
  readonly approvalTiers: readonly ApprovalTier[];
  readonly agents: readonly AgentEntitlement[];
  readonly partners: readonly PartnerEntitlement[];
  /**
   * When the servicing platform cannot be reached (BRD §21): how many
   * automatic attempts, and how long between them. A manual resubmission
   * by a named person is allowed beyond the maximum and is recorded as such.
   */
  readonly servicingRetry: { readonly maxAttempts: number; readonly backoffSeconds: number };
  /**
   * Fields whose change on resubmission after a return is *material*
   * (BRD MC-009): the request is re-validated and, on a channel that consults
   * the servicing platform, the earlier answer is discarded.
   */
  readonly revalidateOn: readonly string[];
}

// -- Parsing ------------------------------------------------------------------

const TOP_LEVEL = new Set(['tenantId', 'version', 'expirySeconds', 'slaSeconds', 'approvalTiers', 'agents', 'partners', 'servicingRetry', 'revalidateOn']);
const REVALIDATABLE = ['tradeReference', 'requestedAmount', 'counterpartyId', 'programmeId', 'requestedTenorDays'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function minorUnits(v: unknown, where: string): Result<bigint> {
  // Strings, as on the wire: a JSON number is a double, and an amount that
  // has been through a double is an amount that may have been rounded.
  if (typeof v !== 'string' || !/^[0-9]+$/.test(v)) {
    return reject('OP-DETERMINACY', 'POLICY_AMOUNT_NOT_MINOR_UNITS', `${where} must be a string of digits (minor units)`, { where });
  }
  return ok(BigInt(v));
}

function seconds(v: unknown, where: string): Result<number> {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    return reject('OP-DETERMINACY', 'POLICY_DURATION_INVALID', `${where} must be a positive integer number of seconds`, { where });
  }
  return ok(v);
}

function durations(v: unknown, where: string): Result<Readonly<Partial<Record<WaitingState, number>>>> {
  if (v === undefined) return ok({});
  if (!isRecord(v)) return reject('OP-DETERMINACY', 'POLICY_SECTION_INVALID', `${where} must be an object`, { where });
  const out: Partial<Record<WaitingState, number>> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!(WAITING_STATES as readonly string[]).includes(k)) {
      return reject('OP-DETERMINACY', 'POLICY_UNKNOWN_STATE', `${where}.${k} is not a state a request can wait in`, { where, key: k });
    }
    const s = seconds(val, `${where}.${k}`);
    if (!s.ok) return s;
    out[k as WaitingState] = s.value;
  }
  return ok(out);
}

function programmes(v: unknown, where: string): Result<readonly string[] | 'ALL'> {
  if (v === 'ALL') return ok('ALL');
  if (Array.isArray(v) && v.every((p) => typeof p === 'string' && p.length > 0)) return ok(v as string[]);
  return reject('OP-DETERMINACY', 'POLICY_PROGRAMMES_INVALID', `${where}.programmes must be 'ALL' or a list of programme identifiers`, { where });
}

function status(v: unknown, where: string): Result<ParticipantStatus> {
  if (v === 'ACTIVE' || v === 'SUSPENDED') return ok(v);
  return reject('OP-DETERMINACY', 'POLICY_STATUS_INVALID', `${where}.status must be ACTIVE or SUSPENDED`, { where });
}

export function parseOriginationPolicy(input: unknown): Result<OriginationPolicy> {
  if (!isRecord(input)) return reject('OP-DETERMINACY', 'POLICY_NOT_AN_OBJECT', 'An origination policy must be an object');

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL.has(key)) {
      // Refused, not ignored. A typo in a limit key would otherwise remove
      // the limit while looking configured.
      return reject('OP-DETERMINACY', 'POLICY_UNKNOWN_SECTION', `Unknown section '${key}' in origination policy`, { key });
    }
  }
  if (typeof input['tenantId'] !== 'string' || typeof input['version'] !== 'string') {
    return reject('OP-DETERMINACY', 'POLICY_IDENTITY_MISSING', 'tenantId and version are required');
  }

  const expiry = durations(input['expirySeconds'], 'expirySeconds');
  if (!expiry.ok) return expiry;
  const sla = durations(input['slaSeconds'], 'slaSeconds');
  if (!sla.ok) return sla;

  // Tiers: ascending, contiguous from zero, last may be unbounded.
  const tiersIn = input['approvalTiers'];
  if (!Array.isArray(tiersIn) || tiersIn.length === 0) {
    return reject('OP-DETERMINACY', 'POLICY_TIERS_MISSING', 'approvalTiers must list at least one tier');
  }
  const tiers: ApprovalTier[] = [];
  let previous: bigint | undefined;
  for (const [i, t] of tiersIn.entries()) {
    if (!isRecord(t)) return reject('OP-DETERMINACY', 'POLICY_TIER_INVALID', `approvalTiers[${String(i)}] must be an object`);
    if (!(APPROVAL_AUTHORITIES as readonly string[]).includes(String(t['authority']))) {
      return reject('OP-DETERMINACY', 'POLICY_AUTHORITY_UNKNOWN', `approvalTiers[${String(i)}].authority is not a known authority`, { index: i });
    }
    const last = i === tiersIn.length - 1;
    if (t['upToMinorUnits'] === undefined) {
      if (!last) return reject('OP-DETERMINACY', 'POLICY_TIER_UNBOUNDED_NOT_LAST', 'Only the last approval tier may be unbounded', { index: i });
      tiers.push({ authority: t['authority'] as ApprovalAuthority });
      continue;
    }
    const bound = minorUnits(t['upToMinorUnits'], `approvalTiers[${String(i)}].upToMinorUnits`);
    if (!bound.ok) return bound;
    if (previous !== undefined && bound.value <= previous) {
      return reject('OP-DETERMINACY', 'POLICY_TIERS_NOT_ASCENDING', 'approvalTiers must ascend by bound', { index: i });
    }
    previous = bound.value;
    tiers.push({ upToMinorUnits: bound.value, authority: t['authority'] as ApprovalAuthority });
  }

  const agents: AgentEntitlement[] = [];
  for (const [i, a] of (Array.isArray(input['agents']) ? input['agents'] : []).entries()) {
    const where = `agents[${String(i)}]`;
    if (!isRecord(a) || typeof a['agentId'] !== 'string' || typeof a['branchCode'] !== 'string') {
      return reject('OP-DETERMINACY', 'POLICY_AGENT_INVALID', `${where} needs agentId and branchCode`, { where });
    }
    const st = status(a['status'], where); if (!st.ok) return st;
    const pr = programmes(a['programmes'], where); if (!pr.ok) return pr;
    const mx = minorUnits(a['maxRequestMinorUnits'], `${where}.maxRequestMinorUnits`); if (!mx.ok) return mx;
    agents.push({ agentId: a['agentId'], status: st.value, branchCode: a['branchCode'], programmes: pr.value, maxRequestMinorUnits: mx.value });
  }

  const partners: PartnerEntitlement[] = [];
  for (const [i, p] of (Array.isArray(input['partners']) ? input['partners'] : []).entries()) {
    const where = `partners[${String(i)}]`;
    if (!isRecord(p) || typeof p['partnerId'] !== 'string') {
      return reject('OP-DETERMINACY', 'POLICY_PARTNER_INVALID', `${where} needs partnerId`, { where });
    }
    if (p['channel'] !== 'PARTNER_API' && p['channel'] !== 'EMBEDDED_AGGREGATOR') {
      return reject('OP-DETERMINACY', 'POLICY_PARTNER_CHANNEL_INVALID', `${where}.channel must be PARTNER_API or EMBEDDED_AGGREGATOR`, { where });
    }
    const st = status(p['status'], where); if (!st.ok) return st;
    const pr = programmes(p['programmes'], where); if (!pr.ok) return pr;
    const mx = minorUnits(p['maxRequestMinorUnits'], `${where}.maxRequestMinorUnits`); if (!mx.ok) return mx;
    partners.push({ partnerId: p['partnerId'], status: st.value, channel: p['channel'], programmes: pr.value, maxRequestMinorUnits: mx.value });
  }

  let servicingRetry = { maxAttempts: 3, backoffSeconds: 300 };
  if (input['servicingRetry'] !== undefined) {
    const r = input['servicingRetry'];
    if (!isRecord(r) || typeof r['maxAttempts'] !== 'number' || !Number.isInteger(r['maxAttempts']) || r['maxAttempts'] < 1 || typeof r['backoffSeconds'] !== 'number' || !Number.isInteger(r['backoffSeconds']) || r['backoffSeconds'] < 0) {
      return reject('OP-DETERMINACY', 'POLICY_SERVICING_RETRY_INVALID', 'servicingRetry needs maxAttempts ≥ 1 and backoffSeconds ≥ 0');
    }
    servicingRetry = { maxAttempts: r['maxAttempts'], backoffSeconds: r['backoffSeconds'] };
  }
  let revalidateOn: readonly string[] = ['tradeReference', 'requestedAmount', 'counterpartyId', 'programmeId'];
  if (input['revalidateOn'] !== undefined) {
    const r = input['revalidateOn'];
    if (!Array.isArray(r) || !r.every((f) => (REVALIDATABLE as readonly string[]).includes(String(f)))) {
      return reject('OP-DETERMINACY', 'POLICY_REVALIDATE_FIELD_UNKNOWN', `revalidateOn may only name ${REVALIDATABLE.join(', ')}`);
    }
    revalidateOn = r as string[];
  }
  return ok({ tenantId: input['tenantId'], version: input['version'], expirySeconds: expiry.value, slaSeconds: sla.value, approvalTiers: tiers, agents, partners, servicingRetry, revalidateOn });
}

// -- Approval authority -------------------------------------------------------

const rank = (a: ApprovalAuthority): number => APPROVAL_AUTHORITIES.indexOf(a);

/** The authority a request of this amount needs. */
export function requiredAuthority(policy: OriginationPolicy, amount: Money): ApprovalAuthority {
  for (const tier of policy.approvalTiers) {
    if (tier.upToMinorUnits === undefined || amount.minorUnits <= tier.upToMinorUnits) return tier.authority;
  }
  // Unreachable when the parser enforced an unbounded last tier; the most
  // demanding answer is the safe one if it ever is reached.
  return 'CREDIT_COMMITTEE';
}

/** A principal with no recorded authority holds the lowest. */
export const authorityCovers = (held: ApprovalAuthority | undefined, required: ApprovalAuthority): boolean =>
  rank(held ?? 'CHECKER') >= rank(required);

// -- Entitlements -------------------------------------------------------------

const allows = (programmes: readonly string[] | 'ALL', programmeId: string): boolean =>
  programmes === 'ALL' || programmes.includes(programmeId);

/**
 * May this agent raise this request?
 *
 * Refused with a control code the screen can show. Agent limits are about the
 * *request*: an agent within limit gets a request that a second person still
 * reviews, and a transaction that still has every gate ahead of it.
 */
export function checkAgentEntitlement(
  policy: OriginationPolicy,
  identification: Extract<InitiatorIdentification, { kind: 'AGENT' }>,
  request: { readonly programmeId: string; readonly requestedAmount: Money },
): Result<true> {
  const agent = policy.agents.find((a) => a.agentId === identification.agentId);
  if (agent === undefined) {
    return reject('OP-DETERMINACY', 'AGENT_NOT_ENTITLED', 'This agent is not configured to originate for this tenant', { agentId: identification.agentId });
  }
  if (agent.status !== 'ACTIVE') {
    return reject('OP-DETERMINACY', 'AGENT_SUSPENDED', 'This agent is suspended', { agentId: identification.agentId });
  }
  if (agent.branchCode !== identification.branchCode) {
    return reject('OP-DETERMINACY', 'AGENT_OUTSIDE_BRANCH', 'This agent may not originate for that branch', { agentId: identification.agentId, branchCode: identification.branchCode });
  }
  if (!allows(agent.programmes, request.programmeId)) {
    return reject('OP-DETERMINACY', 'AGENT_PROGRAMME_NOT_ENTITLED', 'This agent is not entitled to originate under that programme', { agentId: identification.agentId, programmeId: request.programmeId });
  }
  if (request.requestedAmount.minorUnits > agent.maxRequestMinorUnits) {
    return reject('OP-LIMIT', 'AGENT_LIMIT_EXCEEDED', 'The request exceeds this agent’s per-request limit', { agentId: identification.agentId, limitMinorUnits: agent.maxRequestMinorUnits.toString() });
  }
  return ok(true);
}

/** May this partner raise this request? Same shape, same reasons. */
export function checkPartnerEntitlement(
  policy: OriginationPolicy,
  identification: Extract<InitiatorIdentification, { kind: 'PARTNER_SYSTEM' | 'AGGREGATOR_ON_BEHALF' }>,
  request: { readonly programmeId: string; readonly requestedAmount: Money; readonly channel: OriginationChannel },
): Result<true> {
  const id = identification.kind === 'PARTNER_SYSTEM' ? identification.partnerId : identification.aggregatorId;
  const partner = policy.partners.find((p) => p.partnerId === id);
  if (partner === undefined) {
    return reject('OP-DETERMINACY', 'PARTNER_NOT_ENTITLED', 'This partner is not configured to originate for this tenant', { partnerId: id });
  }
  if (partner.status !== 'ACTIVE') {
    return reject('OP-DETERMINACY', 'PARTNER_SUSPENDED', 'This partner is suspended', { partnerId: id });
  }
  if (partner.channel !== request.channel) {
    return reject('OP-DETERMINACY', 'PARTNER_CHANNEL_MISMATCH', 'This partner is not entitled to originate on that channel', { partnerId: id, channel: request.channel });
  }
  if (!allows(partner.programmes, request.programmeId)) {
    return reject('OP-DETERMINACY', 'PARTNER_PROGRAMME_NOT_ENTITLED', 'This partner is not entitled to originate under that programme', { partnerId: id, programmeId: request.programmeId });
  }
  if (request.requestedAmount.minorUnits > partner.maxRequestMinorUnits) {
    return reject('OP-LIMIT', 'PARTNER_LIMIT_EXCEEDED', 'The request exceeds this partner’s per-request limit', { partnerId: id, limitMinorUnits: partner.maxRequestMinorUnits.toString() });
  }
  return ok(true);
}

// -- Time-based: SLA and expiry ------------------------------------------------
//
// Both take the observed instant as an argument. Nothing here reads a clock.

export type SlaStatus = 'WITHIN' | 'BREACHED' | 'NONE';

export function slaStatus(
  policy: OriginationPolicy,
  state: string,
  sinceEpochSeconds: bigint,
  observedEpochSeconds: bigint,
): SlaStatus {
  const limit = policy.slaSeconds[state as WaitingState];
  if (limit === undefined) return 'NONE';
  return observedEpochSeconds - sinceEpochSeconds > BigInt(limit) ? 'BREACHED' : 'WITHIN';
}

export function isExpired(
  policy: OriginationPolicy,
  state: string,
  sinceEpochSeconds: bigint,
  observedEpochSeconds: bigint,
): boolean {
  const ttl = policy.expirySeconds[state as WaitingState];
  return ttl !== undefined && observedEpochSeconds - sinceEpochSeconds >= BigInt(ttl);
}

/** A convenience for callers holding `Money`; keeps `money()` the one constructor. */
export const asMoney = (minor: bigint): Money => money(minor);
