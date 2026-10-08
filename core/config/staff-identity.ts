/**
 * Staff identity: who the institution's identity provider says a member of
 * staff is, and what the platform lets them do with it.
 *
 * The configuration names the provider (SAML or OIDC; a development stand-in
 * only where the deployment profile allows it), and maps the provider's
 * groups to the platform's authorities — MAKER, the approval tiers the
 * origination policy already defines, and PLATFORM_ADMIN. No secret lives
 * here: a client secret or signing certificate is a credential in the vault.
 * The provider informs who a person is; the mapping decides what they may do;
 * four eyes is still applied per request, by identity, not by role.
 */

import { APPROVAL_AUTHORITIES, type ApprovalAuthority } from '../origination/policy.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

/**
 * FINANCE releases a disbursement instruction. It is not an approval authority:
 * a finance user approves nothing, and an approver releases no money (four eyes
 * between the decision and the payment).
 */
export type StaffAuthority = 'MAKER' | ApprovalAuthority | 'FINANCE' | 'PLATFORM_ADMIN';
export const STAFF_AUTHORITIES: readonly StaffAuthority[] = ['MAKER', ...APPROVAL_AUTHORITIES, 'FINANCE', 'PLATFORM_ADMIN'];

export type IdentityProtocol = 'SAML' | 'OIDC' | 'DEVELOPMENT';

export interface IdentityProvider {
  readonly protocol: IdentityProtocol;
  /** SAML entity id or OIDC issuer. */
  readonly issuer: string;
  /** SAML metadata URL or OIDC discovery URL. TLS only. */
  readonly metadataUrl?: string;
  /** OIDC client identifier. Not a secret; the secret is in the vault. */
  readonly clientId?: string;
  /** The claim or attribute that carries group membership. */
  readonly groupsClaim: string;
}

export interface AuthorityMapping {
  readonly group: string;
  readonly authority: StaffAuthority;
}

export interface StaffIdentityConfiguration {
  readonly version: string;
  readonly provider: IdentityProvider;
  readonly mappings: readonly AuthorityMapping[];
  /** A staff session ends this long after sign-in, whatever the activity. */
  readonly sessionLifetimeSeconds: number;
  /** An approval requires a fresh authentication within this window, when set. */
  readonly stepUpForApprovalSeconds?: number;
}

/** Where the configuration will run. A development stand-in provider is refused anywhere but development. */
export type DeploymentProfile = 'DEVELOPMENT' | 'DEPLOYED';

export const MAX_SESSION_LIFETIME_SECONDS = 3_600;

