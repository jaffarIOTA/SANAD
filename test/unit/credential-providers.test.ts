/**
 * The two credential providers answer the same reference the same way: a
 * value that does not print itself, an audit entry per read, and a refusal
 * for anything not configured. The vendor-code mapping is total.
 */
import { describe, expect, it } from 'vitest';

import type { CredentialProviderName } from '../../core/ports/credentials.ts';
import {
  CredentialNotConfiguredError,
  EnvironmentCredentialProvider,
  environmentVariableFor,
  type CredentialReadAudit,
} from '../../adapters/kernel/credentials-environment.ts';
import { readFileSync } from 'node:fs';

import {
  VAULT_PROVIDER_CODES,
  vaultProviderCode,
  vaultProviderResolverFromRails,
} from '../../adapters/kernel/credentials-vault.ts';
import { ADAPTER_CATALOGUE } from '../../adapters/catalogue.ts';
import { VAULT_PROVIDERS } from '../../apps/admin/src/server/credentials.ts';
import { loadRailsConfiguration } from '../../config/loader.ts';
import { expectOk } from '../../core/kernel/result.ts';

const ref = {
  tenantId: 'bank-a',
  provider: 'DOCUMENT_PLATFORM',
  environment: 'sandbox',
  keyName: 'document_engine_api_token',
} as const;

