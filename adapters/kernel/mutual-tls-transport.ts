/**
 * The live transport for a rail that offers mutual TLS (SR-016): the
 * institution's client certificate is presented, the rail's server is trusted
 * only through the CA given for it (not the system store), and optionally
 * only when its public key is one pinned by SHA-256 of its SPKI.
 *
 * Same contract as `HttpTransport`: one JSON call, a timeout, no retries, a
 * typed failure, and a vendor's error body never travels past the adapter.
 * The certificate and key come from the vault; this module never logs them.
 * `node:https`, so no client library is added for it.
 */

import { createHash, X509Certificate } from 'node:crypto';
import { request } from 'node:https';
import { type PeerCertificate, checkServerIdentity } from 'node:tls';

const NOT_PINNED = 'server key not pinned';

import { type RailEnvelope, type RailTransport, TransportError } from './http-transport.ts';

export interface MutualTlsOptions {
  /** PEM. */
  readonly clientCertificate: string;
  /** PEM. */
  readonly clientKey: string;
  /** PEM: the CA that issues the rail's server certificate. The only trust anchor. */
  readonly serverCa: string;
  /** Base64 SHA-256 of the server certificate's SPKI. When given, the server's key must be one of these. */
  readonly pinnedSpkiSha256?: readonly string[];
  readonly timeoutMs?: number;
}

/** Base64 SHA-256 of a certificate's SubjectPublicKeyInfo (the HPKP form). */
export function spkiSha256(certificateDer: Buffer): string {
  const spki = new X509Certificate(certificateDer).publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(spki).digest('base64');
}

/** Whether a presented server certificate carries a pinned key; with no pins, any key the CA vouches for. */
export const pinned = (peer: Pick<PeerCertificate, 'raw'>, pins: readonly string[] | undefined): boolean =>
  pins === undefined || pins.length === 0 || pins.includes(spkiSha256(peer.raw));

export class MutualTlsTransport implements RailTransport {
  constructor(private readonly o: MutualTlsOptions) {}

  call(operation: string, envelope: RailEnvelope): Promise<Readonly<Record<string, unknown>>> {
    const url = new URL(envelope.url);
    if (url.protocol !== 'https:')
      return Promise.reject(new TransportError(operation, undefined, `${operation}: not https`));
    const body = envelope.body === undefined ? undefined : JSON.stringify(envelope.body);
    return new Promise((resolve, reject) => {
      const fail = (status: number | undefined, why: string) =>
        reject(new TransportError(operation, status, `${operation}: ${why}`));
      const req = request(
        url,
        {
          method: envelope.method,
          cert: this.o.clientCertificate,
          key: this.o.clientKey,
          ca: this.o.serverCa,
          rejectUnauthorized: true,
          // A connection of its own: the shared agent would reuse a socket (or resume a session) that another
          // transport opened under other pins, and the check below would never run.
          agent: false,
          // During the handshake, after the CA has vouched for the name, before a byte of the request is sent.
          checkServerIdentity: (host, cert) =>
            checkServerIdentity(host, cert) ??
            (pinned(cert, this.o.pinnedSpkiSha256) ? undefined : new Error(NOT_PINNED)),
          timeout: this.o.timeoutMs ?? 30_000,
          headers: {
            accept: 'application/json',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...envelope.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status < 200 || status >= 300) return fail(status, `HTTP ${String(status)}`);
            const text = Buffer.concat(chunks).toString('utf8');
            if (text.trim().length === 0) return resolve({});
            try {
              const parsed: unknown = JSON.parse(text);
              resolve(
                typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                  ? (parsed as Record<string, unknown>)
                  : { value: parsed },
              );
            } catch {
              fail(status, 'response not JSON');
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => fail(undefined, e.message === NOT_PINNED ? NOT_PINNED : e.name));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }
}