const TOP_KEYS = new Set(['version', 'provider', 'mappings', 'sessionLifetimeSeconds', 'stepUpForApprovalSeconds']);
const PROVIDER_KEYS = new Set(['protocol', 'issuer', 'metadataUrl', 'clientId', 'groupsClaim']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const bad = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> => reject('OP-DETERMINACY', reason, detail, context);
const text = (v: unknown, max = 400): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function parseStaffIdentity(raw: unknown, profile: DeploymentProfile): Result<StaffIdentityConfiguration> {
  if (!isRecord(raw)) return bad('IDENTITY_MALFORMED', 'The staff identity configuration is an object');
  const unknownTop = Object.keys(raw).filter((k) => !TOP_KEYS.has(k));
  if (unknownTop.length > 0) return bad('IDENTITY_UNKNOWN_KEY', 'Unknown key in the staff identity configuration', { keys: unknownTop.join(',') });
  if (!text(raw['version'], 40)) return bad('IDENTITY_VERSION_REQUIRED', 'The configuration carries a version');
  const p = raw['provider'];
  if (!isRecord(p)) return bad('IDENTITY_PROVIDER_REQUIRED', 'provider is an object');
  const unknownP = Object.keys(p).filter((k) => !PROVIDER_KEYS.has(k));
  if (unknownP.length > 0) return bad('IDENTITY_PROVIDER_UNKNOWN_KEY', 'Unknown key in provider; a secret never belongs here', { keys: unknownP.join(',') });
  const protocol = p['protocol'];
  if (protocol !== 'SAML' && protocol !== 'OIDC' && protocol !== 'DEVELOPMENT') return bad('IDENTITY_PROTOCOL_UNKNOWN', 'protocol is SAML, OIDC or DEVELOPMENT');
  if (protocol === 'DEVELOPMENT' && profile !== 'DEVELOPMENT') return bad('IDENTITY_DEVELOPMENT_PROVIDER_REFUSED', 'A deployed environment authenticates staff through the institution’s identity provider, never a development stand-in', { profile });
  if (!text(p['issuer'], 400)) return bad('IDENTITY_ISSUER_REQUIRED', 'The provider’s issuer or entity id is required');
  const metadataUrl = p['metadataUrl'];
  if (protocol !== 'DEVELOPMENT') {
    if (typeof metadataUrl !== 'string' || !/^https:\/\/[^\s]+$/.test(metadataUrl)) return bad('IDENTITY_METADATA_URL_REQUIRED', 'SAML metadata or OIDC discovery is fetched over TLS', { protocol });
    if (protocol === 'OIDC' && !text(p['clientId'], 200)) return bad('IDENTITY_CLIENT_ID_REQUIRED', 'An OIDC provider needs the client identifier (the secret goes to the vault)');
  } else if (metadataUrl !== undefined) {
    return bad('IDENTITY_DEVELOPMENT_NO_METADATA', 'The development stand-in has no metadata');
  }
  if (!text(p['groupsClaim'], 100)) return bad('IDENTITY_GROUPS_CLAIM_REQUIRED', 'The claim that carries group membership is named');
  const m = raw['mappings'];
  if (!Array.isArray(m) || m.length === 0) return bad('IDENTITY_MAPPINGS_REQUIRED', 'At least one group maps to an authority');
  const mappings: AuthorityMapping[] = [];
  const seenGroups = new Set<string>();
  for (const [i, entry] of m.entries()) {
    const at = { index: String(i) };
    if (!isRecord(entry) || !text(entry['group'], 200) || typeof entry['authority'] !== 'string') return bad('IDENTITY_MAPPING_MALFORMED', 'A mapping is { group, authority }', at);
    if (!STAFF_AUTHORITIES.includes(entry['authority'] as StaffAuthority)) return bad('IDENTITY_AUTHORITY_UNKNOWN', 'authority is one the platform defines', { ...at, authority: entry['authority'], allowed: STAFF_AUTHORITIES.join(',') });
    const group = entry['group'].trim();
    if (seenGroups.has(group)) return bad('IDENTITY_GROUP_MAPPED_TWICE', 'A group maps to one authority; a person holding two authorities belongs to two groups', { ...at, group });
    seenGroups.add(group);
    mappings.push({ group, authority: entry['authority'] as StaffAuthority });
  }
  const mapped = new Set(mappings.map((x) => x.authority));
  for (const required of ['MAKER', 'CHECKER'] as const) {
    if (!mapped.has(required)) return bad('IDENTITY_AUTHORITY_UNMAPPED', 'Maker and checker must each be reachable, or nothing can be keyed and approved', { authority: required });
  }
  const life = raw['sessionLifetimeSeconds'];
  if (typeof life !== 'number' || !Number.isInteger(life) || life <= 0 || life > MAX_SESSION_LIFETIME_SECONDS) return bad('IDENTITY_SESSION_LIFETIME', `sessionLifetimeSeconds is a whole number of seconds, at most ${String(MAX_SESSION_LIFETIME_SECONDS)}`);
  const step = raw['stepUpForApprovalSeconds'];
  if (step !== undefined && (typeof step !== 'number' || !Number.isInteger(step) || step <= 0 || step > life)) return bad('IDENTITY_STEP_UP_WINDOW', 'stepUpForApprovalSeconds is a whole number of seconds no longer than the session');
  return ok({
    version: raw['version'],
    provider: { protocol, issuer: p['issuer'].trim(), groupsClaim: (p['groupsClaim'] as string).trim(), ...(typeof metadataUrl === 'string' ? { metadataUrl } : {}), ...(typeof p['clientId'] === 'string' ? { clientId: p['clientId'].trim() } : {}) },
    mappings,
    sessionLifetimeSeconds: life,
    ...(typeof step === 'number' ? { stepUpForApprovalSeconds: step } : {}),
  });
}

/** The authorities a person holds, from the groups the provider asserted. Unknown groups confer nothing. */
export function authoritiesFor(groups: readonly string[], c: StaffIdentityConfiguration): readonly StaffAuthority[] {
  const held = new Set<StaffAuthority>();
  for (const g of groups) { const m = c.mappings.find((x) => x.group === g); if (m !== undefined) held.add(m.authority); }
  return STAFF_AUTHORITIES.filter((a) => held.has(a));
}

/**
 * The highest approval tier among the authorities a person holds, for the
 * request-level approval check; undefined when they hold none (MAKER, FINANCE
 * and PLATFORM_ADMIN approve nothing).
 */
export function highestApprovalAuthority(held: readonly StaffAuthority[]): ApprovalAuthority | undefined {
  let top: ApprovalAuthority | undefined;
  for (const a of APPROVAL_AUTHORITIES) if (held.includes(a)) top = a;
  return top;
}
