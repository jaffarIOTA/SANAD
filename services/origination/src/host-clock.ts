/**
 * The host clock standing in for a timestamping authority (SR-006).
 *
 * Until an accredited RFC 3161 authority is procured (ClaudeRecommendations
 * E-04), the apps attest instants from this server's clock. That is acceptable
 * only where nothing it attests is relied on as evidence: in development, and
 * on a hosted environment that declares synthetic data (ADR 0004). Anywhere
 * else it refuses, so a real-data deployment cannot run without the authority.
 *
 * Every instant it makes says so: authority `host-clock`, digest
 * `host-clock-<epoch>`, never mistakable for an authority's attestation. It is
 * one of the three places a `TsaInstant` may be constructed; an architecture
 * test holds every other module to `restoreAttestedInstant` or this.
 */

import { type TsaInstant, tsaInstant } from '../../../core/time/tsa.ts';

import { DevelopmentStandInRefused, deploymentProfile, syntheticDataDeclared } from './profile.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const HOST_CLOCK_AUTHORITY = 'host-clock';

export const hostClockPermitted = (env: Env = process.env): boolean =>
  deploymentProfile(env) === 'DEVELOPMENT' || syntheticDataDeclared(env);

/** This server's time now, or at `epochSeconds` (a seed, a strictly-later successor), as a host-clock instant. */
export function hostClockInstant(epochSeconds?: bigint, env: Env = process.env): TsaInstant {
  if (!hostClockPermitted(env)) throw new DevelopmentStandInRefused('hostClockInstant');
  const at = epochSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  return tsaInstant({
    verified: true,
    genTimeEpochSeconds: at,
    tokenDigest: `${HOST_CLOCK_AUTHORITY}-${at.toString()}`,
    authorityId: HOST_CLOCK_AUTHORITY,
  });
}
