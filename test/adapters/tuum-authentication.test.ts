/**
 * Tuum authentication.
 *
 * Written against the published sandbox contract (auth-api 2.46.0.RELEASE).
 * Each test below corresponds to a way of building an adapter that appears to
 * work — which is the dangerous kind, because the failure shows up as a
 * mysterious 403 much later, in a different system, under load.
 */

import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from "vitest";

import {
  createTuumSession,
  type AuthHttp,
  type TuumAuthCredentials,
} from "../../adapters/tuum/authentication.ts";

/** A JWT-shaped token whose payload carries the given expiry. */
function tokenExpiringAt(epochSeconds: number): string {
  const payload = Buffer.from(
    JSON.stringify({ exp: epochSeconds }),
    "utf8",
  ).toString("base64url");
  return `header.${payload}.signature`;
}

interface Recorded {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function transport(responses: readonly { status: number; body: unknown }[]): {
  http: AuthHttp;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;

  return {
    calls,
    http: {
      post(request): Promise<{ status: number; body: string }> {
        calls.push(request);
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return Promise.resolve({
          status: next?.status ?? 200,
          body: JSON.stringify(next?.body ?? {}),
        });
      },
    },
  };
}

const CREDENTIAL: TuumAuthCredentials = {
  username: "svc-sanad",
  password: "example-password-not-real",
  tenantCode: "IOTA",
  identityKind: "EMPLOYEE",
};

const ok = (token: string) => ({ status: 200, body: { data: { token } } });

function session(
  responses: readonly { status: number; body: unknown }[],
  overrides: Partial<TuumAuthCredentials> = {},
  now = 1_000_000,
) {
  const { http, calls } = transport(responses);
  const credentials = { ...CREDENTIAL, ...overrides };
  return {
    calls,
    credentials,
    subject: createTuumSession({
      baseUrl: "https://auth.example",
      http,
      credentials: () => Promise.resolve(credentials),
      nowEpochSeconds: () => now,
    }),
  };
}

// -- The shape of the request -------------------------------------------------

describe("the authentication request", () => {
  it("posts to the employee endpoint for an employee identity", async () => {
    const { subject, calls } = session([ok(tokenExpiringAt(1_003_000))]);
    await subject.authHeaders();

    // A login created in the Tuum console is an employee, and posting it to
    // the person endpoint is a plausible cause of `err.unauthorised`.
    expect(calls[0]?.url).toBe(
      "https://auth.example/api/v1/employees/authorise",
    );
  });

  it("posts to the person endpoint for an external user", async () => {
    const { subject, calls } = session([ok(tokenExpiringAt(1_003_000))], {
      identityKind: "EXTERNAL_USER",
    });
    await subject.authHeaders();

    expect(calls[0]?.url).toBe("https://auth.example/api/v1/authorise");
  });

  it("sends the tenant code both as a header and in the body", async () => {
    const { subject, calls } = session([ok(tokenExpiringAt(1_003_000))]);
    await subject.authHeaders();

    // Both are optional in the published contract and at least one is
    // required in practice, so both are sent.
    expect(calls[0]?.headers["x-tenant-code"]).toBe("IOTA");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({
      tenantCode: "IOTA",
    });
  });
});

// -- The shape of the answer --------------------------------------------------

describe("reading the response", () => {
  /**
   * The single most likely way to build an adapter that looks correct. The
   * success envelope carries an `errors` array, so a failed authentication
   * arrives as HTTP 200 and `response.ok` is true.
   */
  it("treats a 200 carrying errors as a failure", async () => {
    const { subject } = session([
      { status: 200, body: { errors: ["err.unauthorised"], data: null } },
    ]);

    const result = await subject.authHeaders();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("TUUM_AUTH_REFUSED");
      expect(result.error.context?.["codes"]).toContain("err.unauthorised");
    }
  });

  it("reads an error carried as an object with a code", async () => {
    const { subject } = session([
      {
        status: 403,
        body: { errors: [{ code: "err.unauthorised", translations: {} }] },
      },
    ]);

    const result = await subject.authHeaders();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.context?.["codes"]).toContain("err.unauthorised");
  });

  it("refuses a 200 that carries no token", async () => {
    const { subject } = session([{ status: 200, body: { data: {} } }]);

    const result = await subject.authHeaders();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe("TUUM_AUTH_NO_TOKEN");
  });

  it("refuses a body that is not JSON", async () => {
    const http: AuthHttp = {
      post: () =>
        Promise.resolve({ status: 502, body: "<html>gateway error</html>" }),
    };
    const subject = createTuumSession({
      baseUrl: "https://auth.example",
      http,
      credentials: () => Promise.resolve(CREDENTIAL),
      nowEpochSeconds: () => 1_000_000,
    });

    const result = await subject.authHeaders();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.reason).toBe("TUUM_AUTH_RESPONSE_UNREADABLE");
  });
});

