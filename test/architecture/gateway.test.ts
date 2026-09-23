/**
 * The gateway holds no control, and no service depends on one.
 *
 * IBM API Connect is the integration layer and DataPower is the gateway
 * (ClaudeRecommendations.md E-20). Kong has been removed — it was the
 * development gateway while the client's choice was unknown, and a
 * configuration nothing applies is worse than none.
 *
 * What survived Kong's removal is the *independence*, and it is asserted here
 * rather than trusted. Sanad is a product: it deploys to each buying
 * institution's own cluster, and the second institution may not run API
 * Connect (E-23). A service that reads a gateway-injected header is a service
 * that cannot move.
 *
 * The sharpest rule is the authentication one. A gateway auth policy looks
 * like defence in depth and is actually a second, weaker identity source;
 * once a service stops authenticating because "the gateway does it", the
 * gateway is no longer swappable and the service is no longer safe behind a
 * different one.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** Every API definition we publish. */
const DEFINITIONS = [
  'gateway/ibm/health-api_1.0.0.yaml',
  'gateway/ibm/origination-api_1.0.0.yaml',
  'gateway/ibm/tuum-egress_1.0.0.yaml',
];
const PRODUCTS = [
  'gateway/ibm/health-product_1.0.0.yaml',
  'gateway/ibm/origination-product_1.0.0.yaml',
  'gateway/ibm/tuum-egress-product_1.0.0.yaml',
];

const definitions = DEFINITIONS.map((path) => ({
  path,
  doc: parse(read(path)) as Record<string, any>,
}));

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (['.ts', '.tsx'].includes(extname(entry))) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

// -- The shape of the directory ----------------------------------------------

describe('gateway configuration is declarative and lives here', () => {
  it('has an API Connect directory', () => {
    expect(existsSync(join(ROOT, 'gateway/ibm'))).toBe(true);
  });

  it('no longer carries a Kong configuration', () => {
    // Removed deliberately. A gateway config that nothing applies rots, and
    // implies a tested capability that is not tested.
    expect(existsSync(join(ROOT, 'gateway/kong'))).toBe(false);
  });

  it.each(DEFINITIONS)('%s is OpenAPI 3.0, which v10.0.11 parses', (path) => {
    const doc = definitions.find((d) => d.path === path)?.doc;
    expect(String(doc?.['openapi'])).toMatch(/^3\.0\./);
  });

  it.each(DEFINITIONS)('%s carries x-ibm-configuration', (path) => {
    const doc = definitions.find((d) => d.path === path)?.doc;
    expect(doc?.['x-ibm-configuration']?.gateway).toBe('datapower-api-gateway');
  });

  it.each([...DEFINITIONS, ...PRODUCTS])('%s names no environment host', (path) => {
    // One definition serves every catalog; the upstream is a property. A
    // hostname here leaks an environment's topology into git and means four
    // near-identical files.
    const raw = read(path);
    expect(raw).not.toMatch(/apiconnect\.ibmappdomain\.cloud/);
    expect(raw).not.toMatch(/https?:\/\/[a-z0-9.-]*\.(com|net|io)\b/i);
  });
});

// -- The gateway is not the security boundary --------------------------------

