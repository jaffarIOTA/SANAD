/**
 * SR-047: the deployment's jurisdiction and its licence act on every
 * institution, so only the platform operator may propose or decide them. An
 * institution's administrator, signed in through that institution's single
 * sign-on, is refused. Each case attempts the deployment-wide act and passes
 * only when it is refused.
 */
import { describe, expect, it } from 'vitest';

import { TENANT_CODES, isTenantCode, loadPlatformOperatorIdentity } from '../../config/loader.ts';
import { parseStaffIdentity } from '../../core/config/staff-identity.ts';
import { PLATFORM_OPERATOR } from '../../apps/admin/src/server/single-sign-on.ts';
import { configurableTenant, mayActForDeployment } from '../../apps/admin/src/server/tenant-scope.ts';

const bankAdmin = { method: 'OIDC', tenantId: 'bank-a', scope: 'INSTITUTION' } as const;
const operator = { method: 'OIDC', scope: 'PLATFORM' } as const;

describe('Deployment-wide Admin acts need platform authority (SR-047)', () => {
  it("refuses an institution's administrator the jurisdiction and licence acts", () => {
    expect(mayActForDeployment(bankAdmin)).toBe(false);
    for (const tenantId of TENANT_CODES) {
      const admin = { method: 'OIDC', tenantId, scope: 'INSTITUTION' } as const;
      expect(mayActForDeployment(admin)).toBe(false);
    }
  });

  it('permits the platform operator', () => {
    expect(mayActForDeployment(operator)).toBe(true);
  });

  it('the platform operator configures no institution', () => {
    for (const code of TENANT_CODES) expect(configurableTenant(operator, code)).toBeUndefined();
  });

  it('the platform operator choice is never an institution, so it cannot be named as one', () => {
    expect(isTenantCode(PLATFORM_OPERATOR)).toBe(false);
    expect(configurableTenant(bankAdmin, PLATFORM_OPERATOR)).toBeUndefined();
  });

  it("the operator's provider grants platform administration and nothing else, in either profile", () => {
    for (const profile of ['DEVELOPMENT', 'DEPLOYED'] as const) {
      const identity = loadPlatformOperatorIdentity(profile);
      expect(identity.ok).toBe(true);
      if (!identity.ok) continue;
      expect(identity.value.mappings.every((m) => m.authority === 'PLATFORM_ADMIN')).toBe(true);
    }
    const deployed = loadPlatformOperatorIdentity('DEPLOYED');
    expect(deployed.ok && deployed.value.provider.protocol).toBe('OIDC');
  });

  it('refuses an operator configuration that would also key or approve credit', () => {
    const withMaker = {
      version: 'x',
      provider: { protocol: 'DEVELOPMENT', issuer: 'development:platform', groupsClaim: 'groups' },
      mappings: [
        { group: 'operators', authority: 'PLATFORM_ADMIN' },
        { group: 'makers', authority: 'MAKER' },
      ],
      sessionLifetimeSeconds: 1800,
    };
    const parsed = parseStaffIdentity(withMaker, 'DEVELOPMENT', 'PLATFORM_OPERATOR');
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error.reason).toBe('PLATFORM_OPERATOR_AUTHORITY_ONLY');
  });
});
