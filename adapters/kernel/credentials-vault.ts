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

import {
  type CredentialProvider,
  type CredentialProviderName,
  type CredentialRef,
  SecretValue,
} from '../../core/ports/credentials.ts';

import type { CredentialAuditSink } from './credentials-environment.ts';

/**
 * Every provider code the vault accepts: migration 0007's list, widened for
 * the UAE rails by migration 0015 (ADR 0005). A code outside this list would
 * be refused by the table's check constraint, so it is refused here first.
 */
export const VAULT_PROVIDER_CODES = [
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
  'AECB',
  'UAE_PASS',
  'ICP',
  'NER',
  'MOHRE',
  'FTA',
  'PARTNER_BANK',
] as const;
export type VaultProviderCode = (typeof VAULT_PROVIDER_CODES)[number];

/**
 * The default capability → provider code, used when nothing says which
 * adapter a tenant has configured. These are the Saudi defaults of migration
 * 0007; a tenant on another adapter (a second Saudi bureau, or any UAE rail)
 * is resolved through its rail configuration instead — see
 * `vaultProviderResolverFromRails`.
 */
const VAULT_PROVIDER: Readonly<Record<CredentialProviderName, VaultProviderCode>> = {
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

export const isVaultProviderCode = (code: string): code is VaultProviderCode =>
  (VAULT_PROVIDER_CODES as readonly string[]).includes(code);

/**
 * Which adapter serves a capability for the tenant that owns a credential
 * reference, as a vault provider code; `undefined` means "use the default".
 */
export type VaultProviderResolver = (ref: CredentialRef) => string | undefined;

/**
 * The vault provider code for a capability. `configured` is the adapter code
 * the tenant's rail configuration names for it (adapter codes are the vault's
 * provider codes — core/config/rails.ts); without one, the default. A
 * configured code the vault would not accept is refused, never defaulted, so
 * a UAE tenant's bureau credential is never silently read from a Saudi row.
 */
export function vaultProviderCode(provider: CredentialProviderName, configured?: string): VaultProviderCode {
  if (configured === undefined) return VAULT_PROVIDER[provider];
  if (!isVaultProviderCode(configured)) throw new Error(`no vault provider code ${configured} for ${provider}`);
  return configured;
}

/** The minimal shape of a tenant's rail configuration the resolver needs (core/config/rails.ts RailsConfiguration satisfies it). */
export interface ConfiguredRails {
  readonly rails: readonly { readonly capability: CredentialProviderName; readonly adapter: string }[];
}

/**
 * A resolver from each tenant's rail configuration, keyed by tenant code (the
 * `tenantId` a credential reference carries). A tenant or capability not in
 * the map falls back to the default.
 */
export function vaultProviderResolverFromRails(
  byTenant: Readonly<Record<string, ConfiguredRails>>,
): VaultProviderResolver {
  const table = new Map<string, string>();
  for (const [tenant, config] of Object.entries(byTenant)) {
    for (const rail of config.rails) table.set(`${tenant}\u0000${rail.capability}`, rail.adapter);
  }
  return (ref) => table.get(`${ref.tenantId}\u0000${ref.provider}`);
}

export class VaultCredentialProvider implements CredentialProvider {
  readonly #pool: Pool;

  constructor(
    config: Pool | PoolConfig,
    private readonly audit: CredentialAuditSink,
    /** The tenant's uuid in `core.tenant`, by its code — the vault keys on the uuid. */
    private readonly tenantUuidFor: (tenantId: string) => Promise<string>,
    /** Which adapter the tenant configured for the capability. Omitted, every capability reads its default row. */
    private readonly resolveProvider: VaultProviderResolver = () => undefined,
  ) {
    this.#pool = config instanceof Pool ? config : new Pool(config);
  }

  async get(ref: CredentialRef, correlationId: string): Promise<SecretValue> {
    const code = vaultProviderCode(ref.provider, this.resolveProvider(ref));
    const tenantUuid = await this.tenantUuidFor(ref.tenantId);
    const result = await this.#pool.query<{ secret: string | null }>(
      'select config.get_integration_credential($1::uuid, $2, $3, $4, $5::uuid) as secret',
      [tenantUuid, code, ref.environment, ref.keyName, isUuid(correlationId) ? correlationId : null],
    );
    const secret = result.rows[0]?.secret;
    if (typeof secret !== 'string' || secret.length === 0) {
      // The function raises on every refusal, so an empty row is a wiring fault, not a policy outcome.
      throw new Error(`credential read returned nothing: ${code}/${ref.environment}/${ref.keyName}`);
    }
    this.audit({
      tenantId: ref.tenantId,
      provider: ref.provider,
      environment: ref.environment,
      keyName: ref.keyName,
      correlationId,
      source: 'VAULT',
    });
    return new SecretValue(secret);
  }

  async end(): Promise<void> {
    await this.#pool.end();
  }
}

const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