describe('the gateway holds no control', () => {
  it.each(DEFINITIONS)('%s transforms nothing in either direction', (path) => {
    /*
     * DataPower is a transformation engine — GatewayScript, XSLT and JSON/XML
     * mediation are its core competency, which is exactly why this has to be
     * ruled out explicitly rather than assumed absent (E-16).
     *
     * A gateway that normalises JSON silently disables SH-01: our schemas are
     * closed, so a stripped unknown property never reaches the service that
     * exists to reject it. A gateway that rewrites an error strips the control
     * code a compliance rejection carries. A gateway that transforms a body
     * can change an amount.
     */
    const doc = definitions.find((d) => d.path === path)?.doc;
    const steps: Record<string, unknown>[] = doc?.['x-ibm-configuration'].assembly.execute ?? [];
    const kinds = steps.flatMap((s) => Object.keys(s));

    for (const forbidden of [
      'map',
      'gatewayscript',
      'xslt',
      'json-to-xml',
      'xml-to-json',
      'validate',
    ]) {
      expect(kinds, `${path}: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it.each(DEFINITIONS)('%s enforces no authentication in the assembly', (path) => {
    /*
     * The assembly, not the whole document.
     *
     * `components.securitySchemes` legitimately *declares* that a partner
     * presents an OAuth token — that is documentation telling an integrator
     * what credential to bring, and the service is what checks it. An
     * assembly policy would be different: a second, weaker identity source
     * enforced at the gateway, which is what makes a gateway unswappable and
     * what would otherwise force an enterprise licence.
     *
     * So this asserts on the steps, and a raw text search would not
     * distinguish the two.
     */
    const doc = definitions.find((d) => d.path === path)?.doc;
    const steps: Record<string, unknown>[] = doc?.['x-ibm-configuration'].assembly.execute ?? [];
    const kinds = steps.flatMap((s) => Object.keys(s).map((k) => k.toLowerCase()));

    for (const policy of [
      'oauth',
      'jwt-validate',
      'jwt-generate',
      'validate-usernametoken',
      'ldap-authenticate',
      'extract-identity',
      'authenticate',
      'user-security',
    ]) {
      expect(kinds, `${path}: ${policy}`).not.toContain(policy);
    }
  });

  it.each(DEFINITIONS)('%s allows no browser origin', (path) => {
    const doc = definitions.find((d) => d.path === path)?.doc;
    expect(doc?.['x-ibm-configuration'].cors?.enabled).toBe(false);
  });

  it.each(PRODUCTS)('%s uses no hard rate limit', (path) => {
    /*
     * A hard limit that sheds a state-changing request produces a retry, and a
     * retry the caller did not choose to make is how an instruction gets sent
     * twice. The service's idempotency store is the protection; a gateway
     * limit is a shock absorber.
     */
    const product = parse(read(path)) as Record<string, any>;
    for (const [name, plan] of Object.entries(product['plans'] as Record<string, any>)) {
      expect(plan['rate-limits']?.default?.['hard-limit'], `${path}: ${name}`).toBe(false);
    }
  });
});

// -- Egress ------------------------------------------------------------------

describe('the egress to the core banking platform', () => {
  const egress = parse(read('gateway/ibm/tuum-egress_1.0.0.yaml')) as Record<string, any>;
  const product = parse(read('gateway/ibm/tuum-egress-product_1.0.0.yaml')) as Record<string, any>;

  it('is an allowlist, not a denylist', () => {
    // A new endpoint at the vendor is unreachable until somebody decides it
    // should be — the correct default for the one route out of an in-Kingdom
    // cluster.
    const prefixes = String(egress['x-ibm-configuration'].properties['allowed-prefixes'].value);
    expect(prefixes.length).toBeGreaterThan(0);
    expect(prefixes.split(',').length).toBeGreaterThan(1);
  });

  it('checks the allowlist before forwarding, not after', () => {
    // A gateway that forwards first and checks later is not an allowlist.
    const steps: Record<string, unknown>[] = egress['x-ibm-configuration'].assembly.execute;
    const guard = steps.findIndex((s) => 'switch' in s);
    const forward = steps.findIndex((s) => 'invoke' in s);
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(forward);
  });

  it('passes through without translating', () => {
    /*
     * The distinction that keeps §7 intact. A façade exposing our capability
     * names and mapping them onto the vendor's would put domain mapping in
     * the gateway, and would be the transformation E-16 forbids.
     *
     * Because this is a pipe, `adapters/tuum/` stays the only thing that
     * understands the vendor's shape — which is what stops a vendor DTO, and
     * the proportion-shaped fields on an accepted offer (OI-02), from
     * crossing out of the adapter layer.
     */
    const steps: Record<string, unknown>[] = egress['x-ibm-configuration'].assembly.execute;
    const kinds = steps.flatMap((s) => Object.keys(s));
    for (const forbidden of ['map', 'gatewayscript', 'xslt', 'json-to-xml', 'xml-to-json']) {
      expect(kinds, forbidden).not.toContain(forbidden);
    }
  });

  it('is not subscribable by a partner', () => {
    // An egress a partner can call is a confused deputy with a Murabaha
    // attached: an integrating system reaching the bank's ledger through our
    // credential.
    for (const kind of ['view', 'subscribe']) {
      expect(product['visibility'][kind].type, kind).toBe('custom');
      expect(product['visibility'][kind].orgs, kind).not.toHaveLength(0);
    }
    expect(product['plans'].internal.approval).toBe(true);
  });

  it('names no vendor concept in our own path structure', () => {
    // The path is a pass-through parameter, so the vendor's route names are
    // data rather than part of our published surface.
    expect(Object.keys(egress['paths'])).toEqual(['/{tuumPath}']);
  });
});

// -- No service depends on a gateway -----------------------------------------

describe('no service depends on a gateway having run', () => {
  const surfaces = ['services', 'apps/ops/src', 'apps/sme/src', 'core', 'adapters'];

  it.each(surfaces)('%s reads no gateway-injected header', (surface) => {
    // API Connect and DataPower inject their own headers, as every gateway
    // does. Reading any of them is what makes a gateway unswappable — and
    // this platform is sold to institutions that each bring their own.
    const injected =
      /x-consumer-|x-anonymous-consumer|x-credential-|x-authenticated-(scope|userid)|x-kong-|x-ibm-client|x-datapower|x-apic-/i;

    const offenders: string[] = [];
    for (const file of sourcesUnder(surface)) {
      const source = readFileSync(file, 'utf8');
      // Strip comments: a rule is allowed to name what it forbids.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (injected.test(code)) offenders.push(relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it('names no gateway product inside core', () => {
    // §7: no vendor names in core. A gateway is a vendor like any other, and
    // that stays true now that the vendor has been chosen.
    const offenders: string[] = [];
    for (const file of sourcesUnder('core')) {
      if (/\b(kong|konnect|datapower|api ?connect|apigee)\b/i.test(readFileSync(file, 'utf8'))) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
