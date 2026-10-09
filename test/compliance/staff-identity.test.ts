/**
 * Staff identity configuration. A deployed environment never authenticates
 * staff through a development stand-in; metadata travels over TLS; no secret
 * is accepted in the configuration; maker and checker are always reachable;
 * a group confers one authority; unknown groups confer nothing.
 */
import { describe, expect, it } from 'vitest';

import { TENANT_CODES, type TenantCode, loadStaffIdentity } from '@sanad/config/loader.ts';
import { authoritiesFor, parseStaffIdentity } from '@sanad/core/config/staff-identity.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { singleSignOnInstitutions } from '@sanad/origination/staff-identity.ts';
import bankA from '@sanad/config/tenants/bank-a/identity/staff-identity.json' with { type: 'json' };
import fintechB from '@sanad/config/tenants/fintech-b/identity/staff-identity.json' with { type: 'json' };
import fundAe from '@sanad/config/tenants/sme-fund-ae/identity/staff-identity.json' with { type: 'json' };

const TENANT_IDENTITY_FILES: Readonly<Record<TenantCode, unknown>> = {
  'bank-a': bankA,
  'fintech-b': fintechB,
  'sme-fund-ae': fundAe,
};
/** The hosted environment's filling-in of the placeholders, with illustrative identifiers. */
const fill = (file: unknown): unknown =>
  JSON.parse(
    JSON.stringify(file)
      .replaceAll('<ENTRA_TENANT_ID>', '00000000-0000-0000-0000-000000000001')
      .replaceAll('<ENTRA_CLIENT_ID>', '00000000-0000-0000-0000-000000000002'),
  );
const devProvider = { protocol: 'DEVELOPMENT', issuer: 'development:t', groupsClaim: 'groups' };

const oidc = {
  version: 't',
  provider: {
    protocol: 'OIDC',
    issuer: 'https://idp.example/realms/bank',
    metadataUrl: 'https://idp.example/realms/bank/.well-known/openid-configuration',
    clientId: 'sanad-ops',
    groupsClaim: 'groups',
  },
  mappings: [
    { group: 'makers', authority: 'MAKER' },
    { group: 'checkers', authority: 'CHECKER' },
  ],
  sessionLifetimeSeconds: 1800,
};
const reason = (raw: unknown, profile: 'DEVELOPMENT' | 'DEPLOYED' = 'DEPLOYED'): string => {
  const r = parseStaffIdentity(raw, profile);
  return r.ok ? 'OK' : r.error.reason;
};

