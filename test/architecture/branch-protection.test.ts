/**
 * SR-021: the checks main requires are the gates security.yml runs, so
 * renaming or adding a gate cannot quietly leave a merge unguarded, and the
 * scheduled check fails on a branch that has lost its protection.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// @ts-expect-error: a plain script, typed by its use here.
import { REQUIRED_CHECKS, protectionFailures } from '../../scripts/branch-protection-check.mjs';

interface Job {
  readonly name?: string;
  readonly if?: string;
  readonly strategy?: { readonly matrix?: Record<string, readonly string[]> };
}

const workflow = parse(
  readFileSync(fileURLToPath(new URL('../../.github/workflows/security.yml', import.meta.url)), 'utf8'),
) as { readonly jobs: Record<string, Job> };

/** Each job's check name as GitHub reports it, a matrix expanded. */
const gateNames = Object.values(workflow.jobs).flatMap((job) => {
  const name = job.name ?? '';
  const matrix = job.strategy?.matrix ?? {};
  const [key] = Object.keys(matrix);
  if (key === undefined || !name.includes('${{ matrix.')) return [name];
  return (matrix[key] ?? []).map((value) => name.replace(`\${{ matrix.${key} }}`, value));
});

/**
 * A gate on a stacked branch not yet on main. Requiring it before it reaches
 * main would block every pull request into main, since it never reports there.
 */
const NOT_YET_ON_MAIN = new Set(['Image scan (worker)']);

const required = REQUIRED_CHECKS as readonly string[];

describe('main requires every security gate (SR-021)', () => {
  it('requires only checks the workflow runs', () => {
    for (const check of required) expect(gateNames).toContain(check);
  });

  it('requires every gate the workflow runs, but for one not yet on main', () => {
    const missing = gateNames.filter((g) => !required.includes(g) && !NOT_YET_ON_MAIN.has(g));
    expect(missing).toEqual([]);
  });

  it('fails a branch that is unprotected, open to administrators, or missing a check', () => {
    const contexts = [...required];
    const good = {
      protected: true,
      protection: { enabled: true, required_status_checks: { enforcement_level: 'everyone', contexts } },
    };
    expect(protectionFailures(good)).toEqual([]);
    expect(protectionFailures({ protected: false })).toContain('main is not protected');
    expect(
      protectionFailures({
        ...good,
        protection: { enabled: true, required_status_checks: { enforcement_level: 'non_admins', contexts } },
      }),
    ).toContain('protection does not bind administrators');
    expect(
      protectionFailures({
        ...good,
        protection: {
          enabled: true,
          required_status_checks: { enforcement_level: 'everyone', contexts: contexts.slice(1) },
        },
      }),
    ).toEqual([`not required: ${required[0] ?? ''}`]);
  });
});
