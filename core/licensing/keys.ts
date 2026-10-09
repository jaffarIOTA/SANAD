/**
 * The issuer's public keys, compiled into the build (ADR 0006 §1).
 *
 * Keyed by `keyId`, so a key can rotate without invalidating a licence signed
 * under the previous one: add the new key, keep the old one until every
 * licence it signed has expired.
 *
 * Each entry is the public half of one of the issuer's P-256 signing keys,
 * which live in a managed HSM and never leave it, exported as a JWK
 * (`kty: EC`, `crv: P-256`, `x`, `y`). Without an entry, a production build
 * verifies no licence, and so — by design — starts no new business.
 *
 * A public key is not a secret; it belongs in the source. A private key never
 * does, and nothing in this repository signs a licence (the issuer is not in
 * this repository).
 */

/** An ECDSA P-256 public key as a JSON Web Key. */
export interface EcP256PublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

export type Keyring = Readonly<Record<string, EcP256PublicJwk>>;

export const PRODUCTION_KEYRING: Keyring = Object.freeze({
  // Created 2026-10-09 in the issuer's HSM (EC-HSM, P-256, sign/verify only).
  // Verified at provisioning: an ES256 signature from the HSM checks against
  // this key in the 64-byte IEEE P1363 form verify.ts expects.
  'issuer-2026-10': {
    kty: 'EC',
    crv: 'P-256',
    x: 'e9_lEadDYDA1H2ywizBBUKU0Lvjf0ppmx13WHm7RDTc',
    y: 'MtevAxOuYOO86eVu6KRRVn5dKkZ5hm9FWKAGiW4avRY',
  },
});
