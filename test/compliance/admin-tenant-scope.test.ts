/**
 * SR-033: an administrator signed in through one institution's single sign-on
 * cannot read or change another's configuration by naming it in a form or an
 * address. Each case attempts the cross-tenant choice and passes only when it
 * is refused.
 */
import { describe, expect, it } from 'vitest';

import { configurableTenant, configurableTenants, displayedTenant } from '../../apps/admin/src/server/tenant-scope.ts';

const bankAdmin = { method: 'OIDC', tenantId: 'bank-a' } as const;
const developer = { method: 'DEVELOPMENT' } as const;
const tenants = [{ code: 'bank-a' }, { code: 'fintech-b' }];

describe('Admin is bound to the institution that signed it in (SR-033)', () => {
  it("refuses another institution's code from a form", () => {
    expect(configurableTenant(bankAdmin, 'fintech-b')).toBeUndefined();
    expect(configurableTenant(bankAdmin, 'bank-a')).toBe('bank-a');
  });

  it('refuses an unknown code, an empty one and none', () => {
    for (const requested of ['no-such-bank', '', undefined]) {
      expect(configurableTenant(bankAdmin, requested)).toBeUndefined();
      expect(configurableTenant(developer, requested)).toBeUndefined();
    }
  });

  it('a single sign-on session without an institution configures none', () => {
    expect(configurableTenant({ method: 'OIDC' }, 'bank-a')).toBeUndefined();
    expect(displayedTenant({ method: 'OIDC' }, 'bank-a', 'bank-a')).toBeUndefined();
    expect(configurableTenants({ method: 'OIDC' }, tenants)).toEqual([]);
  });

  it("shows the administrator's own institution whatever the address asks for", () => {
    expect(displayedTenant(bankAdmin, 'fintech-b', 'fintech-b')).toBe('bank-a');
    expect(displayedTenant(bankAdmin, undefined, 'fintech-b')).toBe('bank-a');
    expect(configurableTenants(bankAdmin, tenants)).toEqual([{ code: 'bank-a' }]);
  });

  it('development sign-in, refused outside development, may choose any known institution', () => {
    expect(configurableTenant(developer, 'fintech-b')).toBe('fintech-b');
    expect(displayedTenant(developer, undefined, 'bank-a')).toBe('bank-a');
    expect(configurableTenants(developer, tenants)).toEqual(tenants);
  });
});
