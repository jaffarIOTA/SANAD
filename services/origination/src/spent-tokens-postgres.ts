/**
 * Spent tokens on PostgreSQL (`config.spent_token`, migration 0023; SR-030,
 * SR-043), shared by every replica. Only the digest crosses to the database.
 */

import type { Pool } from 'pg';

import { type SpentTokens, tokenDigest } from '../../../packages/auth/spent-tokens.ts';

export function postgresSpentTokens(pool: Pool): SpentTokens {
  return {
    async spend(purpose, token, expiresAt) {
      const r = await pool.query<{ spent: boolean }>(
        'select config.spend_token($1, $2, to_timestamp($3::bigint)) as spent',
        [purpose, tokenDigest(token), expiresAt.toString()],
      );
      return r.rows[0]?.spent === true;
    },
    async isSpent(purpose, token) {
      const r = await pool.query<{ spent: boolean }>('select config.token_spent($1, $2) as spent', [
        purpose,
        tokenDigest(token),
      ]);
      return r.rows[0]?.spent === true;
    },
  };
}
