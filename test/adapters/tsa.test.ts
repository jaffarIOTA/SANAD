/**
 * The RFC 3161 adapter (SR-006, SDD INT-10).
 *
 * Two tokens from independent issuers are the ground truth: one FreeTSA's public
 * service gave on 2026-10-28, which must be accepted, and one LibreSSL's
 * `openssl ts -reply` made against a throwaway root, which signs with SHA-1 and
 * must be refused (adapters/tsa/README.md). Every other refusal is driven with
 * genuine signatures from the in-process authority.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HttpTsaTransport, Rfc3161TimestampAuthority } from '../../adapters/tsa/adapter.ts';
import { TAG, child, hex, integer, oid, parse } from '../../adapters/tsa/der.ts';
import { OID, timestampRequest, tokenFromResponse, verifyToken } from '../../adapters/tsa/rfc3161.ts';
import { TEST_TSA_POLICY, testTsa } from '../support/test-tsa.ts';

const fixture = (f: string): Buffer => readFileSync(join(process.cwd(), 'adapters/tsa/fixtures', f));
/** Certificates are kept as `.crt` (PEM inside): `*.pem` is ignored repository-wide so that no key is ever committed. */
const anchor = (f: string): X509Certificate => new X509Certificate(fixture(f.replace(/\.pem$/, '.crt')));
const tokenOf = (f: string): Uint8Array => {
  const t = tokenFromResponse(fixture(f));
  if (typeof t === 'string') throw new Error(t);
  return t;
};

// LibreSSL 3.3.6: `openssl ts -query -data message.txt -sha256 -cert`, then `-reply`.
const LIBRESSL = {
  digest: '17104943d56ace164cf9177396f8aee3bc2d49b8e5df361b785fa8e274675c12',
  nonce: 0x2b3717a2225c003an,
  genTime: BigInt(Date.UTC(2026, 9, 27, 21, 3, 6) / 1000),
  policy: '1.3.6.1.4.1.99999.1',
};
// FreeTSA, https://freetsa.org/tsr, 2026-10-28 (00:03 Riyadh).
const FREETSA = {
  digest: '453d413c7a2cadd11acf6a2cc0ee0f4e1e890ca65a5a07ab59764e8ad3cf3eba',
  nonce: 0x4e156bcda46757dcn,
  genTime: BigInt(Date.UTC(2026, 9, 27, 21, 3, 20) / 1000),
};
const digestOf = (n: number): string => n.toString(16).padStart(64, '0');

describe('tokens from independent issuers', () => {
  it('accepts FreeTSA’s token against FreeTSA’s root: imprint, nonce, signature, ESS binding, chain', () => {
    const verdict = verifyToken(tokenOf('freetsa-response.tsr'), {
      messageDigest: FREETSA.digest,
      nonce: FREETSA.nonce,
      trustAnchors: [anchor('freetsa-root.pem')],
    });
    expect(verdict).toMatchObject({ accepted: true, token: { genTimeEpochSeconds: FREETSA.genTime } });
  });

  it('refuses LibreSSL’s token: it signs with SHA-1 whatever it is configured to do, and SHA-1 is not accepted', () => {
    // LibreSSL 3.3.6 ignores `signer_digest = sha256` and signs the CMS with SHA-1 (asn1parse shows it).
    const verdict = verifyToken(tokenOf('libressl-response.tsr'), {
      messageDigest: LIBRESSL.digest,
      nonce: LIBRESSL.nonce,
      policy: LIBRESSL.policy,
      trustAnchors: [anchor('libressl-root.pem')],
    });
    expect(verdict).toEqual({ accepted: false, reason: 'UNSUPPORTED_ALGORITHM' });
    // What it attests is still read correctly before the algorithm is judged.
    expect(
      verifyToken(tokenOf('libressl-response.tsr'), {
        messageDigest: digestOf(1),
        trustAnchors: [anchor('libressl-root.pem')],
      }),
    ).toMatchObject({ reason: 'IMPRINT_MISMATCH' });
  });

  it('refuses for another message, another nonce, another policy, or another root', () => {
    const token = tokenOf('freetsa-response.tsr');
    const base = { messageDigest: FREETSA.digest, trustAnchors: [anchor('freetsa-root.pem')] };
    expect(verifyToken(token, { ...base, messageDigest: digestOf(1) })).toEqual({
      accepted: false,
      reason: 'IMPRINT_MISMATCH',
    });
    expect(verifyToken(token, { ...base, nonce: 7n })).toMatchObject({ reason: 'NONCE_MISMATCH' });
    expect(verifyToken(token, { ...base, policy: '1.2.3' })).toMatchObject({ reason: 'POLICY_MISMATCH' });
    expect(verifyToken(token, { ...base, trustAnchors: [anchor('libressl-root.pem')] })).toMatchObject({
      reason: 'UNTRUSTED_CHAIN',
    });
  });

  it('refuses a token altered anywhere: in the TSTInfo, in the signature, or truncated', () => {
    const token = tokenOf('freetsa-response.tsr');
    const expect_ = { messageDigest: FREETSA.digest, trustAnchors: [anchor('freetsa-root.pem')] };
    const genTimeAt = Buffer.from(token).indexOf(Buffer.from('20261027210320'));
    expect(genTimeAt).toBeGreaterThan(0);
    const laterGenTime = Uint8Array.from(token);
    laterGenTime[genTimeAt + 11] = '7'.charCodeAt(0);
    expect(verifyToken(laterGenTime, expect_)).toMatchObject({ accepted: false, reason: 'CONTENT_DIGEST_MISMATCH' });
    const badSignature = Uint8Array.from(token);
    badSignature.set([(badSignature.at(-3) ?? 0) ^ 0x01], badSignature.length - 3);
    expect(verifyToken(badSignature, expect_)).toMatchObject({ accepted: false, reason: 'SIGNATURE_INVALID' });
    expect(verifyToken(token.subarray(0, token.length - 10), expect_)).toMatchObject({ reason: 'MALFORMED' });
  });
});

