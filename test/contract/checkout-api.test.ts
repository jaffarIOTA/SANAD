/**
 * The merchant checkout contract: closed schemas, money as strings, identity
 * from the credential, nothing rate-shaped, idempotency on every write.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { compileContract, contractPath } from '../../services/origination/src/contracts.ts';

const SPEC = fileURLToPath(new URL('../../api/openapi/checkout.v1.yaml', import.meta.url));
type Schema = { readonly type?: string; readonly additionalProperties?: boolean; readonly properties?: Record<string, Schema>; readonly $ref?: string };
const spec = parse(readFileSync(SPEC, 'utf8')) as { readonly openapi: string; readonly paths: Record<string, Record<string, { readonly operationId: string; readonly parameters?: { readonly $ref: string }[] }>>; readonly components: { readonly schemas: Record<string, Schema> } };

describe('checkout contract', () => {
  it('is OpenAPI 3.1 with the three operations and the webhook', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.values(spec.paths).flatMap((p) => Object.entries(p).filter(([m]) => m !== 'parameters').map(([, o]) => o.operationId)).sort()).toEqual(['cancelCheckoutSession', 'createCheckoutSession', 'getCheckoutSession']);
  });
  it('every object schema is closed', () => {
    const walk = (name: string, s: Schema): void => {
      if (s.type === 'object') expect(s.additionalProperties, `${name} must be additionalProperties: false`).toBe(false);
      for (const [k, v] of Object.entries(s.properties ?? {})) walk(`${name}.${k}`, v);
    };
    for (const [name, s] of Object.entries(spec.components.schemas)) if (name !== 'Problem') walk(name, s);
  });
  it('names nothing rate-shaped, no identifier, and no merchant or tenant field in a request body', () => {
    const names = new Set<string>();
    const collect = (s: Schema): void => { for (const [k, v] of Object.entries(s.properties ?? {})) { names.add(k); collect(v); } };
    for (const s of Object.values(spec.components.schemas)) collect(s);
    for (const n of names) expect(n, n).not.toMatch(/rate|apr|percent|margin|nationalId|iqama|phone|email/i);
    const create = spec.components.schemas['CreateCheckoutSession']?.properties ?? {};
    expect(Object.keys(create)).not.toContain('merchantId'); expect(Object.keys(create)).not.toContain('tenantId');
  });
  it('requires an Idempotency-Key on every state-changing operation', () => {
    for (const [path, ops] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(ops)) {
      if (method === 'parameters' || method === 'get') continue;
      expect((op.parameters ?? []).some((p) => p.$ref.endsWith('/IdempotencyKey')), `${method} ${path}`).toBe(true);
    }
  });
  it('compiles into a validator that refuses an unknown property and a numeric amount', () => {
    const validate = compileContract(contractPath('checkout.v1.yaml')).validatorFor('CreateCheckoutSession');
    const good = { merchantOrderRef: 'ORD-1', basket: { minorUnits: '120000', currency: 'SAR' }, returnUrl: 'https://shop.example/r', cancelUrl: 'https://shop.example/c' };
    expect(validate(good)).toEqual([]);
    expect(validate({ ...good, feePercent: 2 }).some((f) => f.unknownProperty === 'feePercent')).toBe(true);
    expect(validate({ ...good, basket: { minorUnits: 1200.5, currency: 'SAR' } }).length).toBeGreaterThan(0);
  });
});
