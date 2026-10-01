/**
 * The credential provider for every deployed environment: the vault, read
 * through `config.get_integration_credential()`.
 *
 * The function is `security definer`, writes the access audit row itself, and
 * raises for a missing, revoked or expired credential — so this class has
 * nothing to add but the connection. It never selects from the credential
 * table, never sees the vault, and never logs what it fetched.
 *
 * Provider names in the vault are the vendor or rail names the migrations
 * declare; the port's names are capabilities. The mapping lives here, at the
 * boundary, so neither side learns the other's vocabulary.
 */

import { Pool, type PoolConfig } from 'pg';

import { type CredentialProvider, type CredentialProviderName, type CredentialRef, SecretValue } from '../../core/ports/credentials.ts';

import type { CredentialAuditSink } from './credentials-environment.ts';

/** Capability → the vault's provider code, as constrained by migration 0007. */
const VAULT_PROVIDER: Readonly<Record<CredentialProviderName, string>> = {
  CORE_BANKING: 'TUUM',
  DOCUMENT_PLATFORM: 'NUTRIENT',
  E_INVOICING: 'ZATCA',
  IDENTITY: 'NAFATH',
  BUSINESS_REGISTRY: 'WATHQ',
  CREDIT_BUREAU: 'SIMAH',
  SCREENING: 'SCREENING',
  CERTIFICATION_SERVICE_PROVIDER: 'CSP',
  TIMESTAMP_AUTHORITY: 'TSA',
  IDENTITY_AUTHENTICATION: 'NAFATH',
  IDENTITY_VERIFICATION: 'YAKEEN',
  DOCUMENT_VERIFICATION: 'TAHAQOQ',
  EMPLOYMENT_VERIFICATION: 'GOSI',
  TAX_COMPLIANCE: 'ZATCA',
  OPEN_BANKING: 'OPEN_BANKING',
  BILL_COLLECTION: 'SADAD',
  PAYMENTS_HUB: 'PAYMENTS_HUB',
  RATE_PUBLISHER: 'RATE_PUBLISHER',
  COMMODITY_BROKER: 'COMMODITY_BROKER',
  WORKFLOW_ENGINE: 'WORKFLOW_ENGINE',
};

export function vaultProviderCode(provider: CredentialProviderName): string {
  return VAULT_PROVIDER[provider];
}

export class VaultCredentialProvider implements CredentialProvider {
  readonly #pool: Pool;

  constructor(
    config: Pool | PoolConfig,
    private readonly audit: CredentialAuditSink,
    /** The tenant's uuid in `core.tenant`, by its code — the vault keys on the uuid. */
    private readonly tenantUuidFor: (tenantId: string) => Promise<string>,
  ) {
    this.#pool = config instanceof Pool ? config : new Pool(config);
  }

  async get(ref: CredentialRef, correlationId: string): Promise<SecretValue> {
    const tenantUuid = await this.tenantUuidFor(ref.tenantId);
    const result = await this.#pool.query<{ secret: string | null }>(
      'select config.get_integration_credential($1::uuid, $2, $3, $4, $5::uuid) as secret',
      [tenantUuid, vaultProviderCode(ref.provider), ref.environment, ref.keyName, isUuid(correlationId) ? correlationId : null],
    );
    const secret = result.rows[0]?.secret;
    if (typeof secret !== 'string' || secret.length === 0) {
      // The function raises on every refusal, so an empty row is a wiring fault, not a policy outcome.
      throw new Error(`credential read returned nothing: ${vaultProviderCode(ref.provider)}/${ref.environment}/${ref.keyName}`);
    }
    this.audit({ tenantId: ref.tenantId, provider: ref.provider, environment: ref.environment, keyName: ref.keyName, correlationId, source: 'VAULT' });
    return new SecretValue(secret);
  }

  async end(): Promise<void> {
    await this.#pool.end();
  }
}

const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
