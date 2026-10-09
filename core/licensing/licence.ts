/**
 * The installation licence (ADR 0006 §1), and a strict parser for it.
 *
 * A licence is data the issuer signs, never something an installation edits.
 * The parser is deliberately unforgiving: an unknown key, a missing key, a
 * float where a count belongs, a date that is not a calendar day — each is a
 * refusal with a typed reason, because a lenient parser is how a field the
 * signature did not cover ends up deciding something.
 *
 * The licensee's legal name is carried as data only. Nothing in core/ or
 * products/ names an institution.
 */

import { type Result, err, ok } from '../kernel/result.ts';
import { parseDate, parseInstant } from './dates.ts';

export type LicenceKind = 'ANNUAL' | 'POC';
export type LicensedJurisdiction = 'SA' | 'AE';

/** Exactly the fields of ADR 0006 §1. Dates are `YYYY-MM-DD` (UTC); `issuedAt` is `YYYY-MM-DDTHH:MM:SSZ`. */
export interface Licence {
  readonly licenceId: string;
  readonly kind: LicenceKind;
  /** The institution's legal name, as data. */
  readonly licensee: string;
  /** The one installation this licence is bound to. */
  readonly installationId: string;
  readonly jurisdictions: readonly LicensedJurisdiction[];
  /** Product module codes entitled, e.g. `bnpl`. */
  readonly products: readonly string[];
  readonly maxActiveTenants: number;
  /** First day in force, 00:00 UTC. */
  readonly notBefore: string;
  /** First day no longer in force, 00:00 UTC (exclusive). An extension starts here. */
  readonly notAfter: string;
  /** 30 for ANNUAL, 7 for POC. */
  readonly graceDays: number;
  /** The licence this one replaces, or null. */
  readonly supersedes: string | null;
  readonly issuedAt: string;
  readonly issuedBy: string;
  /** Selects the issuer's public key, so keys rotate without invalidating issued licences. */
  readonly keyId: string;
}

/**
 * A signed revocation (ADR 0006 §3). It never stops an installation outright:
 * it ends the licence's term on `effectiveFrom`, and the grace period starts there.
 */
export interface Revocation {
  readonly revocationId: string;
  readonly licenceId: string;
  readonly installationId: string;
  readonly effectiveFrom: string;
  readonly issuedAt: string;
  readonly issuedBy: string;
  readonly keyId: string;
}

/** Why a licence document, or a revocation, was refused. */
export type LicenceRefusalReason =
  | 'MALFORMED'
  | 'UNKNOWN_KEY'
  | 'KEY_UNKNOWN'
  | 'SIGNATURE_INVALID'
  | 'TERM_NOT_POSITIVE'
  | 'TERM_TOO_LONG'
  | 'GRACE_DAYS_MISMATCH'
  | 'INSTALLATION_MISMATCH'
  | 'KEYRING_INJECTION_REFUSED';

export interface LicenceRefusal {
  readonly reason: LicenceRefusalReason;
  /** English, for the audit trail and the administrator. Never carries a key or a signature. */
  readonly detail: string;
}

const refuse = (reason: LicenceRefusalReason, detail: string): Result<never, LicenceRefusal> => err({ reason, detail });

export const LICENCE_KEYS: readonly (keyof Licence)[] = [
  'licenceId',
  'kind',
  'licensee',
  'installationId',
  'jurisdictions',
  'products',
  'maxActiveTenants',
  'notBefore',
  'notAfter',
  'graceDays',
  'supersedes',
  'issuedAt',
  'issuedBy',
  'keyId',
];

export const REVOCATION_KEYS: readonly (keyof Revocation)[] = [
  'revocationId',
  'licenceId',
  'installationId',
  'effectiveFrom',
  'issuedAt',
  'issuedBy',
  'keyId',
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRODUCT_CODE = /^[a-z][a-z0-9-]{1,63}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max && v === v.trim();
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): Result<true, LicenceRefusal> {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) return refuse('UNKNOWN_KEY', `The ${what} carries a key that is not part of it`);
  const missing = allowed.filter((k) => !(k in value));
  if (missing.length > 0) return refuse('MALFORMED', `The ${what} is missing ${missing.join(', ')}`);
  return ok(true);
}

