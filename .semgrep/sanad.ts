// Fixtures for .semgrep/sanad.yml (SR-033), run by `npm run test:semgrep`. Never imported; never built.
// `ruleid:` marks a line the rule must match, `ok:` one it must not.
/* eslint-disable */
declare const req: { body: Record<string, string>; query: Record<string, string> };
declare const form: FormData;
declare const url: URL;
declare const admin: { method: 'OIDC' | 'DEVELOPMENT'; tenantId?: string };
declare function field(form: FormData, name: string): string;
declare function configurableTenant(admin: unknown, requested: string | undefined): string | undefined;

export function fromTheClient(): unknown[] {
  return [
    // ruleid: sanad-no-tenant-id-from-client
    req.body.tenantId,
    // ruleid: sanad-no-tenant-id-from-client
    req.body.tenant_id,
    // ruleid: sanad-no-tenant-id-from-client
    req.query.tenantId,
    // ruleid: sanad-no-tenant-id-from-client
    req.query.tenant,
    // ruleid: sanad-no-tenant-id-from-client
    form.get('tenant'),
    // ruleid: sanad-no-tenant-id-from-client
    form.get('tenantCode'),
    // ruleid: sanad-no-tenant-id-from-client
    form.getAll('tenant'),
    // ruleid: sanad-no-tenant-id-from-client
    url.searchParams.get('tenant'),
    // ruleid: sanad-no-tenant-id-from-client
    field(form, 'tenant'),
    // ruleid: sanad-no-tenant-id-from-client
    field(form, 'targetTenant'),
  ];
}

export function boundToThePrincipal(): unknown[] {
  return [
    // ok: sanad-no-tenant-id-from-client
    configurableTenant(admin, field(form, 'tenant')),
    // ok: sanad-no-tenant-id-from-client
    configurableTenant(admin, url.searchParams.get('tenant') ?? undefined),
    // ok: sanad-no-tenant-id-from-client
    admin.tenantId,
    // ok: sanad-no-tenant-id-from-client
    field(form, 'locale'),
    // ok: sanad-no-tenant-id-from-client
    form.get('institution'),
    // ok: sanad-no-tenant-id-from-client
    req.body.amountMinor,
  ];
}
