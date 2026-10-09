/**
 * Offline verification of a signed licence or revocation (ADR 0006 §1).
 *
 * ## What the issuer signs — reproduce this byte for byte
 *
 * The signature covers the **canonical serialisation** of the inner object
 * (the `licence` or the `revocation`, not the envelope around it), encoded as
 * UTF-8:
 *
 *   1. Objects: keys sorted ascending by UTF-16 code unit (JavaScript's default
 *      `Array.prototype.sort` on strings, which for these ASCII keys is plain
 *      byte order), each key written as a JSON string, then `:`, then the value;
 *      members separated by `,`; wrapped in `{` `}`.
 *   2. Arrays: elements in their given order, separated by `,`, wrapped in `[` `]`.
 *   3. Strings: exactly as ECMAScript `JSON.stringify` writes them (`"` and `\`
 *      escaped, control characters as `\b \f \n \r \t` or `\u00XX` lower-case
 *      hex, everything else — Arabic included — as the literal UTF-8 character).
 *   4. Numbers: whole numbers only, in plain decimal with no sign for positives,
 *      no exponent, no fraction, no leading zeros. A fractional number is not
 *      canonicalisable and is refused.
 *   5. `null`, `true`, `false` as those words.
 *   6. No whitespace anywhere: no spaces, no newlines, no trailing newline.
 *
 * For this value domain the result is identical to RFC 8785 (JCS).
 *
 * Example: `{"b":[2,1],"a":"x"}` canonicalises to `{"a":"x","b":[2,1]}`.
 *
 * ## The signature
 *
 * ES256: ECDSA over P-256 with SHA-256 of the canonical bytes. The signature
 * is the 64-byte IEEE P1363 form — `r` then `s`, each a 32-byte big-endian
 * integer, left-padded with zeros — encoded base64url without padding (86
 * characters). Not DER. `keyId` in the signed object selects the public key.
 *
 * ## Which keys
 *
 * The keyring is `PRODUCTION_KEYRING` (keys.ts), compiled in. A test keyring
 * can be supplied outside production only. Under `NODE_ENV=production` a
 * supplied keyring is refused (`KEYRING_INJECTION_REFUSED`) — structurally:
 * the only way to obtain a `LicenceVerifier` is `createVerifier`, and it
 * checks the environment itself as well as what the caller says.
 */

import { type KeyObject, createPublicKey, verify as verifySignature } from 'node:crypto';

import { type Result, err, ok } from '../kernel/result.ts';
import { addDays, addMonths, dayNumber, parseDate } from './dates.ts';
import { type Keyring, PRODUCTION_KEYRING } from './keys.ts';
import {
  type Licence,
  type LicenceRefusal,
  type LicenceRefusalReason,
  type Revocation,
  type SignedDocument,
  parseLicence,
  parseRevocation,
  parseSignedFile,
} from './licence.ts';

// -- Canonical serialisation ----------------------------------------------------

const byCodeUnit = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** The canonical form described above, or undefined if the value holds something that has none (a fraction, a function). */
export function canonicalJson(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : undefined;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const c = canonicalJson(item);
      if (c === undefined) return undefined;
      parts.push(c);
    }
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    // UTF-16 code-unit order, never locale order: the issuer must be able to reproduce it anywhere.
    for (const key of Object.keys(record).sort(byCodeUnit)) {
      const c = canonicalJson(record[key]);
      if (c === undefined) return undefined;
      parts.push(`${JSON.stringify(key)}:${c}`);
    }
    return `{${parts.join(',')}}`;
  }
  return undefined;
}

// -- The verifier -----------------------------------------------------------------

const CONSTRUCTION = Symbol('licence-verifier');

export type VerifierMode = 'PRODUCTION' | 'NON_PRODUCTION';

/**
 * Holds the public keys and checks signatures. Obtainable only from
 * `createVerifier`: the constructor refuses any caller without the
 * module-private token, so no other code path can hand in a keyring.
 */
export class LicenceVerifier {
  readonly mode: VerifierMode;
  readonly #keys: ReadonlyMap<string, KeyObject>;

  constructor(token: symbol, mode: VerifierMode, keys: ReadonlyMap<string, KeyObject>) {
    if (token !== CONSTRUCTION) throw new Error('a licence verifier is obtained from createVerifier');
    this.mode = mode;
    this.#keys = keys;
  }

