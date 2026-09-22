/**
 * Who is calling, and what that entitles them to.
 *
 * Three properties matter here, and each one is a requirement rather than a
 * preference.
 *
 * **The tenant comes from the credential, never from the request.** §8 is
 * explicit: tenant scope is derived from the authenticated principal and never
 * accepted from the client. The contract has no `tenantId` field for exactly
 * this reason, and this module is where the rule is actually applied.
 *
 * **So does the channel.** A partner credential means `PARTNER_API`; an
 * aggregator credential means `EMBEDDED_AGGREGATOR`. A caller that could
 * choose its own channel could choose the one with the weaker evidence
 * requirement, which is the erosion `core/origination/channel.ts` warns
 * about.
 *
 * **No gateway header is trusted.** Kong may well have authenticated this
 * request already, and IBM API Connect may do it tomorrow (§5). This service
 * re-validates independently and reads nothing a gateway injects, which is
 * both defence in depth and what keeps the gateway swappable.
 *
 * The token itself is never stored, compared in plaintext or logged. Lookup is
 * by digest, and the comparison is length-independent.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { OriginationChannel } from '@sanad/core/origination/channel.ts';

export type Scope = 'origination:read' | 'origination:write';

export interface PartnerPrincipal {
  /** Opaque partner identifier. Safe to log. */
  readonly partnerId: string;
  readonly tenantId: string;
  /** Derived from the credential, never from the body. */
  readonly channel: OriginationChannel;
  readonly scopes: readonly Scope[];
  /**
   * A reference to the credential, for the audit trail. Never the credential.
   */
  readonly credentialRef: string;
}

export interface CredentialRegistry {
  /** Look a principal up by the digest of its presented token. */
  findByTokenDigest(digest: string): PartnerPrincipal | undefined;
}

const digestOf = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Development registry.
 *
 * Built from the environment at construction, so no token is ever written into
 * source. In a deployed environment this is replaced by a lookup against
 * `config.integration_credential`, and every resolution is audited (§4).
 */
export function developmentRegistry(env: NodeJS.ProcessEnv): CredentialRegistry {
  const entries = new Map<string, PartnerPrincipal>();

  const add = (
    token: string | undefined,
    principal: PartnerPrincipal,
  ): void => {
    if (token === undefined || token.trim().length === 0) return;
    entries.set(digestOf(token), principal);
  };

  add(env['PARTNER_API_DEV_TOKEN'], {
    partnerId: 'partner-dev-01',
    tenantId: 'bank-a',
    channel: 'PARTNER_API',
    scopes: ['origination:read', 'origination:write'],
    credentialRef: 'cred-dev-partner-01',
  });

  add(env['AGGREGATOR_DEV_TOKEN'], {
    partnerId: 'aggregator-dev-01',
    tenantId: 'bank-a',
    channel: 'EMBEDDED_AGGREGATOR',
    scopes: ['origination:read', 'origination:write'],
    credentialRef: 'cred-dev-aggregator-01',
  });

  return {
    findByTokenDigest(digest: string): PartnerPrincipal | undefined {
      // Constant-time over the candidate set, so a timing signal does not
      // narrow which credential exists.
      const target = Buffer.from(digest, 'hex');
      let found: PartnerPrincipal | undefined;
      for (const [candidate, principal] of entries) {
        const other = Buffer.from(candidate, 'hex');
        if (other.length === target.length && timingSafeEqual(other, target)) {
          found = principal;
        }
      }
      return found;
    },
  };
}

export type AuthOutcome =
  | { readonly ok: true; readonly principal: PartnerPrincipal }
  | { readonly ok: false; readonly reason: 'CREDENTIAL_MISSING' | 'CREDENTIAL_NOT_RECOGNISED' };

/**
 * Authenticate from the Authorization header alone.
 *
 * Deliberately takes the header rather than the request, so nothing in this
 * function can reach for a gateway-injected value by accident.
 */
export function authenticate(
  authorization: string | undefined,
  registry: CredentialRegistry,
): AuthOutcome {
  if (authorization === undefined) return { ok: false, reason: 'CREDENTIAL_MISSING' };

  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (match === null) return { ok: false, reason: 'CREDENTIAL_MISSING' };

  const principal = registry.findByTokenDigest(digestOf(match[1] ?? ''));
  if (principal === undefined) return { ok: false, reason: 'CREDENTIAL_NOT_RECOGNISED' };

  return { ok: true, principal };
}

export const hasScope = (principal: PartnerPrincipal, scope: Scope): boolean =>
  principal.scopes.includes(scope);
