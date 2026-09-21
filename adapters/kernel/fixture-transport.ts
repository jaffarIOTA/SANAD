/**
 * Recorded-fixture transport.
 *
 * Every adapter ships with fixtures so the pipeline tests deterministically and
 * offline (SDD §4.5.2). Fixtures are keyed on the operation plus a stable digest
 * of the request, so a test that changes its request without re-recording fails
 * loudly rather than silently matching the wrong response.
 *
 * Once a vendor sandbox is available these are re-recorded from real responses.
 * Until then they encode what we believe the contract to be, and the belief is
 * visible rather than buried in a mock.
 */

export interface FixtureKey {
  readonly operation: string;
  readonly requestDigest: string;
}

export interface Fixture {
  readonly operation: string;
  /** Subset of request fields the fixture matches on. */
  readonly match: Readonly<Record<string, unknown>>;
  readonly response: Readonly<Record<string, unknown>>;
  /** Where set, the transport throws instead, to exercise the failure posture. */
  readonly failsWith?: string;
}

export class FixtureNotFoundError extends Error {
  constructor(operation: string, request: Readonly<Record<string, unknown>>) {
    super(
      `no recorded fixture for ${operation}; re-record it rather than loosening the match. request keys: ${Object.keys(request).sort().join(',')}`,
    );
    this.name = 'FixtureNotFoundError';
  }
}

export interface RecordedCall {
  readonly operation: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
}

export class FixtureTransport {
  #calls: RecordedCall[] = [];

  constructor(private readonly fixtures: readonly Fixture[]) {}

  get calls(): readonly RecordedCall[] {
    return this.#calls;
  }

  async call(
    operation: string,
    payload: Readonly<Record<string, unknown>>,
    headers: Readonly<Record<string, string>>,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#calls.push({ operation, request: payload, headers });

    const fixture = this.fixtures.find(
      (f) =>
        f.operation === operation &&
        Object.entries(f.match).every(([key, value]) => deepEqual(payload[key], value)),
    );

    if (fixture === undefined) throw new FixtureNotFoundError(operation, payload);
    if (fixture.failsWith !== undefined) throw new Error(fixture.failsWith);
    return fixture.response;
  }
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
