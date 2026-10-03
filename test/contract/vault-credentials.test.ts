/**
 * The credential store against a real database: save through the vault
 * function, read through the vault provider, see the audit row, revoke, and
 * be refused. Runs only when SANAD_TEST_DATABASE_URL points at a database
 * with migrations 0001–0007 applied (`npx supabase start`).
 */
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { VaultCredentialProvider } from '../../adapters/kernel/credentials-vault.ts';
import type { CredentialReadAudit } from '../../adapters/kernel/credentials-environment.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const KEY = `contract_probe_${String(Date.now())}`;
const VALUE = `fixture-value-${String(Math.random()).slice(2)}`;

describe.skipIf(url === undefined)('the vault credential store (SANAD_TEST_DATABASE_URL)', () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  const tenant = async (): Promise<string> => (await pool.query<{ id: string }>("select id from core.tenant where code = 'bank-a'")).rows[0]?.id ?? '';
  const audits: CredentialReadAudit[] = [];
  const provider = new VaultCredentialProvider(pool, (a) => audits.push(a), tenant);
  let credentialId = '';
  afterAll(async () => { await pool.end(); });

  it('saves without exposing a plaintext column, and the listing shows names only', async () => {
    const t = await tenant();
    const r = await pool.query<{ id: string }>('select config.set_integration_credential($1::uuid, $2, $3, $4, $5, $6) as id', [t, 'NUTRIENT', 'sandbox', KEY, VALUE, 'contract test']);
    credentialId = r.rows[0]?.id ?? '';
    expect(credentialId).toMatch(/^[0-9a-f-]{36}$/);
    const cols = await pool.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'config' and table_name = 'integration_credential'");
    expect(cols.rows.map((c) => c.column_name)).not.toContain('secret');
    const listed = await pool.query<{ key_name: string }>('select key_name from config.list_integration_credentials($1::uuid)', [t]);
    expect(listed.rows.map((c) => c.key_name)).toContain(KEY);
    expect(JSON.stringify(listed.rows)).not.toContain(VALUE);
  });
  it('reads back through the provider as a redacting secret, and the read is audited', async () => {
    const before = Number((await pool.query<{ n: string }>('select count(*) as n from audit.credential_access')).rows[0]?.n ?? '0');
    const secret = await provider.get({ tenantId: 'bank-a', provider: 'DOCUMENT_PLATFORM', environment: 'sandbox', keyName: KEY }, '00000000-0000-4000-8000-000000000001');
    expect(secret.expose()).toBe(VALUE);
    expect(String(secret)).toBe('[redacted]');
    const after = Number((await pool.query<{ n: string }>('select count(*) as n from audit.credential_access')).rows[0]?.n ?? '0');
    expect(after).toBe(before + 1);
    expect(audits.at(-1)?.source).toBe('VAULT');
  });
  it('refuses after revocation rather than returning the stale value', async () => {
    await pool.query('select config.revoke_integration_credential($1::uuid)', [credentialId]);
    await expect(provider.get({ tenantId: 'bank-a', provider: 'DOCUMENT_PLATFORM', environment: 'sandbox', keyName: KEY }, 'x')).rejects.toThrow(/REVOKED|revoked/);
  });
  it('refuses a name never saved', async () => {
    await expect(provider.get({ tenantId: 'bank-a', provider: 'DOCUMENT_PLATFORM', environment: 'sandbox', keyName: 'never_saved' }, 'x')).rejects.toThrow(/no credential/);
  });
});
