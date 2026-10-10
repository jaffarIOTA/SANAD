/**
 * SR-003: no statement reaches tenant data outside a tenant scope.
 *
 * Row-level security binds only inside `inTenant` (services/origination/src/
 * tenant-scope.ts), which drops to `sanad_app` and sets the tenant for the
 * transaction. A query sent straight through a pool runs as whatever the pool
 * logs in as, and a connection taken from a pool is a transaction the scope
 * does not own. So: a pool's `.query` never names a tenant table, and only the
 * scope takes connections. The database side is proven in
 * test/contract/runtime-rls.test.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const SCOPE = 'services/origination/src/tenant-scope.ts';

function files(dir: string, pattern: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === '.next') continue;
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) files(p, pattern, out);
    else if (pattern.test(name)) out.push(p);
  }
  return out;
}

/**
 * Every table a migration creates with a `tenant_id` column, less the vault's two,
 * which no runtime role may touch at all and which are reached only through their
 * SECURITY DEFINER functions.
 */
const VAULT_ONLY = new Set(['config.integration_credential', 'audit.credential_access']);
const TENANT_TABLES = files('supabase/migrations', /\.sql$/)
  .flatMap((f) => [...read(f).matchAll(/create table (?:if not exists )?([a-z_]+\.[a-z_]+)\s*\(([\s\S]*?)\n\);/gi)])
  .filter((m) => /\btenant_id\b/.test(m[2] ?? ''))
  .map((m) => (m[1] as string).toLowerCase())
  .filter((t) => !VAULT_ONLY.has(t));

const RUNTIME = [...files('services', /\.tsx?$/), ...files('apps', /\.tsx?$/), ...files('packages', /\.tsx?$/)].filter(
  (f) => f !== SCOPE,
);

describe('tenant data only through a tenant scope (SR-003)', () => {
  it('finds the tenant tables the rule protects', () => {
    expect(TENANT_TABLES).toEqual(
      expect.arrayContaining(['core.origination_request', 'core.business_application', 'core.outbox_event']),
    );
    expect(TENANT_TABLES.length).toBeGreaterThan(30);
  });

  it("never names a tenant table in a pool's own query", () => {
    const offenders: string[] = [];
    for (const file of RUNTIME) {
      const src = read(file);
      for (const m of src.matchAll(/\bpool\.query\b/g)) {
        // The statement is the call's first argument; 800 characters covers the longest one in the tree.
        const call = src.slice(m.index, m.index + 800).split(/\)\s*;/)[0] ?? '';
        for (const t of TENANT_TABLES)
          if (new RegExp(`\\b${t.replace('.', '\\.')}\\b`, 'i').test(call)) offenders.push(`${file}: ${t}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('takes connections from a pool only in the scope itself', () => {
    expect(RUNTIME.filter((f) => /\bpool\.connect\(/.test(read(f)))).toEqual([]);
  });

  it('sets the tenant per transaction and drops to a runtime role first', () => {
    const scope = read(SCOPE);
    expect(scope).toMatch(/set_config\('sanad\.tenant_id', \$1, true\)/);
    expect(scope).toMatch(/set local role sanad_app/);
    expect(scope).not.toMatch(/set_config\('sanad\.tenant_id', \$1, false\)/);
  });
});