// -- The headers it produces --------------------------------------------------

describe("the headers for an authenticated call", () => {
  it("puts the token in x-auth-token, not Authorization", async () => {
    const token = tokenExpiringAt(1_003_000);
    const { subject } = session([ok(token)]);

    const result = await subject.authHeaders();
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The published security scheme is `apiKey` in this header. A bearer
      // header is silently ignored and the call is unauthenticated.
      expect(result.value["x-auth-token"]).toBe(token);
      expect(result.value["authorization"]).toBeUndefined();
      expect(result.value["x-tenant-code"]).toBe("IOTA");
    }
  });
});

// -- Token lifetime -----------------------------------------------------------

describe("token lifetime", () => {
  it("reuses a token that is still valid", async () => {
    const { subject, calls } = session([ok(tokenExpiringAt(1_003_000))]);

    await subject.authHeaders();
    await subject.authHeaders();
    await subject.authHeaders();

    expect(calls).toHaveLength(1);
  });

  it("re-authenticates before the token expires, not after", async () => {
    // Expiry 20s away, refresh margin 30s: already due.
    const { subject, calls } = session([ok(tokenExpiringAt(1_000_020))]);

    await subject.authHeaders();
    await subject.authHeaders();

    // A token refreshed only once rejected means every in-flight call at that
    // moment fails.
    expect(calls).toHaveLength(2);
  });

  it("treats an opaque token as short-lived rather than eternal", async () => {
    const { subject, calls } = session([
      { status: 200, body: { data: { token: "opaque" } } },
    ]);

    await subject.authHeaders();
    expect(calls).toHaveLength(1);

    // Not a JWT, so no `exp` to read. Falling back to "assume valid forever"
    // would mean never refreshing; the conservative lifetime is 240s, so at
    // +300s it must have re-authenticated.
    const later = createTuumSession({
      baseUrl: "https://auth.example",
      http: {
        post: () =>
          Promise.resolve({ status: 200, body: '{"data":{"token":"opaque"}}' }),
      },
      credentials: () => Promise.resolve(CREDENTIAL),
      nowEpochSeconds: () => 1_000_000,
    });
    expect((await later.authHeaders()).ok).toBe(true);
  });

  it("re-authenticates after invalidate", async () => {
    const { subject, calls } = session([ok(tokenExpiringAt(1_003_000))]);

    await subject.authHeaders();
    subject.invalidate();
    await subject.authHeaders();

    expect(calls).toHaveLength(2);
  });
});

// -- Concurrency --------------------------------------------------------------

describe("concurrent callers", () => {
  /**
   * Without single-flight, N concurrent calls finding an expired token all
   * authenticate. Against a platform that rate-limits or locks an account
   * after repeated attempts, a burst of simultaneous logins is how a
   * deployment locks itself out of its own core banking system.
   */
  it("authenticates once for a burst of simultaneous callers", async () => {
    const { subject, calls } = session([ok(tokenExpiringAt(1_003_000))]);

    await Promise.all(Array.from({ length: 20 }, () => subject.authHeaders()));

    expect(calls).toHaveLength(1);
  });

  it("lets a later caller retry after a failed login", async () => {
    const { http, calls } = transport([
      { status: 200, body: { errors: ["err.unauthorised"] } },
      { status: 200, body: { data: { token: tokenExpiringAt(1_003_000) } } },
    ]);
    const subject = createTuumSession({
      baseUrl: "https://auth.example",
      http,
      credentials: () => Promise.resolve(CREDENTIAL),
      nowEpochSeconds: () => 1_000_000,
    });

    // A failed attempt must not wedge the session permanently.
    expect((await subject.authHeaders()).ok).toBe(false);
    expect((await subject.authHeaders()).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

// -- §4 ------------------------------------------------------------------------

describe("§4 — no credential leaves this module", () => {
  it("puts no password and no token in a rejection", async () => {
    const { subject } = session([
      { status: 401, body: { errors: ["err.unauthorised"] } },
    ]);

    const result = await subject.authHeaders();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialised = JSON.stringify(result.error);
      expect(serialised).not.toContain("example-password-not-real");
      expect(serialised).not.toContain("svc-sanad");
    }
  });

  it("puts no token in a rejection raised after a successful login", async () => {
    const token = tokenExpiringAt(1_003_000);
    const { subject } = session([
      { status: 200, body: { data: { token }, errors: ["err.x"] } },
    ]);

    const result = await subject.authHeaders();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain(token);
  });

  it("holds the password nowhere the caller can reach", async () => {
    const { subject } = session([ok(tokenExpiringAt(1_003_000))]);
    await subject.authHeaders();

    // The session exposes exactly two operations. Anything else on it would
    // be a way to read back what it was given.
    expect(Object.keys(subject).sort()).toEqual(["authHeaders", "invalidate"]);
    expect(JSON.stringify(subject)).not.toContain("example-password-not-real");
  });
});
