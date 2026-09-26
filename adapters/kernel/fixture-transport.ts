/**
 * Recorded-fixture transport.
 *
 * Every adapter ships with fixtures so the pipeline tests deterministically and
 * offline (SDD §4.5.2). Fixtures are matched on the operation plus declared
 * fields of the request, so a test that changes its request without re-recording
 * fails loudly rather than silently matching the wrong response.
 *
 * Two request shapes are supported, because the adapters differ honestly: one
 * passes a payload and headers, the other a full envelope with a method and a
 * URL. Both normalise to the same recorded call.
 *
 * Once vendor sandboxes are available these are re-recorded from real responses.
 * Until then they encode what we believe the contract to be, and the belief is
 * visible rather than buried in a mock.
 */

export interface Fixture {
  readonly operation: string;
  /**
   * Subset of the request the fixture matches on. Body fields by name, plus the
   * reserved keys `url` and `method` where the adapter sends an envelope.
   */
  readonly match: Readonly<Record<string, unknown>>;
  readonly response: Readonly<Record<string, unknown>>;
  /** Where set, the transport throws instead, to exercise the failure posture. */
  readonly failsWith?: string;
}

export interface RecordedCall {
  readonly operation: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly method?: string;
  readonly url?: string;
}

interface Envelope {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly url: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
}

export class FixtureNotFoundError extends Error {
  constructor(operation: string, request: Readonly<Record<string, unknown>>, url?: string) {
    const where = url === undefined ? operation : `${operation} ${url}`;
    const keys = Object.keys(request).sort((a, b) => a.localeCompare(b)).join(',');
    super(
      `no recorded fixture for ${where}; re-record it rather than loosening the match. ` +
        `request keys: ${keys}`,
    );
    this.name = 'FixtureNotFoundError';
  }
}

export class FixtureTransport {
  readonly #calls: RecordedCall[] = [];

  constructor(private readonly fixtures: readonly Fixture[]) {}

  get calls(): readonly RecordedCall[] {
    return this.#calls;
  }

  /** Accepts either `(operation, envelope)` or `(operation, payload, headers)`. */
  async call(
    operation: string,
    payloadOrEnvelope: Readonly<Record<string, unknown>> | Envelope,
    maybeHeaders: Readonly<Record<string, string>> = {},
  ): Promise<Readonly<Record<string, unknown>>> {
    const envelope = isEnvelope(payloadOrEnvelope) ? payloadOrEnvelope : undefined;
    const request = envelope
      ? (envelope.body ?? {})
      : (payloadOrEnvelope as Readonly<Record<string, unknown>>);
    const headers = envelope ? envelope.headers : maybeHeaders;

    this.#calls.push({
      operation,
      request,
      headers,
      ...(envelope === undefined ? {} : { method: envelope.method, url: envelope.url }),
    });

    const candidate: Record<string, unknown> = envelope
      ? { ...request, url: envelope.url, method: envelope.method }
      : { ...request };

    const fixture = this.fixtures.find(
      (f) =>
        f.operation === operation &&
        Object.entries(f.match).every(([key, value]) => matches(candidate[key], value)),
    );

    if (fixture === undefined) throw new FixtureNotFoundError(operation, request, envelope?.url);
    if (fixture.failsWith !== undefined) throw new Error(fixture.failsWith);
    return fixture.response;
  }
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'url' in value &&
    'headers' in value &&
    'method' in value
  );
}

/** A `RegExp` in a match is tested; anything else is compared structurally. */
function matches(actual: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual);
  return deepEqual(actual, expected);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  const ae = Object.entries(a as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y));
  const be = Object.entries(b as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y));
  if (ae.length !== be.length) return false;
  return ae.every(([k, v], i) => be[i]?.[0] === k && deepEqual(v, be[i]?.[1]));
}
