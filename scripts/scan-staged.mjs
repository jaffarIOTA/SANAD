#!/usr/bin/env node
/**
 * Scan what is about to be committed.
 *
 * Distinct from the architecture test, which scans the working tree. A hook
 * has to read the *staged* content, because that is what will end up in the
 * history — the file on disk may already have been cleaned up, and the index
 * may hold something the working tree does not.
 *
 * Exits non-zero with a list. Nothing it prints contains the offending value.
 */

import { execFileSync } from 'node:child_process';

import { findSecrets } from './secret-patterns.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Added, copied or modified paths in the index. Deletions cannot leak. */
const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'])
  .split('\u0000')
  .filter(Boolean);

if (staged.length === 0) process.exit(0);

const findings = [];

for (const path of staged) {
  let content = '';
  try {
    // From the index, not the working tree.
    content = git(['show', `:${path}`]);
  } catch {
    continue; // Binary or unreadable; the path rules above still applied.
  }
  findings.push(...findSecrets(path, content));
}

if (findings.length > 0) {
  process.stderr.write('\nCommit refused — possible secret in staged content:\n\n');
  for (const finding of findings) process.stderr.write(`  ${finding}\n`);
  process.stderr.write(
    '\nMove the value to .env.local (gitignored) and keep names only in .env.example.\n' +
      'If this is a false positive, fix the pattern in scripts/secret-patterns.mjs\n' +
      'rather than bypassing the hook — a scanner that is routinely bypassed is\n' +
      'worse than none, because it is still believed in.\n\n',
  );
  process.exit(1);
}
