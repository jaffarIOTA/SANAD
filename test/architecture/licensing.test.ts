/**
 * Installation licensing (ADR 0006) — the absences and the one decision.
 *
 * As `core/pricing/apr.ts` is the only place an APR is computed, the
 * licensing gate `assertNewBusinessPermitted` (core/licensing/gate.ts) is the
 * only place a licence state becomes a decision. These read the source:
 *
 *   - the gate is defined once, and only it builds the LICENCE_NOT_ACTIVE outcome;
 *   - no code outside core/licensing compares against the states that block or
 *     permit, and only the services runtime computes a state;
 *   - every new-business entry point asks the gate, and the paths that must
 *     never be stopped — servicing, collections, review, the outbox, exports,
 *     sign-in, licence installation — do not.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CODE = new Set(['.ts', '.tsx']);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (CODE.has(extname(entry))) out.push(full);
    }
  };
  if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
  return out;
}

const rel = (f: string): string => relative(ROOT, f);
const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8');
/** Comments stripped: the rule is about code, and the prose around it names what it forbids. */
const codeOnly = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PRODUCT_CODE = ['core', 'products', 'services', 'apps', 'adapters', 'packages', 'config'].flatMap(filesUnder);

describe('assertNewBusinessPermitted is the only licence decision', () => {
  it('is defined once, in core/licensing/gate.ts', () => {
    const defining = PRODUCT_CODE.filter((f) =>
      /function\s+assertNewBusinessPermitted\b|assertNewBusinessPermitted\s*=/.test(codeOnly(readFileSync(f, 'utf8'))),
    ).map(rel);
    expect(defining).toEqual(['core/licensing/gate.ts']);
  });

  it('only the gate builds the LICENCE_NOT_ACTIVE outcome', () => {
    const building = PRODUCT_CODE.filter((f) =>
      /outcome:\s*'LICENCE_NOT_ACTIVE'/.test(codeOnly(readFileSync(f, 'utf8'))),
    ).map(rel);
    expect(building).toEqual(['core/licensing/gate.ts']);
  });

  it('no code outside core/licensing compares against the blocking or development states', () => {
    const offenders = PRODUCT_CODE.filter((f) => !rel(f).startsWith('core/licensing/'))
      .filter((f) => /['"](NEW_BUSINESS_BLOCKED|DEVELOPMENT_UNLICENSED)['"]/.test(codeOnly(readFileSync(f, 'utf8'))))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('inside core/licensing, only the state function, the gate and the wording name them', () => {
    const naming = filesUnder('core/licensing')
      .filter((f) => /['"](NEW_BUSINESS_BLOCKED|DEVELOPMENT_UNLICENSED)['"]/.test(codeOnly(readFileSync(f, 'utf8'))))
      .map(rel)
      .sort();
    expect(naming).toEqual(['core/licensing/explain.ts', 'core/licensing/gate.ts', 'core/licensing/state.ts']);
  });

  it('only the services runtime computes a licence state', () => {
    const computing = PRODUCT_CODE.filter((f) => !rel(f).startsWith('core/licensing/'))
      .filter((f) => /\blicenceState\s*\(/.test(codeOnly(readFileSync(f, 'utf8'))))
      .map(rel);
    expect(computing).toEqual(['services/origination/src/licensing.ts']);
  });

  it('the gate reads no clock and no environment', () => {
    const gate = codeOnly(read('core/licensing/gate.ts'));
    expect(gate).not.toMatch(/Date\.now|new Date|process\.env/);
  });
});

/** Where new business starts, and what each must call. */
const ENTRY_POINTS: readonly (readonly [string, RegExp])[] = [
  ['services/origination/src/server.ts', /newBusinessRefusal/],
  ['apps/ops/src/server/actions.ts', /newBusinessPermitted/],
  ['apps/ops/src/app/api/origination/v1/requests/route.ts', /newBusinessRefusal/],
  ['apps/ops/src/app/api/origination/v1/business-applications/route.ts', /newBusinessRefusal/],
  ['apps/ops/src/server/business.ts', /newBusinessRefusal/],
  ['apps/ops/src/app/[locale]/products/page.tsx', /newBusinessPermitted/],
  ['apps/consumer/src/server/actions.ts', /newBusinessRefusal/],
  ['apps/consumer/src/app/api/checkout/v1/sessions/route.ts', /newBusinessRefusal/],
  ['apps/consumer/src/app/[locale]/checkout/[sessionId]/page.tsx', /newBusinessRefusal/],
  ['apps/consumer/src/app/[locale]/checkout/[sessionId]/actions.ts', /newBusinessRefusal/],
];

/** What must never be stopped by a licence: none of these may consult it. */
const NEVER_GATED: readonly string[] = [
  'apps/ops/src/app/api/review/v1',
  'apps/ops/src/app/api/origination/v1/requests/[requestId]',
  'apps/ops/src/app/api/origination/v1/business-applications/[applicationId]',
  'apps/ops/src/app/api/documents',
  'apps/ops/src/app/[locale]/business/export',
  'apps/consumer/src/app/api/internal/outbox',
  'apps/consumer/src/app/api/checkout/v1/sessions/[sessionId]',
  'apps/ops/src/server/auth-actions.ts',
  'apps/ops/src/server/staff-session.ts',
  'apps/ops/src/server/business-actions.ts',
  'services/outbox',
  'core/outbox',
  'core/reconciliation',
  'products',
];

describe('the gate stands at every new-business entry point, and nowhere it must not', () => {
  it.each(ENTRY_POINTS)('%s asks the licence', (file, call) => {
    expect(codeOnly(read(file))).toMatch(call);
  });

  it.each(NEVER_GATED)('%s never consults the licence', (path) => {
    const files = path.endsWith('.ts') ? [join(ROOT, path)] : filesUnder(path);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((f) =>
        /licensing\.ts|newBusiness(Permitted|Refusal)|assertNewBusinessPermitted/.test(
          codeOnly(readFileSync(f, 'utf8')),
        ),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the workbench service gates exactly three acts — hand-over, offer, disbursement — and no servicing act', () => {
    const service = codeOnly(read('apps/ops/src/server/business.ts'));
    const calls = [...service.matchAll(/await licencePermits\(/g)].length;
    expect(calls).toBe(3);
    // The servicing and withdrawal functions do not reach it.
    for (const fn of ['recordPortfolioStatus', 'withdrawApplication', 'recordSigned', 'sendOffer']) {
      const body = new RegExp(`export async function ${fn}\\([\\s\\S]*?\\n}`).exec(service)?.[0] ?? '';
      expect(body.length, fn).toBeGreaterThan(0);
      expect(body, fn).not.toMatch(/licencePermits|licenceFacts/);
    }
  });

  it('installing a licence is never itself gated', () => {
    const admin = codeOnly(read('apps/admin/src/server/actions.ts'));
    expect(admin).not.toMatch(/newBusiness(Permitted|Refusal)/);
  });
});
