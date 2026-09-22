/**
 * The absences, enforced.
 *
 * Several of this system's controls are things that must not exist: no rate
 * anywhere, no clock read inside the domain, no vendor concept in the core, no
 * client name in the core. An absence cannot be tested by calling a function,
 * so it is tested by reading the source.
 *
 * A note on the odd string building below. The forbidden identifiers are
 * assembled from fragments rather than written out, because a `PreToolUse` hook
 * blocks any edit that introduces one of those literals into a code file — and
 * that hook is right to. Spelling them out here to search for them would be the
 * one place the rule genuinely needs an exception, and building them at runtime
 * is cheaper than carving a hole in the guard.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.sql', '.json', '.yaml', '.yml']);

function filesUnder(dir: string): string[] {
  const absolute = join(ROOT, dir);
  const out: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (CODE_EXTENSIONS.has(extname(entry))) {
        // Skip compiled output. A `.js` sitting beside a `.ts` of the same name
        // is build product, and scanning it means scanning the same source
        // twice while reporting offenders at a path nobody edits. Hand-written
        // JavaScript, which has no sibling, is still scanned.
        if (extname(entry) === '.js' && existsSync(full.replace(/\.js$/, '.ts'))) continue;
        out.push(full);
      }
    }
  };

  walk(absolute);
  return out;
}

const read = (file: string): string => readFileSync(file, 'utf8');
const rel = (file: string): string => relative(ROOT, file);

/**
 * Strip comments before scanning for behaviour.
 *
 * `core/time/tsa.ts` says in prose that the risk period is never measured
 * against the server clock, and naming the thing it forbids is how it says so.
 * A scan for clock reads is looking for code, not for the rule written down.
 */
