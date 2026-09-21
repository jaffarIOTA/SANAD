const REDACTED = "[redacted]";
class SecretValue {
  #value;
  constructor(value) {
    this.#value = value;
  }
  expose() {
    return this.#value;
  }
  toString() {
    return REDACTED;
  }
  toJSON() {
    return REDACTED;
  }
  get [Symbol.toStringTag]() {
    return REDACTED;
  }
}
class BoundedCredentialCache {
  #entries = /* @__PURE__ */ new Map();
  #ttlSeconds;
  constructor(ttlSeconds) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new TypeError("credential cache TTL must be a positive whole number of seconds");
    }
    this.#ttlSeconds = ttlSeconds;
  }
  get(ref, nowEpochSeconds) {
    const entry = this.#entries.get(key(ref));
    if (entry === void 0) return void 0;
    if (entry.expiresAt <= nowEpochSeconds) {
      this.#entries.delete(key(ref));
      return void 0;
    }
    return entry.value;
  }
  put(ref, value, nowEpochSeconds) {
    this.#entries.set(key(ref), { value, expiresAt: nowEpochSeconds + this.#ttlSeconds });
  }
  /** Called on adapter disposal. */
  clear() {
    this.#entries.clear();
  }
}
const key = (ref) => `${ref.tenantId}/${ref.provider}/${ref.environment}/${ref.keyName}`;
export {
  BoundedCredentialCache,
  SecretValue
};
