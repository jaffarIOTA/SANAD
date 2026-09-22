/**
 * The gateway stays swappable, and stays out of the domain.
 *
 * CLAUDE.md §5 makes two promises. Gateway concerns live in `gateway/` as
 * configuration, one directory per implementation; and no application code
 * depends on a particular gateway having run. Both erode the same way — a
 * plugin that is convenient today becomes a dependency tomorrow — so both are
 * asserted here rather than reviewed.
 *
 * The sharpest of these is the authentication one. A gateway auth plugin looks
 * like defence in depth and is actually a second, weaker identity source; once
 * a service stops authenticating because "the gateway does it", the gateway is
 * no longer swappable and the service is no longer safe behind a different
 * one.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

interface KongConfig {
  readonly _format_version: string;
  readonly services: readonly {
    readonly name: string;
    readonly retries?: number;
    readonly routes?: readonly { readonly protocols?: readonly string[] }[];
  }[];
  readonly plugins?: readonly { readonly name: string; readonly config?: Record<string, unknown> }[];
}

const kong = parse(read('gateway/kong/kong.yaml')) as KongConfig;

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

// -- §5 one directory per implementation --------------------------------------

describe('§5 — gateway concerns are configuration, not code', () => {
  it('declares a directory for each implementation', () => {
    expect(existsSync(join(ROOT, 'gateway/kong'))).toBe(true);
    expect(existsSync(join(ROOT, 'gateway/ibm'))).toBe(true);
  });

  it('parses the Kong configuration', () => {
    expect(kong._format_version).toMatch(/^3\./);
    expect(kong.services.length).toBeGreaterThan(0);
  });

  it('names no environment host in the configuration', () => {
    // One file serves every environment. A hostname here would leak an
    // environment's topology into git and mean four near-identical files.
    const raw = read('gateway/kong/kong.yaml');
    const hosts = raw.match(/https?:\/\/[a-z0-9.-]+/gi) ?? [];
    const realHosts = hosts.filter((h) => !h.includes('docs.konghq.com'));
    expect(realHosts).toEqual([]);
  });
});

// -- The gateway holds no control ---------------------------------------------

describe('the API Connect artefacts', () => {
  const api = parse(read('gateway/ibm/health-api_1.0.0.yaml')) as Record<string, any>;
  const product = parse(read('gateway/ibm/health-product_1.0.0.yaml')) as Record<string, any>;

  it('is OpenAPI 3.0, because v10.0.11 rejects 3.1', () => {
    // Established by experiment: `apic validate` answers "Invalid file type
    // provided" on a 3.1 document, identically with --no-extensions. See
    // ClaudeRecommendations.md E-25.
    expect(String(api['openapi'])).toMatch(/^3\.0\./);
  });

  it('carries x-ibm-configuration, without which it will not validate', () => {
    expect(api['x-ibm-configuration']).toBeDefined();
    expect(api['x-ibm-configuration'].gateway).toBe('datapower-api-gateway');
  });

  it('names no environment host — the upstream is a property', () => {
    // One definition per API, not one per environment.
    const raw = read('gateway/ibm/health-api_1.0.0.yaml');
    const targets: string[] = [];
    for (const step of api['x-ibm-configuration'].assembly.execute ?? []) {
      if (step.invoke !== undefined) targets.push(String(step.invoke['target-url']));
    }
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(target).toMatch(/^\$\(/);
    expect(raw).not.toMatch(/apiconnect\.ibmappdomain\.cloud/);
  });

  it('transforms nothing — it constructs a fixed response', () => {
    // DataPower is a transformation engine, and this is the flow where that
    // temptation is strongest. Nothing from the upstream body may reach the
    // caller, or upstream detail leaks through a health check (E-16).
    const steps = api['x-ibm-configuration'].assembly.execute ?? [];
    const kinds = steps.flatMap((s: object) => Object.keys(s));
    for (const forbidden of ['map', 'gatewayscript', 'xslt', 'json-to-xml', 'xml-to-json']) {
      expect(kinds).not.toContain(forbidden);
    }
  });

  it('exposes no component detail to an unauthenticated caller', () => {
    // The published API answers a fixed word. The detailed report, which
    // names our dependencies, is a different endpoint behind a scope.
    const schema = api['components'].schemas.Health;
    expect(Object.keys(schema.properties)).toEqual(['status']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('publishes through a plan that does not throttle a monitor', () => {
    const plan = product['plans'].default;
    expect(plan.approval).toBe(false);
    expect(plan['rate-limits'].default['hard-limit']).toBe(false);
  });
});

describe('§5 — the gateway is not the security boundary', () => {
  const pluginNames = (kong.plugins ?? []).map((p) => p.name);

  it('configures no authentication plugin', () => {
    // Authentication is the service's job. A plugin here would be a second
    // identity source and the requirement that forces an enterprise licence.
    const auth = [
      'key-auth',
      'jwt',
      'openid-connect',
      'oauth2',
      'basic-auth',
      'hmac-auth',
      'ldap-auth',
      'mtls-auth',
      'session',
    ];
    expect(pluginNames.filter((n) => auth.includes(n))).toEqual([]);
  });

  it('configures nothing that rewrites a request or a response', () => {
    // A gateway that rewrites a body can change an amount. A gateway that
    // rewrites a response can strip the control code a compliance rejection
    // exists to carry.
    const transformers = [
      'request-transformer',
      'request-transformer-advanced',
      'response-transformer',
      'response-transformer-advanced',
    ];
    expect(pluginNames.filter((n) => transformers.includes(n))).toEqual([]);
  });

  it('uses only plugins in the open-source distribution', () => {
    const openSource = new Set([
      'rate-limiting',
      'request-size-limiting',
      'correlation-id',
      'cors',
      'ip-restriction',
      'request-termination',
      'file-log',
      'syslog',
      'prometheus',
    ]);
    const enterprise = pluginNames.filter((n) => !openSource.has(n));
    expect(enterprise).toEqual([]);
  });

  /**
   * A gateway retry reissues a request without a fresh idempotency key, which
   * is the one path by which this platform can execute an instruction twice.
   * Retries belong to the caller, who holds the key.
   */
  it('never retries an upstream request', () => {
    for (const service of kong.services) {
      expect(service.retries, `${service.name} retries`).toBe(0);
    }
  });

  it('exposes no plaintext listener', () => {
    for (const service of kong.services) {
      for (const route of service.routes ?? []) {
        expect(route.protocols).toEqual(['https']);
      }
    }
  });

  it('allows no browser origin on a server-to-server API', () => {
    const cors = (kong.plugins ?? []).find((p) => p.name === 'cors');
    expect(cors?.config?.['origins']).toEqual([]);
  });
});

