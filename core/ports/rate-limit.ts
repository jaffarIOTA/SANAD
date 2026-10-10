/**
 * Request rate limits (SR-031): how many requests a principal, and a tenant
 * as a whole, may make in a window. The gateway's plans limit each client at
 * the edge; the service limits again, because it does not take the gateway's
 * word for anything (CLAUDE.md §8).
 *
 * A port: the counter store is an adapter (shared between replicas), or this
 * process's in development. A limit names a key built from the authenticated
 * principal and tenant only: never a body field, never a personal datum.
 */

export interface RateLimit {
  /** At most this many requests ... */
  readonly limit: number;
  /** ... in a fixed window of this many seconds. */
  readonly windowSeconds: number;
}

export type RateDecision =
  | { readonly kind: 'ALLOWED'; readonly remaining: number }
  | { readonly kind: 'LIMITED'; readonly retryAfterSeconds: number }
  /** The counter store did not answer. The caller admits the request: a limiter outage is not an outage. */
  | { readonly kind: 'UNAVAILABLE' };

export interface RateLimitPort {
  /** Count one request against `key` and say whether it is within the limit. */
  take(key: string, limit: RateLimit): Promise<RateDecision>;
}
