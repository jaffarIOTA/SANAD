#!/usr/bin/env node
/**
 * No suppression without an owner (SEC-D14, SR-032).
 *
 * Collects every suppressed security finding from the tools' own files — gitleaks
 * fingerprints, Trivy and OSV ignores, `nosemgrep` comments — and checks each
 * against .security/suppressions.json: it must be registered with an owner, a
 * reason and an expiry that has not passed. A registered entry that suppresses
 * nothing is stale and fails too. Licence exceptions (.security/licence-policy.json)
 * are held to the same expiry.
 *
 * `evaluate()` is the rule, exported for its test; the CLI reads the repository.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lines = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

/** Every suppression the tools would honour, as { tool, id }. */
export function collectSuppressions(root) {
  const found = [];
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : undefined);
  for (const id of lines(read('.gitleaksignore') ?? '')) found.push({ tool: 'gitleaks', id });
  for (const id of lines(read('.trivyignore') ?? '')) found.push({ tool: 'trivy', id: id.split(/\s/)[0] });
  for (const m of (read('osv-scanner.toml') ?? '').matchAll(/^\s*id\s*=\s*"([^"]+)"/gm))
    found.push({ tool: 'osv', id: m[1] });
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of tracked) {
    if (!/\.(ts|tsx|js|mjs|cjs|yml|yaml|sql)$/.test(file) || file.startsWith('scripts/suppressions-check')) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const [i, line] of text.split('\n').entries())
      if (/\bnosemgrep\b/.test(line)) found.push({ tool: 'semgrep', id: `${file}:${String(i + 1)}` });
  }
  return found;
}

export function evaluate(found, registry, licencePolicy, today) {
  const violations = [];
  const key = (s) => `${s.tool} ${s.id}`;
  const registered = new Map(registry.suppressions.map((s) => [key(s), s]));
  for (const s of found) {
    const entry = registered.get(key(s));
    if (entry === undefined) violations.push(`${key(s)}: suppressed without an entry in .security/suppressions.json`);
  }
  const present = new Set(found.map(key));
  for (const s of registry.suppressions) {
    if (!s.owner || !s.reason || !/^\d{4}-\d{2}-\d{2}$/.test(s.expires ?? ''))
      violations.push(`${key(s)}: needs an owner, a reason and an expiry date`);
    else if (s.expires < today)
      violations.push(`${key(s)}: expired on ${s.expires} (${s.owner}${s.register ? `, ${s.register}` : ''})`);
    if (!present.has(key(s))) violations.push(`${key(s)}: registered but suppresses nothing; remove the entry`);
  }
  for (const e of licencePolicy.exceptions)
    if (e.expires < today) violations.push(`licence ${e.package}: the exception expired on ${e.expires} (${e.owner})`);
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const registry = JSON.parse(readFileSync(join(root, '.security/suppressions.json'), 'utf8'));
  const licencePolicy = JSON.parse(readFileSync(join(root, '.security/licence-policy.json'), 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const found = collectSuppressions(root);
  const violations = evaluate(found, registry, licencePolicy, today);
  if (violations.length > 0) {
    process.stderr.write(`Suppression check failed:\n${violations.map((v) => `  ${v}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`Suppression check passed: ${String(found.length)} suppressions, all owned and in date\n`);
}
