/**
 * The credential store, as the administration surface sees it: names and
 * dates, never values. Saving passes the secret straight from the form to
 * `config.set_integration_credential`, which puts it in the vault and keeps
 * only a reference; nothing here holds it after the call returns. Revoking
 * calls `config.revoke_integration_credential`. Listing never returns a value
 * because the function it calls has none to return.
 *
 * Provider codes are the vault's own (migration 0007); the admin speaks in
 * those because that is what the operator saves against.
 */

import { Pool } from 'pg';

import { databaseUrlFromEnvironment, sharedPool, tenantUuidByCode } from '@sanad/origination/credentials.ts';

/** As constrained by migration 0007, widened for the UAE rails by migration 0015 (ADR 0005). */
export const VAULT_PROVIDERS = [
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
export type VaultProvider = (typeof VAULT_PROVIDERS)[number];
export const ENVIRONMENTS = ['sandbox', 'uat', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** The key names each provider's adapter reads, offered as suggestions; any name is accepted. */
export const KNOWN_KEY_NAMES: Readonly<Partial<Record<VaultProvider, readonly string[]>>> = {
  NUTRIENT: ['web_sdk_license_key', 'document_engine_base_url', 'document_engine_api_token', 'jwt_private_key'],
  TUUM: ['username', 'password', 'tenant_code', 'auth_base_url', 'loan_api_base_url'],
};

export interface CredentialRow {
  readonly id: string;
  readonly provider: string;
  readonly environment: string;
  readonly keyName: string;
  readonly label: string | null;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly lastRotatedAt: string | null;
  readonly lastAccessedAt: string | null;
  readonly createdAt: string;
}

export interface Tenant {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
}

export type StoreState = { readonly kind: 'READY'; readonly pool: Pool } | { readonly kind: 'NO_DATABASE' };

export function store(): StoreState {
  const url = databaseUrlFromEnvironment();
  return url === undefined ? { kind: 'NO_DATABASE' } : { kind: 'READY', pool: sharedPool(url) };
}

export async function listTenants(pool: Pool): Promise<readonly Tenant[]> {
  const r = await pool.query<{ id: string; code: string; name_en: string; name_ar: string }>(
    'select id, code, name_en, name_ar from core.tenant order by code',
  );
  return r.rows.map((t) => ({ id: t.id, code: t.code, nameEn: t.name_en, nameAr: t.name_ar }));
}

export async function listCredentials(pool: Pool, tenantCode: string): Promise<readonly CredentialRow[]> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  const r = await pool.query<{
    id: string;
    provider: string;
    environment: string;
    key_name: string;
    label: string | null;
    status: string;
    expires_at: Date | null;
    last_rotated_at: Date | null;
    last_accessed_at: Date | null;
    created_at: Date;
  }>('select * from config.list_integration_credentials($1::uuid) order by provider, environment, key_name', [tenant]);
  const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());
  return r.rows.map((c) => ({
    id: c.id,
    provider: c.provider,
    environment: c.environment,
    keyName: c.key_name,
    label: c.label,
    status: c.status,
    expiresAt: iso(c.expires_at),
    lastRotatedAt: iso(c.last_rotated_at),
    lastAccessedAt: iso(c.last_accessed_at),
    createdAt: c.created_at.toISOString(),
  }));
}

export interface SaveParams {
  readonly tenantCode: string;
  readonly provider: VaultProvider;
  readonly environment: Environment;
  readonly keyName: string;
  readonly secret: string;
  readonly label?: string;
}

/** Returns the credential id. The secret is a parameter of one query and is referenced nowhere else. */
export async function saveCredential(pool: Pool, p: SaveParams): Promise<string> {
  const tenant = await tenantUuidByCode(pool, p.tenantCode);
  const r = await pool.query<{ id: string }>(
    'select config.set_integration_credential($1::uuid, $2, $3, $4, $5, $6) as id',
    [tenant, p.provider, p.environment, p.keyName, p.secret, p.label ?? null],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('the credential store returned no id');
  return id;
}

export async function revokeCredential(pool: Pool, credentialId: string): Promise<void> {
  await pool.query('select config.revoke_integration_credential($1::uuid)', [credentialId]);
}
