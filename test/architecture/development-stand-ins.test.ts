/**
 * SR-004: no development stand-in is constructed under a deployed profile.
 *
 * The stand-ins (environment-token credential registry, fabricated applicant
 * snapshots, host-clock timestamps, dispatch ports that report bureau reports
 * and payments as delivered without delivering them) each refuse construction
 * when the profile is not development. The entry points and the hosted apps use
 * no other stand-in, and no app builds one at module load, where `next build`
 * (which runs as production) would evaluate it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { developmentDispatchPorts } from '../../services/outbox/src/development-ports.ts';
import { developmentRegistry } from '../../services/origination/src/principal.ts';
import { DevelopmentStandInRefused, deploymentProfile } from '../../services/origination/src/profile.ts';
import { developmentTimestamps } from '../../services/origination/src/server.ts';
import { developmentSnapshots } from '../../services/origination/src/snapshots.ts';
import { developmentTokensPermitted } from '../../apps/ops/src/server/staff.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

type Env = Record<string, string | undefined>;
const FACTORIES: Readonly<Record<string, (env: Env) => unknown>> = {
  developmentRegistry: (env) => developmentRegistry(env as NodeJS.ProcessEnv),
  developmentSnapshots: (env) => developmentSnapshots(env),
  developmentTimestamps: (env) => developmentTimestamps(env),
  developmentDispatchPorts: (env) => developmentDispatchPorts([], { env }),
};
const DEPLOYED: readonly Env[] = [
  { NODE_ENV: 'production' },
  { SANAD_DEPLOYMENT_PROFILE: 'DEPLOYED' },
  { NODE_ENV: 'test', SANAD_DEPLOYMENT_PROFILE: 'DEPLOYED' },
];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === '.next') continue;
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) files(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('development stand-ins under a deployed profile (SR-004)', () => {
  for (const [name, build] of Object.entries(FACTORIES)) {
    it(`${name} refuses construction under every deployed profile`, () => {
      for (const env of DEPLOYED) expect(() => build(env), JSON.stringify(env)).toThrow(DevelopmentStandInRefused);
    });
    it(`${name} constructs in development`, () => {
      expect(build({ NODE_ENV: 'test' })).toBeDefined();
    });
  }

  it('reads SANAD_DEPLOYMENT_PROFILE as well as NODE_ENV, and defaults to development only when neither says deployed', () => {
    expect(deploymentProfile({})).toBe('DEVELOPMENT');
    expect(deploymentProfile({ NODE_ENV: 'development' })).toBe('DEVELOPMENT');
    for (const env of DEPLOYED) expect(deploymentProfile(env)).toBe('DEPLOYED');
  });

  it('refuses staff development tokens under SANAD_DEPLOYMENT_PROFILE=DEPLOYED, not only NODE_ENV=production', () => {
    for (const env of DEPLOYED) expect(developmentTokensPermitted(env)).toBe(false);
  });

  it('every development factory exported by a service calls the guard first', () => {
    // developmentSnapshot is the pure answer behind developmentSnapshots, reachable only through it or a test.
    const PURE_HELPERS = new Set(['developmentSnapshot']);
    const found: string[] = [];
    for (const file of files('services')) {
      const src = read(file);
      for (const m of src.matchAll(/export function (development[A-Z]\w*)\([^)]*\)[^{]*\{\n([^\n]*)/g)) {
        const [, name, firstLine] = m;
        if (PURE_HELPERS.has(name as string)) continue;
        found.push(name as string);
        expect(firstLine, `${file} ${name as string}`).toMatch(/refuseUnderDeployedProfile\('/);
      }
    }
    expect(found.sort()).toEqual(Object.keys(FACTORIES).sort());
  });

  it('the service and worker entry points use no stand-in outside the guarded set', () => {
    for (const entry of ['services/origination/src/index.ts', 'services/outbox/src/index.ts']) {
      const called = [...read(entry).matchAll(/\b(development[A-Z]\w*)\(/g)].map((m) => m[1] as string);
      expect(called.length, entry).toBeGreaterThan(0);
      for (const name of called) expect(Object.keys(FACTORIES), `${entry} ${name}`).toContain(name);
    }
  });

  it('no app constructs a guarded stand-in at module load', () => {
    const factory = new RegExp(
      `^(?:export )?(?:const|let|var) \\w+[^=]*= *(?:${Object.keys(FACTORIES).join('|')})\\(`,
      'm',
    );
    const offenders = files('apps')
      .filter((f) => factory.test(read(f)))
      .map((f) => relative(ROOT, join(ROOT, f)));
    expect(offenders).toEqual([]);
  });
});
