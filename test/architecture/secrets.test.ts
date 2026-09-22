/**
 * Secrets, enforced by reading the repository.
 *
 * CLAUDE.md §4 and §10 say a secret is never committed, never logged, never
 * returned from an API and never written into a tracked `.env`. Those are
 * absences, so they are tested the same way the other absences are — by
 * reading the source rather than by calling a function.
 *
 * The rule that matters most in a Next.js codebase is the `NEXT_PUBLIC_` one.
 * That prefix does not merely expose a value to the server's client code: the
 * build **inlines it into the JavaScript bundle**, so it ships to every
 * browser that loads the page and lives in every CDN cache and every user's
 * disk. One character of prefix is the whole difference, there is no runtime
 * error when it is wrong, and it is invisible in review.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.sql', '.json', '.yaml', '.yml']);
const SURFACES = ['core', 'config', 'adapters', 'apps', 'packages', 'supabase', 'api'];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.has(extname(entry))) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const rel = (file: string): string => relative(ROOT, file);
const tracked = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

/** Names that carry a secret rather than a location. */
const SECRET_SHAPED = /(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)/i;

describe('§4 — no secret is committed', () => {
  it('tracks no environment file except the example', () => {
    const offenders = tracked().filter(
      (f) => /(^|\/)\.env/.test(f) && !f.endsWith('.env.example'),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the example free of values', () => {
    const lines = readFileSync(join(ROOT, '.env.example'), 'utf8').split('\n');
    const withValues = lines.filter((line) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return false;
      const [, value = ''] = trimmed.split(/=(.*)/s);
      return value.trim().length > 0;
    });
    expect(withValues).toEqual([]);
  });

  it('commits no key or certificate file', () => {
    const offenders = tracked().filter((f) => /\.(pem|p12|pfx|key|jks|keystore)$/i.test(f));
    expect(offenders).toEqual([]);
  });

  /**
   * Catches the shape of a pasted credential rather than any specific one: a
   * long opaque string assigned to a secret-named thing. Deliberately narrow,
   * because a scanner that cries wolf gets switched off.
   */
  it('assigns no long opaque literal to a secret-named field', () => {
    const assignment =
      /(token|secret|password|api[_-]?key|credential)\w*\s*[:=]\s*['"`]([A-Za-z0-9_\-+/=.]{24,})['"`]/gi;

    const offenders: string[] = [];
    for (const surface of SURFACES) {
      for (const file of filesUnder(surface)) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(assignment)) {
          const value = match[2] ?? '';
          // Placeholders, fixtures and obvious non-secrets are fine.
          if (/^(development|example|placeholder|redacted|changeme|test|fixture)/i.test(value)) {
            continue;
          }
          if (/^\$\{/.test(value)) continue;
          offenders.push(`${rel(file)}: ${match[1] ?? ''}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('§4 — no secret reaches the browser', () => {
  /**
   * The one that will actually bite someone. `NEXT_PUBLIC_` inlines the value
   * into the client bundle at build time — no runtime error, no review signal,
   * and the value ends up in every CDN cache.
   */
  it('gives no secret-shaped variable a NEXT_PUBLIC_ prefix', () => {
    const offenders: string[] = [];

    const check = (source: string, where: string): void => {
      for (const match of source.matchAll(/NEXT_PUBLIC_([A-Z0-9_]+)/g)) {
        const name = match[1] ?? '';
        if (SECRET_SHAPED.test(name)) offenders.push(`${where}: NEXT_PUBLIC_${name}`);
      }
    };

    for (const surface of SURFACES) {
      for (const file of filesUnder(surface)) check(readFileSync(file, 'utf8'), rel(file));
    }
    check(readFileSync(join(ROOT, '.env.example'), 'utf8'), '.env.example');

    expect(offenders).toEqual([]);
  });

  it('reads no environment variable inside core', () => {
    // Core is pure. It takes its configuration as arguments, which is also
    // what makes gate evaluation replayable by the Board (SH-18).
    const offenders: string[] = [];
    for (const file of filesUnder('core')) {
      if (/process\s*\.\s*env/.test(readFileSync(file, 'utf8'))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Credentials are resolved where the adapter is constructed — never in a
   * React component, which may be a client component now or become one later
   * by someone adding `'use client'` to the top of the file.
   */
  it('reads no secret-shaped environment variable inside a component tree', () => {
    const offenders: string[] = [];
    for (const surface of ['apps', 'packages']) {
      for (const file of filesUnder(surface)) {
        if (extname(file) !== '.tsx') continue;
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/process\s*\.\s*env\s*[.[]\s*['"`]?([A-Z0-9_]+)/g)) {
          const name = match[1] ?? '';
          if (SECRET_SHAPED.test(name)) offenders.push(`${rel(file)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('§4 — the credential store has no plaintext column', () => {
  it('never adds a value column to config.integration_credential', () => {
    const migrations = filesUnder('supabase/migrations')
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    // The table stores metadata plus a vault reference. A column that could
    // hold the secret itself defeats the whole arrangement.
    expect(migrations).not.toMatch(/add\s+column\s+(secret_value|plaintext|api_key_value)/i);
    expect(migrations).toMatch(/vault_secret_id/);
  });
});
