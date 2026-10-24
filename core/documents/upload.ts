/**
 * What the platform accepts as an uploaded document, decided from the bytes.
 *
 * The browser's declared type and the file name are not trusted: the media
 * type is read from the file's own signature, and a file whose signature is
 * not one of the accepted types is refused whatever it calls itself. Pure.
 */
import { createHash } from 'node:crypto';

import type { StorableMediaType } from '../ports/object-storage.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

/** Ten megabytes: a scanned multi-page statement fits; a video does not. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface AcceptedUpload {
  readonly mediaType: StorableMediaType;
  readonly sha256Hex: string;
  readonly byteLength: number;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  signature.every((b, i) => bytes[i] === b);

/** The media type the bytes' signature says, or undefined. */
export function sniffMediaType(bytes: Uint8Array): StorableMediaType | undefined {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  return undefined;
}

export function acceptUpload(bytes: Uint8Array): Result<AcceptedUpload> {
  if (bytes.byteLength === 0) return reject('OP-DETERMINACY', 'UPLOAD_EMPTY', 'The file is empty');
  if (bytes.byteLength > MAX_UPLOAD_BYTES)
    return reject('OP-DETERMINACY', 'UPLOAD_TOO_LARGE', 'The file is larger than the platform accepts', {
      limitBytes: String(MAX_UPLOAD_BYTES),
    });
  const mediaType = sniffMediaType(bytes);
  if (mediaType === undefined)
    return reject('OP-DETERMINACY', 'UPLOAD_TYPE_NOT_ACCEPTED', 'Only PDF, PNG and JPEG files are accepted');
  return ok({ mediaType, sha256Hex: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength });
}
