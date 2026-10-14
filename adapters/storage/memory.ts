/**
 * An in-memory object store: the fixture for tests and for a synthetic
 * demonstration where no store is configured. Labelled FIXTURE on every
 * screen that shows a document it holds. Process-local: a restart, or a
 * second instance, does not have the bytes, and the screen then says the
 * document cannot be read rather than serving anything else.
 */
import { createHash } from 'node:crypto';

import type { ObjectStoragePort, StorableMediaType, StoredObject } from '../../core/ports/object-storage.ts';
import type { RailOutcome } from '../../core/ports/rail.ts';
import { type Result, ok, reject } from '../../core/kernel/result.ts';

export class InMemoryObjectStorage implements ObjectStoragePort {
  readonly source = 'FIXTURE' as const;
  readonly #objects = new Map<string, { readonly bytes: Uint8Array; readonly mediaType: StorableMediaType }>();

  put(params: {
    readonly tenantId: string;
    readonly objectKey: string;
    readonly bytes: Uint8Array;
    readonly mediaType: StorableMediaType;
    readonly sha256Hex: string;
  }): Promise<Result<RailOutcome<StoredObject>>> {
    if (createHash('sha256').update(params.bytes).digest('hex') !== params.sha256Hex)
      return Promise.resolve(
        reject('OP-DETERMINACY', 'OBJECT_HASH_MISMATCH', 'The bytes are not the bytes that were hashed'),
      );
    this.#objects.set(`${params.tenantId}|${params.objectKey}`, {
      bytes: new Uint8Array(params.bytes),
      mediaType: params.mediaType,
    });
    return Promise.resolve(
      ok({
        kind: 'ANSWERED',
        value: {
          objectKey: params.objectKey,
          sha256Hex: params.sha256Hex,
          byteLength: params.bytes.byteLength,
          mediaType: params.mediaType,
        },
      }),
    );
  }

  get(params: {
    readonly tenantId: string;
    readonly objectKey: string;
    readonly sha256Hex: string;
  }): Promise<Result<RailOutcome<{ readonly bytes: Uint8Array; readonly mediaType: StorableMediaType }>>> {
    const held = this.#objects.get(`${params.tenantId}|${params.objectKey}`);
    if (held === undefined) return Promise.resolve(ok({ kind: 'REFUSED', code: 'NOT_HELD' }));
    if (createHash('sha256').update(held.bytes).digest('hex') !== params.sha256Hex)
      return Promise.resolve(
        reject('OP-DETERMINACY', 'OBJECT_TAMPERED', 'The stored bytes do not match their recorded hash'),
      );
    return Promise.resolve(
      ok({ kind: 'ANSWERED', value: { bytes: new Uint8Array(held.bytes), mediaType: held.mediaType } }),
    );
  }
}