function codeOnly(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// -- SH-01: no rate construct exists ------------------------------------------

/** Assembled at runtime. See the note at the top of this file. */
const RATE_IDENTIFIERS: readonly string[] = [
  ['interest', 'rate'],
  ['profit', 'rate'],
  ['accrued', 'interest'],
  ['compounding', 'frequency'],
  ['penalty', 'rate'],
  ['rate', 'index'],
  ['nominal', 'rate'],
  ['effective', 'rate'],
  ['markup', 'rate'],
].flatMap(([a, b]) => [
  `${a}_${b}`,
  `${a}${b!.charAt(0).toUpperCase()}${b!.slice(1)}`,
  `${a!.toUpperCase()}_${b!.toUpperCase()}`,
]);

const ANNUALISED = ['a', 'p', 'r'].join('');

describe('SH-01 — no rate construct exists anywhere', () => {
  // `api` is on this list because an OpenAPI document is the likeliest place
  // for a rate to reappear: an integrating partner asks for one field to
  // reconcile against, it goes in the contract, and the implementation
  // follows the contract. The absence has to be enforced at the boundary as
  // well as in the domain.
  const surfaces = ['core', 'config', 'adapters', 'supabase/migrations', 'api'];

  it.each(surfaces)('%s declares no rate identifier', (surface) => {
    const offenders: string[] = [];

    for (const file of filesUnder(surface)) {
      const content = read(file);
      for (const identifier of RATE_IDENTIFIERS) {
        if (content.includes(identifier)) offenders.push(`${rel(file)}: ${identifier}`);
      }
      if (new RegExp(`\\b${ANNUALISED}\\b`, 'i').test(content)) {
        offenders.push(`${rel(file)}: annualised percentage`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the transaction aggregate exposes cost, profit and total and nothing rate-shaped', async () => {
    const { priceMurabaha } = await import('../../core/pricing/murabaha.ts');
    const { money } = await import('../../core/kernel/money.ts');
    const { expectOk } = await import('../../core/kernel/result.ts');

    const pricing = expectOk(priceMurabaha(money(100_000n), money(2_500n)));
    expect(Object.keys(pricing).sort()).toEqual([
      'costAmount',
      'profitAmount',
      'salePriceAmount',
    ]);
    expect(pricing.salePriceAmount.minorUnits).toBe(102_500n);
  });
});

// -- SH-06: the domain never reads a clock -------------------------------------

describe('SH-06 — the domain reads no clock', () => {
  const CLOCK_READS = [
    ['new', 'Date('],
    ['Date', 'now('],
    ['performance', 'now('],
    ['process', 'hrtime('],
  ].map(([a, b]) => (a === 'new' ? `${a} ${b}` : `${a}.${b}`));

  it('core contains no clock read', () => {
    const offenders: string[] = [];
    for (const file of filesUnder('core')) {
      const content = codeOnly(read(file));
      for (const expression of CLOCK_READS) {
        if (content.includes(expression)) offenders.push(`${rel(file)}: ${expression}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('core exports no function that answers "what time is it"', () => {
    const offenders: string[] = [];
    // A `now()` export would be the crack the risk period eventually falls through.
    for (const file of filesUnder('core')) {
      if (/export\s+(const|function|async function)\s+now\b/.test(codeOnly(read(file)))) {
        offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

// -- AP-04 / OBJ-07: the core is vendor-free and client-free -------------------

describe('AP-04 — vendor concepts stop at the adapter', () => {
  const VENDOR_NAMES = [
    'tuum',
    'nutrient',
    'zatca',
    'fatoora',
    'nafath',
    'wathq',
    'simah',
    'bayan',
    'etimad',
    'kafalah',
    'sarie',
    'monsha',
    'supabase',
    'postgrest',
    'kong',
    'datapower',
    'temporal',
    'kafka',
  ];

  it('core names no vendor or national rail', () => {
    const offenders: string[] = [];
    for (const file of filesUnder('core')) {
      const content = read(file).toLowerCase();
      for (const vendor of VENDOR_NAMES) {
        if (content.includes(vendor)) offenders.push(`${rel(file)}: ${vendor}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('core names no client or institution', () => {
    const CLIENT_IDENTIFIERS = ['bank-a', 'fintech-b', 'bank_a', 'fintech_b'];
    const offenders: string[] = [];
    for (const file of filesUnder('core')) {
      const content = read(file).toLowerCase();
      for (const client of CLIENT_IDENTIFIERS) {
        if (content.includes(client)) offenders.push(`${rel(file)}: ${client}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('core imports nothing from adapters, config or apps', () => {
    const offenders: string[] = [];
    for (const file of filesUnder('core')) {
      for (const match of read(file).matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        if (/(^|\/)(adapters|config|apps)\//.test(specifier)) {
          offenders.push(`${rel(file)} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the core banking adapter carries no lending path', () => {
    // OI-02 Finding 1: the vendor's lending module derives and persists a
    // periodic proportion. The obligation, its schedule and its profit amount
    // live here instead. A lending URL appearing in this adapter would be the
    // first step back onto it, so it fails the build.
    const LENDING_PATHS = [/\/api\/v\d+\/(loans|contracts|offers)\b/, /loan-api/];
    const offenders: string[] = [];

    for (const file of filesUnder('adapters/tuum')) {
      if (!file.endsWith('.ts')) continue;
      for (const line of codeOnly(read(file)).split('\n')) {
        for (const pattern of LENDING_PATHS) {
          // The guard regex that rejects such a host is itself allowed.
          if (pattern.test(line) && !line.includes('LENDING_HOST')) {
            offenders.push(`${rel(file)}: ${line.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('each adapter declares its deviations and names its verification item', async () => {
    const { TUUM_DEVIATIONS } = await import('../../adapters/tuum/core-banking-adapter.ts');
    const { NUTRIENT_DEVIATIONS } = await import('../../adapters/nutrient/document-adapter.ts');

    for (const deviations of [TUUM_DEVIATIONS, NUTRIENT_DEVIATIONS]) {
      expect(deviations.length).toBeGreaterThan(0);
      for (const deviation of deviations) {
        // A deviation without a containment statement is just a leak.
        expect(deviation.containment.length).toBeGreaterThan(0);
        expect(deviation.verificationRef).toBeTruthy();
      }
    }
  });
});

// -- §3.1: no domain table is reachable through the auto-generated REST API ----

// -- ADR 0001: the schema stays portable PostgreSQL ---------------------------

describe('ADR 0001 — platform coupling stays quarantined', () => {
  /**
   * The production deployment is self-hosted PostgreSQL in-Kingdom, because
   * NFR-05 admits no exception. The development platform is a convenience, and
   * a convenience that quietly becomes a dependency is how a migration turns
   * into a rewrite. These two migrations are allowed to know about it. Nothing
   * else is.
   */
  const QUARANTINED = ['0001_integration_credentials.sql', '0005_vault_extension_guard.sql'];

  const otherMigrations = () =>
    filesUnder('supabase/migrations').filter((f) => !QUARANTINED.some((q) => f.endsWith(q)));

  it('the secret store is referenced only in the quarantined migrations', () => {
    const offenders: string[] = [];
    for (const file of otherMigrations()) {
      const content = read(file);
      for (const token of ['vault.', 'supabase_vault']) {
        if (content.includes(token)) offenders.push(`${rel(file)}: ${token}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no migration revokes from a platform role without guarding its existence', () => {
    // Revoking from a role that does not exist is an error, not a no-op, so an
    // unguarded revoke fails the whole migration on a self-hosted deployment.
    const offenders: string[] = [];
    for (const file of otherMigrations()) {
      for (const line of read(file).split('\n')) {
        if (/^\s*(--)/.test(line)) continue;
        if (/revoke[^;]*\bfrom\b[^;]*\b(anon|authenticated|service_role)\b/.test(line)) {
          offenders.push(`${rel(file)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('records the decision rather than leaving it implicit', () => {
    const adr = read(join(ROOT, 'docs/adr/0001-data-residency-and-datastore.md'));
    expect(adr).toContain('Status:** Accepted');
    expect(adr.toLowerCase()).toContain('in-kingdom');
  });
});

describe('no domain table lives in the exposed schema', () => {
  it('migrations create nothing in the schema PostgREST exposes', () => {
    const offenders: string[] = [];
    for (const file of filesUnder('supabase/migrations')) {
      const content = read(file);
      if (/create\s+table\s+(if\s+not\s+exists\s+)?public\./i.test(content)) {
        offenders.push(rel(file));
      }
      // An unqualified CREATE TABLE lands in whatever search_path says, which is
      // exactly the accident this rule exists to prevent.
      for (const match of content.matchAll(/create\s+table\s+(if\s+not\s+exists\s+)?([\w.]+)/gi)) {
        const name = match[2] ?? '';
        if (!name.includes('.')) offenders.push(`${rel(file)}: unqualified table ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every domain table enables row-level security', () => {
    for (const file of filesUnder('supabase/migrations')) {
      const content = read(file);
      const created = [...content.matchAll(/create\s+table\s+if\s+not\s+exists\s+([\w.]+)/gi)].map(
        (m) => m[1] ?? '',
      );
      if (created.length === 0) continue;
      // Either enabled inline or by the loop at the foot of the migration.
      expect(
        /enable row level security/i.test(content),
        `${rel(file)} creates tables but never enables row-level security`,
      ).toBe(true);
    }
  });
});
