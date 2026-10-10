/**
 * SR-016: a rail that offers mutual TLS is called over a real handshake: the
 * institution presents its client certificate, the server is trusted only
 * through the CA given for it, and only with a pinned key when pins are set.
 * Certificates are generated for the run with the openssl CLI; skipped where
 * it is absent.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MutualTlsTransport, spkiSha256 } from '../../adapters/kernel/mutual-tls-transport.ts';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)('mutual TLS transport (SR-016)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sanad-mtls-'));
  const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  const read = (f: string) => readFileSync(join(dir, f), 'utf8');
  let server: Server;
  let url: string;

  /** A CA, and a certificate it issues for `name` (with `localhost` and 127.0.0.1 as alternative names). */
  const issue = (ca: string, name: string) => {
    ssl(
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=${name}`,
    );
    ssl(
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      `${ca}.crt`,
      '-CAkey',
      `${ca}.key`,
      '-CAcreateserial',
      '-out',
      `${name}.crt`,
      '-days',
      '1',
      '-extfile',
      'san.cnf',
    );
  };
  const authority = (name: string) =>
    ssl(
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.crt`,
      '-days',
      '1',
      '-subj',
      `/CN=${name}`,
    );

  beforeAll(async () => {
    execFileSync('sh', ['-c', 'printf "subjectAltName=DNS:localhost,IP:127.0.0.1\\n" > san.cnf'], { cwd: dir });
    authority('rail-ca');
    authority('other-ca');
    authority('client-ca');
    issue('rail-ca', 'rail');
    issue('client-ca', 'institution');
    issue('other-ca', 'stranger');
    server = createServer(
      {
        key: read('rail.key'),
        cert: read('rail.crt'),
        ca: read('client-ca.crt'),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      },
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `https://localhost:${String((server.address() as AddressInfo).port)}/v1/ping`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const transport = (over: Partial<ConstructorParameters<typeof MutualTlsTransport>[0]> = {}) =>
    new MutualTlsTransport({
      clientCertificate: read('institution.crt'),
      clientKey: read('institution.key'),
      serverCa: read('rail-ca.crt'),
      timeoutMs: 5_000,
      ...over,
    });
  const ping = (t: MutualTlsTransport) => t.call('rail.ping', { method: 'GET', url, headers: {} });
  const railPin = () => spkiSha256(Buffer.from(read('rail.crt').replace(/-----[^-]+-----|\s/g, ''), 'base64'));

  it('answers over a handshake that presents the client certificate, with the server key pinned', async () => {
    expect(await ping(transport({ pinnedSpkiSha256: [railPin()] }))).toEqual({ ok: true, path: '/v1/ping' });
  });

  it('is refused by the rail without a certificate its CA issued', async () => {
    await expect(
      ping(transport({ clientCertificate: read('stranger.crt'), clientKey: read('stranger.key') })),
    ).rejects.toThrow(/rail\.ping/);
  });

  it('refuses a server its configured CA did not issue, whatever the system store says', async () => {
    await expect(ping(transport({ serverCa: read('other-ca.crt') }))).rejects.toThrow(/rail\.ping/);
  });

  it('refuses a server whose key is not pinned, before sending anything', async () => {
    await expect(
      ping(transport({ pinnedSpkiSha256: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='] })),
    ).rejects.toThrow(/server key not pinned/);
  });
});