// -- No application code depends on a gateway ---------------------------------

describe('§5 — no service depends on a gateway having run', () => {
  const surfaces = ['services', 'apps/ops/src', 'apps/sme/src', 'core', 'adapters'];

  it.each(surfaces)('%s reads no gateway-injected header', (surface) => {
    // Kong injects `x-consumer-*`; API Connect and DataPower inject their own.
    // Reading any of them is what makes a gateway unswappable.
    const injected =
      /x-consumer-|x-anonymous-consumer|x-credential-|x-authenticated-(scope|userid)|x-kong-|x-ibm-client|x-datapower/i;

    const offenders: string[] = [];
    for (const file of sourcesUnder(surface)) {
      const source = readFileSync(file, 'utf8');
      // Strip comments: the rule is allowed to name what it forbids.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (injected.test(code)) offenders.push(relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it('names no gateway product inside core', () => {
    // §7: no vendor names in core. The gateway is a vendor like any other.
    const offenders: string[] = [];
    for (const file of sourcesUnder('core')) {
      if (/\b(kong|konnect|datapower|api connect|apigee)\b/i.test(readFileSync(file, 'utf8'))) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the two implementations in step', () => {
    // The IBM directory is a list of obligations rather than configuration,
    // so what is asserted is that it still enumerates what Kong does.
    const ibm = read('gateway/ibm/README.md');
    for (const plugin of (kong.plugins ?? []).map((p) => p.name)) {
      expect(ibm, `IBM README covers ${plugin}`).toContain(plugin);
    }
  });
});