describe('the environment credential provider', () => {
  it('derives the variable name from the reference', () => {
    expect(environmentVariableFor(ref)).toBe('SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_API_TOKEN');
  });
  it('returns a redacting secret and records the read without the value', async () => {
    const audits: CredentialReadAudit[] = [];
    const provider = new EnvironmentCredentialProvider((e) => audits.push(e), {
      SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_API_TOKEN: ' token-value ',
    });
    const secret = await provider.get(ref, 'cor-1');
    expect(secret.expose()).toBe('token-value');
    expect(String(secret)).toBe('[redacted]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(audits).toEqual([
      {
        tenantId: 'bank-a',
        provider: 'DOCUMENT_PLATFORM',
        environment: 'sandbox',
        keyName: 'document_engine_api_token',
        correlationId: 'cor-1',
        source: 'ENVIRONMENT',
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('token-value');
  });
  it('refuses a missing or blank variable by name', async () => {
    const provider = new EnvironmentCredentialProvider(() => undefined, {
      SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_API_TOKEN: '  ',
    });
    await expect(provider.get(ref, 'cor-2')).rejects.toBeInstanceOf(CredentialNotConfiguredError);
    await expect(provider.get({ ...ref, keyName: 'absent' }, 'cor-3')).rejects.toThrow(
      'SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_ABSENT',
    );
  });
  it('refuses to exist in production', () => {
    expect(() => new EnvironmentCredentialProvider(() => undefined, { NODE_ENV: 'production' })).toThrow();
  });
});

describe('the vault provider code mapping', () => {
  const NAMES: readonly CredentialProviderName[] = [
    'CORE_BANKING',
    'DOCUMENT_PLATFORM',
    'E_INVOICING',
    'IDENTITY',
    'BUSINESS_REGISTRY',
    'CREDIT_BUREAU',
    'SCREENING',
    'CERTIFICATION_SERVICE_PROVIDER',
    'TIMESTAMP_AUTHORITY',
    'IDENTITY_AUTHENTICATION',
    'IDENTITY_VERIFICATION',
    'DOCUMENT_VERIFICATION',
    'EMPLOYMENT_VERIFICATION',
    'TAX_COMPLIANCE',
    'OPEN_BANKING',
    'BILL_COLLECTION',
    'PAYMENTS_HUB',
    'RATE_PUBLISHER',
    'COMMODITY_BROKER',
    'WORKFLOW_ENGINE',
  ];
  const MIGRATION_0007 = [
    'TUUM',
    'NUTRIENT',
    'ZATCA',
    'NAFATH',
    'YAKEEN',
    'TAHAQOQ',
    'WATHQ',
    'SIMAH',
    'BAYAN',
    'GOSI',
    'OPEN_BANKING',
    'SADAD',
    'PAYMENTS_HUB',
    'RATE_PUBLISHER',
    'COMMODITY_BROKER',
    'WORKFLOW_ENGINE',
    'SCREENING',
    'CSP',
    'TSA',
  ];
  it('maps every capability to a code the migration allows', () => {
    for (const name of NAMES) expect(MIGRATION_0007, name).toContain(vaultProviderCode(name));
  });
  it('sends the document platform to the vault row the saving guide names', () => {
    expect(vaultProviderCode('DOCUMENT_PLATFORM')).toBe('NUTRIENT');
  });
});

describe('the vault provider code follows the adapter the tenant configured (ADR 0005)', () => {
  /** The codes the provider check constraint allows once migration 0015 runs, read from the migration itself. */
  const migration0015 = (): readonly string[] => {
    const sql = readFileSync(
      new URL('../../supabase/migrations/0015_uae_rail_credentials.sql', import.meta.url),
      'utf8',
    );
    const list = /check \(provider in \(([\s\S]*?)\)\);/.exec(sql)?.[1] ?? '';
    return [...list.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1] ?? '');
  };

  it('migration 0015 keeps every 0007 code and adds the UAE rails; code, admin and migration agree', () => {
    const codes = migration0015();
    expect([...codes].sort()).toEqual([...VAULT_PROVIDER_CODES].sort());
    expect([...VAULT_PROVIDERS].sort()).toEqual([...VAULT_PROVIDER_CODES].sort());
    for (const uae of ['AECB', 'UAE_PASS', 'ICP', 'NER', 'MOHRE', 'FTA', 'PARTNER_BANK']) expect(codes).toContain(uae);
  });
  it('every adapter in the catalogue is a code the vault accepts', () => {
    for (const adapters of Object.values(ADAPTER_CATALOGUE))
      for (const code of adapters ?? []) expect(VAULT_PROVIDER_CODES, code).toContain(code);
  });
  it('a configured adapter overrides the default; nothing configured keeps the default', () => {
    expect(vaultProviderCode('CREDIT_BUREAU', 'AECB')).toBe('AECB');
    expect(vaultProviderCode('CREDIT_BUREAU', undefined)).toBe('SIMAH');
    expect(vaultProviderCode('CREDIT_BUREAU', 'BAYAN')).toBe('BAYAN');
  });
  it('a configured code the vault would not accept is refused, never defaulted', () => {
    expect(() => vaultProviderCode('CREDIT_BUREAU', 'NOT_A_BUREAU')).toThrow('NOT_A_BUREAU');
  });
  it('a UAE tenant reads its bureau, identity, registry, salary, tax and payments credentials from the UAE rows', () => {
    const rails = expectOk(loadRailsConfiguration('sme-fund-ae', ADAPTER_CATALOGUE));
    const resolve = vaultProviderResolverFromRails({ 'sme-fund-ae': rails });
    const code = (provider: CredentialProviderName, tenantId = 'sme-fund-ae') =>
      vaultProviderCode(provider, resolve({ tenantId, provider, environment: 'sandbox', keyName: 'api_key' }));
    expect(code('CREDIT_BUREAU')).toBe('AECB');
    expect(code('IDENTITY_AUTHENTICATION')).toBe('UAE_PASS');
    expect(code('IDENTITY_VERIFICATION')).toBe('ICP');
    expect(code('BUSINESS_REGISTRY')).toBe('NER');
    expect(code('EMPLOYMENT_VERIFICATION')).toBe('MOHRE');
    expect(code('TAX_COMPLIANCE')).toBe('FTA');
    expect(code('PAYMENTS_HUB')).toBe('PARTNER_BANK');
    expect(code('CORE_BANKING')).toBe('TUUM');
    // A tenant not in the map keeps the defaults.
    expect(code('CREDIT_BUREAU', 'bank-a')).toBe('SIMAH');
  });
});
