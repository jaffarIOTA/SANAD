/**
 * The outcome shape every KSA rail port shares.
 *
 * `UNAVAILABLE` is a value, not an exception: the caller decides what an
 * unavailable rail means for the application (usually `SERVICING_UNAVAILABLE`
 * with the attempt ledger), and nothing downstream can mistake it for an
 * answer. `REFUSED` is the rail declining the request itself — consent not
 * recognised, subject not found — and carries the rail's own code by
 * reference.
 */
export type RailOutcome<T> =
  | { readonly kind: 'ANSWERED'; readonly value: T }
  | { readonly kind: 'REFUSED'; readonly code: string; readonly referenceId?: string }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string; readonly retryAfterSeconds?: number };
