/**
 * A rail configuration that could route a call to the wrong place, over the
 * wrong channel, or to an adapter that does not exist, does not parse. The
 * engine names no vendor: the adapter catalogue is an input.
 */
import { describe, expect, it } from 'vitest';

import { ADAPTER_CATALOGUE } from '../../adapters/catalogue.ts';
import { parseRailsConfiguration, railFor } from '@sanad/core/config/rails.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { loadRailsConfiguration } from '@sanad/config/loader.ts';

const base = { version: 't', rails: [{ capability: 'CREDIT_BUREAU', adapter: 'SIMAH', fallbackAdapter: 'BAYAN', environment: 'sandbox', enabled: true }] };
const parse = (raw: unknown) => parseRailsConfiguration(raw, ADAPTER_CATALOGUE);
const reason = (raw: unknown): string => { const r = parse(raw); return r.ok ? 'OK' : r.error.reason; };

describe('the rail configuration', () => {
  it('both tenants’ checked-in files parse, and the bureau has a fallback', () => {
    for (const t of ['bank-a', 'fintech-b'] as const) {
      const c = expectOk(loadRailsConfiguration(t, ADAPTER_CATALOGUE));
      expect(railFor(c, 'CREDIT_BUREAU')?.fallbackAdapter).toBe('BAYAN');
      expect(c.rails.filter((r) => r.enabled).map((r) => r.capability)).toEqual(['DOCUMENT_PLATFORM']);
    }
  });
  it('refuses an adapter that does not serve the capability, with the allowed codes named', () => {
    const r = parse({ ...base, rails: [{ ...base.rails[0], adapter: 'NAFATH' }] });
    expect(r.ok).toBe(false); if (!r.ok) { expect(r.error.reason).toBe('RAIL_ADAPTER_UNKNOWN'); expect(String(r.error.context?.['allowed'])).toBe('SIMAH,BAYAN'); }
  });
  it('refuses a fallback that is the primary, or that does not serve the capability', () => {
    expect(reason({ ...base, rails: [{ ...base.rails[0], fallbackAdapter: 'SIMAH' }] })).toBe('RAIL_FALLBACK_SAME');
    expect(reason({ ...base, rails: [{ ...base.rails[0], fallbackAdapter: 'GOSI' }] })).toBe('RAIL_FALLBACK_UNKNOWN');
  });
  it('refuses a capability the engine does not consume, and a capability configured twice', () => {
    expect(reason({ ...base, rails: [{ ...base.rails[0], capability: 'FAX' }] })).toBe('RAIL_CAPABILITY_UNKNOWN');
    expect(reason({ ...base, rails: [base.rails[0], base.rails[0]] })).toBe('RAIL_CAPABILITY_DUPLICATED');
  });
  it('beyond the sandbox a rail is reached over TLS only; a base URL never carries a path', () => {
    expect(reason({ ...base, rails: [{ ...base.rails[0], environment: 'uat', baseUrl: 'http://bureau.example' }] })).toBe('RAIL_BASE_URL_NOT_TLS');
    expect(reason({ ...base, rails: [{ ...base.rails[0], environment: 'production', baseUrl: 'https://bureau.example' }] })).toBe('OK');
    expect(reason({ ...base, rails: [{ ...base.rails[0], baseUrl: 'https://bureau.example/api/v1' }] })).toBe('RAIL_BASE_URL_MALFORMED');
  });
  it('refuses an unknown environment, an unknown key and a missing enabled flag', () => {
    expect(reason({ ...base, rails: [{ ...base.rails[0], environment: 'staging' }] })).toBe('RAIL_ENVIRONMENT_UNKNOWN');
    expect(reason({ ...base, rails: [{ ...base.rails[0], timeoutMs: 5 }] })).toBe('RAIL_UNKNOWN_KEY');
    expect(reason({ ...base, rails: [{ capability: 'CREDIT_BUREAU', adapter: 'SIMAH', environment: 'sandbox' }] })).toBe('RAIL_ENABLED_REQUIRED');
  });
});
