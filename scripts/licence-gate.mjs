#!/usr/bin/env node
/**
 * The licence gate (SEC-D12, SR-032): every installed production dependency carries
 * an allowed licence, is first-party, or is covered by an unexpired exception that
 * names its owner (.security/licence-policy.json). Anything else fails the build.
 *
 * `evaluate()` is the rule, exported for its test; the CLI reads `npm ls`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every installed production package once: name, version, the licence its package.json declares. */
export function installedProductionPackages(cwd) {
  let json;
  try {
    json = execFileSync('npm', ['ls', '--omit=dev', '--all', '--long', '--json'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    // npm ls exits non-zero on tree problems (an extraneous or invalid package) but still prints the tree.
    json = error.stdout;
  }
  const tree = JSON.parse(json);
  const out = new Map();
  (function walk(deps) {
    for (const [name, d] of Object.entries(deps ?? {})) {
      // An optional dependency for another platform is listed without a version: not installed, not shipped.
      // An extraneous one is a leftover the lockfile does not install (CI's `npm ci` never has one).
      if (d.version === undefined || d.extraneous === true || out.has(`${name}@${d.version}`)) continue;
      const licence = typeof d.license === 'string' ? d.license : d.license?.type;
      out.set(`${name}@${d.version}`, { name, version: d.version, licence });
      walk(d.dependencies);
    }
  })(tree.dependencies);
  return [...out.values()];
}

/**
 * Whether an SPDX expression is satisfied by the allowed list: `A OR B` when either is allowed (the
 * recipient may choose), `A AND B` only when both are (all apply). Parentheses are not nested in practice;
 * an expression this does not understand is not allowed.
 */
export function allowedExpression(expression, allowed) {
  let e = expression.trim();
  if (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1).trim();
  if (e.includes(' OR ')) return e.split(' OR ').some((part) => allowedExpression(part, allowed));
  if (e.includes(' AND ')) return e.split(' AND ').every((part) => allowedExpression(part, allowed));
  return allowed.includes(e);
}

/** The violations: packages with no allowed licence, and exceptions that are expired or incomplete. */
export function evaluate(packages, policy, today) {
  const violations = [];
  for (const p of packages) {
    if (policy.firstParty.some((f) => (f.endsWith('/') ? p.name.startsWith(f) : p.name === f))) continue;
    const licence = p.licence ?? policy.declaredInLicenceFile[p.name]?.licence;
    if (licence !== undefined && allowedExpression(licence, policy.allowed)) continue;
    const exception = policy.exceptions.find(
      (e) => (e.package.endsWith('-') ? p.name.startsWith(e.package) : p.name === e.package) && e.licence === licence,
    );
    if (exception === undefined) {
      violations.push(`${p.name}@${p.version}: licence ${licence ?? 'undeclared'} is not allowed`);
      continue;
    }
    if (exception.expires < today)
      violations.push(
        `${p.name}@${p.version}: the exception for ${licence} expired on ${exception.expires} (${exception.owner})`,
      );
  }
  for (const e of policy.exceptions)
    if (!e.owner || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? ''))
      violations.push(`exception ${e.package}: needs an owner, a reason and an expiry date`);
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const policy = JSON.parse(readFileSync(new URL('../.security/licence-policy.json', import.meta.url), 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  const packages = installedProductionPackages(root);
  const violations = evaluate(packages, policy, today);
  if (violations.length > 0) {
    process.stderr.write(`Licence gate failed:\n${violations.map((v) => `  ${v}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`Licence gate passed: ${String(packages.length)} production packages\n`);
}
