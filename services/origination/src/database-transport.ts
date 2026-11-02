/**
 * The database connection is encrypted and its certificate verified, or it is
 * not opened (SR-051).
 *
 * node-postgres sends nothing over TLS unless the connection string or the
 * pool asks it to. A deployed process (deploymentProfile) therefore refuses a
 * URL to anything but this machine unless it says `sslmode=verify-full`: the
 * server's certificate chains to a trusted root and names the host. A provider
 * whose root is not public (Supabase's) is trusted by `sslrootcert`, the path
 * of its root certificate in the image (deploy/certs/). A development process
 * may connect to a local container in the clear.
 *
 * The reason names the rule, never the URL: the URL carries a password.
 */

import { deploymentProfile } from './profile.ts';

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export type DatabaseTransportRefusal = 'DATABASE_URL_MALFORMED' | 'DATABASE_TLS_NOT_VERIFIED';

/** Why this URL may not be opened under this profile, or undefined when it may. */
export function databaseTransportRefusal(url: string, env: Env = process.env): DatabaseTransportRefusal | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'DATABASE_URL_MALFORMED';
  }
  if (deploymentProfile(env) === 'DEVELOPMENT') return undefined;
  if (LOOPBACK.has(parsed.hostname)) return undefined;
  return parsed.searchParams.get('sslmode') === 'verify-full' ? undefined : 'DATABASE_TLS_NOT_VERIFIED';
}

export class DatabaseTransportRefused extends Error {
  readonly reason: DatabaseTransportRefusal;
  constructor(reason: DatabaseTransportRefusal) {
    super(
      reason === 'DATABASE_URL_MALFORMED'
        ? 'the database URL is not a URL'
        : 'a deployed process opens the database only over verified TLS (sslmode=verify-full)',
    );
    this.name = 'DatabaseTransportRefused';
    this.reason = reason;
  }
}

/** Throws unless the URL may be opened. Call it before every pool is built from a URL. */
export function assertDatabaseTransport(url: string, env: Env = process.env): void {
  const refusal = databaseTransportRefusal(url, env);
  if (refusal !== undefined) throw new DatabaseTransportRefused(refusal);
}
