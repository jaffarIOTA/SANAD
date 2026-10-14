/**
 * AWS Signature Version 4 for S3-compatible object stores, header form only.
 *
 * Written against the published algorithm rather than taken from an SDK, so
 * the platform carries no cloud SDK and every byte that is signed can be read
 * here. Pure: the instant is passed in, nothing is read from the clock. The
 * test reproduces AWS's own worked example (GET /test.txt, 24 May 2013).
 *
 * The secret is used only as HMAC key material and is never returned,
 * concatenated into a string that leaves this module, or logged.
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigningKeys {
  readonly accessKeyId: string;
  /** The secret access key. Read from the vault immediately before signing. */
  readonly secretAccessKey: string;
  readonly region: string;
}

export interface SignableRequest {
  readonly method: 'GET' | 'PUT' | 'HEAD';
  readonly url: URL;
  /** Headers to sign besides host, x-amz-date and x-amz-content-sha256. Names in any case. */
  readonly headers: Readonly<Record<string, string>>;
  /** Lower-case hex SHA-256 of the body ('e3b0…' for an empty body). */
  readonly payloadSha256Hex: string;
}

export const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');

/** RFC 3986 encoding as SigV4 requires: everything but unreserved characters, '/' kept in paths. */
function uriEncode(value: string, keepSlash: boolean): string {
  return [...new TextEncoder().encode(value)]
    .map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9\-._~]/.test(c) || (keepSlash && c === '/')) return c;
      return `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

/** 20130524T000000Z from epoch seconds. */
export function amzDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * The headers to send: the caller's, plus host, x-amz-date,
 * x-amz-content-sha256 and Authorization.
 */
export function signRequest(req: SignableRequest, keys: SigningKeys, epochSeconds: number): Record<string, string> {
  const date = amzDate(epochSeconds);
  const day = date.slice(0, 8);
  const scope = `${day}/${keys.region}/s3/aws4_request`;

  const all: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) all[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  all['host'] = req.url.host;
  all['x-amz-date'] = date;
  all['x-amz-content-sha256'] = req.payloadSha256Hex;

  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join('');
  const signedHeaders = names.join(';');

  // The path is already percent-encoded by URL; decode and re-encode so the two encodings cannot disagree.
  const path = uriEncode(decodeURIComponent(req.url.pathname), true) || '/';
  const query = [...req.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [req.method, path, query, canonicalHeaders, signedHeaders, req.payloadSha256Hex].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${keys.secretAccessKey}`, day);
  const kRegion = hmac(kDate, keys.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const out: Record<string, string> = {};
  for (const n of names) if (n !== 'host') out[n] = all[n] ?? '';
  out['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}
