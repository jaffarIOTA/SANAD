import {
  BoundedCredentialCache
} from "../../core/ports/credentials.js";
import { CircuitBreaker } from "./circuit-breaker.js";
class BaseAdapter {
  constructor(config, credentials) {
    this.config = config;
    this.#credentials = credentials;
    this.#cache = new BoundedCredentialCache(config.credentialTtlSeconds);
    this.breaker = new CircuitBreaker(`${config.provider}:${config.environment}`, {
      ...config.breaker,
      nowEpochSeconds: config.nowEpochSeconds
    });
  }
  breaker;
  #credentials;
  #cache;
  /**
   * Resolve a credential, cached for a bounded TTL.
   *
   * The returned value redacts itself on `toString` and `toJSON`. Getting the
   * plaintext out needs an explicit `.expose()` call, which is greppable in
   * review — and must never appear inside a log, trace or metric expression.
   */
  async credential(keyName, correlationId) {
    const ref = {
      tenantId: this.config.tenantId,
      provider: this.config.provider,
      environment: this.config.environment,
      keyName
    };
    const now = this.config.nowEpochSeconds();
    const cached = this.#cache.get(ref, now);
    if (cached !== void 0) return cached;
    const fetched = await this.#credentials.get(ref, correlationId);
    this.#cache.put(ref, fetched, now);
    return fetched;
  }
  /** Called on disposal. Credentials do not linger after the adapter is done. */
  dispose() {
    this.#cache.clear();
  }
}
const REDACT_KEYS = /(secret|token|password|authorization|credential|nationalId|iqama|nin)/i;
function redactForLogging(value, depth = 0) {
  if (depth > 6) return "[depth-limited]";
  if (value === null || value === void 0) return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactForLogging(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = REDACT_KEYS.test(key) ? "[redacted]" : redactForLogging(v, depth + 1);
  }
  return out;
}
export {
  BaseAdapter,
  redactForLogging
};
