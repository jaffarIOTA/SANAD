/**
 * The live transport every rail adapter shares: one JSON call, a timeout, no
 * retries (the outbox and the breaker own retry), and a typed failure so the
 * adapter can turn it into an `UNAVAILABLE` outcome rather than a throw.
 *
 * Egress goes through the institution's forward proxy or the gateway's
 * egress policy. Node's fetch does not read proxy environment variables;
 * inject a `fetch` bound to the right dispatcher rather than reading them
 * here.
 */

export interface RailEnvelope {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly url: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
}

export interface RailTransport {
  call(operation: string, envelope: RailEnvelope): Promise<Readonly<Record<string, unknown>>>;
}

export class TransportError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export class HttpTransport implements RailTransport {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async call(operation: string, envelope: RailEnvelope): Promise<Readonly<Record<string, unknown>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(envelope.url, {
        method: envelope.method,
        headers: { accept: 'application/json', ...(envelope.body === undefined ? {} : { 'content-type': 'application/json' }), ...envelope.headers },
        ...(envelope.body === undefined ? {} : { body: JSON.stringify(envelope.body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        // The status is enough for the caller; the body may carry the vendor's
        // own error text and must not travel any further than this adapter.
        throw new TransportError(operation, response.status, `${operation}: HTTP ${String(response.status)}`);
      }
      if (text.trim().length === 0) return {};
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { value: parsed };
    } catch (error) {
      if (error instanceof TransportError) throw error;
      throw new TransportError(operation, undefined, `${operation}: ${error instanceof Error ? error.name : 'transport failure'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
