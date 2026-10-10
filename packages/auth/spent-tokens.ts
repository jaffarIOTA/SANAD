/**
 * Tokens spent before they expire: a sign-in state consumed, a session signed
 * out. A sealed token is stateless, so without this a copied session cookie
 * stays good until its expiry after sign-out (SR-030), and a copied state
 * cookie opens once per replica (SR-043).
 *
 * Only a SHA-256 digest of the token is kept, under a purpose, until the
 * token's own expiry; after that the seal refuses it anyway. In memory for one
 * process (development, tests); `services/origination/src/spent-tokens-postgres.ts`
 * shares it between replicas (migration 0023).
 */

import { createHash } from 'node:crypto';

export const SPEND_PURPOSES = [
  'ADMIN_OIDC_STATE',
  'OPS_OIDC_STATE',
  'ADMIN_SESSION',
  'OPS_SESSION',
  'CONSUMER_SESSION',
] as const;
export type SpendPurpose = (typeof SPEND_PURPOSES)[number];

export interface SpentTokens {
  /** Spends the token. True if this call spent it, false if it already was: of two at once, one wins. */
  spend(purpose: SpendPurpose, token: string, expiresAtEpochSeconds: bigint): Promise<boolean>;
  isSpent(purpose: SpendPurpose, token: string): Promise<boolean>;
}

export const tokenDigest = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** One process's spent tokens. `now` only prunes: a token past its expiry is refused by its seal. */
export function inMemorySpentTokens(now: () => bigint = () => BigInt(Math.floor(Date.now() / 1000))): SpentTokens {
  const spent = new Map<string, bigint>();
  const key = (purpose: SpendPurpose, token: string): string => `${purpose}:${tokenDigest(token)}`;
  return {
    spend(purpose, token, expiresAt) {
      const t = now();
      for (const [k, exp] of spent) if (exp <= t) spent.delete(k);
      const k = key(purpose, token);
      if (spent.has(k)) return Promise.resolve(false);
      spent.set(k, expiresAt);
      return Promise.resolve(true);
    },
    isSpent(purpose, token) {
      return Promise.resolve(spent.has(key(purpose, token)));
    },
  };
}
