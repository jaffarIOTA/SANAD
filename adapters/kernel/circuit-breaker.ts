/**
 * Circuit breaker.
 *
 * Isolates a failing dependency before it exhausts connection pools, and makes
 * the degraded behaviour explicit rather than emergent (SDD §4.9).
 *
 * The clock is injected. Adapters are allowed to read time — they are not the
 * sequencing engine — but an injected clock keeps breaker behaviour testable
 * without sleeping in a test suite.
 */

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface BreakerOptions {
  /** Consecutive failures before the circuit opens. */
  readonly failureThreshold: number;
  /** How long it stays open before allowing a trial call. */
  readonly resetAfterSeconds: number;
  /** Consecutive successes in HALF_OPEN before closing again. */
  readonly successThreshold: number;
  readonly nowEpochSeconds: () => number;
}

export class CircuitOpenError extends Error {
  constructor(readonly dependency: string) {
    super(`circuit open for ${dependency}`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  #state: BreakerState = 'CLOSED';
  #consecutiveFailures = 0;
  #consecutiveSuccesses = 0;
  #openedAt = 0;

  constructor(
    private readonly dependency: string,
    private readonly options: BreakerOptions,
  ) {}

  get state(): BreakerState {
    return this.#state;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const now = this.options.nowEpochSeconds();

    if (this.#state === 'OPEN') {
      if (now - this.#openedAt < this.options.resetAfterSeconds) {
        throw new CircuitOpenError(this.dependency);
      }
      this.#state = 'HALF_OPEN';
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

  #onSuccess(): void {
    this.#consecutiveFailures = 0;
    if (this.#state === 'HALF_OPEN') {
      this.#consecutiveSuccesses += 1;
      if (this.#consecutiveSuccesses >= this.options.successThreshold) {
        this.#state = 'CLOSED';
      }
      return;
    }
    this.#state = 'CLOSED';
  }

  #onFailure(now: number): void {
    this.#consecutiveSuccesses = 0;
    this.#consecutiveFailures += 1;
    if (this.#state === 'HALF_OPEN' || this.#consecutiveFailures >= this.options.failureThreshold) {
      this.#state = 'OPEN';
      this.#openedAt = now;
    }
  }
}
