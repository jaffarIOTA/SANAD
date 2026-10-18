/**
 * SR-019: the SME portal reads real data only behind sign-in, and stays
 * undeployed until it is released.
 *
 * Until Wasl W3 the portal rendered fixture data and had no sign-in, and this
 * test held it off the database entirely. W3 put it behind sign-in — a
 * distributor's authorised signatory, through the national identity service,
 * in a sealed session — with its BOLA tests
 * (test/compliance/wasl-acceptance.test.ts), so the test now holds the shape
 * that makes real data safe there:
 *
 *   - the portal reaches the database only through the shared Wasl book and
 *     its session's spent tokens — never a pool, the credential store, staff
 *     identity, the licence or the tenant scope directly;
 *   - every page but sign-in requires the session before it reads anything;
 *   - it imports nothing from the operations workbench, which is another
 *     deployable and another trust boundary;
 *   - it is still not in the hosted environment.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === '.next') continue;
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('the SME portal reads real data only behind sign-in (SR-019)', () => {
  it('reaches the database only through the Wasl book and its spent tokens', () => {
    const reach =
      /from 'pg'|sharedPool|SANAD_DATABASE_URL|@sanad\/origination\/(credentials|staff-identity|licensing|tenant-scope)|tenant-scope/;
    expect(sources('apps/sme/src').filter((f) => reach.test(read(f)))).toEqual([]);
  });

  it('imports nothing from the operations workbench', () => {
    expect(sources('apps/sme/src').filter((f) => /apps\/ops|\.\.\/ops\//.test(read(f)))).toEqual([]);
  });

  it('every page but sign-in requires the session before it reads', () => {
    const pages = sources('apps/sme/src/app').filter((f) => /page\.tsx$/.test(f) && !f.includes('sign-in'));
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      const text = read(page);
      expect(text, page).toMatch(/const session = await currentSession\(\);\s*if \(session === undefined\) redirect\(/);
    }
  });

  it('the distributor is the configuration’s, never the form’s', () => {
    const actions = read('apps/sme/src/server/actions.ts');
    expect(actions).not.toMatch(/field\(form, '(counterpartyId|tenant|tenantId|distributor)'\)/);
  });

  it('is not in the hosted environment', () => {
    expect(read('deploy/azure/main.bicep')).not.toMatch(/app: 'sme'/);
    const deploy = parse(read('.github/workflows/deploy-azure.yml')) as {
      jobs: Record<string, { strategy?: { matrix?: { app?: string[] } } }>;
    };
    for (const job of Object.values(deploy.jobs)) expect(job.strategy?.matrix?.app ?? []).not.toContain('sme');
  });
});
