/**
 * The Partner entitlements area: the origination policy in force, and a
 * proposed change to one partner's entitlement (or a new partner), parsed by
 * the production policy parser before it may be proposed. Agents and
 * approval tiers are shown; they are changed the same way, as the whole
 * policy is the revision's payload.
 */

import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type OriginationPolicy, type PartnerEntitlement, parseOriginationPolicy } from '@sanad/core/origination/policy.ts';
import { resolveOriginationPolicy } from '@sanad/origination/origination-policy.ts';

export { resolveOriginationPolicy };

export function policyToJson(p: OriginationPolicy): unknown {
  return {
    tenantId: p.tenantId, version: p.version, expirySeconds: p.expirySeconds, slaSeconds: p.slaSeconds,
    approvalTiers: p.approvalTiers.map((t) => ({ ...(t.upToMinorUnits === undefined ? {} : { upToMinorUnits: t.upToMinorUnits.toString() }), authority: t.authority })),
    agents: p.agents.map((a) => ({ ...a, maxRequestMinorUnits: a.maxRequestMinorUnits.toString() })),
    partners: p.partners.map((x) => ({ ...x, maxRequestMinorUnits: x.maxRequestMinorUnits.toString() })),
    servicingRetry: p.servicingRetry, revalidateOn: p.revalidateOn,
  };
}

export interface PartnerChange {
  readonly partnerId: string;
  readonly status: string;
  readonly channel: string;
  /** Comma-separated programme ids, or ALL. */
  readonly programmesText: string;
  readonly maxRequestMinorUnits: string;
}

export function policyWithPartner(current: OriginationPolicy, change: PartnerChange): Result<{ readonly payload: unknown; readonly parsed: OriginationPolicy }> {
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(change.partnerId)) return reject('OP-DETERMINACY', 'PARTNER_ID_MALFORMED', 'A partner id is lower-case letters, digits and hyphens');
  const programmes = change.programmesText.trim().toUpperCase() === 'ALL' ? 'ALL' : change.programmesText.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  if (programmes !== 'ALL' && programmes.length === 0) return reject('OP-DETERMINACY', 'PARTNER_PROGRAMMES_REQUIRED', 'A partner is entitled to named programmes, or ALL');
  if (!/^\d{1,18}$/.test(change.maxRequestMinorUnits)) return reject('OP-DETERMINACY', 'PARTNER_MAX_MALFORMED', 'The maximum request is a whole number of minor units');
  const entry = { partnerId: change.partnerId, status: change.status, channel: change.channel, programmes, maxRequestMinorUnits: change.maxRequestMinorUnits };
  const json = policyToJson(current) as { partners: Record<string, unknown>[] };
  const exists = json.partners.some((x) => x['partnerId'] === change.partnerId);
  const partners = exists ? json.partners.map((x) => (x['partnerId'] === change.partnerId ? entry : x)) : [...json.partners, entry];
  const payload = { ...json, partners };
  const parsed = parseOriginationPolicy(payload);
  if (!parsed.ok) return parsed;
  return ok({ payload, parsed: parsed.value });
}

export const partnerOf = (p: OriginationPolicy, id: string | undefined): PartnerEntitlement | undefined => p.partners.find((x) => x.partnerId === id);
