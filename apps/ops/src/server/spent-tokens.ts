/**
 * The workbench's spent tokens (SR-030, SR-043): the database's, shared by
 * every replica, when one is configured; else this process's.
 */

import { type SpentTokens, inMemorySpentTokens } from '@sanad/auth/spent-tokens.ts';
import { postgresSpentTokens } from '@sanad/origination/spent-tokens-postgres.ts';

import { persistencePool } from './persistence.ts';

const shared: { tokens?: SpentTokens } = ((
  globalThis as { __sanadOpsSpent?: { tokens?: SpentTokens } }
).__sanadOpsSpent ??= {});

export function spentTokens(): SpentTokens {
  if (shared.tokens !== undefined) return shared.tokens;
  const pool = persistencePool();
  shared.tokens = pool === undefined ? inMemorySpentTokens() : postgresSpentTokens(pool);
  return shared.tokens;
}
