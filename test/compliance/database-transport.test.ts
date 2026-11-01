/**
 * SR-051: a deployed process opens the database only over TLS whose
 * certificate it verifies. Each case attempts a connection a deployed process
 * must refuse, and passes only when it is refused before any pool exists.
 */
import { describe, expect, it } from 'vitest';

import { sharedPool } from '../../services/origination/src/credentials.ts';
import {
  DatabaseTransportRefused,
  assertDatabaseTransport,
  databaseTransportRefusal,
} from '../../services/origination/src/database-transport.ts';

const deployed = { NODE_ENV: 'production' } as const;
const development = { NODE_ENV: 'development' } as const;
const remote = 'postgresql://sanad_runtime.ref:pw@pooler.example.test:5432/postgres';
const root = '/opt/app-root/src/deploy/certs/supabase-root-2021.crt';

describe('The database is reached over verified TLS (SR-051)', () => {
  it('refuses a deployed connection in the clear', () => {
    expect(databaseTransportRefusal(remote, deployed)).toBe('DATABASE_TLS_NOT_VERIFIED');
  });

  it('refuses encryption that does not verify the server', () => {
    for (const mode of ['disable', 'prefer', 'require', 'no-verify', 'verify-ca'])
      expect(databaseTransportRefusal(`${remote}?sslmode=${mode}`, deployed)).toBe('DATABASE_TLS_NOT_VERIFIED');
  });

  it('opens verify-full, with or without a pinned root', () => {
    expect(databaseTransportRefusal(`${remote}?sslmode=verify-full`, deployed)).toBeUndefined();
    expect(
      databaseTransportRefusal(`${remote}?sslmode=verify-full&sslrootcert=${encodeURIComponent(root)}`, deployed),
    ).toBeUndefined();
  });

  it('a local container needs no TLS, and development may connect anywhere', () => {
    expect(databaseTransportRefusal('postgresql://postgres:pw@127.0.0.1:55432/sanad', deployed)).toBeUndefined();
    expect(databaseTransportRefusal('postgresql://postgres:pw@localhost:5432/sanad', deployed)).toBeUndefined();
    expect(databaseTransportRefusal(remote, development)).toBeUndefined();
  });

  it('refuses what is not a URL, and never repeats the URL in the error', () => {
    expect(databaseTransportRefusal('not a url', deployed)).toBe('DATABASE_URL_MALFORMED');
    try {
      assertDatabaseTransport(remote, deployed);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DatabaseTransportRefused);
      expect(String(error)).not.toContain('pw');
      expect(String(error)).not.toContain('pooler.example.test');
    }
  });

  it('the shared pool is never built for a URL the rule refuses', () => {
    const before = process.env['NODE_ENV'];
    (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'production';
    try {
      expect(() => sharedPool(`${remote}?sslmode=require`)).toThrow(DatabaseTransportRefused);
    } finally {
      (process.env as Record<string, string | undefined>)['NODE_ENV'] = before;
    }
  });
});
