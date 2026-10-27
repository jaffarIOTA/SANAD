/**
 * RFC 3161 time-stamp tokens: the request we send, and the checks a token must
 * pass before it becomes an attested instant (SR-006, SH-06).
 *
 * A token is a CMS SignedData (RFC 5652) whose content is a TSTInfo. It is
 * accepted only when every one of these holds; the first that fails names the
 * reason, which stays inside the adapter (SR-008):
 *
 *   1. the TSTInfo's message imprint is SHA-256 over exactly the digest asked for;
 *   2. the nonce, when we sent one, comes back unchanged;
 *   3. the signed attributes name the TSTInfo content type and carry its digest;
 *   4. the signature over the signed attributes verifies with the signer's key;
 *   5. the signer certificate is the one the ESS signing-certificate attribute names;
 *   6. that certificate's only extended key usage is time stamping;
 *   7. it chains, through certificates carried in the token, to a configured
 *      trust anchor, every certificate valid at the token's genTime;
 *   8. the policy, when the institution names one, is that policy.
 *
 * Algorithms are an allow-list (SHA-256/384/512; RSA PKCS #1 v1.5 and ECDSA).
 * Anything else fails closed. No clock is read: validity is judged at genTime.
 */

import { X509Certificate, createHash, verify as verifySignature } from 'node:crypto';

import {
  type Der,
  DerError,
  TAG,
  boolean,
  child,
  context,
  equalBytes,
  find,
  generalizedTime,
  hex,
  integer,
  nullValue,
  octetString,
  oid,
  parse,
  sequence,
  writeInteger,
  writeOid,
} from './der.ts';

export const OID = {
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3',
} as const;

/** Digest algorithms a token may use, by OID. SHA-1 only ever identifies a certificate (ESS v1). */
const DIGESTS: Readonly<Record<string, string>> = {
  [OID.sha256]: 'sha256',
  [OID.sha384]: 'sha384',
  [OID.sha512]: 'sha512',
};

/** Signature algorithms a signer may use: the key type is taken from the certificate. */
const SIGNATURES: Readonly<Record<string, string | undefined>> = {
  '1.2.840.113549.1.1.1': undefined, // rsaEncryption: the digest algorithm says which hash
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
};

export type TokenFailure =
  | 'MALFORMED'
  | 'NOT_GRANTED'
  | 'IMPRINT_MISMATCH'
  | 'NONCE_MISMATCH'
  | 'POLICY_MISMATCH'
  | 'UNSUPPORTED_ALGORITHM'
  | 'CONTENT_DIGEST_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'SIGNER_NOT_FOUND'
  | 'SIGNER_NOT_BOUND'
  | 'SIGNER_NOT_TIMESTAMPING'
  | 'UNTRUSTED_CHAIN'
  | 'CERTIFICATE_NOT_VALID_AT_GENTIME';

export interface AcceptedToken {
  readonly genTimeEpochSeconds: bigint;
  /** SHA-256 of the whole token (the ContentInfo), hex: how the token is referenced once retained. */
  readonly tokenDigest: string;
  readonly serialNumber: bigint;
  readonly policy: string;
}

export type TokenVerdict =
  | { readonly accepted: true; readonly token: AcceptedToken }
  | { readonly accepted: false; readonly reason: TokenFailure };

