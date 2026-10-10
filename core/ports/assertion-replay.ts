/**
 * Assertion replay guard.
 *
 * An identity assertion from the national digital identity rail proves a person authenticated once.
 * Accepted twice, it lets whoever captured it sign in or sign as that person
 * again. Each assertion is consumed once per tenant; the adapter is a
 * repository over a table whose primary key is the actual enforcement, so two
 * concurrent consumers cannot both succeed (SR-007).
 */

export interface AssertionUse {
  readonly tenantId: string;
  readonly assertionId: string;
  readonly authenticatedAtEpochSeconds: bigint;
}

export interface AssertionReplayGuard {
  /** FRESH the first time an assertion is presented for a tenant; REPLAYED every time after. */
  consume(use: AssertionUse): Promise<'FRESH' | 'REPLAYED'>;
}

/** In this process's memory: development and tests. A deployment uses the database's. */
export function inMemoryAssertionReplayGuard(): AssertionReplayGuard {
  const seen = new Set<string>();
  return {
    consume(use) {
      const key = `${use.tenantId}\u0000${use.assertionId}`;
      if (seen.has(key)) return Promise.resolve('REPLAYED');
      seen.add(key);
      return Promise.resolve('FRESH');
    },
  };
}