describe('the request', () => {
  it('asks for SHA-256 over the digest, with the nonce, the policy and the signer certificate', () => {
    const req = parse(timestampRequest(digestOf(42), 99n, '1.2.3.4'));
    expect(integer(child(req, 0, TAG.INTEGER))).toBe(1n);
    const imprint = child(req, 1, TAG.SEQUENCE);
    expect(oid(child(child(imprint, 0, TAG.SEQUENCE), 0, TAG.OID))).toBe(OID.sha256);
    expect(hex(child(imprint, 1, TAG.OCTET_STRING).value)).toBe(digestOf(42));
    expect(oid(child(req, 2, TAG.OID))).toBe('1.2.3.4');
    expect(integer(child(req, 3, TAG.INTEGER))).toBe(99n);
    expect(child(req, 4, TAG.BOOLEAN).value[0]).toBe(0xff);
  });

  it('refuses anything that is not a SHA-256 digest in hex', () => {
    expect(() => timestampRequest('abc', 1n)).toThrow(/SHA-256/);
    expect(() => timestampRequest(digestOf(1).toUpperCase().replace('0', 'G'), 1n)).toThrow();
  });
});

describe('the adapter', () => {
  const now = (): number => 1_800_000_000;

  it('stamps: the token comes back with the attestation and re-verifies for audit replay', async () => {
    const tsa = testTsa();
    const authority = new Rfc3161TimestampAuthority({
      authorityId: 'test-tsa',
      transport: tsa.transport(),
      trustAnchors: [tsa.root.x509],
      policy: TEST_TSA_POLICY,
      nowEpochSeconds: now,
    });
    const stamped = await authority.stamp(digestOf(7));
    expect(stamped).toMatchObject({ verified: true, genTimeEpochSeconds: 1_800_000_000n, authorityId: 'test-tsa' });
    expect(stamped?.token.length).toBeGreaterThan(100);
    const replayed = await authority.verify(stamped?.token ?? new Uint8Array(), digestOf(7));
    expect(replayed?.tokenDigest).toBe(stamped?.tokenDigest);
    // The same token offered for another message is not an attestation of it (SR-006: no reuse).
    expect(await authority.verify(stamped?.token ?? new Uint8Array(), digestOf(8))).toBeUndefined();
  });

  it('answers undefined, never throws, when the authority is down, refuses, or answers wrongly', async () => {
    const tsa = testTsa();
    const make = (transport: { exchange(r: Uint8Array): Promise<Uint8Array> }) =>
      new Rfc3161TimestampAuthority({
        authorityId: 'test-tsa',
        transport,
        trustAnchors: [tsa.root.x509],
        nowEpochSeconds: now,
      });
    const down = make({ exchange: () => Promise.reject(new Error('ECONNREFUSED')) });
    expect(await down.stamp(digestOf(1))).toBeUndefined();
    expect(down.refusals.get('UNAVAILABLE')).toBe(1);

    // status 2: rejection
    const rejecting = make({
      exchange: () => Promise.resolve(Uint8Array.from([0x30, 0x05, 0x30, 0x03, 0x02, 0x01, 0x02])),
    });
    expect(await rejecting.stamp(digestOf(1))).toBeUndefined();
    expect(rejecting.refusals.get('NOT_GRANTED')).toBe(1);

    // a valid token, but for another digest than asked
    const elsewhere = make({ exchange: () => Promise.resolve(tsa.respond(digestOf(2), undefined)) });
    expect(await elsewhere.stamp(digestOf(1))).toBeUndefined();
    expect(elsewhere.refusals.get('IMPRINT_MISMATCH')).toBe(1);

    // a replayed answer: right digest, stale nonce
    const replaying = make({ exchange: () => Promise.resolve(tsa.respond(digestOf(1), 5n)) });
    expect(await replaying.stamp(digestOf(1))).toBeUndefined();
    expect(replaying.refusals.get('NONCE_MISMATCH')).toBe(1);
  });

  it('refuses a signer that is not a time-stamping certificate, or not the one the token binds', async () => {
    const tsa = testTsa();
    const authority = (options: Parameters<typeof tsa.transport>[0]) =>
      new Rfc3161TimestampAuthority({
        authorityId: 'test-tsa',
        transport: tsa.transport(options),
        trustAnchors: [tsa.root.x509],
        nowEpochSeconds: now,
      });
    const serverAuth = tsa.certificate({ subject: 'Not a TSA', extendedKeyUsage: '1.3.6.1.5.5.7.3.1' });
    const a = authority({ signer: serverAuth });
    expect(await a.stamp(digestOf(1))).toBeUndefined();
    expect(a.refusals.get('SIGNER_NOT_TIMESTAMPING')).toBe(1);

    const other = tsa.certificate({ subject: 'Another TSA', extendedKeyUsage: OID.timeStamping });
    const b = authority({ essNames: other });
    expect(await b.stamp(digestOf(1))).toBeUndefined();
    expect(b.refusals.get('SIGNER_NOT_BOUND')).toBe(1);

    const c = authority({ corruptSignature: true });
    expect(await c.stamp(digestOf(1))).toBeUndefined();
    expect(c.refusals.get('SIGNATURE_INVALID')).toBe(1);
  });

  it('judges certificates at genTime: a signer expired then is refused, whatever today is', async () => {
    const tsa = testTsa();
    const expired = tsa.certificate({
      subject: 'Expired TSA',
      extendedKeyUsage: OID.timeStamping,
      notBefore: 1_700_000_000n,
      notAfter: 1_750_000_000n,
    });
    const a = new Rfc3161TimestampAuthority({
      authorityId: 'test-tsa',
      transport: tsa.transport({ signer: expired }),
      trustAnchors: [tsa.root.x509],
      nowEpochSeconds: now,
    });
    expect(await a.stamp(digestOf(1))).toBeUndefined();
    expect(a.refusals.get('CERTIFICATE_NOT_VALID_AT_GENTIME')).toBe(1);
  });

  it('needs a trust anchor to exist at all', () => {
    expect(
      () =>
        new Rfc3161TimestampAuthority({
          authorityId: 'x',
          transport: { exchange: () => Promise.resolve(new Uint8Array()) },
          trustAnchors: [],
          nowEpochSeconds: now,
        }),
    ).toThrow(/trust anchor/);
  });
});

