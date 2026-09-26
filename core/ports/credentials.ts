/**
 * Credential access port.
 *
 * Adapters need provider credentials. They get them through this, and the rules
 * are not negotiable (CLAUDE.md §4):
 *
 *   - the value is fetched at adapter construction and cached in memory for a
 *     bounded TTL, never held in a module-level global;
 *   - every read is audited server-side;
 *   - no value is ever interpolated into a log line, an error message, a trace
 *     span or a metric label.
 *
 * `SecretValue` exists so a credential cannot reach a template literal or a
 * `JSON.stringify` by accident. Getting the string out requires calling
 * `expose()`, which is greppable, and `toString`/`toJSON` are overridden to
 * redact.
 */

export type CredentialProviderName =
  | 'CORE_BANKING'
  | 'DOCUMENT_PLATFORM'
  | 'E_INVOICING'
  | 'IDENTITY'
  | 'BUSINESS_REGISTRY'
  | 'CREDIT_BUREAU'
  | 'SCREENING'
  | 'CERTIFICATION_SERVICE_PROVIDER'
  | 'TIMESTAMP_AUTHORITY'
  // KSA rails (CLAUDE.md §5). Capability names, never vendor names.
  | 'IDENTITY_AUTHENTICATION'
  | 'IDENTITY_VERIFICATION'
  | 'DOCUMENT_VERIFICATION'
  | 'EMPLOYMENT_VERIFICATION'
  | 'TAX_COMPLIANCE'
  | 'OPEN_BANKING'
  | 'BILL_COLLECTION'
  | 'PAYMENTS_HUB'
  | 'RATE_PUBLISHER'
  | 'COMMODITY_BROKER'
  | 'WORKFLOW_ENGINE';

export type Environment = 'sandbox' | 'uat' | 'production';

export interface CredentialRef {
  readonly tenantId: string;
  readonly provider: CredentialProviderName;
  readonly environment: Environment;
  readonly keyName: string;
}

const REDACTED = '[redacted]';

/**
 * A secret that does not print itself.
 *
 * `String(secret)`, `${secret}` and `JSON.stringify({ secret })` all yield
 * `[redacted]`. Only `expose()` returns the value, and a reviewer can find every
 * call site by searching for it.
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  expose(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return REDACTED;
  }
}

export interface CredentialProvider {
  /**
   * Resolve a credential. Implementations read through the vault function that
   * writes an access audit row; there is no path that reads the value without
   * recording that it was read.
   */
  get(ref: CredentialRef, correlationId: string): Promise<SecretValue>;
}

/**
 * A bounded in-memory cache for adapter construction.
 *
 * Deliberately not a singleton and deliberately not exported as a shared
 * instance: an adapter owns its cache for its lifetime, so credentials do not
 * outlive the thing that needed them.
 *
 * `nowEpochSeconds` is injected rather than read, so expiry is testable and this
 * module stays clock-free like the rest of core.
 */
export class BoundedCredentialCache {
  readonly #entries = new Map<string, { readonly value: SecretValue; readonly expiresAt: number }>();
  readonly #ttlSeconds: number;

  constructor(ttlSeconds: number) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new TypeError('credential cache TTL must be a positive whole number of seconds');
    }
    this.#ttlSeconds = ttlSeconds;
  }

  get(ref: CredentialRef, nowEpochSeconds: number): SecretValue | undefined {
    const entry = this.#entries.get(key(ref));
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= nowEpochSeconds) {
      this.#entries.delete(key(ref));
      return undefined;
    }
    return entry.value;
  }

  put(ref: CredentialRef, value: SecretValue, nowEpochSeconds: number): void {
    this.#entries.set(key(ref), { value, expiresAt: nowEpochSeconds + this.#ttlSeconds });
  }

  /** Called on adapter disposal. */
  clear(): void {
    this.#entries.clear();
  }
}

const key = (ref: CredentialRef): string =>
  `${ref.tenantId}/${ref.provider}/${ref.environment}/${ref.keyName}`;
