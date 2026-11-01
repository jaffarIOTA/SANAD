#!/usr/bin/env node
/**
 * SR-021: fails when `main` loses its protection.
 *
 * Reads the branch as any reader can (the workflow's token is read-only):
 * whether it is protected, whether that binds administrators too, and which
 * status checks a merge must pass. The review count and the signed-commit rule
 * are visible only to an administrator; they are set with the rest and
 * recorded in docs/SECURITY-REGISTER.md.
 *
 * Exit 0 when protected as required, 1 when not, 2 when it could not be read.
 */

import { pathToFileURL } from 'node:url';

/**
 * The gates in .github/workflows/security.yml a merge to main must pass
 * (test/architecture/branch-protection.test.ts keeps the two in step).
 */
export const REQUIRED_CHECKS = [
  'Compliance suite (authorisation-bypass tests)',
  'Database controls (RLS at runtime)',
  'Dependency review',
  'Image scan and DAST (admin)',
  'Image scan and DAST (consumer)',
  'Image scan and DAST (ops)',
  'SAST — CodeQL',
  'SAST — Semgrep + Sanad invariant rules',
  'SBOM',
  'SCA — dependencies',
  'Secrets — full history',
  'Trivy — IaC and filesystem',
];

/** What is wrong with the branch as the API reports it; empty when nothing is. */
export function protectionFailures(branch) {
  const failures = [];
  if (branch.protected !== true || branch.protection?.enabled !== true) failures.push('main is not protected');
  const checks = branch.protection?.required_status_checks;
  if (checks?.enforcement_level !== 'everyone') failures.push('protection does not bind administrators');
  const required = new Set(checks?.contexts ?? []);
  for (const check of REQUIRED_CHECKS) if (!required.has(check)) failures.push(`not required: ${check}`);
  return failures;
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    console.error('branch-protection-check needs GITHUB_REPOSITORY (owner/name)');
    process.exit(2);
  }
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let branch;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/branches/main`, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    branch = await response.json();
  } catch (error) {
    console.error(`could not read main: ${error instanceof Error ? error.message : 'unknown'}`);
    process.exit(2);
  }
  const failures = protectionFailures(branch);
  if (failures.length > 0) {
    for (const f of failures) console.error(`SR-021: ${f}`);
    process.exit(1);
  }
  console.log(`main is protected for everyone; ${REQUIRED_CHECKS.length} required checks present`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
