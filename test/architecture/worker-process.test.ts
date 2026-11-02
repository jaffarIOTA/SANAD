/**
 * The workflow worker starts as its own process, outside any bundler (ADR 0003,
 * KSA-WF-TEMPORAL-01): plain Node resolves every module it needs through the
 * alias hook, which reads tsconfig.json's `paths` so the two cannot drift.
 * The process is spawned, not imported: an import here would be resolved by
 * Vitest and prove nothing.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { aliasesFrom, resolveAlias } from '../../services/worker/alias-map.mjs';

const ROOT = process.cwd();
const NODE_FLAGS = ['--experimental-transform-types', '--no-warnings', '--import', './services/worker/aliases.mjs'];

describe('the standalone workflow worker', () => {
  it('maps every tsconfig alias, the longest first', () => {
    const aliases = aliasesFrom(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8'), ROOT);
    const paths = (
      JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf8')) as {
        compilerOptions: { paths: Record<string, string[]> };
      }
    ).compilerOptions.paths;
    expect(aliases).toHaveLength(Object.keys(paths).length);
    expect(resolveAlias('@sanad/origination/wasl/book.ts', aliases)).toBe(
      `${pathToFileURL(join(ROOT, 'services/origination/src')).href}/wasl/book.ts`,
    );
    expect(resolveAlias('@sanad/core/kernel/result.ts', aliases)).toBe(
      `${pathToFileURL(join(ROOT, 'core')).href}/kernel/result.ts`,
    );
    expect(resolveAlias('node:fs', aliases)).toBeUndefined();
    expect(resolveAlias('@temporalio/worker', aliases)).toBeUndefined();
  });

  it('starts under plain Node, resolving everything, and names each tenant’s daily schedule', () => {
    const out = execFileSync(process.execPath, [...NODE_FLAGS, 'services/worker/main.ts', '--check'], {
      cwd: ROOT,
      env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'development' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(out).toContain('schedule bank-a 06:00 Asia/Riyadh');
    expect(out).toContain('schedule sme-fund-ae 06:00 Asia/Dubai');
    expect(out).toContain('worker ready for default/sanad-sequencing');
  }, 90_000);

  it('refuses a tenant that does not exist, and to run without a server address', () => {
    const run = (env: Record<string, string>, args: string[]) => {
      try {
        execFileSync(process.execPath, [...NODE_FLAGS, 'services/worker/main.ts', ...args], {
          cwd: ROOT,
          env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'development', ...env },
          encoding: 'utf8',
          timeout: 60_000,
          stdio: 'pipe',
        });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    expect(run({ SANAD_WORKER_TENANTS: 'no-such-bank' }, ['--check'])).toBe(1);
    expect(run({}, [])).toBe(2);
  }, 120_000);
});
