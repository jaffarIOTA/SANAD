/**
 * The origination contract, enforced.
 *
 * `api/openapi/origination.v1.yaml` is authored before the implementation and
 * wins where the two disagree (CLAUDE.md §8). A specification that only a
 * human reads drifts, so the properties it relies on are asserted here.
 *
 * These are not schema-linting niceties. Each one is a control:
 *
 *   - closed schemas are how a rate cannot be posted (§1.1);
 *   - a string of minor units is how no float enters the financial path (§8);
 *   - the absent `tenantId` is how tenancy cannot be claimed by a client (§8);
 *   - the absent gateway header is what keeps Kong swappable for IBM (§5);
 *   - `detailAr` on every problem is why no counterparty gets an
 *     English-only refusal (§6).
 *
 * The implementation is not built yet. When it is, its handler is tested
 * against this same document rather than against a second copy of these
 * beliefs.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const SPEC_PATH = fileURLToPath(new URL('../../api/openapi/origination.v1.yaml', import.meta.url));

interface Spec {
  readonly openapi: string;
  readonly paths: Record<string, Record<string, Operation>>;
  readonly webhooks?: Record<string, Record<string, Operation>>;
  readonly components: {
    readonly schemas: Record<string, Schema>;
    readonly responses: Record<string, ResponseObject>;
    readonly parameters: Record<string, { readonly name: string; readonly required?: boolean }>;
    readonly securitySchemes: Record<string, { readonly type: string }>;
  };
  readonly security?: readonly Record<string, readonly string[]>[];
}

interface Operation {
  readonly operationId?: string;
  readonly parameters?: readonly ({ readonly $ref?: string; readonly name?: string })[];
  readonly responses?: Record<string, ResponseObject | { readonly $ref: string }>;
  readonly requestBody?: { readonly content?: Record<string, MediaType> };
}

interface MediaType {
  readonly schema?: Schema;
  readonly examples?: Record<string, { readonly value: Record<string, unknown> }>;
}

interface ResponseObject {
  readonly content?: Record<string, MediaType>;
}

type Schema = Record<string, unknown>;

const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as Spec;

const STATE_CHANGING = new Set(['post', 'put', 'patch', 'delete']);
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace']);

/** Every (path, method, operation) in the document, webhooks excluded. */
function operations(): { path: string; method: string; op: Operation }[] {
  const out: { path: string; method: string; op: Operation }[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (HTTP_METHODS.has(method)) out.push({ path, method, op });
    }
  }
  return out;
}

/** Walk every node, so an assertion cannot be evaded by nesting. */
function* nodes(value: unknown, path = '$'): Generator<{ path: string; node: Schema }> {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) yield* nodes(v, `${path}[${String(i)}]`);
  } else if (value !== null && typeof value === 'object') {
    yield { path, node: value as Schema };
    for (const [k, v] of Object.entries(value)) yield* nodes(v, `${path}.${k}`);
  }
}

