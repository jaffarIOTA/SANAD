/**
 * The module aliases exist twice, so they are checked against each other.
 *
 * `tsconfig.json` maps `@sanad/*` for the compiler; `vitest.config.ts` maps it
 * again for the test runner, because Vite resolves imports itself and does not
 * read tsconfig paths. Two copies of one mapping drift, and the failure is
 * confusing when it happens — the build is green and the tests cannot find a
 * module, or worse, the tests resolve a stale path and pass against the wrong
 * file.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function tsconfigPaths(): Record<string, string> {
  // Comments are not permitted in this file today, so JSON.parse is honest.
  const tsconfig = JSON.parse(readFileSync(`${ROOT}tsconfig.json`, 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> };
  };

  const out: Record<string, string> = {};
  for (const [alias, targets] of Object.entries(tsconfig.compilerOptions.paths)) {
    if (!alias.startsWith('@sanad/')) continue;
    const target = targets[0];
    if (target === undefined) continue;
    out[alias.replace(/\/\*$/, '')] = target.replace(/\/\*$/, '');
  }
  return out;
}

function vitestAliases(): Record<string, string> {
  const source = readFileSync(`${ROOT}vitest.config.ts`, 'utf8');
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/'(@sanad\/[\w-]+)':\s*dir\('\.\/([^']+)'\)/g)) {
    const [, alias, target] = match;
    if (alias !== undefined && target !== undefined) out[alias] = target;
  }
  return out;
}

describe('module aliases agree across the compiler and the test runner', () => {
  it('maps the same names', () => {
    expect(Object.keys(vitestAliases()).sort()).toEqual(Object.keys(tsconfigPaths()).sort());
  });

  it('maps them to the same directories', () => {
    expect(vitestAliases()).toEqual(tsconfigPaths());
  });
});
