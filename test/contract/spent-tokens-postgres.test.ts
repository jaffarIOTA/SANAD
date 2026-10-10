/**
 * SR-030, SR-043: spent tokens on PostgreSQL are shared between replicas. Two
 * pools stand for two app instances: a state consumed through one is refused
 * through the other, of two consuming at once exactly one wins, and a session
 * signed out on one is spent on the other. Only digests are stored.
 * Runs with SANAD_TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { tokenDigest } from '../../packages/auth/spent-tokens.ts';
import { stateReplayGuard } from '../../packages/auth/staff-oidc.ts';
import { postgresSpentTokens } from '../../services/origination/src/spent-tokens-postgres.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];

describe.skipIf(url === undefined)('spent tokens shared by every replica (SR-030, SR-043)', () => {
  let one: Pool;
  let two: Pool;
  beforeAll(() => {
    one = new Pool({ connectionString: url, max: 4 });
    two = new Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    await Promise.all([one.end(), two.end()]);
  });

  const inTenMinutes = () => BigInt(Math.floor(Date.now() / 1000) + 600);

  it('refuses on a second instance a state consumed on the first', async () => {
    const state = `state-${randomUUID()}`;
    const first = stateReplayGuard(postgresSpentTokens(one), 'OPS');
    const second = stateReplayGuard(postgresSpentTokens(two), 'OPS');
    expect(await first.consume(state, inTenMinutes())).toBe(true);
    expect(await second.consume(state, inTenMinutes())).toBe(false);
    // Purposes are apart: the same string as an Admin state is its own.
    expect(await stateReplayGuard(postgresSpentTokens(two), 'ADMIN').consume(state, inTenMinutes())).toBe(true);
  });

  it('lets exactly one of several concurrent consumers win', async () => {
    const state = `state-${randomUUID()}`;
    const guards = [one, two, one, two, one, two].map((p) => stateReplayGuard(postgresSpentTokens(p), 'ADMIN'));
    const won = await Promise.all(guards.map((g) => g.consume(state, inTenMinutes())));
    expect(won.filter(Boolean)).toHaveLength(1);
  });

  it('sees on one instance a session signed out on another, and keeps only its digest', async () => {
    const session = `v1.session-${randomUUID()}`;
    expect(await postgresSpentTokens(two).isSpent('CONSUMER_SESSION', session)).toBe(false);
    await postgresSpentTokens(one).spend('CONSUMER_SESSION', session, inTenMinutes());
    expect(await postgresSpentTokens(two).isSpent('CONSUMER_SESSION', session)).toBe(true);
    const stored = await one.query<{ token_digest: string }>(
      'select token_digest from config.spent_token where token_digest = $1',
      [tokenDigest(session)],
    );
    expect(stored.rows).toHaveLength(1);
    const raw = await one.query("select 1 from config.spent_token where token_digest like 'v1.%'");
    expect(raw.rows).toHaveLength(0);
  });

  it('prunes what has expired, and is reachable by no hosted role', async () => {
    const old = `v1.expired-${randomUUID()}`;
    await postgresSpentTokens(one).spend('OPS_SESSION', old, BigInt(Math.floor(Date.now() / 1000) - 1));
    await postgresSpentTokens(one).spend('OPS_SESSION', `v1.trigger-${randomUUID()}`, inTenMinutes());
    expect(await postgresSpentTokens(one).isSpent('OPS_SESSION', old)).toBe(false);
    const grants = await one.query<{ grantee: string }>(
      `select grantee from information_schema.role_table_grants
        where table_schema = 'config' and table_name = 'spent_token' and grantee <> current_user`,
    );
    expect(grants.rows).toEqual([]);
  });
});
