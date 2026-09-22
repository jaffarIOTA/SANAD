/**
 * Tuum authentication.
 *
 * Written against the published sandbox contract
 * (`auth-api …/v3/api-docs/api`, auth-api 2.46.0.RELEASE) rather than against
 * a guess. Five things about that contract shape this file, and four of them
 * are traps.
 *
 * **1. It is not OAuth 2.** There is no client-credentials grant, no
 * `grant_type`, no `client_id`. A caller posts `{username, password,
 * tenantCode}` and receives a token. That means the stored credential is a
 * *password*, so password rotation policy applies to it, not API-key policy.
 *
 * **2. The token goes in `x-auth-token`, not `Authorization`.** The document's
 * security scheme is `apiKey` in a header of that name. An adapter that sends
 * a bearer header is silently unauthenticated.
 *
 * **3. A 200 can carry errors.** The envelope is `{errors, validationErrors,
 * data}` and the success response is declared as that same envelope. Checking
 * `response.ok` is therefore not enough — a failed authentication can arrive
 * as HTTP 200 with a populated `errors` array. This is the single most likely
 * way to build an adapter that appears to work.
 *
 * **4. The response carries no expiry.** `AuthTokenJson` has exactly one
 * field, `token`. There is no `expiresIn` and no `refreshToken`. So the
 * lifetime has to come from the token itself, or be assumed conservatively.
 *
 * **5. `tenantCode` travels twice** — in the body and as an `x-tenant-code`
 * header. Both are optional in the document and at least one is required in
 * practice, so this sends both.
 *
 * On secrecy: no password and no token is logged, returned, put in an error
 * message or held in a module-level global (CLAUDE.md §4). The token lives in
 * one field of one instance and is replaced in place.
 */

import { type Result, ok, reject } from '../../core/kernel/result.ts';

/** Which authorise endpoint. They take the same body and mean different things. */
export type TuumIdentityKind =
  /** A person in the tenant. `/api/v1/authorise`. */
  | 'EXTERNAL_USER'
  /** A back-office user, which is what a console-created login usually is. */
  | 'EMPLOYEE';

const PATHS: Readonly<Record<TuumIdentityKind, string>> = {
  EXTERNAL_USER: '/api/v1/authorise',
  EMPLOYEE: '/api/v1/employees/authorise',
};

export interface TuumAuthCredentials {
  readonly username: string;
  /** Resolved from the credential store per call to `authenticate`. */
  readonly password: string;
  readonly tenantCode: string;
  readonly identityKind: TuumIdentityKind;
}

/** Minimal HTTP surface, so this is testable without a network. */
export interface AuthHttp {
  post(request: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }): Promise<{ readonly status: number; readonly body: string }>;
}

interface Envelope<T> {
  readonly errors?: readonly unknown[];
  readonly validationErrors?: readonly unknown[];
  readonly data?: T;
}

/**
 * Error codes, as `err.somethingHappened`.
 *
 * Normalised to strings whether the platform returns bare codes or objects
 * carrying `code` and `translations`, because both shapes appear in the
 * document and we should not care which we got.
 */
function errorCodes(envelope: Envelope<unknown>): string[] {
  const from = (list: readonly unknown[] | undefined): string[] =>
    (list ?? []).map((entry) =>
      typeof entry === 'string'
        ? entry
        : String((entry as { code?: unknown } | null)?.code ?? 'err.unknown'),
    );
  return [...from(envelope.errors), ...from(envelope.validationErrors)];
}

/**
 * When does this token stop working?
 *
 * The response does not say, so the `exp` claim is read from the token's own
 * payload. **The signature is not verified and must not be**: we are not the
 * audience for this token and hold none of the keys. The claim is used for one
 * purpose — deciding when to ask for a new token — and a wrong answer costs a
 * redundant refresh or one rejected call, never an authorisation decision.
 *
 * An opaque or unparseable token falls back to a conservative lifetime.
 */
const CONSERVATIVE_LIFETIME_SECONDS = 240;

function expiryOf(token: string, nowEpochSeconds: number): number {
  const parts = token.split('.');
  if (parts.length !== 3) return nowEpochSeconds + CONSERVATIVE_LIFETIME_SECONDS;

  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp
      : nowEpochSeconds + CONSERVATIVE_LIFETIME_SECONDS;
  } catch {
    return nowEpochSeconds + CONSERVATIVE_LIFETIME_SECONDS;
  }
}

