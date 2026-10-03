/**
 * Which credential provider an app uses, decided once from the environment.
 *
 * A database reachable → the vault, through `config.get_integration_credential`,
 * which audits and refuses on its own. No database → the environment
 * provider, development only; it refuses to exist in production. Either way
 * an adapter asks by `CredentialRef` and cannot tell which answered.
 */

import { Pool } from 'pg';

import { EnvironmentCredentialProvider } from '../../../adapters/kernel/credentials-environment.ts';
import { VaultCredentialProvider } from '../../../adapters/kernel/credentials-vault.ts';
import type { CredentialProvider } from '../../../core/ports/credentials.ts';

export function databaseUrlFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const url = env['SANAD_DATABASE_URL'] ?? env['SANAD_TEST_DATABASE_URL'];
  return url === undefined || url.trim().length === 0 ? undefined : url.trim();
}

interface State { pool?: Pool; provider?: CredentialProvider; url?: string }
const state: State = ((globalThis as { __sanadCredentials?: State }).__sanadCredentials ??= {});

/** One pool per process; the tenant code → uuid lookup is the only query this module owns. */
export function sharedPool(url: string): Pool {
  if (state.pool === undefined || state.url !== url) { state.pool = new Pool({ connectionString: url, max: 4 }); state.url = url; }
  return state.pool;
}

export async function tenantUuidByCode(pool: Pool, code: string): Promise<string> {
  const r = await pool.query<{ id: string }>('select id from core.tenant where code = $1', [code]);
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`unknown tenant code: ${code}`);
  return id;
}

export function credentialProviderFromEnvironment(env: Readonly<Record<string, string | undefined>> = process.env): CredentialProvider {
  if (state.provider !== undefined) return state.provider;
  const url = databaseUrlFromEnvironment(env);
  // The vault function writes its own audit row; the environment provider's reads are development-only and not persisted.
  const quiet = (): void => undefined;
  state.provider = url === undefined
    ? new EnvironmentCredentialProvider(quiet, env)
    : new VaultCredentialProvider(sharedPool(url), quiet, (code) => tenantUuidByCode(sharedPool(url), code));
  return state.provider;
}

export function credentialSource(env: Readonly<Record<string, string | undefined>> = process.env): 'VAULT' | 'ENVIRONMENT' {
  return databaseUrlFromEnvironment(env) === undefined ? 'ENVIRONMENT' : 'VAULT';
}
