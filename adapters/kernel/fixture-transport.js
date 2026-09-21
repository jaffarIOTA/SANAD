class FixtureNotFoundError extends Error {
  constructor(operation, request, url) {
    const where = url === void 0 ? operation : `${operation} ${url}`;
    const keys = Object.keys(request).sort((a, b) => a.localeCompare(b)).join(",");
    super(
      `no recorded fixture for ${where}; re-record it rather than loosening the match. request keys: ${keys}`
    );
    this.name = "FixtureNotFoundError";
  }
}
class FixtureTransport {
  constructor(fixtures) {
    this.fixtures = fixtures;
  }
  #calls = [];
  get calls() {
    return this.#calls;
  }
  /** Accepts either `(operation, envelope)` or `(operation, payload, headers)`. */
  async call(operation, payloadOrEnvelope, maybeHeaders = {}) {
    const envelope = isEnvelope(payloadOrEnvelope) ? payloadOrEnvelope : void 0;
    const request = envelope ? envelope.body ?? {} : payloadOrEnvelope;
    const headers = envelope ? envelope.headers : maybeHeaders;
    this.#calls.push({
      operation,
      request,
      headers,
      ...envelope === void 0 ? {} : { method: envelope.method, url: envelope.url }
    });
    const candidate = envelope ? { ...request, url: envelope.url, method: envelope.method } : { ...request };
    const fixture = this.fixtures.find(
      (f) => f.operation === operation && Object.entries(f.match).every(([key, value]) => matches(candidate[key], value))
    );
    if (fixture === void 0) throw new FixtureNotFoundError(operation, request, envelope?.url);
    if (fixture.failsWith !== void 0) throw new Error(fixture.failsWith);
    return fixture.response;
  }
}
function isEnvelope(value) {
  return typeof value === "object" && value !== null && "url" in value && "headers" in value && "method" in value;
}
function matches(actual, expected) {
  if (expected instanceof RegExp) return typeof actual === "string" && expected.test(actual);
  return deepEqual(actual, expected);
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ae = Object.entries(a).sort(([x], [y]) => x.localeCompare(y));
  const be = Object.entries(b).sort(([x], [y]) => x.localeCompare(y));
  if (ae.length !== be.length) return false;
  return ae.every(([k, v], i) => be[i]?.[0] === k && deepEqual(v, be[i]?.[1]));
}
export {
  FixtureNotFoundError,
  FixtureTransport
};