/** A licence from its parsed JSON. Strict: unknown keys are refused, nothing is defaulted. */
export function parseLicence(value: unknown): Result<Licence, LicenceRefusal> {
  if (!isPlainObject(value)) return refuse('MALFORMED', 'A licence is a JSON object');
  const keys = exactKeys(value, LICENCE_KEYS, 'licence');
  if (!keys.ok) return keys;
  const v = value;
  if (!isUuid(v['licenceId'])) return refuse('MALFORMED', 'licenceId is a lower-case UUID');
  if (v['kind'] !== 'ANNUAL' && v['kind'] !== 'POC') return refuse('MALFORMED', 'kind is ANNUAL or POC');
  if (!isText(v['licensee'], 300)) return refuse('MALFORMED', 'licensee is the institution’s legal name');
  if (!isUuid(v['installationId'])) return refuse('MALFORMED', 'installationId is a lower-case UUID');
  const jurisdictions = v['jurisdictions'];
  if (
    !Array.isArray(jurisdictions) ||
    jurisdictions.length === 0 ||
    !jurisdictions.every((j) => j === 'SA' || j === 'AE') ||
    new Set(jurisdictions).size !== jurisdictions.length
  )
    return refuse('MALFORMED', 'jurisdictions is a non-empty list of SA and AE, without repeats');
  const products = v['products'];
  if (
    !Array.isArray(products) ||
    products.length === 0 ||
    !products.every((p) => typeof p === 'string' && PRODUCT_CODE.test(p)) ||
    new Set(products).size !== products.length
  )
    return refuse('MALFORMED', 'products is a non-empty list of product module codes, without repeats');
  if (!isCount(v['maxActiveTenants'])) return refuse('MALFORMED', 'maxActiveTenants is a positive whole number');
  if (parseDate(v['notBefore']) === undefined) return refuse('MALFORMED', 'notBefore is a date, YYYY-MM-DD');
  if (parseDate(v['notAfter']) === undefined) return refuse('MALFORMED', 'notAfter is a date, YYYY-MM-DD');
  if (!isCount(v['graceDays'])) return refuse('MALFORMED', 'graceDays is a positive whole number');
  if (v['supersedes'] !== null && !isUuid(v['supersedes']))
    return refuse('MALFORMED', 'supersedes is the replaced licence’s id, or null');
  if (v['supersedes'] === v['licenceId']) return refuse('MALFORMED', 'a licence does not supersede itself');
  if (parseInstant(v['issuedAt']) === undefined)
    return refuse('MALFORMED', 'issuedAt is an instant, YYYY-MM-DDTHH:MM:SSZ');
  if (!isText(v['issuedBy'], 200)) return refuse('MALFORMED', 'issuedBy names the issuing principal');
  if (typeof v['keyId'] !== 'string' || !KEY_ID.test(v['keyId']))
    return refuse('MALFORMED', 'keyId names the signing key');
  return ok({
    licenceId: v['licenceId'],
    kind: v['kind'],
    licensee: v['licensee'],
    installationId: v['installationId'],
    jurisdictions: [...(jurisdictions as LicensedJurisdiction[])],
    products: [...(products as string[])],
    maxActiveTenants: v['maxActiveTenants'],
    notBefore: v['notBefore'] as string,
    notAfter: v['notAfter'] as string,
    graceDays: v['graceDays'],
    supersedes: v['supersedes'] as string | null,
    issuedAt: v['issuedAt'] as string,
    issuedBy: v['issuedBy'],
    keyId: v['keyId'],
  });
}

/** A revocation from its parsed JSON. Strict, like the licence. */
export function parseRevocation(value: unknown): Result<Revocation, LicenceRefusal> {
  if (!isPlainObject(value)) return refuse('MALFORMED', 'A revocation is a JSON object');
  const keys = exactKeys(value, REVOCATION_KEYS, 'revocation');
  if (!keys.ok) return keys;
  const v = value;
  if (!isUuid(v['revocationId'])) return refuse('MALFORMED', 'revocationId is a lower-case UUID');
  if (!isUuid(v['licenceId'])) return refuse('MALFORMED', 'licenceId is a lower-case UUID');
  if (!isUuid(v['installationId'])) return refuse('MALFORMED', 'installationId is a lower-case UUID');
  if (parseDate(v['effectiveFrom']) === undefined) return refuse('MALFORMED', 'effectiveFrom is a date, YYYY-MM-DD');
  if (parseInstant(v['issuedAt']) === undefined)
    return refuse('MALFORMED', 'issuedAt is an instant, YYYY-MM-DDTHH:MM:SSZ');
  if (!isText(v['issuedBy'], 200)) return refuse('MALFORMED', 'issuedBy names the issuing principal');
  if (typeof v['keyId'] !== 'string' || !KEY_ID.test(v['keyId']))
    return refuse('MALFORMED', 'keyId names the signing key');
  return ok({
    revocationId: v['revocationId'],
    licenceId: v['licenceId'],
    installationId: v['installationId'],
    effectiveFrom: v['effectiveFrom'] as string,
    issuedAt: v['issuedAt'] as string,
    issuedBy: v['issuedBy'],
    keyId: v['keyId'],
  });
}

/**
 * A signed document as it travels and as it is stored: the inner object's JSON
 * text and the detached signature over its canonical form (see `verify.ts`).
 */
export interface SignedDocument {
  readonly kind: 'LICENCE' | 'REVOCATION';
  /** The inner object, as JSON text. Re-canonicalised before verification, so whitespace here is harmless. */
  readonly document: string;
  /** base64url, no padding: the 64-byte IEEE P1363 r‖s ES256 signature. */
  readonly signature: string;
}

/**
 * The file an administrator uploads, or the check-in server returns:
 * `{"licence":{…},"signature":"…"}` or `{"revocation":{…},"signature":"…"}`.
 * Exactly two keys; anything else is refused.
 */
export function parseSignedFile(text: string): Result<SignedDocument, LicenceRefusal> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('MALFORMED', 'The file is not JSON');
  }
  if (!isPlainObject(parsed)) return refuse('MALFORMED', 'The file is a JSON object');
  const kind = 'licence' in parsed ? 'LICENCE' : 'revocation' in parsed ? 'REVOCATION' : undefined;
  if (kind === undefined) return refuse('MALFORMED', 'The file carries a licence or a revocation');
  const inner = kind === 'LICENCE' ? 'licence' : 'revocation';
  const keys = exactKeys(parsed, [inner, 'signature'], 'signed file');
  if (!keys.ok) return keys;
  if (typeof parsed['signature'] !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(parsed['signature']))
    return refuse('MALFORMED', 'signature is 64 bytes, base64url without padding');
  if (!isPlainObject(parsed[inner])) return refuse('MALFORMED', `${inner} is a JSON object`);
  return ok({ kind, document: JSON.stringify(parsed[inner]), signature: parsed['signature'] });
}
