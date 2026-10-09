/**
 * A stand-in issuer for licensing tests.
 *
 * Generates a P-256 key pair at runtime — no key material is checked in — and
 * signs exactly as the issuer must: ES256 over the canonical serialisation of
 * the inner object, IEEE P1363 r‖s, base64url. Tests verify against the
 * public half through a test keyring, which `createVerifier` accepts outside
 * production only.
 */

import { generateKeyPairSync, sign } from 'node:crypto';

import type { EcP256PublicJwk, Keyring } from '../../core/licensing/keys.ts';
import type { Licence, Revocation } from '../../core/licensing/licence.ts';
import { type LicenceVerifier, canonicalJson, createVerifier } from '../../core/licensing/verify.ts';
import { expectOk } from '../../core/kernel/result.ts';

export const INSTALLATION = '0b5e7a2c-4d1f-4c3e-9a8b-1c2d3e4f5a6b';
export const OTHER_INSTALLATION = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
export const KEY_ID = 'issuer-test-2026';

export interface TestIssuer {
  readonly keyId: string;
  readonly keyring: Keyring;
  signLicence(licence: Licence): string;
  signRevocation(revocation: Revocation): string;
  /** A signature over arbitrary canonicalisable content, for tamper tests. */
  signatureOver(value: unknown): string;
}

export function testIssuer(keyId = KEY_ID): TestIssuer {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const pub: EcP256PublicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  const signatureOver = (value: unknown): string => {
    const canonical = canonicalJson(value);
    if (canonical === undefined) throw new Error('not canonicalisable');
    return sign('sha256', Buffer.from(canonical, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString(
      'base64url',
    );
  };
  return {
    keyId,
    keyring: { [keyId]: pub },
    signatureOver,
    signLicence: (licence) => JSON.stringify({ licence, signature: signatureOver(licence) }),
    signRevocation: (revocation) => JSON.stringify({ revocation, signature: signatureOver(revocation) }),
  };
}

export function testVerifier(issuer: TestIssuer): LicenceVerifier {
  return expectOk(createVerifier({ nodeEnv: 'test', testKeyring: issuer.keyring }));
}

let counter = 0;
/** A fresh lower-case UUID, deterministic per run. */
export function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export function annual(over: Partial<Licence> = {}): Licence {
  return {
    licenceId: uuid(),
    kind: 'ANNUAL',
    licensee: 'Illustrative Institution',
    installationId: INSTALLATION,
    jurisdictions: ['SA', 'AE'],
    products: ['murabaha-scf', 'bnpl', 'tawarruq-personal', 'sme-term-conventional', 'conventional-term'],
    maxActiveTenants: 5,
    notBefore: '2026-01-01',
    notAfter: '2027-01-01',
    graceDays: 30,
    supersedes: null,
    issuedAt: '2025-12-15T10:00:00Z',
    issuedBy: 'issuer-ops',
    keyId: KEY_ID,
    ...over,
  };
}

export function poc(over: Partial<Licence> = {}): Licence {
  return annual({ kind: 'POC', notBefore: '2026-10-01', notAfter: '2026-11-01', graceDays: 7, ...over });
}

/** Epoch seconds of a UTC date (and optional hour). */
export function at(date: string, hour = 12): bigint {
  return BigInt(Date.parse(`${date}T00:00:00Z`) / 1000) + BigInt(hour * 3600);
}