describe('the HTTP transport', () => {
  it('posts a timestamp query and reads back a timestamp reply', async () => {
    let seen: { url: string; type: string | null } | undefined;
    const fetchImpl = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      seen = { url: String(url), type: new Headers(init?.headers).get('content-type') };
      return Promise.resolve(
        new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'application/timestamp-reply' } }),
      );
    };
    const t = new HttpTsaTransport('https://tsa.example/tsr', {}, fetchImpl as typeof fetch);
    expect([...(await t.exchange(Uint8Array.of(9)))]).toEqual([1, 2, 3]);
    expect(seen).toEqual({ url: 'https://tsa.example/tsr', type: 'application/timestamp-query' });
  });

  it('refuses plain HTTP beyond loopback, an error status, and a reply of another type', async () => {
    expect(() => new HttpTsaTransport('http://tsa.example/tsr')).toThrow(/HTTPS/);
    const answering = (status: number, type: string) =>
      new HttpTsaTransport('https://tsa.example/tsr', {}, (() =>
        Promise.resolve(new Response('x', { status, headers: { 'content-type': type } }))) as typeof fetch);
    await expect(answering(500, 'application/timestamp-reply').exchange(Uint8Array.of(1))).rejects.toThrow(/HTTP 500/);
    await expect(answering(200, 'text/html').exchange(Uint8Array.of(1))).rejects.toThrow(/not a timestamp reply/);
  });
});
