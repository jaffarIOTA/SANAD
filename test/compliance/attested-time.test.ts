/**
 * SR-006: an attested instant is made only by a timestamping authority, by the
 * labelled host clock where that is permitted, or restored from its recorded
 * evidence; nowhere else.
 *
 * - No module outside the three named places constructs a `TsaInstant`.
 * - The host clock refuses in any deployment that is not declared synthetic,
 *   so a real-data deployment cannot run without an authority, and every
 *   instant it makes says it is the host clock's.
 * - A stored instant without its evidence is refused, not restored.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { restoreAttestedInstant } from '../../core/time/tsa.ts';
import { HOST_CLOCK_AUTHORITY, hostClockInstant } from '../../services/origination/src/host-clock.ts';
import { DevelopmentStandInRefused } from '../../services/origination/src/profile.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The only places that may construct one. A timestamping adapter, when it exists, is added here. */
const CONSTRUCTORS = new Set([
  'core/time/tsa.ts',
  'services/origination/src/host-clock.ts',
  // A virtual clock for workflow tests; never wired into an app.
  'adapters/workflow-temporal/in-memory/runner.ts',
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === '.next') continue;
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('attested instants (SR-006)', () => {
  it('are constructed only by the authority, the host clock and restoration', () => {
    const offenders = ['core', 'products', 'services', 'apps', 'adapters', 'packages']
      .flatMap((d) => sources(d))
      .filter((f) => !CONSTRUCTORS.has(f))
      .filter((f) => /\btsaInstant\s*\(/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('come from the host clock only in development or a declared-synthetic deployment', () => {
    expect(hostClockInstant(1_800_000_000n, { NODE_ENV: 'test' }).epochSeconds).toBe(1_800_000_000n);
    expect(hostClockInstant(1n, { NODE_ENV: 'production', SANAD_DATA_CLASS: 'SYNTHETIC' }).epochSeconds).toBe(1n);
    for (const env of [
      { NODE_ENV: 'production' },
      { SANAD_DEPLOYMENT_PROFILE: 'DEPLOYED' },
      { NODE_ENV: 'production', SANAD_DATA_CLASS: 'PRODUCTION' },
    ])
      expect(() => hostClockInstant(undefined, env), JSON.stringify(env)).toThrow(DevelopmentStandInRefused);
  });

  it("say they are the host clock's, never an authority's", () => {
    const i = hostClockInstant(1_800_000_000n, { NODE_ENV: 'test' });
    expect(i.authorityId).toBe(HOST_CLOCK_AUTHORITY);
    expect(i.tokenDigest).toBe('host-clock-1800000000');
  });

  it('are restored only with the evidence they were recorded with', () => {
    expect(restoreAttestedInstant({ epochSeconds: 5n, tokenDigest: 'd', authorityId: 'tsa-1' }).epochSeconds).toBe(5n);
    expect(() => restoreAttestedInstant({ epochSeconds: 5n, tokenDigest: '', authorityId: 'tsa-1' })).toThrow();
    expect(() => restoreAttestedInstant({ epochSeconds: 5n, tokenDigest: 'd', authorityId: '' })).toThrow();
  });
});
