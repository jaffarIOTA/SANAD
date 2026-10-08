/**
 * Staff identity configuration. A deployed environment never authenticates
 * staff through a development stand-in; metadata travels over TLS; no secret
 * is accepted in the configuration; maker and checker are always reachable;
 * a group confers one authority; unknown groups confer nothing.
 */
import { describe, expect, it } from 'vitest';

import { loadStaffIdentity } from '@sanad/config/loader.ts';
import { authoritiesFor, parseStaffIdentity } from '@sanad/core/config/staff-identity.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';

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
  it('both tenants’ files parse in development and are refused when deployed, because they name the development stand-in', () => {
    for (const t of ['bank-a', 'fintech-b'] as const) {
      expect(loadStaffIdentity(t, 'DEVELOPMENT').ok).toBe(true);
      const deployed = loadStaffIdentity(t, 'DEPLOYED');
      expect(deployed.ok).toBe(false);
      if (!deployed.ok) expect(deployed.error.reason).toBe('IDENTITY_DEVELOPMENT_PROVIDER_REFUSED');
    }
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
