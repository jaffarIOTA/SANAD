/**
 * Admin's spent tokens (SR-030, SR-043): the database's, shared by every
 * replica, when one is configured; else this process's.
 */

import { type SpentTokens, inMemorySpentTokens } from '@sanad/auth/spent-tokens.ts';
import { postgresSpentTokens } from '@sanad/origination/spent-tokens-postgres.ts';

import { store } from './credentials.ts';

const shared: { tokens?: SpentTokens } = ((
  globalThis as { __sanadAdminSpent?: { tokens?: SpentTokens } }
).__sanadAdminSpent ??= {});

export function spentTokens(): SpentTokens {
  if (shared.tokens !== undefined) return shared.tokens;
  const s = store();
  shared.tokens = s.kind === 'READY' ? postgresSpentTokens(s.pool) : inMemorySpentTokens();
  return shared.tokens;
}
