/**
 * SR-032: the licence gate (SEC-D12) and the suppression check (SEC-D14) fail on
 * a seeded violation, and pass on this repository today.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// @ts-expect-error -- a plain ES module script, without type declarations
import { allowedExpression, evaluate as licences } from '../../scripts/licence-gate.mjs';
// @ts-expect-error -- a plain ES module script, without type declarations
import { collectSuppressions, evaluate as suppressions } from '../../scripts/suppressions-check.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const json = (p: string) => JSON.parse(readFileSync(`${ROOT}${p}`, 'utf8')) as Record<string, unknown>;
const POLICY = {
  allowed: ['MIT', 'Apache-2.0', 'BSD-3-Clause'],
  firstParty: ['sanad', '@sanad/'],
  declaredInLicenceFile: { 'no-field': { licence: 'MIT', evidence: 'LICENSE' } },
  exceptions: [
    { package: 'lgpl-lib', licence: 'LGPL-3.0-or-later', owner: 'Platform', reason: 'dynamic', expires: '2026-12-31' },
    { package: 'old-lib', licence: 'MPL-2.0', owner: 'Platform', reason: 'legacy', expires: '2026-01-01' },
  ],
};
const pkg = (name: string, licence?: string) => ({ name, version: '1.0.0', licence });

describe('the licence gate (SEC-D12)', () => {
  it('refuses copyleft, an undeclared licence, and an expired exception', () => {
    const v = licences(
      [pkg('gpl-lib', 'GPL-3.0-only'), pkg('silent-lib'), pkg('old-lib', 'MPL-2.0')],
      POLICY,
      '2026-10-10',
    ) as string[];
    expect(v).toHaveLength(3);
    expect(v.join('\n')).toMatch(
      /gpl-lib.*not allowed[\s\S]*silent-lib.*undeclared[\s\S]*old-lib.*expired on 2026-01-01/,
    );
  });

  it('passes allowed, first-party, file-declared and excepted packages', () => {
    expect(
      licences(
        [
          pkg('a', 'MIT'),
          pkg('@sanad/core'),
          pkg('no-field'),
          pkg('lgpl-lib', 'LGPL-3.0-or-later'),
          pkg('dual', 'MIT OR GPL-2.0-only'),
          pkg('both', '(Apache-2.0 AND MIT)'),
        ],
        POLICY,
        '2026-10-10',
      ),
    ).toEqual([]);
  });

  it('reads SPDX expressions: OR needs one allowed licence, AND needs all', () => {
    expect(allowedExpression('GPL-2.0-only OR MIT', ['MIT'])).toBe(true);
    expect(allowedExpression('Apache-2.0 AND MIT', ['MIT'])).toBe(false);
    expect(allowedExpression('Apache-2.0 AND MIT', ['MIT', 'Apache-2.0'])).toBe(true);
  });

  it('passes this repository’s policy, whose exceptions are all owned and dated', () => {
    const policy = json('.security/licence-policy.json') as { exceptions: { owner: string; expires: string }[] };
    for (const e of policy.exceptions) {
      expect(e.owner).toBeTruthy();
      expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('no suppression without an owner (SEC-D14)', () => {
  const registry = (expires: string) => ({
    suppressions: [{ tool: 'gitleaks', id: 'abc:file:rule:1', owner: 'Platform', reason: 'known', expires }],
  });
  const none = { exceptions: [] };

  it('refuses a suppression that is not registered', () => {
    const v = suppressions(
      [
        { tool: 'gitleaks', id: 'abc:file:rule:1' },
        { tool: 'semgrep', id: 'core/x.ts:12' },
      ],
      registry('2026-12-31'),
      none,
      '2026-10-10',
    ) as string[];
    expect(v).toEqual(['semgrep core/x.ts:12: suppressed without an entry in .security/suppressions.json']);
  });

  it('refuses an expired suppression, and a stale one', () => {
    expect(
      suppressions([{ tool: 'gitleaks', id: 'abc:file:rule:1' }], registry('2026-10-09'), none, '2026-10-10'),
    ).toEqual(['gitleaks abc:file:rule:1: expired on 2026-10-09 (Platform)']);
    expect(suppressions([], registry('2026-12-31'), none, '2026-10-10')).toEqual([
      'gitleaks abc:file:rule:1: registered but suppresses nothing; remove the entry',
    ]);
  });

  it('refuses an expired licence exception', () => {
    const v = suppressions(
      [],
      { suppressions: [] },
      { exceptions: [{ package: 'x', owner: 'P', expires: '2026-01-01' }] },
      '2026-10-10',
    );
    expect(v).toEqual(['licence x: the exception expired on 2026-01-01 (P)']);
  });

  it('finds this repository’s suppressions and registers every one', () => {
    const found = collectSuppressions(ROOT) as { tool: string; id: string }[];
    const registered = (json('.security/suppressions.json') as { suppressions: { tool: string; id: string }[] })
      .suppressions;
    expect(found.length).toBeGreaterThan(0);
    for (const s of found)
      expect(
        registered.some((r) => r.tool === s.tool && r.id === s.id),
        `${s.tool} ${s.id}`,
      ).toBe(true);
  });
});
