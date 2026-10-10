/**
 * The deployment profile, and the guard every development stand-in calls.
 *
 * Anything but development is DEPLOYED: `NODE_ENV=production` (which every
 * built Next app and container sets) or `SANAD_DEPLOYMENT_PROFILE=DEPLOYED`.
 * Under it a development stand-in (environment tokens, host-clock timestamps,
 * fabricated snapshots, dispatch ports that report delivery without
 * delivering) refuses to be constructed, so production wiring either supplies
 * the real dependency or does not start (SR-004).
 *
 * The one exception is the consumer demonstration sign-in on a hosted
 * environment that holds synthetic data only (ADR 0004). It needs two
 * independent declarations: `SANAD_DATA_CLASS=SYNTHETIC` on the process and a
 * database whose `config.deployment_profile` says it is not cleared for
 * production data. Either missing, it is refused (SR-005).
 */

import type { Pool } from 'pg';

import type { DeploymentProfile } from '../../../core/config/staff-identity.ts';

type Env = Readonly<Record<string, string | undefined>>;

export function deploymentProfile(env: Env = process.env): DeploymentProfile {
  return env['NODE_ENV'] === 'production' || env['SANAD_DEPLOYMENT_PROFILE'] === 'DEPLOYED'
    ? 'DEPLOYED'
    : 'DEVELOPMENT';
}

export class DevelopmentStandInRefused extends Error {
  readonly standIn: string;
  constructor(standIn: string) {
    super(`${standIn} is a development stand-in and is refused under a deployed profile`);
    this.name = 'DevelopmentStandInRefused';
    this.standIn = standIn;
  }
}

/** Throws unless this process runs under the development profile. Call it first in every development factory. */
export function refuseUnderDeployedProfile(standIn: string, env: Env = process.env): void {
  if (deploymentProfile(env) !== 'DEVELOPMENT') throw new DevelopmentStandInRefused(standIn);
}

/** The process's own declaration that it serves synthetic data only. Necessary, never sufficient. */
export const syntheticDataDeclared = (env: Env = process.env): boolean => env['SANAD_DATA_CLASS'] === 'SYNTHETIC';

/**
 * Whether the database says it is not cleared for production data (migration
 * 0005). Unreadable, absent, or cleared for production: no.
 */
export async function databaseHoldsSyntheticDataOnly(pool: Pool): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ production_data_permitted: boolean }>(
      'select production_data_permitted from config.deployment_profile limit 1',
    );
    const row = rows[0];
    return row !== undefined && row.production_data_permitted === false;
  } catch {
    return false;
  }
}

/**
 * Whether a demonstration stand-in may run: always in development; under a
 * deployed profile only when the process declares synthetic data and the
 * database confirms it. Without a database a deployed process cannot confirm.
 */
export async function syntheticDemonstrationPermitted(
  pool: Pool | undefined,
  env: Env = process.env,
): Promise<boolean> {
  if (deploymentProfile(env) === 'DEVELOPMENT') return true;
  if (!syntheticDataDeclared(env) || pool === undefined) return false;
  return databaseHoldsSyntheticDataOnly(pool);
}
