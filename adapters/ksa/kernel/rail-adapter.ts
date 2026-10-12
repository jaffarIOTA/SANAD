/**
 * The base every KSA rail adapter shares (CLAUDE.md §5).
 *
 * One `invoke`: fetch the credential from the vault (cached, bounded),
 * call through the circuit breaker, and turn every failure into a typed
 * `RailOutcome` — `UNAVAILABLE` for anything the rail did not answer,
 * `REFUSED` for a 4xx it did. Nothing throws past this class, and no
 * response body travels further than the adapter that mapped it.
 */

import { type AdapterConfig, BaseAdapter } from '../../kernel/adapter.ts';
import { CircuitOpenError } from '../../kernel/circuit-breaker.ts';
import { type RailTransport, TransportError } from '../../kernel/http-transport.ts';
import type { ConsentType } from '../../../core/consent/consent.ts';
import type { AssertionReplayGuard } from '../../../core/ports/assertion-replay.ts';
import type { ConsentLedger } from '../../../core/ports/consent-ledger.ts';
import type { CredentialProvider } from '../../../core/ports/credentials.ts';
import type { RailOutcome } from '../../../core/ports/rail.ts';
import { type Result, reject, ok } from '../../../core/kernel/result.ts';

export interface RailAdapterConfig extends AdapterConfig {
  readonly baseUrl: string;
  /** The vault key name for this rail's credential. */
  readonly credentialKeyName?: string;
  /** Where a consent-gated rail checks the consent it is given. Absent: every consent-gated call is refused. */
  readonly consents?: ConsentLedger;
  /** Identity rails: each assertion is accepted once per tenant. Absent: every confirmation is refused (SR-007). */
  readonly assertionReplay?: AssertionReplayGuard;
  /** Identity rails: an assertion older than this is refused. Defaults to the 300-second step-up window. */
  readonly maxAssertionAgeSeconds?: number;
}

/** How far ahead of this server's clock a provider's completion time may be, for clock skew. */
const ASSERTION_CLOCK_SKEW_SECONDS = 120n;

export type Body = Readonly<Record<string, unknown>>;

export abstract class RailAdapter extends BaseAdapter {
  constructor(
    protected override readonly config: RailAdapterConfig,
    credentials: CredentialProvider,
    protected readonly transport: RailTransport,
  ) {
    super(config, credentials);
  }

  protected async invoke(
    operation: string,
    request: {
      readonly method: 'GET' | 'POST' | 'PUT';
      readonly path: string;
      readonly body?: Body;
      /** Rail-specific headers (a standard's interaction id, a consent binding). They never replace the credential or the correlation id. */
      readonly headers?: Readonly<Record<string, string>>;
    },
    correlationId: string,
  ): Promise<RailOutcome<Body>> {
    let secret;
    try {
      secret = await this.credential(this.config.credentialKeyName ?? 'api_key', correlationId);
    } catch {
      return { kind: 'UNAVAILABLE', reason: 'credential unavailable' };
    }
    try {
      const value = await this.breaker.execute(() =>
        this.transport.call(operation, {
          method: request.method,
          url: `${this.config.baseUrl}${request.path}`,
          ...(request.body === undefined ? {} : { body: request.body }),
          // The secret is exposed here and nowhere else in the adapter.
          headers: {
            // Only x- headers, and never the correlation id: a rail header cannot stand in for the credential.
            ...Object.fromEntries(
              Object.entries(request.headers ?? {}).filter(
                ([k]) => /^x-/i.test(k) && k.toLowerCase() !== 'x-correlation-id',
              ),
            ),
            authorization: `Bearer ${secret.expose()}`,
            'x-correlation-id': correlationId,
          },
        }),
      );
      return { kind: 'ANSWERED', value };
    } catch (error) {
      if (error instanceof CircuitOpenError)
        return {
          kind: 'UNAVAILABLE',
          reason: 'circuit open',
          retryAfterSeconds: this.config.breaker.resetAfterSeconds,
        };
      if (
        error instanceof TransportError &&
        error.status !== undefined &&
        error.status < 500 &&
        error.status !== 429 &&
        error.status !== 408
      ) {
        return { kind: 'REFUSED', code: `HTTP_${String(error.status)}` };
      }
      return { kind: 'UNAVAILABLE', reason: error instanceof Error ? error.name : 'transport failure' };
    }
  }

