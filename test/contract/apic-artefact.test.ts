/**
 * The published artefact still says what the contract says.
 *
 * `api/openapi/origination.v1.yaml` is OpenAPI 3.1 and is the source of
 * truth. API Connect v10.0.11 cannot parse 3.1, so
 * `gateway/ibm/origination-api_1.0.0.yaml` is generated from it in 3.0.
 *
 * Two documents describing one API is a drift problem waiting to happen, and
 * the failure is quiet: the gateway advertises one contract while the service
 * enforces another, and a partner integrates against the wrong one. So the
 * agreement is asserted rather than assumed.
 *
 * What is NOT asserted is equality. The conversion is deliberately lossy in
 * five specific places, each recorded in `x-sanad-not-expressible`. This
 * checks that the loss is exactly that list and nothing more.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (p: string): Record<string, any> =>
  parse(readFileSync(`${ROOT}${p}`, 'utf8')) as Record<string, any>;

const contract = read('api/openapi/origination.v1.yaml');
const artefact = read('gateway/ibm/origination-api_1.0.0.yaml');

function* schemas(node: unknown, path = '$'): Generator<{ path: string; node: Record<string, any> }> {
  if (Array.isArray(node)) {
    for (const [i, v] of node.entries()) yield* schemas(v, `${path}[${String(i)}]`);
  } else if (node !== null && typeof node === 'object') {
    yield { path, node: node as Record<string, any> };
    for (const [k, v] of Object.entries(node)) yield* schemas(v, `${path}.${k}`);
  }
}

describe('the generated artefact is publishable', () => {
  it('is OpenAPI 3.0, which is what v10.0.11 parses', () => {
    expect(String(artefact['openapi'])).toMatch(/^3\.0\./);
  });

  it('carries x-ibm-configuration, without which it will not validate', () => {
    expect(artefact['x-ibm-configuration']?.gateway).toBe('datapower-api-gateway');
  });

  it('is marked generated, so nobody edits it by hand', () => {
    expect(readFileSync(`${ROOT}gateway/ibm/origination-api_1.0.0.yaml`, 'utf8')).toContain(
      'GENERATED — do not edit',
    );
  });
});

describe('it agrees with the contract on everything that matters', () => {
  it('exposes the same paths', () => {
    expect(Object.keys(artefact['paths']).sort()).toEqual(Object.keys(contract['paths']).sort());
  });

  it('exposes the same operations on each path', () => {
    for (const [path, item] of Object.entries(contract['paths'] as Record<string, any>)) {
      const methods = Object.keys(item).filter((k) =>
        ['get', 'put', 'post', 'delete', 'patch'].includes(k),
      );
      const published = Object.keys(artefact['paths'][path]).filter((k) =>
        ['get', 'put', 'post', 'delete', 'patch'].includes(k),
      );
      expect(published.sort(), path).toEqual(methods.sort());
    }
  });

  it('keeps every required field required', () => {
    for (const [name, schema] of Object.entries(contract['components'].schemas as Record<string, any>)) {
      if (schema.required === undefined) continue;
      expect(artefact['components'].schemas[name]?.required, name).toEqual(schema.required);
    }
  });

  /**
   * The control that has to survive the conversion. A closed schema is how a
   * proportion-shaped field cannot be posted (SH-01); an artefact that
   * published an open schema would advertise a contract the service refuses.
   */
  it('keeps every schema closed', () => {
    const open: string[] = [];
    for (const { path, node } of schemas(artefact)) {
      if (/\.(if|then|else|not)$/.test(path)) continue;
      // `x-ibm-configuration` has its own `properties` map — gateway
      // properties, not a JSON Schema. Walking into it mistakes configuration
      // for a schema and reports a vendor extension as an open object.
      if (path.startsWith('$.x-ibm-configuration')) continue;
      const isObjectSchema =
        node['type'] === 'object' || (node['properties'] !== undefined && node['$ref'] === undefined);
      if (isObjectSchema && node['additionalProperties'] === undefined) open.push(path);
    }
    expect(open).toEqual([]);
  });

  it('declares no proportion-shaped property', () => {
    const banned = ['rate', 'margin', ['a', 'p', 'r'].join(''), 'percent', 'yield'];
    const offenders: string[] = [];
    for (const { path, node } of schemas(artefact)) {
      const properties = node['properties'];
      if (properties === null || typeof properties !== 'object') continue;
      for (const key of Object.keys(properties as object)) {
        if (banned.some((b) => key.toLowerCase().includes(b))) offenders.push(`${path}.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still requires Idempotency-Key on every state-changing operation', () => {
    for (const [path, item] of Object.entries(artefact['paths'] as Record<string, any>)) {
      for (const [method, op] of Object.entries(item as Record<string, any>)) {
        if (!['post', 'put', 'patch', 'delete'].includes(method)) continue;
        const names = (op.parameters ?? []).map((p: any) =>
          p.$ref === undefined ? p.name : String(p.$ref).split('/').pop(),
        );
        expect(names, `${method} ${path}`).toContain('IdempotencyKey');
      }
    }
  });
});

describe('the lossy conversion is declared, not hidden', () => {
  const declared = artefact['x-sanad-not-expressible'];

  it('lists what 3.0 cannot express', () => {
    expect(declared?.constraints).toBeInstanceOf(Array);
    expect(declared.constraints.length).toBeGreaterThan(0);
  });

  it('names exactly the five known losses', () => {
    // If a sixth appears, the generator changed or the contract grew a
    // construct nobody considered. Either way it needs a human, not a
    // silently longer list.
    expect(declared.constraints).toHaveLength(5);
    const joined = declared.constraints.join('\n');
    expect(joined).toContain('TradeReference');
    expect(joined).toContain('webhooks');
    expect(joined).toContain('mutualTLS');
  });

  it('points back at the source', () => {
    expect(declared.source).toBe('api/openapi/origination.v1.yaml');
  });
});

describe('the assembly does not weaken the API', () => {
  const steps: Record<string, any>[] = artefact['x-ibm-configuration'].assembly.execute ?? [];

  it('transforms nothing in either direction', () => {
    // A gateway that normalises JSON disables SH-01; one that rewrites an
    // error strips the control code; one that transforms a body can change an
    // amount (E-16).
    const kinds = steps.flatMap((s) => Object.keys(s));
    for (const forbidden of ['map', 'gatewayscript', 'xslt', 'json-to-xml', 'xml-to-json', 'set-variable']) {
      expect(kinds, forbidden).not.toContain(forbidden);
    }
  });

  it('names no environment host', () => {
    const invoke = steps.find((s) => s['invoke'] !== undefined)?.['invoke'];
    expect(String(invoke['target-url'])).toMatch(/^\$\(/);
  });
});
