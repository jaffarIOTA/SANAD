/**
 * RTL correctness, enforced by reading the source.
 *
 * CLAUDE.md §6 requires logical properties throughout: `margin-inline-start`,
 * never `margin-left`. The reason is not tidiness. Arabic is the primary
 * language of this product, and a single `ml-4` renders correctly in the
 * language almost nobody here reads and incorrectly in the one almost everyone
 * does — while looking perfectly fine to whoever wrote it, because they were
 * looking at the English route.
 *
 * That failure mode is invisible to a rendering test that only checks the page
 * appeared. It is trivially visible to a scan. So this is a scan.
 *
 * The matching is token-exact rather than substring. An earlier pass of this
 * check reported `border-line` as a physical `border-l`, which is the kind of
 * false positive that gets a test deleted rather than fixed.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Everything that renders. */
const SURFACES = ['packages/design', 'apps/ops/src', 'apps/sme/src'];

function filesUnder(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.includes(extname(entry))) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

const rel = (file: string): string => relative(ROOT, file);

// -- Tailwind utilities -------------------------------------------------------

const PHYSICAL_UTILITY: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^-?(ml|mr|pl|pr)-/, why: 'physical margin or padding — use ms-/me-/ps-/pe-' },
  { pattern: /^-?(left|right)-/, why: 'physical inset — use start-/end-' },
  { pattern: /^text-(left|right)$/, why: 'physical text alignment — use text-start/text-end' },
  { pattern: /^border-(l|r)(-|$)/, why: 'physical border side — use border-s/border-e' },
  { pattern: /^rounded-(l|r|tl|tr|bl|br)(-|$)/, why: 'physical corner — use the logical corner' },
  { pattern: /^float-(left|right)$/, why: 'float — use float-start/float-end' },
  { pattern: /^(scroll-m|scroll-p)[lr]-/, why: 'physical scroll spacing' },
];

/** `className="…"`, `className='…'`, `className={`…`}` and `className={'…'}`. */
const CLASS_ATTRIBUTE =
  /class(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\}|\{\s*['"]([^'"]*)['"]\s*\})/gs;

/** Class tokens, with `${…}` holes removed and variant prefixes stripped. */
function classTokens(source: string): { token: string; line: number }[] {
  const out: { token: string; line: number }[] = [];
  for (const match of source.matchAll(CLASS_ATTRIBUTE)) {
    const blob = match.slice(1).find((g) => g !== undefined);
    if (blob === undefined) continue;
    const line = source.slice(0, match.index).split('\n').length;
    for (const raw of blob.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      const token = raw.trim().replace(/^!/, '');
      if (token.length > 0) out.push({ token, line });
    }
  }
  return out;
}

describe('§6 — the interface is composed in logical properties', () => {
  it.each(SURFACES)('%s uses no physical-direction utility', (surface) => {
    const offenders: string[] = [];

    for (const file of filesUnder(surface, ['.tsx'])) {
      for (const { token, line } of classTokens(readFileSync(file, 'utf8'))) {
        // A variant prefix (`sm:`, `hover:`, `dark:`) does not make a physical
        // utility acceptable, so test the bare utility.
        const bare = token.split(':').at(-1) ?? token;
        for (const { pattern, why } of PHYSICAL_UTILITY) {
          if (pattern.test(bare)) offenders.push(`${rel(file)}:${String(line)} ${token} — ${why}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the stylesheets declare no physical box property', () => {
    const PHYSICAL_CSS =
      /(?:^|[;{\s])(?:(?:margin|padding|border)-(?:left|right)|left|right|float|clear)\s*:|text-align\s*:\s*(?:left|right)/;

    const offenders: string[] = [];
    for (const surface of [...SURFACES, 'apps/ops/src', 'apps/sme/src']) {
      for (const file of filesUnder(surface, ['.css'])) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            // `direction: rtl` and logical properties are fine; only the
            // physical box model is not.
            if (PHYSICAL_CSS.test(line)) offenders.push(`${rel(file)}:${String(i + 1)} ${line.trim()}`);
          });
      }
    }

    expect(offenders).toEqual([]);
  });
});

// -- SH-01 on the rendering surface -------------------------------------------

describe('SH-01 — no rate reaches a screen', () => {
  /**
   * `<Money>` is where a Shariah requirement is either met or quietly lost:
   * disclosure of cost and markup is a validity condition of the Murabaha
   * (SH-15), and a fourth field would be the obvious place to add "and the
   * effective rate, for the customer's convenience".
   *
   * The compile-time guarantee is in `money.test.tsx`. This asserts the prop
   * surface itself, so the absence is visible in the place someone would look
   * before adding one.
   */
  it('the Money component declares exactly four props, none of them a rate', () => {
    const source = readFileSync(join(ROOT, 'packages/design/Money.tsx'), 'utf8');
    const block = /export interface MoneyProps \{([\s\S]*?)\n\}/.exec(source);
    expect(block, 'MoneyProps is declared').not.toBeNull();

    const declared = [...(block?.[1] ?? '').matchAll(/^\s*readonly\s+(\w+)\??:/gm)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual(['labels', 'locale', 'numerals', 'pricing']);
  });

  it('no rendering surface names a proportion in a prop or a label', () => {
    const banned = [['rate'], ['margin'], [['a', 'p', 'r'].join('')], ['percent'], ['yield']].flat();
    const offenders: string[] = [];

    for (const surface of SURFACES) {
      for (const file of filesUnder(surface, ['.tsx'])) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/^\s*readonly\s+(\w+)\??:/gm)) {
          const name = (match[1] ?? '').toLowerCase();
          // `marginInlineStart` is a logical property, not a lending margin.
          if (name.startsWith('margininline')) continue;
          if (banned.some((b) => name.includes(b))) {
            offenders.push(`${rel(file)}: ${match[1] ?? ''}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
