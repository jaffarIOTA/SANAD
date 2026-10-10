/**
 * The authority's cryptographic stamp, verified here rather than read from a
 * response flag (SR-016).
 *
 * A cleared invoice carries a QR code: TLV records (one-byte tag, one-byte
 * length) in which tag 6 is the invoice hash, tag 7 the ECDSA signature over
 * it and tag 8 the signer's public key. The stamp is valid only when all of
 * these hold:
 *   - the QR's hash is the hash of the invoice asked about;
 *   - the signer's key is one the institution pinned as the authority's
 *     (configuration, never the response's own say-so);
 *   - the signature verifies over that hash under that key.
 * Anything missing, malformed or unpinned is an invalid stamp, never an error
 * that might be read as a pass.
 *
 * Deviation ZATCA-EINV-DEV-003 records what the sandbox must confirm: the tag
 * layout for the read path and which certificate the authority stamps with.
 */

import { type KeyObject, createPublicKey, verify } from 'node:crypto';

const TAG_INVOICE_HASH = 6;
const TAG_SIGNATURE = 7;
const TAG_PUBLIC_KEY = 8;

/** TLV records by tag, or undefined when the encoding does not parse exactly. */
export function parseTlv(bytes: Uint8Array): ReadonlyMap<number, Uint8Array> | undefined {
  const out = new Map<number, Uint8Array>();
  let i = 0;
  while (i < bytes.length) {
    if (i + 2 > bytes.length) return undefined;
    const tag = bytes[i] as number;
    const length = bytes[i + 1] as number;
    const end = i + 2 + length;
    if (end > bytes.length || out.has(tag)) return undefined;
    out.set(tag, bytes.subarray(i + 2, end));
    i = end;
  }
  return out;
}

const spki = (k: KeyObject): Buffer => k.export({ format: 'der', type: 'spki' });

/** Whether the QR code carries the authority's valid stamp over this invoice's hash. */
export function stampVerifies(qrCode: unknown, invoiceHash: string, authorityKeys: readonly KeyObject[]): boolean {
  if (typeof qrCode !== 'string' || qrCode.length === 0 || qrCode.length > 4096 || authorityKeys.length === 0)
    return false;
  const tlv = parseTlv(new Uint8Array(Buffer.from(qrCode, 'base64')));
  const hash = tlv?.get(TAG_INVOICE_HASH);
  const signature = tlv?.get(TAG_SIGNATURE);
  const keyDer = tlv?.get(TAG_PUBLIC_KEY);
  if (hash === undefined || signature === undefined || keyDer === undefined) return false;
  if (Buffer.from(hash).toString('utf8') !== invoiceHash) return false;
  let signer: KeyObject;
  try {
    signer = createPublicKey({ key: Buffer.from(keyDer), format: 'der', type: 'spki' });
  } catch {
    return false;
  }
  const signerDer = spki(signer);
  if (!authorityKeys.some((k) => spki(k).equals(signerDer))) return false;
  try {
    return verify('sha256', Buffer.from(hash), { key: signer, dsaEncoding: 'der' }, Buffer.from(signature));
  } catch {
    return false;
  }
}
