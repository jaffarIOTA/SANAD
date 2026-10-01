/**
 * The two credential providers answer the same reference the same way: a
 * value that does not print itself, an audit entry per read, and a refusal
 * for anything not configured. The vendor-code mapping is total.
 */
import { describe, expect, it } from 'vitest';

import type { CredentialProviderName } from '../../core/ports/credentials.ts';
import { CredentialNotConfiguredError, EnvironmentCredentialProvider, environmentVariableFor, type CredentialReadAudit } from '../../adapters/kernel/credentials-environment.ts';
import { vaultProviderCode } from '../../adapters/kernel/credentials-vault.ts';

const ref = { tenantId: 'bank-a', provider: 'DOCUMENT_PLATFORM', environment: 'sandbox', keyName: 'document_engine_api_token' } as const;

describe('the environment credential provider', () => {
  it('derives the variable name from the reference', () => {
    expect(environmentVariableFor(ref)).toBe('SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_API_TOKEN');
  });
  it('returns a redacting secret and records the read without the value', async () => {
    const audits: CredentialReadAudit[] = [];
    const provider = new EnvironmentCredentialProvider((e) => audits.push(e), { SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_API_TOKEN: ' token-value ' });
    const secret = await provider.get(ref, 'cor-1');
    expect(secret.expose()).toBe('token-value');
    expect(String(secret)).toBe('[redacted]'); expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(audits).toEqual([{ tenantId: 'bank-a', provider: 'DOCUMENT_PLATFORM', environment: 'sandbox', keyName: 'document_engine_api_token', correlationId: 'cor-1', source: 'ENVIRONMENT' }]);
    expect(JSON.stringify(audits)).not.toContain('token-value');
  });
  it('refuses a missing or blank variable by name', async () => {
    const provider = new EnvironmentCredentialProvider(() => undefined, { SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_API_TOKEN: '  ' });
    await expect(provider.get(ref, 'cor-2')).rejects.toBeInstanceOf(CredentialNotConfiguredError);
    await expect(provider.get({ ...ref, keyName: 'absent' }, 'cor-3')).rejects.toThrow('SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_ABSENT');
  });
  it('refuses to exist in production', () => {
    expect(() => new EnvironmentCredentialProvider(() => undefined, { NODE_ENV: 'production' })).toThrow();
  });
});

describe('the vault provider code mapping', () => {
  const NAMES: readonly CredentialProviderName[] = ['CORE_BANKING', 'DOCUMENT_PLATFORM', 'E_INVOICING', 'IDENTITY', 'BUSINESS_REGISTRY', 'CREDIT_BUREAU', 'SCREENING', 'CERTIFICATION_SERVICE_PROVIDER', 'TIMESTAMP_AUTHORITY', 'IDENTITY_AUTHENTICATION', 'IDENTITY_VERIFICATION', 'DOCUMENT_VERIFICATION', 'EMPLOYMENT_VERIFICATION', 'TAX_COMPLIANCE', 'OPEN_BANKING', 'BILL_COLLECTION', 'PAYMENTS_HUB', 'RATE_PUBLISHER', 'COMMODITY_BROKER', 'WORKFLOW_ENGINE'];
  const MIGRATION_0007 = ['TUUM', 'NUTRIENT', 'ZATCA', 'NAFATH', 'YAKEEN', 'TAHAQOQ', 'WATHQ', 'SIMAH', 'BAYAN', 'GOSI', 'OPEN_BANKING', 'SADAD', 'PAYMENTS_HUB', 'RATE_PUBLISHER', 'COMMODITY_BROKER', 'WORKFLOW_ENGINE', 'SCREENING', 'CSP', 'TSA'];
  it('maps every capability to a code the migration allows', () => {
    for (const name of NAMES) expect(MIGRATION_0007, name).toContain(vaultProviderCode(name));
  });
  it('sends the document platform to the vault row the saving guide names', () => {
    expect(vaultProviderCode('DOCUMENT_PLATFORM')).toBe('NUTRIENT');
  });
});
