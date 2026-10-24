/**
 * Object storage for documents an applicant or an officer uploads (UAE M2b).
 *
 * A port: capability-named, vendor-free. Objects are content-addressed: the
 * caller names an object by a key that ends in the SHA-256 of its bytes, and
 * the store is trusted with nothing it could change unnoticed — a read whose
 * bytes do not hash to what was recorded is refused, never served.
 *
 * What crosses this boundary is bytes and a media type. No file name (a file
 * name is personal data as often as not), no party identifier, no tag.
 * Unavailability is a typed outcome, never a throw: a store that is down
 * stores nothing and the document is not presented.
 */

import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

/** The media types the platform accepts for an uploaded document. */
export const STORABLE_MEDIA_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export type StorableMediaType = (typeof STORABLE_MEDIA_TYPES)[number];

export interface StoredObject {
  readonly objectKey: string;
  /** Lower-case hex SHA-256 of the bytes, as the platform computed it before storing. */
  readonly sha256Hex: string;
  readonly byteLength: number;
  readonly mediaType: StorableMediaType;
}

export interface ObjectStoragePort {
  /** Where the bytes go: 'FIXTURE' (an in-memory store for synthetic demonstration) or 'LIVE'. */
  readonly source: 'FIXTURE' | 'LIVE';

  put(params: {
    readonly tenantId: string;
    readonly objectKey: string;
    readonly bytes: Uint8Array;
    readonly mediaType: StorableMediaType;
    readonly sha256Hex: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<StoredObject>>>;

  /** The bytes, checked against `sha256Hex` before they are returned. */
  get(params: {
    readonly tenantId: string;
    readonly objectKey: string;
    readonly sha256Hex: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<{ readonly bytes: Uint8Array; readonly mediaType: StorableMediaType }>>>;
}
