/**
 * The timestamping authority adapter (SDD INT-10, SR-006): RFC 3161 over HTTP.
 *
 * `stamp` sends a TimeStampReq for a SHA-256 digest with a fresh nonce, and
 * returns the attestation only once the token has passed every check in
 * `rfc3161.ts`; `verify` re-checks a retained token for audit replay. Either
 * way a failure is `undefined`, never a guess and never an exception the
 * caller has to classify: no leg executes without a trusted time (SDD §4.9).
 * Why a token was refused is counted here, not returned (SR-008).
 *
 * The transport is the authority's HTTP endpoint, behind a circuit breaker and
 * the institution's forward proxy (an injected fetch). Which authority, and
 * which certificates the institution trusts for it, are configuration: E-04
 * names no accredited authority yet, so no tenant configures one.
 */

import { randomBytes, type X509Certificate } from 'node:crypto';

import type { StampedTimestamp, TimestampAuthorityPort, VerifiedTimestamp } from '../../core/time/tsa.ts';
import { CircuitBreaker } from '../kernel/circuit-breaker.ts';
import { TransportError } from '../kernel/http-transport.ts';

import { type TokenFailure, timestampRequest, tokenFromResponse, verifyToken } from './rfc3161.ts';

/** One request out, one response back, as DER. */
export interface TsaTransport {
  exchange(request: Uint8Array): Promise<Uint8Array>;
}

/** RFC 3161 §3.4: `application/timestamp-query` in, `application/timestamp-reply` out. */
export class HttpTsaTransport implements TsaTransport {
  constructor(
    private readonly url: string,
    private readonly headers: Readonly<Record<string, string>> = {},
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15_000,
  ) {
    if (!/^https:\/\/[^/\s]+/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url))
      throw new TransportError('tsa', undefined, 'the authority is reached over HTTPS only');
  }

  async exchange(request: Uint8Array): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/timestamp-query', ...this.headers },
        body: request,
        signal: controller.signal,
      });
      if (!response.ok) throw new TransportError('tsa', response.status, `tsa: HTTP ${String(response.status)}`);
      if (!/application\/timestamp-reply/i.test(response.headers.get('content-type') ?? ''))
        throw new TransportError('tsa', response.status, 'tsa: not a timestamp reply');
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError('tsa', undefined, `tsa: ${error instanceof Error ? error.name : 'transport failure'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface TsaAuthorityConfig {
  /** How the authority is named on every instant it attests, e.g. the institution's chosen provider. */
  readonly authorityId: string;
  readonly transport: TsaTransport;
  readonly trustAnchors: readonly X509Certificate[];
  /** The policy the institution requires, when it names one. */
  readonly policy?: string;
  /** The breaker's clock: operational, never an attested instant. */
  readonly nowEpochSeconds: () => number;
  /** A fresh 64-bit nonce per request; injectable for tests. */
  readonly nonce?: () => bigint;
}

const randomNonce = (): bigint => BigInt(`0x${randomBytes(8).toString('hex')}`) | 1n;

export class Rfc3161TimestampAuthority implements TimestampAuthorityPort {
  /** Refusals by reason, for operations; never returned to a caller. */
  readonly refusals = new Map<TokenFailure | 'UNAVAILABLE' | 'NOT_GRANTED', number>();
  private readonly breaker: CircuitBreaker;

  constructor(private readonly config: TsaAuthorityConfig) {
    if (config.trustAnchors.length === 0) throw new Error('a timestamping authority needs at least one trust anchor');
    this.breaker = new CircuitBreaker(`tsa:${config.authorityId}`, {
      failureThreshold: 3,
      resetAfterSeconds: 30,
      successThreshold: 1,
      nowEpochSeconds: config.nowEpochSeconds,
    });
  }

  private refused(reason: TokenFailure | 'UNAVAILABLE' | 'NOT_GRANTED'): undefined {
    this.refusals.set(reason, (this.refusals.get(reason) ?? 0) + 1);
    return undefined;
  }

  async stamp(messageDigest: string): Promise<StampedTimestamp | undefined> {
    const nonce = (this.config.nonce ?? randomNonce)();
    let response: Uint8Array;
    try {
      const request = timestampRequest(messageDigest, nonce, this.config.policy);
      response = await this.breaker.execute(() => this.config.transport.exchange(request));
    } catch {
      return this.refused('UNAVAILABLE');
    }
    const token = tokenFromResponse(response);
    if (token === 'NOT_GRANTED') return this.refused('NOT_GRANTED');
    if (token === 'MALFORMED') return this.refused('MALFORMED');
    const verified = this.check(token, messageDigest, nonce);
    return verified === undefined ? undefined : { ...verified, token };
  }

  verify(token: Uint8Array, messageDigest: string): Promise<VerifiedTimestamp | undefined> {
    return Promise.resolve(this.check(token, messageDigest, undefined));
  }

  private check(token: Uint8Array, messageDigest: string, nonce: bigint | undefined): VerifiedTimestamp | undefined {
    const verdict = verifyToken(token, {
      messageDigest,
      trustAnchors: this.config.trustAnchors,
      ...(nonce === undefined ? {} : { nonce }),
      ...(this.config.policy === undefined ? {} : { policy: this.config.policy }),
    });
    if (!verdict.accepted) return this.refused(verdict.reason);
    const { genTimeEpochSeconds, tokenDigest } = verdict.token;
    return { verified: true, genTimeEpochSeconds, tokenDigest, authorityId: this.config.authorityId };
  }
}
