/**
 * The core banking platform's own products, read live for the Products &
 * modules screen: what the core offers, and whether it would price a product
 * by a rate. Read only. The adapter is built from the tenant's rail
 * configuration and the vault; the password is resolved through the audited
 * function when a token is needed and held nowhere else.
 */

import { randomUUID } from 'node:crypto';

import { createTuumProductCatalogue } from '@sanad/adapters/tuum/product-catalogue.ts';
import type { TenantCode } from '@sanad/config/loader.ts';
import type {
  CoreBankingProductCatalogue,
  CoreBankingProductDetail,
  CoreBankingProductType,
} from '@sanad/core/ports/core-banking-catalogue.ts';
import type { CredentialRef, Environment } from '@sanad/core/ports/credentials.ts';
import type { RailOutcome } from '@sanad/core/ports/rail.ts';
import { credentialProviderFromEnvironment, databaseUrlFromEnvironment } from '@sanad/origination/credentials.ts';
import { resolveRailsConfiguration } from '@sanad/origination/rails.ts';

/** The vault key names the catalogue reader needs, with the older spelling of the tenant code accepted. */
const KEYS = {
  username: ['username'],
  password: ['password'],
  tenantCode: ['tenant_code', 'tenantcode', 'tenantCode'],
  authHost: ['auth_base_url'],
  productsHost: ['loan_api_base_url'],
} as const;

export type CoreProductsState =
  | { readonly kind: 'NO_DATABASE' }
  | { readonly kind: 'NO_RAIL' }
  | { readonly kind: 'UNSUPPORTED_ADAPTER'; readonly adapter: string }
  | {
      readonly kind: 'NOT_CONFIGURED';
      readonly adapter: string;
      readonly environment: Environment;
      readonly missing: readonly string[];
    }
  | {
      readonly kind: 'READY';
      readonly adapter: string;
      readonly environment: Environment;
      readonly enabled: boolean;
      readonly catalogue: CoreBankingProductCatalogue;
    };

interface Cached {
  readonly catalogue: CoreBankingProductCatalogue;
  readonly environment: Environment;
}
const cache: Map<string, Cached> = ((
  globalThis as { __sanadCoreCatalogues?: Map<string, Cached> }
).__sanadCoreCatalogues ??= new Map());

async function readKey(
  tenant: TenantCode,
  environment: Environment,
  names: readonly string[],
  correlationId: string,
): Promise<string | undefined> {
  const provider = credentialProviderFromEnvironment();
  for (const keyName of names) {
    const ref: CredentialRef = { tenantId: tenant, provider: 'CORE_BANKING', environment, keyName };
    try {
      return (await provider.get(ref, correlationId)).expose();
    } catch {
      // Missing under this spelling; try the next.
    }
  }
  return undefined;
}

export async function coreProductsState(tenant: TenantCode, nowEpochSeconds: bigint): Promise<CoreProductsState> {
  if (databaseUrlFromEnvironment() === undefined) return { kind: 'NO_DATABASE' };
  const rails = await resolveRailsConfiguration(tenant, nowEpochSeconds);
  const rail = rails.rails.ok ? rails.rails.value.rails.find((r) => r.capability === 'CORE_BANKING') : undefined;
  if (rail === undefined) return { kind: 'NO_RAIL' };
  if (rail.adapter !== 'TUUM') return { kind: 'UNSUPPORTED_ADAPTER', adapter: rail.adapter };
  const environment = rail.environment;
  const key = `${tenant}/${environment}`;
  const existing = cache.get(key);
  if (existing !== undefined)
    return { kind: 'READY', adapter: rail.adapter, environment, enabled: rail.enabled, catalogue: existing.catalogue };

  const correlationId = randomUUID();
  const authHost = await readKey(tenant, environment, KEYS.authHost, correlationId);
  const productsHost = await readKey(tenant, environment, KEYS.productsHost, correlationId);
  const username = await readKey(tenant, environment, KEYS.username, correlationId);
  const tenantCode = await readKey(tenant, environment, KEYS.tenantCode, correlationId);
  const password = await readKey(tenant, environment, KEYS.password, correlationId);
  const missing = [
    ...(authHost === undefined ? ['auth_base_url'] : []),
    ...(productsHost === undefined ? ['loan_api_base_url'] : []),
    ...(username === undefined ? ['username'] : []),
    ...(tenantCode === undefined ? ['tenant_code'] : []),
    ...(password === undefined ? ['password'] : []),
  ];
  if (
    authHost === undefined ||
    productsHost === undefined ||
    username === undefined ||
    tenantCode === undefined ||
    password === undefined
  ) {
    return { kind: 'NOT_CONFIGURED', adapter: rail.adapter, environment, missing };
  }

  const catalogue = createTuumProductCatalogue({
    hosts: { auth: authHost.replace(/\/+$/, ''), products: productsHost.replace(/\/+$/, '') },
    // The password is re-read through the audited function each time the session logs in, not kept from the check above.
    credentials: async () => ({
      username,
      tenantCode,
      identityKind: 'EMPLOYEE',
      password: (await readKey(tenant, environment, KEYS.password, randomUUID())) ?? '',
    }),
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  });
  cache.set(key, { catalogue, environment });
  return { kind: 'READY', adapter: rail.adapter, environment, enabled: rail.enabled, catalogue };
}

export async function listCoreProducts(
  state: CoreProductsState,
): Promise<RailOutcome<readonly CoreBankingProductType[]> | undefined> {
  return state.kind === 'READY' ? state.catalogue.listProductTypes(randomUUID()) : undefined;
}

export async function describeCoreProduct(
  state: CoreProductsState,
  code: string,
): Promise<RailOutcome<CoreBankingProductDetail> | undefined> {
  return state.kind === 'READY' ? state.catalogue.describeProductType(code, randomUUID()) : undefined;
}
