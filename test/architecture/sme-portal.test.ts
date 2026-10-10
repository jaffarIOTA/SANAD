/**
 * SR-019: the SME portal has no sign-in, so it may neither read real data nor
 * be deployed.
 *
 * It renders fixture data today. The day someone wires it to the database or
 * adds it to the hosted environment, this fails: put it behind sign-in first
 * (and add its BOLA tests), then change this test.
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

describe('the SME portal stays undeployed and off real data until it has sign-in (SR-019)', () => {
  it('reaches no database, persistence module or credential store', () => {
    const reach =
      /from 'pg'|sharedPool|persistence|SANAD_DATABASE_URL|@sanad\/origination\/(credentials|staff-identity|licensing)|tenant-scope/;
    expect(sources('apps/sme/src').filter((f) => reach.test(read(f)))).toEqual([]);
  });

  it('is not in the hosted environment', () => {
    expect(read('deploy/azure/main.bicep')).not.toMatch(/app: 'sme'/);
    const deploy = parse(read('.github/workflows/deploy-azure.yml')) as {
      jobs: Record<string, { strategy?: { matrix?: { app?: string[] } } }>;
    };
    for (const job of Object.values(deploy.jobs)) expect(job.strategy?.matrix?.app ?? []).not.toContain('sme');
  });
});