export interface TokenExpectation {
  /** SHA-256 of the message, 64 lowercase hex characters. */
  readonly messageDigest: string;
  /** The nonce sent with the request; absent when re-verifying a retained token. */
  readonly nonce?: bigint;
  /** Certificates the institution trusts for this authority (its root, or the TSA certificate itself). */
  readonly trustAnchors: readonly X509Certificate[];
  readonly policy?: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A TimeStampReq for SHA-256 `messageDigest`, asking for the signer's certificate. */
export function timestampRequest(messageDigest: string, nonce: bigint, policy?: string): Uint8Array {
  if (!SHA256_HEX.test(messageDigest)) throw new DerError('the message digest is not SHA-256 hex');
  return sequence(
    writeInteger(1n),
    sequence(sequence(writeOid(OID.sha256), nullValue()), octetString(Buffer.from(messageDigest, 'hex'))),
    ...(policy === undefined ? [] : [writeOid(policy)]),
    writeInteger(nonce),
    boolean(true),
  );
}

/** The token out of a TimeStampResp, when the authority granted one. */
export function tokenFromResponse(response: Uint8Array): Uint8Array | 'NOT_GRANTED' | 'MALFORMED' {
  try {
    const resp = parse(response);
    const status = integer(child(child(resp, 0, TAG.SEQUENCE), 0, TAG.INTEGER));
    if (status !== 0n && status !== 1n) return 'NOT_GRANTED';
    const token = child(resp, 1, TAG.SEQUENCE);
    return Uint8Array.from(token.bytes);
  } catch {
    return 'MALFORMED';
  }
}

interface Certificate {
  readonly x509: X509Certificate;
  readonly der: Uint8Array;
  readonly serial: Uint8Array;
  readonly issuer: Uint8Array;
}

function certificate(node: Der): Certificate {
  const der = Uint8Array.from(node.bytes);
  const tbs = child(node, 0, TAG.SEQUENCE);
  const offset = tbs.children[0]?.tag === context(0) ? 1 : 0;
  return {
    x509: new X509Certificate(der),
    der,
    serial: child(tbs, offset, TAG.INTEGER).value,
    issuer: child(tbs, offset + 2, TAG.SEQUENCE).bytes,
  };
}

const digestOf = (algorithm: string, data: Uint8Array): Uint8Array =>
  Uint8Array.from(createHash(algorithm).update(data).digest());

const validAt = (c: X509Certificate, epochSeconds: bigint): boolean => {
  const at = Number(epochSeconds) * 1000;
  return Date.parse(c.validFrom) <= at && at <= Date.parse(c.validTo);
};

/** Climb from the signer through the token's certificates to a trust anchor. */
function chainsToAnchor(
  signer: X509Certificate,
  carried: readonly X509Certificate[],
  anchors: readonly X509Certificate[],
  genTime: bigint,
): TokenFailure | undefined {
  let current = signer;
  for (let depth = 0; depth < 6; depth++) {
    if (!validAt(current, genTime)) return 'CERTIFICATE_NOT_VALID_AT_GENTIME';
    if (anchors.some((a) => a.fingerprint256 === current.fingerprint256)) return undefined;
    const anchor = anchors.find((a) => current.checkIssued(a) && current.verify(a.publicKey));
    if (anchor !== undefined) return validAt(anchor, genTime) ? undefined : 'CERTIFICATE_NOT_VALID_AT_GENTIME';
    const issuer = carried.find(
      (c) => c.fingerprint256 !== current.fingerprint256 && current.checkIssued(c) && current.verify(c.publicKey),
    );
    if (issuer === undefined) return 'UNTRUSTED_CHAIN';
    current = issuer;
  }
  return 'UNTRUSTED_CHAIN';
}

/** Does the ESS signing-certificate attribute (v1 or v2) name `cert`? */
function boundToSigner(attribute: Der, version: 1 | 2, cert: Certificate): boolean {
  const essCertIds = child(child(child(attribute, 1, TAG.SET), 0, TAG.SEQUENCE), 0, TAG.SEQUENCE);
  const first = child(essCertIds, 0, TAG.SEQUENCE);
  let algorithm = version === 1 ? 'sha1' : 'sha256';
  let index = 0;
  if (version === 2 && first.children[0]?.tag === TAG.SEQUENCE) {
    const named = DIGESTS[oid(child(child(first, 0), 0, TAG.OID))];
    if (named === undefined) return false;
    algorithm = named;
    index = 1;
  }
  const certHash = child(first, index, TAG.OCTET_STRING).value;
  if (!equalBytes(certHash, digestOf(algorithm, cert.der))) return false;
  const issuerSerial = first.children[index + 1];
  return issuerSerial === undefined || equalBytes(child(issuerSerial, 1, TAG.INTEGER).value, cert.serial);
}

/** Verify a TimeStampToken (a ContentInfo) against what we asked for and whom we trust. */
export function verifyToken(token: Uint8Array, expect: TokenExpectation): TokenVerdict {
  const refuse = (reason: TokenFailure): TokenVerdict => ({ accepted: false, reason });
  if (!SHA256_HEX.test(expect.messageDigest)) return refuse('MALFORMED');
  try {
    const contentInfo = parse(token);
    if (oid(child(contentInfo, 0, TAG.OID)) !== OID.signedData) return refuse('MALFORMED');
    const signedData = child(child(contentInfo, 1, context(0)), 0, TAG.SEQUENCE);
    const encap = child(signedData, 2, TAG.SEQUENCE);
    if (oid(child(encap, 0, TAG.OID)) !== OID.tstInfo) return refuse('MALFORMED');
    const eContent = child(child(encap, 1, context(0)), 0, TAG.OCTET_STRING).value;

    // The TSTInfo: what was stamped, when, under which policy.
    const tst = parse(eContent);
    const policy = oid(child(tst, 1, TAG.OID));
    const imprint = child(tst, 2, TAG.SEQUENCE);
    if (oid(child(child(imprint, 0, TAG.SEQUENCE), 0, TAG.OID)) !== OID.sha256) return refuse('IMPRINT_MISMATCH');
    if (hex(child(imprint, 1, TAG.OCTET_STRING).value) !== expect.messageDigest) return refuse('IMPRINT_MISMATCH');
    const serialNumber = integer(child(tst, 3, TAG.INTEGER));
    const genTime = generalizedTime(child(tst, 4, TAG.GENERALIZED_TIME));
    if (expect.nonce !== undefined) {
      const nonce = tst.children.slice(5).find((c) => c.tag === TAG.INTEGER);
      if (nonce === undefined || integer(nonce) !== expect.nonce) return refuse('NONCE_MISMATCH');
    }
    if (expect.policy !== undefined && policy !== expect.policy) return refuse('POLICY_MISMATCH');

    // Exactly one signer, identified by issuer and serial.
    const certificates = (find(signedData, context(0))?.children ?? []).map(certificate);
    const signerInfos = signedData.children[signedData.children.length - 1];
    if (signerInfos?.tag !== TAG.SET || signerInfos.children.length !== 1) return refuse('MALFORMED');
    const signerInfo = child(signerInfos, 0, TAG.SEQUENCE);
    const sid = child(signerInfo, 1);
    const signer =
      sid.tag === TAG.SEQUENCE
        ? certificates.find(
            (c) =>
              equalBytes(c.issuer, child(sid, 0, TAG.SEQUENCE).bytes) &&
              equalBytes(c.serial, child(sid, 1, TAG.INTEGER).value),
          )
        : undefined;
    if (signer === undefined) return refuse('SIGNER_NOT_FOUND');

    const digestAlgorithm = DIGESTS[oid(child(child(signerInfo, 2, TAG.SEQUENCE), 0, TAG.OID))];
    const signedAttrs = child(signerInfo, 3, context(0));
    const signatureOid = oid(child(child(signerInfo, 4, TAG.SEQUENCE), 0, TAG.OID));
    const signature = child(signerInfo, 5, TAG.OCTET_STRING).value;
    if (digestAlgorithm === undefined || !(signatureOid in SIGNATURES)) return refuse('UNSUPPORTED_ALGORITHM');
    const signatureHash = SIGNATURES[signatureOid] ?? digestAlgorithm;

    const attribute = (type: string): Der | undefined =>
      signedAttrs.children.find((a) => oid(child(a, 0, TAG.OID)) === type);
    const contentType = attribute(OID.contentType);
    const messageDigest = attribute(OID.messageDigest);
    if (contentType === undefined || oid(child(child(contentType, 1, TAG.SET), 0, TAG.OID)) !== OID.tstInfo)
      return refuse('MALFORMED');
    if (
      messageDigest === undefined ||
      !equalBytes(
        child(child(messageDigest, 1, TAG.SET), 0, TAG.OCTET_STRING).value,
        digestOf(digestAlgorithm, eContent),
      )
    )
      return refuse('CONTENT_DIGEST_MISMATCH');

    // The signature covers the attributes re-tagged as a SET (RFC 5652 §5.4).
    const toVerify = Uint8Array.from(signedAttrs.bytes);
    toVerify[0] = TAG.SET;
    if (!verifySignature(signatureHash, toVerify, signer.x509.publicKey, signature)) return refuse('SIGNATURE_INVALID');

    const v2 = attribute(OID.signingCertificateV2);
    const v1 = attribute(OID.signingCertificate);
    const bound = v2 !== undefined ? boundToSigner(v2, 2, signer) : v1 !== undefined && boundToSigner(v1, 1, signer);
    if (!bound) return refuse('SIGNER_NOT_BOUND');

    const usages = signer.x509.keyUsage;
    if (usages?.length !== 1 || usages[0] !== OID.timeStamping) return refuse('SIGNER_NOT_TIMESTAMPING');

    const chain = chainsToAnchor(
      signer.x509,
      certificates.map((c) => c.x509),
      expect.trustAnchors,
      genTime,
    );
    if (chain !== undefined) return refuse(chain);

    return {
      accepted: true,
      token: {
        genTimeEpochSeconds: genTime,
        tokenDigest: createHash('sha256').update(token).digest('hex'),
        serialNumber,
        policy,
      },
    };
  } catch {
    return refuse('MALFORMED');
  }
}
