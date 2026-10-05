/**
 * The tenant's rail configuration: for each capability the engine consumes,
 * which adapter serves it, with what fallback, in which environment, at which
 * base address, and whether it is enabled at all.
 *
 * The engine knows capabilities; it does not know vendors. Which adapter codes
 * may serve a capability is therefore an input to this parser (an "adapter
 * catalogue" the adapters layer supplies), exactly as the Islamic product
 * codes are an input to the product catalogue parser. Nothing vendor-named
 * lives here.
 */

import type { CredentialProviderName } from '../ports/credentials.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

export type RailCapability = CredentialProviderName;
export type RailEnvironment = 'sandbox' | 'uat' | 'production';

export interface RailEntry {
  readonly capability: RailCapability;
  /** Adapter code from the adapter catalogue; the vault's provider code for this rail. */
  readonly adapter: string;
  /** A second adapter for the same capability, tried when the first is unavailable. */
  readonly fallbackAdapter?: string;
  readonly environment: RailEnvironment;
  /** Scheme and host; a path belongs to the adapter's route table, not to configuration. */
  readonly baseUrl?: string;
  readonly enabled: boolean;
  readonly note?: string;
}

export interface RailsConfiguration {
  readonly version: string;
  readonly rails: readonly RailEntry[];
}

/** Capability → adapter codes that may serve it. Supplied by the adapters layer. */
export type AdapterCatalogue = Readonly<Partial<Record<RailCapability, readonly string[]>>>;

const ENTRY_KEYS = new Set(['capability', 'adapter', 'fallbackAdapter', 'environment', 'baseUrl', 'enabled', 'note']);
const ENVIRONMENTS: readonly RailEnvironment[] = ['sandbox', 'uat', 'production'];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> => reject('OP-DETERMINACY', reason, detail, context);

export function parseRailsConfiguration(raw: unknown, allowed: AdapterCatalogue): Result<RailsConfiguration> {
  if (!isRecord(raw)) return bad('RAILS_MALFORMED', 'The rail configuration is an object');
  if (typeof raw['version'] !== 'string' || raw['version'].trim().length === 0) return bad('RAILS_VERSION_REQUIRED', 'The rail configuration carries a version');
  if (!Array.isArray(raw['rails'])) return bad('RAILS_LIST_REQUIRED', 'rails is a list');
  const rails: RailEntry[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw['rails'].entries()) {
    const at = { index: String(i) };
    if (!isRecord(entry)) return bad('RAIL_MALFORMED', 'Each rail is an object', at);
    const unknown = Object.keys(entry).filter((k) => !ENTRY_KEYS.has(k));
    if (unknown.length > 0) return bad('RAIL_UNKNOWN_KEY', 'Unknown key in a rail entry', { ...at, keys: unknown.join(',') });
    const capability = entry['capability'];
    if (typeof capability !== 'string' || !(capability in allowed)) return bad('RAIL_CAPABILITY_UNKNOWN', 'The capability is not one the engine consumes', { ...at, capability: String(capability) });
    const cap = capability as RailCapability;
    if (seen.has(cap)) return bad('RAIL_CAPABILITY_DUPLICATED', 'A capability is configured once', { ...at, capability: cap });
    seen.add(cap);
    const codes = allowed[cap] ?? [];
    const adapter = entry['adapter'];
    if (typeof adapter !== 'string' || !codes.includes(adapter)) return bad('RAIL_ADAPTER_UNKNOWN', 'No adapter of that code serves this capability', { ...at, capability: cap, adapter: String(adapter), allowed: codes.join(',') });
    const fallback = entry['fallbackAdapter'];
    if (fallback !== undefined) {
      if (typeof fallback !== 'string' || !codes.includes(fallback)) return bad('RAIL_FALLBACK_UNKNOWN', 'No adapter of that code serves this capability as a fallback', { ...at, capability: cap, fallbackAdapter: String(fallback) });
      if (fallback === adapter) return bad('RAIL_FALLBACK_SAME', 'A fallback is a different adapter from the primary', { ...at, capability: cap });
    }
    const environment = entry['environment'];
    if (typeof environment !== 'string' || !ENVIRONMENTS.includes(environment as RailEnvironment)) return bad('RAIL_ENVIRONMENT_UNKNOWN', 'environment is sandbox, uat or production', at);
    const baseUrl = entry['baseUrl'];
    if (baseUrl !== undefined) {
      if (typeof baseUrl !== 'string' || !/^https?:\/\/[^/\s?#]+$/.test(baseUrl)) return bad('RAIL_BASE_URL_MALFORMED', 'baseUrl is scheme and host only, no path', at);
      if (environment !== 'sandbox' && !baseUrl.startsWith('https://')) return bad('RAIL_BASE_URL_NOT_TLS', 'Beyond the sandbox a rail is reached over TLS only', { ...at, environment });
    }
    if (typeof entry['enabled'] !== 'boolean') return bad('RAIL_ENABLED_REQUIRED', 'enabled is true or false', at);
    const note = entry['note'];
    if (note !== undefined && (typeof note !== 'string' || note.length > 400)) return bad('RAIL_NOTE_MALFORMED', 'note is short text', at);
    rails.push({
      capability: cap, adapter, environment: environment as RailEnvironment, enabled: entry['enabled'],
      ...(typeof fallback === 'string' ? { fallbackAdapter: fallback } : {}),
      ...(typeof baseUrl === 'string' ? { baseUrl } : {}),
      ...(typeof note === 'string' ? { note } : {}),
    });
  }
  return ok({ version: raw['version'], rails });
}

export function railFor(c: RailsConfiguration, capability: RailCapability): RailEntry | undefined {
  return c.rails.find((r) => r.capability === capability);
}
