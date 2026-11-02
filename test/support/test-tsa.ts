/**
 * An RFC 3161 authority for tests: a root and a time-stamping certificate made
 * here, and real tokens over any digest, so the adapter's checks run against
 * genuine signatures rather than a stub that says "verified".
 *
 * It is checked against two independent issuers in `test/adapters/tsa.test.ts`
 * (LibreSSL's `openssl ts` and FreeTSA), so it cannot drift into agreeing only
 * with the verifier it tests. Keys live in memory for the test's life; none is
 * written anywhere.
 */

import { X509Certificate, createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import type { TsaTransport } from '../../adapters/tsa/adapter.ts';
import {
  TAG,
  child,
  encode,
  explicit,
  hex,
  integer,
  octetString,
  parse,
  sequence,
  set,
  writeInteger,
  writeOid,
} from '../../adapters/tsa/der.ts';
import { OID } from '../../adapters/tsa/rfc3161.ts';

const ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const name = (cn: string): Uint8Array =>
  sequence(set(sequence(writeOid('2.5.4.3'), encode(TAG.UTF8_STRING, utf8(cn)))));
const algorithm = (o: string): Uint8Array => sequence(writeOid(o));
const bitString = (bytes: Uint8Array, unused = 0): Uint8Array =>
  encode(TAG.BIT_STRING, Uint8Array.from([unused, ...bytes]));

/** UTCTime for 1950–2049, as RFC 5280 requires. */
function utcTime(epochSeconds: bigint): Uint8Array {
  const d = new Date(Number(epochSeconds) * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  const text = `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
  return encode(TAG.UTC_TIME, utf8(text));
}

function generalizedTime(epochSeconds: bigint): Uint8Array {
  const iso = new Date(Number(epochSeconds) * 1000).toISOString();
  return encode(TAG.GENERALIZED_TIME, utf8(`${iso.slice(0, 19).replace(/[-:T]/g, '')}Z`));
}

const extension = (o: string, critical: boolean, value: Uint8Array): Uint8Array =>
  sequence(writeOid(o), ...(critical ? [encode(TAG.BOOLEAN, Uint8Array.of(0xff))] : []), octetString(value));

interface Issued {
  readonly der: Uint8Array;
  readonly x509: X509Certificate;
  readonly key: KeyObject;
  readonly subject: Uint8Array;
  readonly serial: bigint;
}

function certificate(p: {
  readonly serial: bigint;
  readonly subject: string;
  readonly issuer?: Issued;
  readonly ca: boolean;
  readonly extendedKeyUsage?: string;
  readonly notBefore: bigint;
  readonly notAfter: bigint;
}): Issued {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const subject = name(p.subject);
  const extensions = [
    extension('2.5.29.19', true, p.ca ? sequence(encode(TAG.BOOLEAN, Uint8Array.of(0xff))) : sequence()),
    extension('2.5.29.15', true, p.ca ? bitString(Uint8Array.of(0x06), 1) : bitString(Uint8Array.of(0x80), 7)),
    ...(p.extendedKeyUsage === undefined ? [] : [extension('2.5.29.37', true, sequence(writeOid(p.extendedKeyUsage)))]),
  ];
  const tbs = sequence(
    explicit(0, writeInteger(2n)),
    writeInteger(p.serial),
    algorithm(ECDSA_SHA256),
    p.issuer?.subject ?? subject,
    sequence(utcTime(p.notBefore), utcTime(p.notAfter)),
    subject,
    Uint8Array.from(publicKey.export({ type: 'spki', format: 'der' })),
    explicit(3, sequence(...extensions)),
  );
  const signature = sign('sha256', tbs, p.issuer?.key ?? privateKey);
  const der = sequence(tbs, algorithm(ECDSA_SHA256), bitString(Uint8Array.from(signature)));
  return { der, x509: new X509Certificate(der), key: privateKey, subject, serial: p.serial };
}

export interface IssueOptions {
  /** Sign with this certificate instead of the authority's own. */
  readonly signer?: Issued;
  /** Name this certificate in the ESS attribute instead of the signer. */
  readonly essNames?: Issued;
  readonly policy?: string;
  /** Change one byte of the signature after signing. */
  readonly corruptSignature?: boolean;
}

export interface TestTsa {
  readonly root: Issued;
  readonly signer: Issued;
  /** Another certificate under the same root, for refusals. */
  certificate(p: { subject: string; extendedKeyUsage?: string; notBefore?: bigint; notAfter?: bigint }): Issued;
  /** A TimeStampResp granting a token over `messageDigest` at the authority's current time. */
  respond(messageDigest: string, nonce: bigint | undefined, options?: IssueOptions): Uint8Array;
  /** A transport answering every request as `respond` would, with the request's own digest and nonce. */
  transport(options?: IssueOptions): TsaTransport & { requests: number };
  /** Move the authority's clock. */
  setNow(epochSeconds: bigint): void;
}

export const TEST_TSA_POLICY = '1.3.6.1.4.1.99999.7';

export function testTsa(nowEpochSeconds = 1_800_000_000n): TestTsa {
  let now = nowEpochSeconds;
  let serial = 100n;
  const notBefore = now - 86_400n * 365n;
  const notAfter = now + 86_400n * 365n * 5n;
  const root = certificate({ serial: 1n, subject: 'Sanad Test Root', ca: true, notBefore, notAfter });
  const signer = certificate({
    serial: 2n,
    subject: 'Sanad Test TSA',
    issuer: root,
    ca: false,
    extendedKeyUsage: OID.timeStamping,
    notBefore,
    notAfter,
  });

  function respond(messageDigest: string, nonce: bigint | undefined, options: IssueOptions = {}): Uint8Array {
    const by = options.signer ?? signer;
    const tstInfo = sequence(
      writeInteger(1n),
      writeOid(options.policy ?? TEST_TSA_POLICY),
      sequence(sequence(writeOid(OID.sha256)), octetString(Buffer.from(messageDigest, 'hex'))),
      writeInteger((serial += 1n)),
      generalizedTime(now),
      ...(nonce === undefined ? [] : [writeInteger(nonce)]),
    );
    const named = options.essNames ?? by;
    const signedAttrs = [
      sequence(writeOid(OID.contentType), set(writeOid(OID.tstInfo))),
      sequence(
        writeOid(OID.messageDigest),
        set(octetString(Uint8Array.from(createHash('sha256').update(tstInfo).digest()))),
      ),
      sequence(
        writeOid(OID.signingCertificateV2),
        set(
          sequence(sequence(sequence(octetString(Uint8Array.from(createHash('sha256').update(named.der).digest()))))),
        ),
      ),
    ];
    const attrsAsSet = set(...signedAttrs);
    const signature = Uint8Array.from(sign('sha256', attrsAsSet, by.key));
    if (options.corruptSignature === true) signature.set([(signature.at(-1) ?? 0) ^ 0x01], signature.length - 1);
    const attrsImplicit = Uint8Array.from(attrsAsSet);
    attrsImplicit[0] = 0xa0;
    // Every signer this authority uses is issued by its root.
    const issuerOfSigner = root.subject;
    const signerInfo = sequence(
      writeInteger(1n),
      sequence(issuerOfSigner, writeInteger(by.serial)),
      algorithm(OID.sha256),
      attrsImplicit,
      algorithm(ECDSA_SHA256),
      octetString(signature),
    );
    const certs = Uint8Array.from([...by.der]);
    const signedData = sequence(
      writeInteger(3n),
      set(algorithm(OID.sha256)),
      sequence(writeOid(OID.tstInfo), explicit(0, octetString(tstInfo))),
      encode(0xa0, certs),
      set(signerInfo),
    );
    const token = sequence(writeOid(OID.signedData), explicit(0, signedData));
    return sequence(sequence(writeInteger(0n)), token);
  }

  return {
    root,
    signer,
    certificate: (p) =>
      certificate({
        serial: (serial += 1n),
        subject: p.subject,
        issuer: root,
        ca: false,
        ...(p.extendedKeyUsage === undefined ? {} : { extendedKeyUsage: p.extendedKeyUsage }),
        notBefore: p.notBefore ?? notBefore,
        notAfter: p.notAfter ?? notAfter,
      }),
    respond,
    transport(options) {
      const t = {
        requests: 0,
        exchange(request: Uint8Array): Promise<Uint8Array> {
          t.requests += 1;
          const req = parse(request);
          const digest = hex(child(child(req, 1, TAG.SEQUENCE), 1, TAG.OCTET_STRING).value);
          const nonceNode = req.children.find((c, i) => i >= 2 && c.tag === TAG.INTEGER);
          return Promise.resolve(respond(digest, nonceNode === undefined ? undefined : integer(nonceNode), options));
        },
      };
      return t;
    },
    setNow(epochSeconds) {
      now = epochSeconds;
    },
  };
}