  /**
   * Consent-gated rails refuse before the call, not after (SR-026): the consent must be live, for this rail's
   * purpose, and for the tenant asking, which must be the tenant whose credentials this adapter holds. With no
   * ledger configured there is no way to tell, so every consent-gated call is refused.
   */
  /**
   * An identity assertion is accepted once, fresh, for this adapter's tenant (SR-007). Returns the refusal code,
   * or undefined when it may be used. The assertion is consumed here, so a second confirmation of the same
   * authentication is a replay.
   */
  protected async acceptAssertion(
    tenantId: string,
    assertionId: string,
    authenticatedAtEpochSeconds: bigint,
  ): Promise<string | undefined> {
    if (tenantId !== this.config.tenantId) return 'TENANT_MISMATCH';
    const now = BigInt(this.config.nowEpochSeconds());
    if (authenticatedAtEpochSeconds > now + ASSERTION_CLOCK_SKEW_SECONDS) return 'ASSERTION_FROM_FUTURE';
    if (now - authenticatedAtEpochSeconds > BigInt(this.config.maxAssertionAgeSeconds ?? 300)) return 'ASSERTION_STALE';
    if (this.config.assertionReplay === undefined) return 'ASSERTION_REPLAY_UNCHECKABLE';
    const use = await this.config.assertionReplay.consume({ tenantId, assertionId, authenticatedAtEpochSeconds });
    return use === 'REPLAYED' ? 'ASSERTION_REPLAYED' : undefined;
  }

  protected async requireConsent(tenantId: string, consentId: string, type: ConsentType): Promise<Result<true>> {
    if (consentId.trim().length === 0)
      return reject(
        'OP-DETERMINACY',
        'CONSENT_MISSING',
        'This rail is called only under a recorded consent for its purpose',
      );
    if (tenantId !== this.config.tenantId)
      return reject('OP-DETERMINACY', 'TENANT_MISMATCH', 'This rail is configured for another institution');
    if (this.config.consents === undefined)
      return reject('OP-DETERMINACY', 'CONSENT_UNVERIFIABLE', 'No consent ledger is configured for this rail');
    const live = await this.config.consents.live({ tenantId, consentId, type });
    return live.ok ? ok(true) : live;
  }
}

// -- Mapping helpers: vendor JSON to our integers, without a float ----------------

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
/** An identifier a rail may send as a string or as a whole JSON number; either way a string here. */
export const idStr = (v: unknown): string | undefined =>
  typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : str(v);
export const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
export const int = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v)
    ? v
    : typeof v === 'string' && /^-?\d+$/.test(v)
      ? Number.parseInt(v, 10)
      : undefined;
export const epoch = (v: unknown): bigint | undefined =>
  typeof v === 'number' && Number.isInteger(v)
    ? BigInt(v)
    : typeof v === 'string' && /^\d+$/.test(v)
      ? BigInt(v)
      : undefined;

/** "1234.56" → 123456n, by digit manipulation. A vendor decimal never becomes a float. */
export function decimalToMinor(v: unknown): bigint | undefined {
  if (typeof v === 'number') v = Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v !== 'string') return undefined;
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (m === null) return undefined;
  const minor = BigInt(m[2] ?? '0') * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -minor : minor;
}

/** 123456n → "1234.56": an amount the platform sends to a rail that speaks decimal strings. */
export function minorToDecimal(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const fraction = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${(abs / 100n).toString()}.${fraction}`;
}

/**
 * A vendor vocabulary lookup that only finds the table's own keys. A plain `table[value]` finds
 * `constructor`, `toString` and the rest of Object.prototype, so a vendor answer of "constructor"
 * would resolve to a function rather than to "not understood".
 */
export function own<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  if (typeof key !== 'string' && typeof key !== 'number') return undefined;
  const k = String(key);
  return Object.hasOwn(table, k) ? table[k] : undefined;
}

/** A JSON object, or undefined for anything else (arrays and null included). */
export const obj = (v: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Readonly<Record<string, unknown>>) : undefined;

/** A JSON array, or undefined. */
export const arr = (v: unknown): readonly unknown[] | undefined => (Array.isArray(v) ? (v as unknown[]) : undefined);

/**
 * An ISO 8601 date ("2026-04-30") or date-time ("2026-04-30T10:15:00Z", "…+03:00") to epoch
 * seconds, by integer arithmetic. A date without a zone is read as UTC midnight; anything else
 * (a Hijri date, a locale format) is undefined rather than guessed.
 */
export function isoToEpoch(v: unknown): bigint | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):?(\d{2}))?)?$/.exec(
    v.trim(),
  );
  if (m === null) return undefined;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0', m[6] ?? '0'].map((x) =>
    Number.parseInt(x ?? '0', 10),
  ) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  // Date.UTC rolls 2026-02-31 into March; a date that does not exist is not a date.
  if (new Date(ms).getUTCDate() !== d) return undefined;
  const offset =
    m[8] === undefined
      ? 0
      : (m[8] === '-' ? -1 : 1) * (Number.parseInt(m[9] ?? '0', 10) * 3600 + Number.parseInt(m[10] ?? '0', 10) * 60);
  return BigInt(ms / 1000 - offset);
}

/** Fail closed on a response we do not understand. Typed so it fits any port's outcome. */
export const malformed = (): { readonly kind: 'UNAVAILABLE'; readonly reason: string } => ({
  kind: 'UNAVAILABLE',
  reason: 'response malformed',
});