  keyIds(): readonly string[] {
    return [...this.#keys.keys()];
  }

  /** Verify an ES256 P1363 signature over `bytes` with the key `keyId`. */
  check(bytes: Uint8Array, signature: string, keyId: string): 'OK' | 'KEY_UNKNOWN' | 'SIGNATURE_INVALID' {
    const key = this.#keys.get(keyId);
    if (key === undefined) return 'KEY_UNKNOWN';
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return 'SIGNATURE_INVALID';
    const raw = Buffer.from(signature, 'base64url');
    if (raw.length !== 64) return 'SIGNATURE_INVALID';
    try {
      return verifySignature('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, raw) ? 'OK' : 'SIGNATURE_INVALID';
    } catch {
      return 'SIGNATURE_INVALID';
    }
  }
}

/** What the running process says about itself, independently of what a caller passes. */
function processSaysProduction(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.['NODE_ENV'] === 'production';
}

export interface VerifierOptions {
  /** The caller's view of NODE_ENV. Production if either this or the process says so. */
  readonly nodeEnv: string | undefined;
  /** Tests only. Refused under production. */
  readonly testKeyring?: Keyring;
}

export function createVerifier(options: VerifierOptions): Result<LicenceVerifier, LicenceRefusal> {
  const production = options.nodeEnv === 'production' || processSaysProduction();
  if (production && options.testKeyring !== undefined)
    return err({
      reason: 'KEYRING_INJECTION_REFUSED',
      detail: 'A production build verifies licences only against the compiled-in keyring',
    });
  const ring = production ? PRODUCTION_KEYRING : (options.testKeyring ?? PRODUCTION_KEYRING);
  const keys = new Map<string, KeyObject>();
  for (const [keyId, jwk] of Object.entries(ring)) {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') continue;
    keys.set(keyId, createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' }));
  }
  return ok(new LicenceVerifier(CONSTRUCTION, production ? 'PRODUCTION' : 'NON_PRODUCTION', keys));
}

// -- Term rules ---------------------------------------------------------------------

export const GRACE_DAYS: Readonly<Record<Licence['kind'], number>> = { ANNUAL: 30, POC: 7 };

const refuse = (reason: LicenceRefusalReason, detail: string): Result<never, LicenceRefusal> => err({ reason, detail });

/**
 * Checked at verification, not only at issue (ADR 0006 §1): a POC is at most
 * one calendar month, an ANNUAL at most twelve months and one day, and the
 * grace period is the one the kind carries.
 */
export function checkTerm(licence: Licence): Result<true, LicenceRefusal> {
  const from = parseDate(licence.notBefore);
  const to = parseDate(licence.notAfter);
  if (from === undefined || to === undefined) return refuse('MALFORMED', 'The term’s dates do not parse');
  if (dayNumber(to) <= dayNumber(from)) return refuse('TERM_NOT_POSITIVE', 'notAfter is after notBefore');
  const limit = licence.kind === 'POC' ? addMonths(from, 1) : addDays(addMonths(from, 12), 1);
  if (dayNumber(to) > dayNumber(limit))
    return refuse(
      'TERM_TOO_LONG',
      licence.kind === 'POC'
        ? 'A POC licence runs for at most one calendar month; extend it with a new licence'
        : 'An annual licence runs for at most twelve months and one day',
    );
  if (licence.graceDays !== GRACE_DAYS[licence.kind])
    return refuse(
      'GRACE_DAYS_MISMATCH',
      `A ${licence.kind} licence carries ${String(GRACE_DAYS[licence.kind])} days of grace`,
    );
  return ok(true);
}

// -- Verification -------------------------------------------------------------------

/** The signature over the canonical form of what was parsed — never over the bytes as received. */
function signed(
  signature: string,
  keyId: string,
  verifier: LicenceVerifier,
  parsed: unknown,
): Result<true, LicenceRefusal> {
  const canonical = canonicalJson(parsed);
  if (canonical === undefined) return refuse('MALFORMED', 'The document has no canonical form');
  const outcome = verifier.check(new TextEncoder().encode(canonical), signature, keyId);
  if (outcome === 'KEY_UNKNOWN')
    return refuse('KEY_UNKNOWN', 'The document is signed with a key this build does not hold');
  if (outcome === 'SIGNATURE_INVALID') return refuse('SIGNATURE_INVALID', 'The signature does not verify');
  return ok(true);
}

function parseJson(text: string): Result<unknown, LicenceRefusal> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return refuse('MALFORMED', 'The document is not JSON');
  }
}

/** A signed licence, verified: shape, signature, term rules, and the installation it is bound to. */
export function verifyLicence(
  doc: SignedDocument,
  verifier: LicenceVerifier,
  installationId: string,
): Result<Licence, LicenceRefusal> {
  if (doc.kind !== 'LICENCE') return refuse('MALFORMED', 'This is not a licence');
  const json = parseJson(doc.document);
  if (!json.ok) return json;
  const licence = parseLicence(json.value);
  if (!licence.ok) return licence;
  const sig = signed(doc.signature, licence.value.keyId, verifier, json.value);
  if (!sig.ok) return sig;
  const term = checkTerm(licence.value);
  if (!term.ok) return term;
  if (licence.value.installationId !== installationId)
    return refuse('INSTALLATION_MISMATCH', 'The licence is bound to a different installation');
  return ok(licence.value);
}

/** A signed revocation, verified: shape, signature, and the installation it is addressed to. */
export function verifyRevocation(
  doc: SignedDocument,
  verifier: LicenceVerifier,
  installationId: string,
): Result<Revocation, LicenceRefusal> {
  if (doc.kind !== 'REVOCATION') return refuse('MALFORMED', 'This is not a revocation');
  const json = parseJson(doc.document);
  if (!json.ok) return json;
  const revocation = parseRevocation(json.value);
  if (!revocation.ok) return revocation;
  const sig = signed(doc.signature, revocation.value.keyId, verifier, json.value);
  if (!sig.ok) return sig;
  if (revocation.value.installationId !== installationId)
    return refuse('INSTALLATION_MISMATCH', 'The revocation is addressed to a different installation');
  return ok(revocation.value);
}

/** An uploaded licence file, verified end to end. */
export function verifyLicenceFile(
  text: string,
  verifier: LicenceVerifier,
  installationId: string,
): Result<{ readonly licence: Licence; readonly signed: SignedDocument }, LicenceRefusal> {
  const file = parseSignedFile(text);
  if (!file.ok) return file;
  if (file.value.kind !== 'LICENCE') return refuse('MALFORMED', 'The file carries a revocation, not a licence');
  const licence = verifyLicence(file.value, verifier, installationId);
  if (!licence.ok) return licence;
  return ok({ licence: licence.value, signed: file.value });
}
