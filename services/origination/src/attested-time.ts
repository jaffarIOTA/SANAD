/**
 * Where a tenant's attested instants come from (SR-006, SH-06).
 *
 * - The tenant's TIMESTAMP_AUTHORITY rail is enabled: its RFC 3161 authority,
 *   and nothing else. If the authority is down or its token does not verify,
 *   there is no instant and the step refuses: a rail down never stands in for
 *   one that is up, and the host clock never stands in for the authority.
 * - It is not enabled: the labelled host clock, where that is permitted
 *   (development, or a declared-synthetic deployment).
 * - Neither: no instant at all.
 *
 * The authority's endpoint, its name, the certificates the institution trusts
 * for it and its policy are the rail's vault entry (provider TSA):
 * `endpoint_url`, `authority_id`, `trust_anchors_pem`, and optionally
 * `policy_oid` and `authorization`. Reading them is audited by the vault.
 *
 * This is one of the places a `TsaInstant` is made (test/compliance/attested-time.test.ts).
 */

import { X509Certificate, createHash } from 'node:crypto';

import { ADAPTER_CATALOGUE } from '../../../adapters/catalogue.ts';
import { HttpTsaTransport, Rfc3161TimestampAuthority, type TsaTransport } from '../../../adapters/tsa/adapter.ts';
import { type TenantCode, loadRailsConfiguration } from '../../../config/loader.ts';
import type { CredentialProvider, Environment } from '../../../core/ports/credentials.ts';
import { type TimestampAuthorityPort, type TsaInstant, tsaInstant } from '../../../core/time/tsa.ts';

import { credentialProviderFromEnvironment } from './credentials.ts';
import { hostClockInstant, hostClockPermitted } from './host-clock.ts';
import { resolveRailsConfiguration } from './rails.ts';

type Env = Readonly<Record<string, string | undefined>>;

/** An attested instant, and the token that proves it when an authority made it. */
export interface Attestation {
  readonly instant: TsaInstant;
  readonly token?: Uint8Array;
}

export interface TimeSource {
  readonly kind: 'AUTHORITY' | 'HOST_CLOCK' | 'NONE';
  /** An instant attested over `messageDigest` (SHA-256 hex); undefined when none can be had. */
  attest(messageDigest: string): Promise<Attestation | undefined>;
  /** The authority itself, for re-verifying retained tokens; absent for the host clock. */
  readonly authority?: Pick<TimestampAuthorityPort, 'verify'>;
}

/** No instant could be attested: the step that needed one is refused, nothing written. */
export class TimestampUnavailable extends Error {
  constructor(readonly sourceKind: TimeSource['kind']) {
    super(`no attested instant is available (${sourceKind})`);
    this.name = 'TimestampUnavailable';
  }
}

/** A step's own digest when it attests no artefact: unique to the step, so no token can serve two. */
export const stepDigest = (...parts: readonly string[]): string =>
  createHash('sha256')
    .update(JSON.stringify(['sanad-step-v1', ...parts]), 'utf8')
    .digest('hex');

const HOST_CLOCK: TimeSource = {
  kind: 'HOST_CLOCK',
  attest: () => Promise.resolve({ instant: hostClockInstant() }),
};
const NONE: TimeSource = { kind: 'NONE', attest: () => Promise.resolve(undefined) };

