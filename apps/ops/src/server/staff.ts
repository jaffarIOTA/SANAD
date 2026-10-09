/**
 * Who a member of staff is. One registry decides it, for both doors into the
 * workbench: the sign-in page (which then issues a sealed session cookie) and
 * the review API's bearer credential.
 *
 * Development: a token from the environment, compared by digest in constant
 * time, names exactly one person — one token, one principal, one person — and
 * the groups that person belongs to. What those groups let them do comes from
 * the tenant's staff identity configuration (`config/tenants/<t>/identity/`),
 * exactly as the institution's identity provider's group claim will in
 * production. Development tokens are refused when NODE_ENV is production: there
 * a member of staff signs in through the institution's single sign-on by
 * OpenID Connect (single-sign-on.ts), whose principal is derived from the
 * provider's `sub` claim and whose authorities come from the same mappings.
 *
 * No token, digest or principal is logged here or anywhere it is called from.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { type TenantCode, loadStaffIdentity } from '@sanad/config/loader.ts';
import {
  type StaffAuthority,
  type StaffIdentityConfiguration,
  authoritiesFor,
  highestApprovalAuthority,
} from '@sanad/core/config/staff-identity.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import type { Principal } from '@sanad/core/origination/request.ts';
import { deploymentProfile } from '@sanad/origination/staff-identity.ts';

/** A signed-in member of staff: who they are, whose staff they are, and what they may do. */
export interface StaffPrincipal {
  readonly principalId: string;
  /** The tenant the identity belongs to. Never chosen by a form, a header or a query. */
  readonly tenantId: TenantCode;
  /** Granted by the tenant's staff identity configuration from the person's groups. */
  readonly authorities: readonly StaffAuthority[];
}

/** One development identity: the environment variable holding its token, the person, and their groups. */
export interface DevelopmentStaff {
  readonly environmentName: string;
  readonly principalId: string;
  readonly tenantId: TenantCode;
  readonly groups: readonly string[];
}

/**
 * The development staff. Fictional people; each token is one of them. The
 * groups are the tenant's own group names (its staff-identity.json), so the
 * authorities follow that configuration rather than being hard-coded here.
 * Group names are scoped by tenant (`sanad.<tenant>.<role>`), the same values
 * the deployed identity provider asserts, so several tenants can share one
 * issuer without one tenant's group granting anything in another.
 */
export const DEVELOPMENT_STAFF: readonly DevelopmentStaff[] = [
  {
    environmentName: 'STAFF_DEV_TOKEN_MAKER',
    principalId: 'stf-maker-01',
    tenantId: 'bank-a',
    groups: ['sanad.bank-a.makers'],
  },
  {
    environmentName: 'STAFF_DEV_TOKEN_CHECKER',
    principalId: 'stf-checker-01',
    tenantId: 'bank-a',
    groups: ['sanad.bank-a.checkers'],
  },
  {
    environmentName: 'STAFF_DEV_TOKEN_SENIOR',
    principalId: 'stf-senior-01',
    tenantId: 'bank-a',
    groups: ['sanad.bank-a.senior-checkers'],
  },
  {
    environmentName: 'STAFF_DEV_TOKEN_AE_OFFICER',
    principalId: 'stf-ae-officer-01',
    tenantId: 'sme-fund-ae',
    groups: ['sanad.sme-fund-ae.makers'],
  },
  {
    environmentName: 'STAFF_DEV_TOKEN_AE_CHECKER',
    principalId: 'stf-ae-checker-01',
    tenantId: 'sme-fund-ae',
    groups: ['sanad.sme-fund-ae.checkers'],
  },
  {
    environmentName: 'STAFF_DEV_TOKEN_AE_COMMITTEE',
    principalId: 'stf-ae-committee-01',
    tenantId: 'sme-fund-ae',
    groups: ['sanad.sme-fund-ae.credit-committee'],
  },
  {
    environmentName: 'STAFF_DEV_TOKEN_AE_FINANCE',
    principalId: 'stf-ae-finance-01',
    tenantId: 'sme-fund-ae',
    groups: ['sanad.sme-fund-ae.finance'],
  },
];

type Env = Readonly<Record<string, string | undefined>>;

const digestOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** Development tokens are a development stand-in; production authenticates staff through the institution's SSO. */
export const developmentTokensPermitted = (env: Env = process.env): boolean => deploymentProfile(env) === 'DEVELOPMENT';

/**
 * The development identity a presented token names, or undefined. Every
 * configured token is compared (digest against digest, constant time), with
 * no early exit, so the time taken says nothing about which one matched.
 */
export function developmentStaffFor(presented: string, env: Env = process.env): DevelopmentStaff | undefined {
  if (!developmentTokensPermitted(env)) return undefined;
  const trimmed = presented.trim();
  if (trimmed.length === 0) return undefined;
  const presentedDigest = digestOf(trimmed);
  let found: DevelopmentStaff | undefined;
  for (const staff of DEVELOPMENT_STAFF) {
    const token = env[staff.environmentName]?.trim();
    if (token === undefined || token.length === 0) continue;
    if (timingSafeEqual(digestOf(token), presentedDigest) && found === undefined) found = staff;
  }
  return found;
}

/**
 * The principal a development identity becomes under its tenant's staff
 * identity configuration: the authorities its groups map to. Undefined when the
 * configuration does not parse, when its provider is not the development
 * stand-in, or when it grants the person nothing — a person with no authority
 * does not sign in. A development token is never mapped through a real
 * provider's configuration, even where the group names coincide.
 */
export function principalFor(
  staff: DevelopmentStaff,
  identity: Result<StaffIdentityConfiguration>,
): StaffPrincipal | undefined {
  if (!identity.ok || identity.value.provider.protocol !== 'DEVELOPMENT') return undefined;
  const authorities = authoritiesFor(staff.groups, identity.value);
  if (authorities.length === 0) return undefined;
  return { principalId: staff.principalId, tenantId: staff.tenantId, authorities };
}

/**
 * The principal the origination domain sees: identity, tenant, and the highest
 * approval tier held (absent when the person holds none). The domain applies
 * the tenant's approval tiers and four eyes to this.
 */
export function requestPrincipal(staff: StaffPrincipal): Principal {
  const authority = highestApprovalAuthority(staff.authorities);
  return {
    principalId: staff.principalId,
    tenantId: staff.tenantId,
    ...(authority === undefined ? {} : { authority }),
  };
}

/** The review API's bearer authentication, through the same registry and the same tenant configuration. */
export function authenticateStaff(
  authorization: string | undefined,
  env: Env = process.env,
): StaffPrincipal | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (m === null) return undefined;
  const staff = developmentStaffFor(m[1] ?? '', env);
  if (staff === undefined) return undefined;
  return principalFor(staff, loadStaffIdentity(staff.tenantId, deploymentProfile(env)));
}