/** Refresh this far before expiry, so an in-flight call does not race it. */
const REFRESH_MARGIN_SECONDS = 30;

export interface TuumSession {
  /** Headers every authenticated Tuum call must carry. */
  authHeaders(): Promise<Result<Readonly<Record<string, string>>>>;
  /** Discard the current token, e.g. after the platform rejects it. */
  invalidate(): void;
}

export function createTuumSession(params: {
  readonly baseUrl: string;
  readonly http: AuthHttp;
  /**
   * Resolved from the credential store at each authentication, not held by
   * this object. Keeping the password in a field would mean it outlived the
   * call that needed it.
   */
  readonly credentials: () => Promise<TuumAuthCredentials>;
  /** Injected so this is testable without a clock. */
  readonly nowEpochSeconds: () => number;
}): TuumSession {
  const { baseUrl, http, credentials, nowEpochSeconds } = params;

  let token: string | undefined;
  let expiresAt = 0;
  /**
   * Single-flight.
   *
   * Without this, N concurrent calls finding an expired token all
   * authenticate. Against a platform that rate-limits or locks an account
   * after repeated attempts, a burst of simultaneous logins is how a
   * deployment locks itself out.
   */
  let inFlight: Promise<Result<string>> | undefined;

  async function login(): Promise<Result<string>> {
    const credential = await credentials();
    const path = PATHS[credential.identityKind];

    const response = await http.post({
      url: `${baseUrl}${path}`,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Sent as a header as well as in the body: both are optional in the
        // document and at least one is required in practice.
        'x-tenant-code': credential.tenantCode,
      },
      body: JSON.stringify({
        username: credential.username,
        password: credential.password,
        tenantCode: credential.tenantCode,
      }),
    });

    let envelope: Envelope<{ token?: unknown }>;
    try {
      envelope = JSON.parse(response.body) as Envelope<{ token?: unknown }>;
    } catch {
      return reject(
        'OP-DETERMINACY',
        'TUUM_AUTH_RESPONSE_UNREADABLE',
        'The authentication response could not be read as JSON',
        // The status is safe to record. The body is not — it may carry a token.
        { status: response.status },
      );
    }

    // Checked before the status, because a failure can arrive as 200 with a
    // populated `errors` array.
    const codes = errorCodes(envelope);
    if (codes.length > 0) {
      return reject(
        'OP-DETERMINACY',
        'TUUM_AUTH_REFUSED',
        'The core banking platform refused the credential',
        {
          status: response.status,
          // Platform error codes, not credential material.
          codes: codes.join(','),
          identityKind: credential.identityKind,
        },
      );
    }

    if (response.status !== 200) {
      return reject(
        'OP-DETERMINACY',
        'TUUM_AUTH_UNEXPECTED_STATUS',
        'The authentication call returned an unexpected status',
        { status: response.status },
      );
    }

    const issued = envelope.data?.token;
    if (typeof issued !== 'string' || issued.length === 0) {
      return reject(
        'OP-DETERMINACY',
        'TUUM_AUTH_NO_TOKEN',
        'The authentication call succeeded but carried no token',
        { status: response.status },
      );
    }

    token = issued;
    expiresAt = expiryOf(issued, nowEpochSeconds());
    return ok(issued);
  }

  async function current(): Promise<Result<string>> {
    const now = nowEpochSeconds();
    if (token !== undefined && now < expiresAt - REFRESH_MARGIN_SECONDS) {
      return ok(token);
    }

    inFlight ??= login().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  }

  return {
    async authHeaders(): Promise<Result<Readonly<Record<string, string>>>> {
      const credential = await credentials();
      const resolved = await current();
      if (!resolved.ok) return resolved;

      return ok({
        // The security scheme is `apiKey` in this header. A bearer header
        // would be ignored and the call would be unauthenticated.
        'x-auth-token': resolved.value,
        'x-tenant-code': credential.tenantCode,
      });
    },

    invalidate(): void {
      token = undefined;
      expiresAt = 0;
    },
  };
}