/** An authority as a time source: each attestation its own stamped, verified token. */
export function authorityTimeSource(authority: TimestampAuthorityPort): TimeSource {
  return {
    kind: 'AUTHORITY',
    authority,
    async attest(messageDigest) {
      const stamped = await authority.stamp(messageDigest);
      if (stamped === undefined) return undefined;
      return { instant: tsaInstant(stamped), token: stamped.token };
    },
  };
}

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** The authority configured in the vault for this tenant, or undefined when its entry is incomplete. */
export async function authorityFromVault(
  tenant: TenantCode,
  environment: Environment,
  vault: CredentialProvider,
  options: { readonly fetchImpl?: typeof fetch; readonly transport?: TsaTransport } = {},
): Promise<Rfc3161TimestampAuthority | undefined> {
  const read = async (keyName: string): Promise<string | undefined> => {
    try {
      const v = await vault.get(
        { tenantId: tenant, provider: 'TIMESTAMP_AUTHORITY', environment, keyName },
        'timestamp-authority',
      );
      return v.expose();
    } catch {
      return undefined;
    }
  };
  const [endpoint, authorityId, anchorsPem, policy, authorization] = await Promise.all([
    read('endpoint_url'),
    read('authority_id'),
    read('trust_anchors_pem'),
    read('policy_oid'),
    read('authorization'),
  ]);
  if (authorityId === undefined || anchorsPem === undefined) return undefined;
  const transport =
    options.transport ??
    (endpoint === undefined
      ? undefined
      : new HttpTsaTransport(endpoint, authorization === undefined ? {} : { authorization }, options.fetchImpl));
  if (transport === undefined) return undefined;
  const trustAnchors = (anchorsPem.match(PEM) ?? []).map((pem) => new X509Certificate(pem));
  if (trustAnchors.length === 0) return undefined;
  return new Rfc3161TimestampAuthority({
    authorityId,
    transport,
    trustAnchors,
    ...(policy === undefined ? {} : { policy }),
    nowEpochSeconds: () => Math.floor(Date.now() / 1000),
  });
}

/** One authority per tenant per process, so its breaker remembers. */
const CACHE = Symbol.for('sanad.origination.timestampAuthorities');
const cached = (): Map<string, TimeSource> => {
  const g = globalThis as { [CACHE]?: Map<string, TimeSource> };
  g[CACHE] ??= new Map();
  return g[CACHE];
};

/** Forget every cached authority: after a credential or rail change, and between tests. */
export const resetTimeSources = (): void => {
  cached().clear();
  overrides().clear();
};

/** A source set for a tenant by a test, consulted before the rail. Never set outside tests. */
const OVERRIDES = Symbol.for('sanad.origination.timeSourceOverrides');
const overrides = (): Map<string, TimeSource> => {
  const g = globalThis as { [OVERRIDES]?: Map<string, TimeSource> };
  g[OVERRIDES] ??= new Map();
  return g[OVERRIDES];
};

/** Tests only: answer `tenant`'s attestations from `source` until `resetTimeSources`. */
export function useTimeSourceForTests(tenant: TenantCode, source: TimeSource, env: Env = process.env): void {
  if (env['NODE_ENV'] !== 'test') throw new Error('a time source is overridden only in tests');
  overrides().set(tenant, source);
}

/** The tenant's time source, decided by its TIMESTAMP_AUTHORITY rail (see the header). */
export async function timeSourceFor(
  tenant: TenantCode,
  env: Env = process.env,
  vault?: CredentialProvider,
): Promise<TimeSource> {
  const overridden = overrides().get(tenant);
  if (overridden !== undefined) return overridden;
  // Which configuration is in force is an operational lookup, not an attested fact.
  const resolved = await resolveRailsConfiguration(tenant, BigInt(Math.floor(Date.now() / 1000))).catch(() => ({
    rails: loadRailsConfiguration(tenant, ADAPTER_CATALOGUE),
  }));
  const rail = resolved.rails.ok
    ? resolved.rails.value.rails.find((r) => r.capability === 'TIMESTAMP_AUTHORITY')
    : undefined;
  if (rail?.enabled !== true) return hostClockPermitted(env) ? HOST_CLOCK : NONE;
  const key = `${tenant}:${rail.environment}`;
  const hit = cached().get(key);
  if (hit !== undefined) return hit;
  const authority = await authorityFromVault(tenant, rail.environment, vault ?? credentialProviderFromEnvironment(env));
  if (authority === undefined) return NONE;
  const source = authorityTimeSource(authority);
  cached().set(key, source);
  return source;
}
