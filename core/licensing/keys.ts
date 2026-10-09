/**
 * The issuer's public keys, compiled into the build (ADR 0006 §1).
 *
 * Keyed by `keyId`, so a key can rotate without invalidating a licence signed
 * under the previous one: add the new key, keep the old one until every
 * licence it signed has expired.
 *
 * EMPTY for now, on purpose. The issuer's production public key is added here
 * at provisioning: it is the public half of the issuer's P-256 signing key,
 * which lives in a managed HSM and never leaves it, exported as a JWK
 * (`kty: EC`, `crv: P-256`, `x`, `y`). Until it is added, a production build
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

export const PRODUCTION_KEYRING: Keyring = Object.freeze({});