describe('staff identity configuration', () => {
  it('every tenant’s file selects the development stand-in in development, and is refused when deployed until its OIDC placeholders are filled', () => {
    for (const t of TENANT_CODES) {
      const dev = loadStaffIdentity(t, 'DEVELOPMENT');
      expect(dev.ok).toBe(true);
      if (dev.ok) expect(dev.value.provider.protocol).toBe('DEVELOPMENT');
      const deployed = loadStaffIdentity(t, 'DEPLOYED');
      expect(deployed.ok).toBe(false);
      if (!deployed.ok) expect(deployed.error.reason).toBe('IDENTITY_PLACEHOLDER_UNFILLED');
    }
  });
  it('a filled-in copy of a tenant file selects OIDC when deployed, and its groups are scoped to that tenant', () => {
    for (const t of TENANT_CODES) {
      const filled = fill(TENANT_IDENTITY_FILES[t]);
      const deployed = expectOk(parseStaffIdentity(filled, 'DEPLOYED'));
      expect(deployed.provider.protocol).toBe('OIDC');
      expect(deployed.provider.issuer).toBe(
        'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0',
      );
      expect(deployed.mappings.every((m) => m.group.startsWith(`sanad.${t}.`))).toBe(true);
    }
  });
  it('a provider keyed by profile: the stand-in is never selected when deployed, and is refused as the deployed entry', () => {
    const keyed = { ...oidc, provider: undefined, providers: { DEVELOPMENT: devProvider, DEPLOYED: oidc.provider } };
    const dev = expectOk(parseStaffIdentity(keyed, 'DEVELOPMENT'));
    expect(dev.provider.protocol).toBe('DEVELOPMENT');
    expect(expectOk(parseStaffIdentity(keyed, 'DEPLOYED')).provider.protocol).toBe('OIDC');
    expect(reason({ ...oidc, provider: undefined, providers: { DEPLOYED: devProvider } })).toBe(
      'IDENTITY_DEVELOPMENT_PROVIDER_REFUSED',
    );
    expect(reason({ ...oidc, provider: undefined, providers: { DEVELOPMENT: devProvider } })).toBe(
      'IDENTITY_PROVIDER_REQUIRED',
    );
    // Only DEPLOYED given: development uses it too.
    expect(
      expectOk(
        parseStaffIdentity({ ...oidc, provider: undefined, providers: { DEPLOYED: oidc.provider } }, 'DEVELOPMENT'),
      ).provider.protocol,
    ).toBe('OIDC');
    expect(reason({ ...oidc, providers: { DEPLOYED: oidc.provider } })).toBe('IDENTITY_PROVIDER_AMBIGUOUS');
    expect(reason({ ...oidc, provider: undefined, providers: { PRODUCTION: oidc.provider } })).toBe(
      'IDENTITY_PROVIDER_PROFILE_UNKNOWN',
    );
    // A malformed entry is refused even when it is not the one selected.
    expect(
      reason(
        {
          ...oidc,
          provider: undefined,
          providers: { DEVELOPMENT: devProvider, DEPLOYED: { ...oidc.provider, metadataUrl: 'http://x' } },
        },
        'DEVELOPMENT',
      ),
    ).toBe('IDENTITY_METADATA_URL_REQUIRED');
  });
  it('the sign-in page offers no institution for single sign-on until a real provider is configured', async () => {
    expect(await singleSignOnInstitutions(1_800_000_000n)).toEqual([]);
    const before = process.env['SANAD_DEPLOYMENT_PROFILE'];
    process.env['SANAD_DEPLOYMENT_PROFILE'] = 'DEPLOYED';
    try {
      expect(await singleSignOnInstitutions(1_800_000_000n)).toEqual([]);
    } finally {
      if (before === undefined) delete process.env['SANAD_DEPLOYMENT_PROFILE'];
      else process.env['SANAD_DEPLOYMENT_PROFILE'] = before;
    }
  });
  it('an OIDC issuer is an https URL, and a placeholder is never accepted as configuration', () => {
    expect(reason({ ...oidc, provider: { ...oidc.provider, issuer: 'idp.example' } })).toBe(
      'IDENTITY_ISSUER_NOT_HTTPS',
    );
    expect(reason({ ...oidc, provider: { ...oidc.provider, clientId: '<CLIENT_ID>' } })).toBe(
      'IDENTITY_PLACEHOLDER_UNFILLED',
    );
  });
  it('a real provider parses when deployed; metadata must be TLS; OIDC needs a client id', () => {
    expect(reason(oidc)).toBe('OK');
    expect(reason({ ...oidc, provider: { ...oidc.provider, metadataUrl: 'http://idp.example/x' } })).toBe(
      'IDENTITY_METADATA_URL_REQUIRED',
    );
    expect(reason({ ...oidc, provider: { ...oidc.provider, clientId: undefined } })).toBe(
      'IDENTITY_CLIENT_ID_REQUIRED',
    );
    expect(
      reason({
        ...oidc,
        provider: {
          protocol: 'SAML',
          issuer: 'urn:bank:sanad',
          metadataUrl: 'https://idp.example/metadata.xml',
          groupsClaim: 'memberOf',
        },
      }),
    ).toBe('OK');
  });
  it('a secret in the configuration is refused as an unknown key; it belongs in the vault', () => {
    expect(reason({ ...oidc, provider: { ...oidc.provider, clientSecret: 'nope' } })).toBe(
      'IDENTITY_PROVIDER_UNKNOWN_KEY',
    );
  });
  it('maker and checker must both be reachable; a group maps once; an authority must exist', () => {
    expect(reason({ ...oidc, mappings: [{ group: 'makers', authority: 'MAKER' }] })).toBe(
      'IDENTITY_AUTHORITY_UNMAPPED',
    );
    expect(reason({ ...oidc, mappings: [...oidc.mappings, { group: 'makers', authority: 'CHECKER' }] })).toBe(
      'IDENTITY_GROUP_MAPPED_TWICE',
    );
    expect(reason({ ...oidc, mappings: [...oidc.mappings, { group: 'gods', authority: 'ROOT' }] })).toBe(
      'IDENTITY_AUTHORITY_UNKNOWN',
    );
  });
  it('a session is at most an hour and a step-up window no longer than the session', () => {
    expect(reason({ ...oidc, sessionLifetimeSeconds: 3601 })).toBe('IDENTITY_SESSION_LIFETIME');
    expect(reason({ ...oidc, stepUpForApprovalSeconds: 1801 })).toBe('IDENTITY_STEP_UP_WINDOW');
  });
  it('authorities come only from mapped groups, in the platform’s order', () => {
    const c = expectOk(
      parseStaffIdentity(
        { ...oidc, mappings: [...oidc.mappings, { group: 'seniors', authority: 'SENIOR_CHECKER' }] },
        'DEPLOYED',
      ),
    );
    expect(authoritiesFor(['seniors', 'everyone', 'makers'], c)).toEqual(['MAKER', 'SENIOR_CHECKER']);
    expect(authoritiesFor(['everyone'], c)).toEqual([]);
  });
});
