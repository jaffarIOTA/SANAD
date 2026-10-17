/**
 * A development signing service for Document Engine (verification check V-04,
 * adapters/nutrient/verification/README.md). Nothing real is signed here.
 *
 * Document Engine does not hold the signing key: on `POST /api/documents/{id}/sign`
 * it calls out to the service named by `SIGNING_SERVICE_URL`. This is that
 * service, for plumbing only, with a throwaway self-signed CA and signer
 * certificate made by `scripts/nutrient-dev-signing-cert.sh`. In production the
 * same callback is answered by the institution's signing service in front of the
 * in-Kingdom HSM, holding the licensed certificate service provider's
 * certificate (OI-06); Sanad's code does not change between the two.
 *
 * It answers the engine's RAW container protocol only:
 * - `{ action: "get_certificates" }` → the signer certificate and the CA chain,
 *   each a Base64-encoded PEM;
 * - `{ action: "sign", data_to_be_signed, hash_algorithm }` → the DER-encoded
 *   RSASSA-PKCS1-v1_5 signature over the Base64-decoded data, as the body.
 * `sign_pkcs7` is refused: building a CMS container is the engine's job in the
 * RAW flow, and a hand-rolled container here would prove nothing about OI-06.
 *
 * No dependencies; Node's own http and crypto. It is reachable only on the
 * compose network (no host port), and it logs the action and outcome, never
 * the data or the token.
 */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import process from 'node:process';

const DIR = process.env.SIGNING_MATERIAL_DIR ?? '/signing';
const PORT = Number(process.env.PORT ?? '6000');
const MAX_BODY = 1024 * 1024;
const HASHES = new Set(['sha256', 'sha384', 'sha512']);

const key = createPrivateKey(readFileSync(`${DIR}/signer.key`));
const certificates = {
  certificates: [readFileSync(`${DIR}/signer.crt`).toString('base64')],
  ca_certificates: [readFileSync(`${DIR}/ca.crt`).toString('base64')],
};

const answer = (res, status, body, type = 'text/plain') => {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
};

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthcheck') return answer(res, 200, 'ok');
  if (req.method !== 'POST' || req.url !== '/sign') return answer(res, 404, 'not found');
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(c);
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return answer(res, 400, 'body is not JSON');
    }
    const action = body.action ?? 'sign';
    if (action === 'get_certificates') {
      console.log('get_certificates: answered');
      return answer(res, 200, JSON.stringify(certificates), 'application/json');
    }
    if (action !== 'sign') {
      console.log(`${String(action).slice(0, 32)}: refused`);
      return answer(res, 400, 'only the RAW container is supported: use signatureContainer "raw"');
    }
    const hash = String(body.hash_algorithm ?? 'sha256').toLowerCase();
    if (!HASHES.has(hash) || typeof body.data_to_be_signed !== 'string')
      return answer(res, 400, 'data_to_be_signed and a SHA-2 hash_algorithm are required');
    const signature = sign(hash, Buffer.from(body.data_to_be_signed, 'base64'), key);
    console.log(`sign: ${hash}, ${signature.length}-byte signature`);
    return answer(res, 200, signature, 'application/octet-stream');
  });
}).listen(PORT, () => console.log(`development signing service on :${PORT} (self-signed; not a trust anchor)`));
