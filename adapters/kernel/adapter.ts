/**
 * Adapter base concerns.
 *
 * Every adapter ships with the same five things (SDD §4.5.2, §6.9):
 *   - a capability-named interface it implements, with no vendor vocabulary above it;
 *   - recorded fixtures, so the pipeline tests deterministically and offline;
 *   - a circuit breaker;
 *   - a declared freshness window;
 *   - a declared failure posture.
 *
 * `FailurePosture` is the one that matters most. A compliance dependency fails
 * closed and blocks the transaction; an enrichment dependency degrades and lets
 * the journey continue. Getting these the wrong way round is how a system ends
 * up approving a drawdown it could not screen (AP-07).
 */

import {
  type CredentialProvider,
  type CredentialRef,
  type Environment,
  type SecretValue,
  BoundedCredentialCache,
} from '../../core/ports/credentials.ts';
import type { CredentialProviderName } from '../../core/ports/credentials.ts';
import { CircuitBreaker, type BreakerOptions } from './circuit-breaker.ts';

/** What an adapter provides. One product may satisfy several. */
export type AdapterCapability =
  | 'CORE_BANKING'
  | 'DOCUMENT_RENDERING'
  | 'SIGNING'
  | 'DOCUMENT_INTELLIGENCE'
  | 'E_INVOICING'
  | 'IDENTITY'
  | 'BUSINESS_REGISTRY'
  | 'CREDIT_BUREAU'
  | 'SCREENING'
  | 'TIMESTAMP_AUTHORITY';

export type FailurePosture =
  /** Blocks the transaction. Compliance dependencies never degrade. */
  | 'FAIL_CLOSED'
  /** Serve from cache inside the freshness window, then fail closed. */
  | 'CACHE_THEN_FAIL_CLOSED'
  /** The journey continues with reduced information, flagged for review. */
  | 'DEGRADE'
  /** Persisted to the outbox, retried, reconciled. Never lost, never duplicated. */
  | 'QUEUE_AND_RECONCILE';

export interface AdapterConfig {
  readonly tenantId: string;
  readonly provider: CredentialProviderName;
  readonly environment: Environment;
  /** Seconds a cached response stays usable. Zero means no caching. */
  readonly freshnessWindowSeconds: number;
  readonly failurePosture: FailurePosture;
  /** Bounded. Credentials do not outlive the adapter that needed them. */
  readonly credentialTtlSeconds: number;
  readonly breaker: Omit<BreakerOptions, 'nowEpochSeconds'>;
  readonly nowEpochSeconds: () => number;
}

/**
 * A recorded, known deviation between what the platform's domain model expresses
 * and what a vendor's API requires.
 *
 * Deviations are declared in code so they appear in a review, and explained in
 * the adapter's README so they appear in an audit. The rule they exist to serve:
 * a vendor concept may be satisfied at the boundary, but it does not propagate
 * inward (SDD §6.9).
 */
export interface KnownDeviation {
  readonly id: string;
  readonly summary: string;
  /** Why this does not leak the concept into the domain model. */
  readonly containment: string;
  /** The open item tracking its resolution, where one exists. */
  readonly verificationRef?: string;
}

export abstract class BaseAdapter {
  protected readonly breaker: CircuitBreaker;
  readonly #credentials: CredentialProvider;
  readonly #cache: BoundedCredentialCache;

  abstract readonly vendorName: string;
  abstract readonly capabilities: readonly AdapterCapability[];
  abstract readonly deviations: readonly KnownDeviation[];

  constructor(
    protected readonly config: AdapterConfig,
    credentials: CredentialProvider,
  ) {
    this.#credentials = credentials;
    this.#cache = new BoundedCredentialCache(config.credentialTtlSeconds);
    this.breaker = new CircuitBreaker(`${config.provider}:${config.environment}`, {
      ...config.breaker,
      nowEpochSeconds: config.nowEpochSeconds,
    });
  }

  /**
   * Resolve a credential, cached for a bounded TTL.
   *
   * The returned value redacts itself on `toString` and `toJSON`. Getting the
   * plaintext out needs an explicit `.expose()` call, which is greppable in
   * review — and must never appear inside a log, trace or metric expression.
   */
  protected async credential(keyName: string, correlationId: string): Promise<SecretValue> {
    const ref: CredentialRef = {
      tenantId: this.config.tenantId,
      provider: this.config.provider,
      environment: this.config.environment,
      keyName,
    };
    const now = this.config.nowEpochSeconds();
    const cached = this.#cache.get(ref, now);
    if (cached !== undefined) return cached;

    const fetched = await this.#credentials.get(ref, correlationId);
    this.#cache.put(ref, fetched, now);
    return fetched;
  }

  /** Called on disposal. Credentials do not linger after the adapter is done. */
  dispose(): void {
    this.#cache.clear();
  }
}

/**
 * Strip anything that must never reach a log sink, a trace span or a metric
 * label: credential material, national identifiers, and CR-linked personal data
 * (CLAUDE.md §10, SDD §4.10).
 *
 * Applied at the adapter boundary, on the way out, so redaction is not something
 * each call site has to remember.
 */
const REDACT_KEYS = /(secret|token|password|authorization|credential|nationalId|iqama|nin)/i;

export function redactForLogging(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limited]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactForLogging(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_KEYS.test(key) ? '[redacted]' : redactForLogging(v, depth + 1);
  }
  return out;
}
