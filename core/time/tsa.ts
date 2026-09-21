/**
 * Trusted time.
 *
 * The risk-holding interval is the difference between two facts about the world,
 * and the Board has to be able to check it without trusting us. So every instant
 * that has contractual effect comes from an RFC 3161 timestamping authority, is
 * retained as a token, and is verifiable against a third party's clock rather than
 * the institution's (SH-06, SDD §3.5.3, §5.6).
 *
 * `TsaInstant` is branded. There is no constructor that takes a server clock
 * reading, so "measure the risk period against `Date.now()`" is not an expedient
 * someone can reach for under deadline — it does not typecheck. The only way to
 * obtain one is to verify a token, and verification lives behind the port below.
 *
 * Note what this module does NOT export: anything resembling `now()`. Core never
 * reads a clock. Callers pass the observed instant in, which is also what makes
 * gate evaluation a pure, replayable function.
 */

declare const tsaBrand: unique symbol;

export interface TsaInstant {
  readonly [tsaBrand]: 'RFC3161';
  /** Seconds since the Unix epoch, as attested by the authority's genTime. */
  readonly epochSeconds: bigint;
  /** Digest of the retained token, so an instant can be traced to its evidence. */
  readonly tokenDigest: string;
  /** Which authority attested it. Retained for the audit pack. */
  readonly authorityId: string;
}

/**
 * The result of verifying a timestamp token. Produced only by the TSA adapter,
 * which checks the signature, the certificate chain and the message imprint.
 * `verified: true` is a literal, so an unverified token cannot be widened into one.
 */
export interface VerifiedTimestamp {
  readonly verified: true;
  readonly genTimeEpochSeconds: bigint;
  readonly tokenDigest: string;
  readonly authorityId: string;
}

/**
 * Port. The implementation is an adapter (SDD INT-10); core only declares the
 * shape. Failure posture is fail-closed: no leg executes without a trusted
 * timestamp (SDD §4.9).
 */
export interface TimestampAuthorityPort {
  /** Stamp a document digest and return the verified attestation. */
  stamp(messageDigest: string): Promise<VerifiedTimestamp>;
  /** Re-verify a retained token, for audit replay. */
  verify(token: Uint8Array): Promise<VerifiedTimestamp>;
}

/** The single constructor. Takes an attestation, never a clock. */
export function tsaInstant(v: VerifiedTimestamp): TsaInstant {
  return {
    epochSeconds: v.genTimeEpochSeconds,
    tokenDigest: v.tokenDigest,
    authorityId: v.authorityId,
  } as TsaInstant;
}

export const isBefore = (a: TsaInstant, b: TsaInstant): boolean => a.epochSeconds < b.epochSeconds;
export const isAfter = (a: TsaInstant, b: TsaInstant): boolean => a.epochSeconds > b.epochSeconds;

/** Strictly later. Leg timestamps are monotonic, never merely non-decreasing. */
export const isStrictlyLater = (later: TsaInstant, earlier: TsaInstant): boolean =>
  later.epochSeconds > earlier.epochSeconds;

export const elapsedSeconds = (from: TsaInstant, to: TsaInstant): bigint =>
  to.epochSeconds - from.epochSeconds;

/**
 * Has the required interval passed between two attested instants?
 *
 * Both arguments are attested. There is no overload taking a number of
 * milliseconds or a `Date`, which is the point.
 */
export function hasElapsed(
  from: TsaInstant,
  requiredSeconds: number,
  observedAt: TsaInstant,
): boolean {
  return elapsedSeconds(from, observedAt) >= BigInt(requiredSeconds);
}
