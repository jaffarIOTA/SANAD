/** The internal review contract: staff-only, closed, four eyes in the service, no gate override anywhere. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { compileContract, contractPath } from '../../services/origination/src/contracts.ts';

const spec = parse(
  readFileSync(fileURLToPath(new URL('../../api/openapi/review.v1.yaml', import.meta.url)), 'utf8'),
) as {
  readonly paths: Record<
    string,
    Record<string, { readonly operationId?: string; readonly parameters?: { readonly $ref?: string }[] }>
  >;
  readonly components: {
    readonly schemas: Record<string, { readonly properties?: Record<string, unknown>; readonly enum?: string[] }>;
    readonly securitySchemes: Record<string, { readonly type: string }>;
  };
};

describe('review contract', () => {
  it('has the four operations and is staff-authenticated, not partner-authenticated', () => {
    const ops = Object.values(spec.paths).flatMap((p) =>
      Object.entries(p)
        .filter(([m]) => m !== 'parameters')
        .map(([, o]) => o.operationId),
    );
    expect(ops.sort()).toEqual(['decideRequest', 'getRequestForReview', 'listReviewQueue', 'retryServicing']);
    expect(spec.components.securitySchemes['staffOpenId']?.type).toBe('openIdConnect');
    expect(Object.keys(spec.components.securitySchemes)).not.toContain('partnerOAuth');
  });
  it('offers no decision that advances a gate or overrides a refusal', () => {
    const decisions = (spec.components.schemas['Decision']?.properties?.['decision'] as { enum: string[] }).enum;
    expect(decisions).toEqual(['APPROVE', 'RETURN', 'REJECT', 'REQUEST_INFORMATION']);
    for (const d of decisions) expect(d).not.toMatch(/OVERRIDE|FORCE|BYPASS|ADVANCE|EXECUTE/);
    const names = new Set<string>();
    for (const s of Object.values(spec.components.schemas))
      for (const k of Object.keys(s.properties ?? {})) names.add(k);
    for (const n of names) expect(n, n).not.toMatch(/rate|apr|override|force|bypass/i);
  });
  it('requires an Idempotency-Key on every write and compiles a closed Decision schema', () => {
    for (const [path, ops] of Object.entries(spec.paths))
      for (const [m, op] of Object.entries(ops))
        if (m === 'put' || m === 'post')
          expect(
            (op.parameters ?? []).some((p) => p.$ref?.endsWith('/IdempotencyKey')),
            `${m} ${path}`,
          ).toBe(true);
    const validate = compileContract(contractPath('review.v1.yaml')).validatorFor('Decision');
    expect(validate({ decision: 'RETURN', note: 'tenor' })).toEqual([]);
    expect(validate({ decision: 'APPROVE', override: true }).some((f) => f.unknownProperty === 'override')).toBe(true);
  });
});