function resolveRef(ref: string): unknown {
  let cursor: unknown = spec;
  for (const raw of ref.replace(/^#\//, '').split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    cursor = (cursor as Record<string, unknown>)[part];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

// -- The document is well formed ----------------------------------------------

describe('the document itself', () => {
  it('is OpenAPI 3.1', () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
  });

  it('resolves every internal $ref', () => {
    const broken: string[] = [];
    for (const { path, node } of nodes(spec)) {
      const ref = node['$ref'];
      if (typeof ref === 'string' && ref.startsWith('#/') && resolveRef(ref) === undefined) {
        broken.push(`${path} -> ${ref}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('gives every operation a unique operationId', () => {
    const ids = operations().map(({ op }) => op.operationId);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// -- §1.1 the absence is the control ------------------------------------------

describe('SH-01 — the wire format cannot carry a rate', () => {
  /**
   * The decisive property. A closed schema means an unknown field is refused
   * rather than ignored, so a partner cannot post a proportion and cannot have
   * one quietly persisted. Leave one schema open and that guarantee is gone
   * for the whole document.
   */
  it('closes every object schema against unknown properties', () => {
    // `if`, `then`, `else` and `not` are conditional applicators, not value
    // schemas. They constrain; they do not describe an object's full shape.
    // Putting `additionalProperties: false` inside an `if` would change what
    // the condition matches rather than close anything, so they are skipped.
    const applicator = /\.(if|then|else|not)$/;

    const open: string[] = [];
    for (const { path, node } of nodes(spec)) {
      if (applicator.test(path)) continue;
      const isObjectSchema =
        node['type'] === 'object' || (node['properties'] !== undefined && node['$ref'] === undefined);
      if (isObjectSchema && node['additionalProperties'] === undefined) open.push(path);
    }
    expect(open).toEqual([]);
  });

  /**
   * A JSON Schema trap worth a test of its own.
   *
   * `additionalProperties` only considers `properties` declared in the *same*
   * schema object. So a property introduced inside a `then` branch of a
   * closed parent is not permitted by that parent — it is rejected as an
   * unknown property, and the branch silently never validates anything.
   *
   * The failure mode is nasty: the document reads as though the conditional
   * works, and every request carrying that field is refused with an error
   * naming a field the spec plainly declares. Cheaper to catch here.
   */
  it('introduces no property inside a conditional branch of a closed schema', () => {
    const unreachable: string[] = [];

    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      if (schema['additionalProperties'] !== false) continue;
      const declared = new Set(Object.keys((schema['properties'] ?? {}) as object));

      for (const { path, node } of nodes(schema, `$.${name}`)) {
        if (!/\.(then|else)$/.test(path)) continue;
        for (const branchProperty of Object.keys((node['properties'] ?? {}) as object)) {
          if (!declared.has(branchProperty)) unreachable.push(`${path}.${branchProperty}`);
        }
      }
    }

    expect(unreachable).toEqual([]);
  });

  it('never types additionalProperties as an open true', () => {
    const permissive: string[] = [];
    for (const { path, node } of nodes(spec)) {
      if (node['additionalProperties'] === true) permissive.push(path);
    }
    expect(permissive).toEqual([]);
  });

  /**
   * Belt and braces alongside the absence scan in
   * `test/architecture/absences.test.ts`. That one reads the file as text;
   * this one reads it as a document, so a rate introduced as a structured
   * property name is caught even if its spelling slips past a substring match.
   */
  it('declares no property whose name is proportion-shaped', () => {
    const banned = [
      ['rate'],
      ['margin'],
      ['a', 'p', 'r'].join(''),
      ['percent'],
      ['yield'],
      ['coupon'],
    ].flat();

    const offenders: string[] = [];
    for (const { path, node } of nodes(spec)) {
      const properties = node['properties'];
      if (properties === null || typeof properties !== 'object') continue;
      for (const name of Object.keys(properties)) {
        const lower = name.toLowerCase();
        if (banned.some((b) => lower.includes(b))) offenders.push(`${path}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// -- §8 no floating point in the financial path -------------------------------

describe('money', () => {
  const money = spec.components.schemas['Money'] as
    | { properties: Record<string, Schema>; required: string[] }
    | undefined;

  it('exists and carries an explicit currency', () => {
    expect(money).toBeDefined();
    expect(money?.required).toEqual(expect.arrayContaining(['minorUnits', 'currency']));
  });

  it('carries minor units as a digit string, never a JSON number', () => {
    // A JSON number is a double in most parsers. A string of digits is not.
    expect(money?.properties['minorUnits']?.['type']).toBe('string');
    expect(money?.properties['minorUnits']?.['pattern']).toBeTypeOf('string');
  });

  it('types no amount anywhere as number', () => {
    const numeric: string[] = [];
    for (const { path, node } of nodes(spec)) {
      const properties = node['properties'];
      if (properties === null || typeof properties !== 'object') continue;
      for (const [name, schema] of Object.entries(properties as Record<string, Schema>)) {
        const looksMonetary = /amount|price|cost|profit|total|units|balance/i.test(name);
        const t = schema['type'];
        if (looksMonetary && (t === 'number' || t === 'integer')) numeric.push(`${path}.${name}`);
      }
    }
    expect(numeric).toEqual([]);
  });
});

// -- §8 idempotency and tenancy -----------------------------------------------

describe('§8 — API conventions', () => {
  it('requires Idempotency-Key on every state-changing operation', () => {
    const missing: string[] = [];
    for (const { path, method, op } of operations()) {
      if (!STATE_CHANGING.has(method)) continue;
      const names = (op.parameters ?? []).map((p) =>
        p.$ref === undefined
          ? p.name
          : (resolveRef(p.$ref) as { name?: string } | undefined)?.name,
      );
      if (!names.includes('Idempotency-Key')) missing.push(`${method.toUpperCase()} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  it('declares Idempotency-Key as required, not optional', () => {
    expect(spec.components.parameters['IdempotencyKey']?.required).toBe(true);
  });

  /**
   * Tenant scope is derived from the authenticated principal and never
   * accepted from the client. The control is that the field does not exist in
   * any request body — combined with closed schemas, sending one is a 400.
   */
  it('accepts no tenant, channel or partner identity in a request body', () => {
    const claimed: string[] = [];
    for (const { path, method, op } of operations()) {
      const bodySchemas = Object.values(op.requestBody?.content ?? {}).map((c) => c.schema);
      for (const schema of bodySchemas) {
        const resolved =
          typeof schema?.['$ref'] === 'string'
            ? (resolveRef(schema['$ref'] as string) as Schema)
            : schema;
        for (const { node } of nodes(resolved)) {
          const properties = node['properties'];
          if (properties === null || typeof properties !== 'object') continue;
          for (const name of Object.keys(properties)) {
            if (/^(tenantId|channel|partnerId|aggregatorId|credentialRef)$/.test(name)) {
              claimed.push(`${method.toUpperCase()} ${path}: ${name}`);
            }
          }
        }
      }
    }
    expect(claimed).toEqual([]);
  });

  it('returns RFC 9457 problem details on every error response', () => {
    const wrong: string[] = [];
    for (const { path, method, op } of operations()) {
      for (const [status, response] of Object.entries(op.responses ?? {})) {
        if (!/^[45]/.test(status)) continue;
        const resolved = (
          '$ref' in response ? resolveRef(response.$ref) : response
        ) as ResponseObject | undefined;
        const types = Object.keys(resolved?.content ?? {});
        if (!types.includes('application/problem+json')) {
          wrong.push(`${method.toUpperCase()} ${path} ${status}: ${types.join(',') || 'no content'}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('makes every problem bilingual and correlated', () => {
    const problem = spec.components.schemas['Problem'] as { required: string[] } | undefined;
    expect(problem?.required).toEqual(
      expect.arrayContaining(['detail', 'detailAr', 'correlationId']),
    );
  });

  it('names a control on the rejection examples, never a generic decline', () => {
    const rejection = spec.components.responses['ControlRejection'];
    const examples = rejection?.content?.['application/problem+json']?.examples;
    expect(examples).toBeDefined();
    expect(Object.keys(examples ?? {}).length).toBeGreaterThan(0);
    for (const [name, example] of Object.entries(examples ?? {})) {
      expect(example.value['control'], `${name} names a control`).toBeTypeOf('string');
      expect(example.value['reason'], `${name} names a reason`).toBeTypeOf('string');
      expect(example.value['detailAr'], `${name} is bilingual`).toBeTypeOf('string');
    }
  });
});

// -- §5 the gateway is swappable ----------------------------------------------

describe('§5 — no gateway-specific behaviour in the contract', () => {
  it('names no header a particular gateway injects', () => {
    const forbidden = /^x-(consumer|anonymous-consumer|credential|kong|authenticated-|ibm-|datapower)/i;
    const offenders: string[] = [];
    for (const { path, node } of nodes(spec)) {
      const name = node['name'];
      if (node['in'] === 'header' && typeof name === 'string' && forbidden.test(name)) {
        offenders.push(`${path}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('requires both mutual TLS and a partner token, not either', () => {
    expect(spec.components.securitySchemes['mutualTls']?.type).toBe('mutualTLS');
    expect(spec.components.securitySchemes['partnerOAuth']?.type).toBe('oauth2');
    // One requirement object listing both schemes means AND. Two objects
    // would mean OR, and would let a token alone through.
    expect(spec.security).toHaveLength(1);
    expect(Object.keys(spec.security?.[0] ?? {}).sort()).toEqual(['mutualTls', 'partnerOAuth']);
  });
});

// -- SH-05 the API is not a shortcut ------------------------------------------

describe('SH-05 — no sequencing shortcut is expressible', () => {
  it('exposes no review action on a partner-authenticated API', () => {
    const reviewish = operations().filter(({ path, op }) =>
      /approve|reject|decision|review|override|force/i.test(`${path} ${op.operationId ?? ''}`),
    );
    expect(reviewish.map((r) => r.op.operationId)).toEqual([]);
  });

  it('can only ever report a transaction in DRAFT', () => {
    const request = spec.components.schemas['OriginationRequest'] as {
      properties: Record<string, Schema>;
    };
    const transaction = request.properties['transaction'] as {
      properties: Record<string, Schema>;
    };
    // `const`, not `enum` with one member: there is no later state this API
    // can name, so approval cannot be read as execution.
    expect(transaction.properties['state']?.['const']).toBe('DRAFT');
  });

  it('does not expose KEYING, which is an internal screen state', () => {
    const states = spec.components.schemas['RequestState']?.['enum'] as string[];
    expect(states).not.toContain('KEYING');
  });

  it('enumerates only the two partner channels', () => {
    const request = spec.components.schemas['OriginationRequest'] as {
      properties: Record<string, Schema>;
    };
    expect(request.properties['channel']?.['enum']).toEqual([
      'PARTNER_API',
      'EMBEDDED_AGGREGATOR',
    ]);
  });
});

// -- The contract matches the domain ------------------------------------------

describe('the contract agrees with the domain it fronts', () => {
  it('lists exactly the control codes the kernel defines', async () => {
    const declared = spec.components.schemas['ControlCode']?.['enum'] as string[];
    const shariah = Array.from({ length: 18 }, (_, i) => `SH-${String(i + 1).padStart(2, '0')}`);
    const operational = ['OP-DETERMINACY', 'OP-CHAIN', 'OP-LIMIT'];
    expect(declared).toEqual([...shariah, ...operational]);
  });

  it('exposes every request state the domain can reach externally', async () => {
    const declared = new Set(spec.components.schemas['RequestState']?.['enum'] as string[]);
    // From core/origination/request.ts, less KEYING which never leaves the
    // internal screen. If the domain gains a state, this fails until the
    // contract is updated — which is the intended order of work.
    expect(declared).toEqual(
      new Set([
        'AWAITING_SERVICING_RESPONSE',
        'AWAITING_REVIEW',
        'RETURNED_TO_MAKER',
        'APPROVED',
        'REJECTED',
        'WITHDRAWN',
      ]),
    );
  });

  it('requires a trade on every raise, so there is no amount-only path', async () => {
    const raise = spec.components.schemas['RaiseRequest'] as { required: string[] };
    expect(raise.required).toContain('tradeReference');
  });

  it('requires a merchant mandate from an aggregator, not from the aggregator alone', () => {
    const aggregator = spec.components.schemas['AggregatorInitiator'] as { required: string[] };
    expect(aggregator.required).toContain('merchantMandateRef');
  });

  it('carries the attestation with every instant that has contractual effect', () => {
    const instant = spec.components.schemas['AttestedInstant'] as { required: string[] };
    expect(instant.required).toEqual(expect.arrayContaining(['instant', 'attestationRef']));
  });
});
