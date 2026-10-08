/**
 * Development credential provider: the process environment.
 *
 * Development only. It exists so an adapter can be exercised against a vendor
 * sandbox from a laptop before the database is reachable, with the same
 * `CredentialRef` it will use against the vault later. Nothing else changes
 * when the vault provider replaces it.
 *
 * Variable naming is derived from the reference, never chosen per adapter:
 *
 *     SANAD_CREDENTIAL_<PROVIDER>_<ENVIRONMENT>_<KEY_NAME>
 *     SANAD_CREDENTIAL_NUTRIENT_SANDBOX_DOCUMENT_ENGINE_API_TOKEN
 *
 * Every read is recorded through the audit sink, as the vault function does,
 * so the two providers are indistinguishable to the adapter and to the
 * auditor. The value itself never reaches the sink.
 */

import { type CredentialProvider, type CredentialRef, SecretValue } from '../../core/ports/credentials.ts';

export interface CredentialReadAudit {
  readonly tenantId: string;
  readonly provider: CredentialRef['provider'];
  readonly environment: CredentialRef['environment'];
  readonly keyName: string;
  readonly correlationId: string;
  readonly source: 'ENVIRONMENT' | 'VAULT';
}

export type CredentialAuditSink = (entry: CredentialReadAudit) => void;

export class CredentialNotConfiguredError extends Error {
  constructor(readonly variable: string) {
    super(`credential not configured: ${variable}`);
    this.name = 'CredentialNotConfiguredError';
  }
}

export function environmentVariableFor(ref: CredentialRef): string {
  const part = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return `SANAD_CREDENTIAL_${part(ref.provider)}_${part(ref.environment)}_${part(ref.keyName)}`;
}

export class EnvironmentCredentialProvider implements CredentialProvider {
  constructor(
    private readonly audit: CredentialAuditSink,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    if (env['NODE_ENV'] === 'production') {
      throw new Error('the environment credential provider is for development only');
    }
  }

  get(ref: CredentialRef, correlationId: string): Promise<SecretValue> {
    const variable = environmentVariableFor(ref);
    const value = this.env[variable];
    if (value === undefined || value.trim().length === 0) {
      return Promise.reject(new CredentialNotConfiguredError(variable));
    }
    this.audit({
      tenantId: ref.tenantId,
      provider: ref.provider,
      environment: ref.environment,
      keyName: ref.keyName,
      correlationId,
      source: 'ENVIRONMENT',
    });
    return Promise.resolve(new SecretValue(value.trim()));
  }
}
