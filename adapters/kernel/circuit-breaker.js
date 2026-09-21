class CircuitOpenError extends Error {
  constructor(dependency) {
    super(`circuit open for ${dependency}`);
    this.dependency = dependency;
    this.name = "CircuitOpenError";
  }
}
class CircuitBreaker {
  constructor(dependency, options) {
    this.dependency = dependency;
    this.options = options;
  }
  #state = "CLOSED";
  #consecutiveFailures = 0;
  #consecutiveSuccesses = 0;
  #openedAt = 0;
  get state() {
    return this.#state;
  }
  async execute(operation) {
    const now = this.options.nowEpochSeconds();
    if (this.#state === "OPEN") {
      if (now - this.#openedAt < this.options.resetAfterSeconds) {
        throw new CircuitOpenError(this.dependency);
      }
      this.#state = "HALF_OPEN";
      this.#consecutiveSuccesses = 0;
    }
    try {
      const value = await operation();
      this.#onSuccess();
      return value;
    } catch (error) {
      this.#onFailure(now);
      throw error;
    }
  }
  #onSuccess() {
    this.#consecutiveFailures = 0;
    if (this.#state === "HALF_OPEN") {
      this.#consecutiveSuccesses += 1;
      if (this.#consecutiveSuccesses >= this.options.successThreshold) {
        this.#state = "CLOSED";
      }
      return;
    }
    this.#state = "CLOSED";
  }
  #onFailure(now) {
    this.#consecutiveSuccesses = 0;
    this.#consecutiveFailures += 1;
    if (this.#state === "HALF_OPEN" || this.#consecutiveFailures >= this.options.failureThreshold) {
      this.#state = "OPEN";
      this.#openedAt = now;
    }
  }
}
export {
  CircuitBreaker,
  CircuitOpenError
};
