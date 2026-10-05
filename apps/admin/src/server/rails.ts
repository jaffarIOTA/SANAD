/**
 * The Rails & adapters area: the configuration in force, and a proposed
 * change to one rail, checked by the production parser against the adapter
 * catalogue before it may be proposed.
 */

import { ADAPTER_CATALOGUE, CAPABILITY_LABELS } from '@sanad/adapters/catalogue.ts';
import { type RailCapability, type RailEntry, type RailsConfiguration, parseRailsConfiguration } from '@sanad/core/config/rails.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { resolveRailsConfiguration } from '@sanad/origination/rails.ts';

export { ADAPTER_CATALOGUE, CAPABILITY_LABELS, resolveRailsConfiguration };

export interface RailChange {
  readonly capability: string;
  readonly adapter: string;
  readonly fallbackAdapter?: string;
  readonly environment: string;
  readonly baseUrl?: string;
  readonly enabled: boolean;
  readonly note?: string;
}

export function railsToJson(c: RailsConfiguration): unknown {
  return { version: c.version, rails: c.rails.map((r) => ({ ...r })) };
}

/** The whole configuration with one rail replaced, parsed as production parses it. */
export function railsWithChange(current: RailsConfiguration, change: RailChange): Result<{ readonly payload: unknown; readonly parsed: RailsConfiguration }> {
  if (!(change.capability in ADAPTER_CATALOGUE)) return reject('OP-DETERMINACY', 'RAIL_CAPABILITY_UNKNOWN', 'The capability is not one the engine consumes', { capability: change.capability });
  const cap = change.capability as RailCapability;
  const next: RailEntry = {
    capability: cap, adapter: change.adapter, environment: change.environment as RailEntry['environment'], enabled: change.enabled,
    ...(change.fallbackAdapter === undefined ? {} : { fallbackAdapter: change.fallbackAdapter }),
    ...(change.baseUrl === undefined ? {} : { baseUrl: change.baseUrl }),
    ...(change.note === undefined ? {} : { note: change.note }),
  };
  const exists = current.rails.some((r) => r.capability === cap);
  const rails = exists ? current.rails.map((r) => (r.capability === cap ? next : r)) : [...current.rails, next];
  const payload = railsToJson({ version: current.version, rails });
  const parsed = parseRailsConfiguration(payload, ADAPTER_CATALOGUE);
  if (!parsed.ok) return parsed;
  return ok({ payload, parsed: parsed.value });
}
